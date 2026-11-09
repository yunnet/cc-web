// Authentication module for Claude Code Web
//
// Two ways in. A platform user signs in with a username and password and the
// server sets an HttpOnly login cookie, which every fetch and the WebSocket
// then carry by themselves — nothing is kept in page storage, and a restart
// does not sign anyone out. The shared startup token still works: entered once
// it is exchanged for the same cookie (as the first admin), and while no user
// exists it is what authorises creating that admin.
//
// Two more screens since M4: signing up with an invite link (/?invite=<code>),
// and the password change a one-time password forces before anything else.
class AuthManager {
    constructor() {
        // Always run consumeUrlToken first so a ?token=… in the URL is stripped
        // even when a token is already stored (otherwise the secret would linger
        // in the address bar / history). A URL token, being explicit, wins.
        // A token left in sessionStorage by the token-only version is picked up
        // once and exchanged for a cookie in initialize().
        const urlToken = this.consumeUrlToken();
        this.token = urlToken || sessionStorage.getItem('cc-web-token');
        this.authRequired = false;
        this.setupRequired = false;
        this.user = null;
        this.invite = this.consumeUrlInvite();
    }

    // /?invite=<code>: kept for the sign-up screen, dropped from the address
    // bar so a reload after signing up does not offer it again.
    consumeUrlInvite() {
        try {
            const params = new URLSearchParams(window.location.search);
            const code = params.get('invite');
            if (!code) return null;
            params.delete('invite');
            const qs = params.toString();
            window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
            return code;
        } catch (_) {
            return null;
        }
    }

    // If the page was opened with ?token=… (a convenience/bookmark form), adopt
    // it and immediately strip it from the URL via replaceState so the secret
    // doesn't linger in browser history or leak via the Referer header.
    consumeUrlToken() {
        try {
            const params = new URLSearchParams(window.location.search);
            const t = params.get('token');
            if (!t) return null;
            params.delete('token');
            const qs = params.toString();
            const url = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
            window.history.replaceState(null, '', url);
            sessionStorage.setItem('cc-web-token', t);
            return t;
        } catch (_) {
            return null;
        }
    }

    async checkAuthStatus() {
        try {
            const response = await fetch('/auth-status');
            if (!response.ok) {
                throw new Error('Failed to check auth status');
            }
            const data = await response.json();
            this.authRequired = data.authRequired;
            this.setupRequired = !!data.setupRequired;
            this.user = data.user || null;
            return data;
        } catch (error) {
            console.error('Failed to check auth status:', error);
            // Assume auth is required if we can't check - safer default
            this.authRequired = true;
            return { authRequired: true, authenticated: false };
        }
    }

