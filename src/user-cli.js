const path = require('path');
const UserStore = require('./utils/user-store');
const { dataDir } = require('./utils/data-dir');

// `cc-web user ...` -- platform accounts from the command line (M4).
//
// Reads and writes <dataDir>/platform directly, so it works with the server
// stopped or running: a running server re-reads the users directory when it
// changes, refuses logins issued before a reset or a disable at once, and
// closes the sockets they opened within 30 seconds (sweepRevokedAccess).
//
//   cc-web user list
//   cc-web user add <name> [--admin]      prints a one-time password
//   cc-web user passwd <name>             prints a new one-time password
//   cc-web user disable|enable <name>
//   cc-web user role <name> admin|user
//
// --data-dir <dir> picks the instance; otherwise CCW_DATA_DIR, otherwise the
// default ~/.cc-web/data -- the same answer the server gives.

const USAGE = `用法：
  cc-web user list
  cc-web user add <用户名> [--admin]     新建用户，打印一次性临时密码
  cc-web user passwd <用户名>            重置密码，打印一次性临时密码
  cc-web user disable <用户名>           停用（已登录的浏览器立即失效）
  cc-web user enable <用户名>            重新启用
  cc-web user role <用户名> admin|user   修改角色

  --data-dir <目录>   指定实例的数据目录（默认取 CCW_DATA_DIR，再默认 ~/.cc-web/data）`;

function parse(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--admin') flags.admin = true;
    else if (a === '--data-dir') flags.dataDir = argv[++i];
    else if (a.startsWith('--data-dir=')) flags.dataDir = a.slice('--data-dir='.length);
    else if (a === '-h' || a === '--help') flags.help = true;
    else args.push(a);
  }
  return { args, flags };
}

// `out` / `err` are injectable so the tests can read what was printed.
async function main(argv, { out = console.log, err = console.error } = {}) {
  const { args, flags } = parse(argv);
  const [command, name, extra] = args;
  if (flags.help || !command) {
    out(USAGE);
    return command || flags.help ? 0 : 1;
  }
  const dir = path.resolve(flags.dataDir || dataDir());
  const store = new UserStore(() => path.join(dir, 'platform'));
  const find = () => {
    const user = name ? store.findByUsername(name) : null;
    if (!user) err(name ? `没有用户 ${name}（数据目录 ${dir}）` : '请给出用户名');
    return user;
  };
  const otherActiveAdmins = (id) => store.listUsers().filter((u) => u.role === 'admin' && !u.disabled && u.id !== id).length;

  try {
    switch (command) {
      case 'list': {
        const users = store.listUsers().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        if (!users.length) {
          out(`数据目录 ${dir} 里还没有用户。打开网页用启动令牌创建第一个管理员，或运行 cc-web user add <用户名> --admin。`);
          return 0;
        }
        for (const u of users) {
          const marks = [u.role === 'admin' ? '管理员' : '普通用户'];
          if (u.disabled) marks.push('已停用');
          if (u.mustChangePassword) marks.push('待改密码');
          out(`${u.username}\t${u.id}\t${marks.join('，')}`);
        }
        return 0;
      }
      case 'add': {
        if (!name) { err(USAGE); return 1; }
        const password = UserStore.tempPassword();
        const user = await store.createUser({ username: name, password, role: flags.admin ? 'admin' : 'user', mustChangePassword: true });
        out(`已创建${user.role === 'admin' ? '管理员' : '用户'} ${user.username}（${user.id}）`);
        out(`临时密码：${password}`);
        out('只显示这一次。第一次登录时必须改成自己的密码。');
        return 0;
      }
      case 'passwd': {
        const user = find();
        if (!user) return 1;
        const password = UserStore.tempPassword();
        await store.setPassword(user.id, password, { mustChangePassword: true, revokeAll: true });
        out(`已重置 ${user.username} 的密码，对方已登录的浏览器全部失效。`);
        out(`临时密码：${password}`);
        out('只显示这一次。下次登录时必须改成自己的密码。');
        return 0;
      }
      case 'disable':
      case 'enable': {
        const user = find();
        if (!user) return 1;
        const disabled = command === 'disable';
        if (disabled && user.role === 'admin' && !user.disabled && otherActiveAdmins(user.id) === 0) {
          err('至少要保留一个可用的管理员');
          return 1;
        }
        store.updateUser(user.id, { disabled });
        if (disabled) store.revokeUserSessions(user.id);
        out(disabled
          ? `已停用 ${user.username}。运行中的服务会在 30 秒内断开对方的终端并停止对方的 Claude。`
          : `已启用 ${user.username}`);
        return 0;
      }
      case 'role': {
        const user = find();
        if (!user) return 1;
        if (extra !== 'admin' && extra !== 'user') { err('角色是 admin 或 user'); return 1; }
        if (user.role === 'admin' && extra === 'user' && !user.disabled && otherActiveAdmins(user.id) === 0) {
          err('至少要保留一个可用的管理员');
          return 1;
        }
        store.updateUser(user.id, { role: extra });
        out(`${user.username} 现在是${extra === 'admin' ? '管理员' : '普通用户'}`);
        return 0;
      }
      default:
        err(`不认识的命令：${command}\n\n${USAGE}`);
        return 1;
    }
  } catch (error) {
    err(error.message);
    return 1;
  }
}

module.exports = { main, USAGE };
