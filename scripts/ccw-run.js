#!/usr/bin/env node
// `npm run ccw -- <args>` on any platform: ccw.ps1 on Windows, scripts/ccw
// (bash) elsewhere. Not `bash scripts/ccw` in package.json: npm runs scripts
// through cmd.exe on Windows, where `bash` is usually WSL's, which would run
// the Linux branch against a Windows checkout.

const { spawnSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const [cmd, cmdArgs] = process.platform === 'win32'
  ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'ccw.ps1'), ...args]]
  : ['bash', [path.join(__dirname, 'ccw'), ...args]];

const result = spawnSync(cmd, cmdArgs, { stdio: 'inherit' });
if (result.error) {
  console.error(`ccw: cannot run ${cmd}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