    // Checks the shared token. When the server also signed this browser in
    // (`session: true`), the token is no longer needed and is dropped from the
    // page; otherwise it is kept in memory for the requests that follow.
    async verifyToken(token) {
        try {
            const response = await fetch('/auth-verify', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ token })
            });

            const data = await response.json();
            this.lastVerifyError = response.status === 429 ? data.error : null;
            if (data.valid) {
                this.setupRequired = !!data.setupRequired;
                if (data.session) {
                    this.token = null;
                    sessionStorage.removeItem('cc-web-token');
                } else {
                    // No cookie came back (no enabled admin to stand for), so
                    // the token must survive the reload that follows.
                    this.token = token;
                    sessionStorage.setItem('cc-web-token', token);
                }
            }
            return !!data.valid;
        } catch (error) {
            console.error('Failed to verify token:', error);
            return false;
        }
    }

    // Resolves { ok } or { ok: false, error } — the message is shown as is.
    async postJson(url, body) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) return { ok: false, error: data.error || `Request failed (${response.status})` };
            return { ok: true, data };
        } catch (_) {
            return { ok: false, error: 'Could not reach the server' };
        }
    }

    async login(username, password) {
        const result = await this.postJson('/api/auth/login', { username, password });
        if (result.ok) this.user = result.data.user;
        return result;
    }

    async setupAdmin(token, username, password) {
        const result = await this.postJson('/api/auth/setup', { token, username, password });
        if (result.ok) {
            this.user = result.data.user;
            this.token = null;
            sessionStorage.removeItem('cc-web-token');
        }
        return result;
    }

    // mode: 'login' (username + password), 'token' (shared startup token),
    // 'setup' (create the first administrator), 'register' (sign up with an
    // invite) or 'change' (the forced password change). With no argument it
    // picks setup while no user exists, else login.
    showLoginPrompt(mode) {
        if (!mode) mode = this.setupRequired ? (this.token ? 'setup' : 'token') : 'login';
        console.log('[Auth] Showing login prompt:', mode);

        // Remove any existing auth overlay
        const existingOverlay = document.getElementById('auth-overlay');
        if (existingOverlay) {
            existingOverlay.remove();
        }

        const overlay = document.createElement('div');
        overlay.id = 'auth-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.95);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
        `;

        const loginForm = document.createElement('div');
        loginForm.style.cssText = `
            background: var(--bg-secondary, #1c2128);
            border: 1px solid var(--border-color, #30363d);
            border-radius: 12px;
            padding: 32px;
            max-width: 400px;
            width: 90%;
            box-shadow: 0 10px 50px rgba(0, 0, 0, 0.5);
        `;

        const font = `'Inter', system-ui, -apple-system, Segoe UI, Roboto, 'JetBrains Mono', monospace`;
        const inputStyle = `
            width: 100%;
            padding: 10px 12px;
            background: var(--bg-primary, #0d1117);
            border: 1px solid var(--border-color, #30363d);
            border-radius: 6px;
            color: var(--text-primary, #f0f6fc);
            font-family: ${font};
            font-size: 14px;
            box-sizing: border-box;
        `;
        const labelStyle = 'display: block; color: var(--text-secondary, #8b949e); margin-bottom: 8px; font-size: 14px;';
        const field = (id, label, type, placeholder, autocomplete) => `
            <div style="margin-bottom: 16px;">
                <label for="${id}" style="${labelStyle}">${label}</label>
                <input type="${type}" id="${id}" placeholder="${placeholder}" autocomplete="${autocomplete}" style="${inputStyle}" required />
            </div>`;
        const linkStyle = 'background: none; border: none; padding: 0; color: var(--accent, #58a6ff); cursor: pointer; font-size: 12px; font-family: inherit;';

        const screens = {
            login: {
                heading: 'Sign in',
                intro: 'Sign in with your Claude Code Web account',
                fields: field('auth-username', 'Username', 'text', 'Username', 'username')
                    + field('auth-password', 'Password', 'password', 'Password', 'current-password'),
                button: 'Sign in',
                footer: `<button type="button" id="auth-switch" data-mode="token" style="${linkStyle}">Use the access token instead</button>`
            },
            token: {
                heading: 'Authentication Required',
                intro: this.setupRequired
                    ? 'No account exists yet. Enter the access token printed when the server started to create the administrator.'
                    : 'This Claude Code Web instance requires authentication.',
                fields: field('auth-token', 'Access Token', 'password', 'Enter your access token', 'off'),
                button: 'Authenticate',
                footer: this.setupRequired
                    ? '<p style="color: var(--text-secondary, #8b949e); font-size: 12px; margin: 0;">The access token is printed when the server starts, or read from <code style="background: var(--bg-primary, #0d1117); padding: 2px 4px; border-radius: 3px;">--auth-file</code>.</p>'
                    : `<button type="button" id="auth-switch" data-mode="login" style="${linkStyle}">Sign in with username and password</button>`
            },
            register: {
                heading: '注册账号',
                intro: '你收到了一个邀请。设置用户名和密码，注册后直接登录。',
                fields: field('auth-username', '用户名', 'text', '2–32 位字母、数字或 _ . -', 'username')
                    + field('auth-password', '密码', 'password', '至少 8 位', 'new-password')
                    + field('auth-password2', '再输一次密码', 'password', '再输一次密码', 'new-password'),
                button: '注册并登录',
                footer: `<button type="button" id="auth-switch" data-mode="login" style="${linkStyle}">已有账号？直接登录</button>`
            },
            change: {
                heading: '请先修改密码',
                intro: '你现在用的是管理员给的临时密码。设置一个只有你知道的新密码后才能继续使用。',
                fields: field('auth-current', '临时密码（当前密码）', 'password', '当前密码', 'current-password')
                    + field('auth-password', '新密码', 'password', '至少 8 位', 'new-password')
                    + field('auth-password2', '再输一次新密码', 'password', '再输一次新密码', 'new-password'),
                button: '修改密码',
                footer: `<button type="button" id="auth-logout" style="${linkStyle}">退出登录</button>`
            },
            setup: {
                heading: 'Create administrator',
                intro: 'Choose the username and password for the first account. It becomes the administrator.',
                fields: field('auth-username', 'Username', 'text', '2-32 letters, digits, _ . -', 'username')
                    + field('auth-password', 'Password', 'password', 'At least 8 characters', 'new-password')
                    + field('auth-password2', 'Repeat password', 'password', 'Repeat password', 'new-password'),
                button: 'Create and sign in',
                footer: ''
            }
        };
        const screen = screens[mode] || screens.login;

        loginForm.innerHTML = `
            <h2 style="color: var(--text-primary, #f0f6fc); margin: 0 0 8px 0; font-family: ${font}; display: flex; align-items: center; gap: 8px;">
                <span class="icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="10" width="18" height="11" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/></svg></span>
                ${screen.heading}
            </h2>
            <p style="color: var(--text-secondary, #8b949e); margin: 0 0 24px 0; font-size: 14px;">
                ${screen.intro}
            </p>
            <form id="auth-form">
                ${screen.fields}
                <div id="auth-error" style="color: #f85149; margin-bottom: 16px; font-size: 14px; display: none;"></div>
                <button
                    type="submit"
                    id="auth-submit"
                    style="
                        width: 100%;
                        padding: 10px 16px;
                        background: var(--accent);
                        color: white;
                        border: none;
                        border-radius: 6px;
                        font-family: ${font};
                        font-size: 14px;
                        font-weight: 500;
                        cursor: pointer;
                        transition: opacity 0.2s;
                    "
                    onmouseover="this.style.opacity='0.9'"
                    onmouseout="this.style.opacity='1'"
                >${screen.button}</button>
            </form>
            ${screen.footer ? `<div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border-color, #30363d);">${screen.footer}</div>` : ''}
        `;

        overlay.appendChild(loginForm);
        document.body.appendChild(overlay);

        const form = document.getElementById('auth-form');
        const submit = document.getElementById('auth-submit');
        const errorDiv = document.getElementById('auth-error');
        const inputs = Array.from(form.querySelectorAll('input'));

        const switcher = document.getElementById('auth-switch');
        if (switcher) {
            switcher.addEventListener('click', () => this.showLoginPrompt(switcher.dataset.mode));
        }
        const logoutLink = document.getElementById('auth-logout');
        if (logoutLink) logoutLink.addEventListener('click', () => this.logout());

        const showError = (message) => {
            errorDiv.textContent = message;
            errorDiv.style.display = 'block';
        };
        const setBusy = (busy, label) => {
            inputs.forEach((input) => { input.disabled = busy; });
            submit.disabled = busy;
            submit.textContent = label;
        };
        const done = () => {
            overlay.remove();
            window.location.reload();
        };

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            errorDiv.style.display = 'none';
            const value = (id) => {
                const input = document.getElementById(id);
                return input ? input.value : '';
            };

            if (mode === 'token') {
                const token = value('auth-token').trim();
                if (!token) return showError('Please enter a token');
                setBusy(true, 'Authenticating...');
                const valid = await this.verifyToken(token);
                if (!valid) {
                    setBusy(false, screen.button);
                    const tokenInput = document.getElementById('auth-token');
                    tokenInput.value = '';
                    tokenInput.focus();
                    return showError(this.lastVerifyError || 'Invalid token. Please try again.');
                }
                if (this.setupRequired) return this.showLoginPrompt('setup');
                return done();
            }

            if (mode === 'change') {
                const current = value('auth-current');
                const next = value('auth-password');
                if (!current || !next) return showError('请填写当前密码和新密码');
                if (next !== value('auth-password2')) return showError('两次输入的新密码不一致');
                setBusy(true, '正在修改…');
                const result = await this.postJson('/api/auth/password', { current, next });
                if (!result.ok) {
                    setBusy(false, screen.button);
                    return showError(AuthManager.zh(result.error));
                }
                return done();
            }

            const username = value('auth-username').trim();
            const password = value('auth-password');
            if (mode === 'register') {
                if (!username || !password) return showError('请填写用户名和密码');
                if (password !== value('auth-password2')) return showError('两次输入的密码不一致');
                setBusy(true, '正在注册…');
                const result = await this.postJson('/api/auth/register', { invite: this.invite, username, password });
                if (!result.ok) {
                    setBusy(false, screen.button);
                    return showError(AuthManager.zh(result.error));
                }
                return done();
            }
            if (!username || !password) return showError('Please enter a username and password');

            if (mode === 'setup') {
                if (password !== value('auth-password2')) return showError('The passwords do not match');
                setBusy(true, 'Creating...');
                const result = await this.setupAdmin(this.token, username, password);
                if (!result.ok) {
                    setBusy(false, screen.button);
                    // The token was spent or changed (server restarted with a new one).
                    if (/token/i.test(result.error)) return this.showLoginPrompt('token');
                    return showError(result.error);
                }
                return done();
            }

            setBusy(true, 'Signing in...');
            const result = await this.login(username, password);
            if (!result.ok) {
                setBusy(false, screen.button);
                const passwordInput = document.getElementById('auth-password');
                passwordInput.value = '';
                passwordInput.focus();
                return showError(result.error);
            }
            done();
        });

        // Focus the first input
        if (inputs[0]) inputs[0].focus();
    }

    // The server's account errors, in the words the new (Chinese) screens use.
    // Anything not listed is shown as sent.
    static zh(message) {
        const known = [
            [/^Current password is incorrect/, '当前密码不对'],
            [/^The new password must be different/, '新密码不能和当前密码相同'],
            [/^Password must be at least (\d+)/, (m) => `密码至少 ${m[1]} 位`],
            [/^Password must be at most (\d+)/, (m) => `密码最多 ${m[1]} 位`],
            [/^Username must be/, '用户名为 2–32 位字母、数字或 _ . -，以字母或数字开头'],
            [/^Username already exists/, '这个用户名已经有人用了'],
            [/^Invite code is invalid or has expired/, '邀请链接无效或已过期，请向管理员要一个新的'],
            [/^Too many attempts/, '尝试次数太多，请一分钟后再试'],
            [/^Could not reach the server/, '连不上服务器'],
            [/^Unauthorized/, '登录已失效，请刷新页面重新登录'],
        ];
        const text = String(message || '');
        for (const [re, out] of known) {
            const m = text.match(re);
            if (m) return typeof out === 'function' ? out(m) : out;
        }
        return text;
    }

    // Only the shared token travels in a header. A signed-in browser sends its
    // login cookie with every same-origin fetch on its own.
    getAuthHeaders() {
        if (!this.token) return {};
        return {
            'Authorization': `Bearer ${this.token}`
        };
    }

    getWebSocketUrl(baseUrl) {
        if (!this.token) return baseUrl;
        const separator = baseUrl.includes('?') ? '&' : '?';
        return `${baseUrl}${separator}token=${encodeURIComponent(this.token)}`;
    }

    // URL to open a plan .md in a new tab. Uses the path form
    // `/api/plan/<token>/<encoded-path>` so the URL *ends in `.md`* (the plan
    // path is one percent-encoded segment, slashes as %2F, and there's no query
    // string) — that's what browser Markdown extensions trigger on. `-` in the
    // token slot means "no token": a signed-in browser's new tab carries the
    // login cookie instead, so the secret never sits in the URL.
    getPlanUrl(planPath, sessionId) {
        const token = this.token ? encodeURIComponent(this.token) : '-';
        const sid = sessionId ? encodeURIComponent(sessionId) : '-';
        return `/api/plan/${token}/${sid}/${encodeURIComponent(planPath)}`;
    }

    // URL to open an arbitrary file (the file explorer) in a new tab, same path
    // form as getPlanUrl so the URL ends in the file's real extension. It is not
    // a ticket, so the server serves html/svg as SOURCE on this form — use
    // getFileTicket() when the file should actually be rendered.
    getFileUrl(filePath) {
        const token = this.token ? encodeURIComponent(this.token) : '-';
        return `/api/fs/file/${token}/${encodeURIComponent(filePath)}`;
    }

    // Mint a single-use, short-lived ticket for one file. Swapping the token for
    // this in the URL is what makes rendering html/svg safe: the rendered page
    // can read its own location, and all it finds there is a spent credential.
    // Resolves null on any failure — the caller falls back to the source view.
    async getFileTicket(filePath, { download = false } = {}) {
        try {
            const res = await fetch('/api/fs/ticket', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...this.getAuthHeaders() },
                body: JSON.stringify({ path: filePath, download })
            });
            if (!res.ok) return null;
            const data = await res.json();
            return data.ticket || null;
        } catch (_) {
            return null;
        }
    }

    async logout() {
        try {
            await fetch('/api/auth/logout', { method: 'POST' });
        } catch (_) { /* reload anyway: the page asks again if still signed in */ }
        this.token = null;
        this.user = null;
        sessionStorage.removeItem('cc-web-token');
        window.location.reload();
    }

    async initialize() {
        console.log('[Auth] Initializing auth manager...');

        const status = await this.checkAuthStatus();
        console.log('[Auth] Auth status:', status);

        if (!status.authRequired) return true;

        if (status.authenticated) {
            // Signed in by cookie. A leftover token from the token-only version
            // is no longer needed.
            this.token = null;
            sessionStorage.removeItem('cc-web-token');
            // A one-time password: the server refuses everything else until
            // it is changed, so ask now rather than show a page that fails.
            if (this.user && this.user.mustChangePassword) {
                this.showLoginPrompt('change');
                return false;
            }
            console.log('[Auth] Signed in as', this.user && this.user.username);
            return true;
        }

        if (this.token) {
            // A token from the URL or the token-only version: exchange it.
            const valid = await this.verifyToken(this.token);
            if (!valid) {
                console.log('[Auth] Token invalid - showing login prompt');
                this.token = null;
                sessionStorage.removeItem('cc-web-token');
                this.showLoginPrompt();
                return false;
            }
            if (this.setupRequired) {
                this.showLoginPrompt('setup');
                return false;
            }
            console.log('[Auth] Token valid');
            return true;
        }

        this.showLoginPrompt(this.invite && !this.setupRequired ? 'register' : undefined);
        return false;
    }
}

// Create global auth manager instance
window.authManager = new AuthManager();
