const BASE_STYLE = `
:root {
  color-scheme: light;
  --paper: #fbf6e8;
  --paper-card: rgba(255, 252, 246, .88);
  --paper-soft: rgba(252, 245, 241, .78);
  --ink: #4f4945;
  --muted: #9a8f87;
  --faint: #cfc2b8;
  --pink: #e5a0c4;
  --pink-soft: #f3d5e3;
  --cyan: #8dcbd0;
  --amber: #deb76e;
  --coral: #d77f82;
  --line: #eadbcf;
  font-family: "Noto Sans SC", "Microsoft YaHei UI", "PingFang SC", sans-serif;
}
* { box-sizing: border-box; }
html { min-height: 100%; background: var(--paper); }
body {
  min-height: 100vh;
  margin: 0;
  color: var(--ink);
  background-color: var(--paper);
  background-image: url("/admin/assets/paper-petals-bg.jpg");
  background-size: cover;
  background-position: center top;
  background-attachment: fixed;
}
button, input, select { font: inherit; }
button { cursor: pointer; }
.mono {
  font-family: "Cascadia Mono", "Noto Sans Mono CJK SC", monospace;
  font-variant-numeric: tabular-nums;
}
.eyebrow {
  color: #8f827a;
  font: 700 .72rem/1.2 "Trebuchet MS", "Noto Sans SC", sans-serif;
  letter-spacing: .24em;
}
.brand {
  color: #3e3936;
  font: 760 1.45rem/1 "Trebuchet MS", "Noto Sans SC", sans-serif;
  letter-spacing: .01em;
  text-decoration: none;
}
.button {
  border: 1px solid var(--line);
  border-radius: .35rem;
  color: var(--ink);
  background: rgba(255, 253, 248, .9);
  padding: .66rem .9rem;
  box-shadow: 0 .15rem .5rem rgba(104, 81, 63, .04);
  transition: border-color .18s, color .18s, transform .18s;
}
.button:hover { border-color: var(--pink); color: #ad5f88; transform: translateY(-1px); }
.button:focus-visible, input:focus-visible, select:focus-visible {
  outline: 2px solid var(--cyan);
  outline-offset: 2px;
}
.button-primary {
  color: #fff;
  background: var(--pink);
  border-color: var(--pink);
  font-weight: 700;
}
.button-primary:hover { color: #fff; background: #d98db5; }
.hidden { display: none !important; }
`;

export function setupPage(nonce: string): string {
  return authPage("setup", nonce);
}

export function loginPage(nonce: string): string {
  return authPage("login", nonce);
}

function authPage(mode: "setup" | "login", nonce: string): string {
  const setup = mode === "setup";
  const title = setup ? "第一次见面，请先创建管理员" : "欢迎回来";
  const description = setup
    ? "账号创建成功后，匿名初始化入口会立刻关闭。"
    : "登录后查看网关的实时状态、缓存和上游链路。";
  const fields = setup
    ? `
      <label>管理员账号
        <input id="username" autocomplete="username" minlength="3" maxlength="64" required>
      </label>
      <label>登录密码
        <input id="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required>
      </label>
      <label>再次确认
        <input id="confirm" type="password" autocomplete="new-password" minlength="12" maxlength="256" required>
      </label>
      <label>一次性初始化令牌
        <input id="setup-token" type="password" autocomplete="off" required>
      </label>
      <p class="field-note">密码至少 12 个字符。安全入口会从 URL 的 #fragment 读取令牌，它不会进入服务器访问日志。</p>
    `
    : `
      <label>管理员账号
        <input id="username" autocomplete="username" maxlength="64" required autofocus>
      </label>
      <label>登录密码
        <input id="password" type="password" autocomplete="current-password" maxlength="256" required>
      </label>
    `;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Yukine Gateway</title>
  <style>${BASE_STYLE}
    .auth-wrap {
      width: min(980px, calc(100% - 2rem));
      min-height: 100vh;
      margin: 0 auto;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 25rem;
      align-items: center;
      gap: clamp(2rem, 7vw, 6rem);
      padding: 3rem 0;
    }
    .intro { align-self: stretch; display: flex; flex-direction: column; justify-content: center; position: relative; }
    .intro-copy { margin-bottom: 18rem; }
    .intro h1 { margin: .8rem 0; font: 760 clamp(2.7rem, 6vw, 5.8rem)/.92 "Trebuchet MS", "Noto Sans SC", sans-serif; letter-spacing: -.055em; }
    .intro h1 span { display: block; color: var(--pink); }
    .intro p { max-width: 31rem; color: var(--muted); line-height: 1.75; }
    .mascot { position: absolute; width: min(20rem, 70%); left: 15%; bottom: 0; filter: drop-shadow(0 1.2rem 1.5rem rgba(171, 116, 142, .12)); }
    .auth-card {
      position: relative;
      border: 2px solid var(--pink);
      border-radius: 1rem;
      padding: 2rem;
      background: var(--paper-card);
      box-shadow: 0 1.4rem 3.5rem rgba(129, 93, 75, .12);
    }
    .auth-card::before {
      content: "YUKINE GATEWAY";
      position: absolute;
      top: -1rem;
      left: 1.4rem;
      padding: .35rem .75rem;
      color: #b67195;
      background: var(--paper);
      font: 700 .64rem/1 "Cascadia Mono", monospace;
      letter-spacing: .14em;
    }
    .auth-card h2 { margin: 1rem 0 .5rem; font-size: 1.45rem; }
    .auth-card > p { margin: 0 0 1.6rem; color: var(--muted); line-height: 1.65; font-size: .86rem; }
    form { display: grid; gap: .9rem; }
    label { display: grid; gap: .38rem; color: #756c67; font-size: .76rem; }
    input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: .35rem;
      padding: .78rem .82rem;
      color: var(--ink);
      background: rgba(255, 255, 253, .9);
    }
    input:hover { border-color: var(--pink-soft); }
    .field-note { margin: -.15rem 0 .3rem; color: var(--muted); font-size: .68rem; line-height: 1.55; }
    .form-status { min-height: 1.25rem; color: var(--coral); font-size: .76rem; }
    .form-status.success { color: #5c9a91; }
    .auth-foot { display: flex; justify-content: space-between; margin-top: 1.5rem; color: var(--faint); font: .62rem/1 "Cascadia Mono", monospace; }
    @media (max-width: 760px) {
      .auth-wrap { grid-template-columns: 1fr; padding: 1.3rem 0 3rem; }
      .intro { min-height: 15rem; }
      .intro-copy { margin-bottom: 0; }
      .intro h1 { font-size: 3.2rem; }
      .mascot { width: 9rem; left: auto; right: 0; opacity: .82; }
    }
  </style>
</head>
<body>
  <main class="auth-wrap">
    <section class="intro">
      <a class="brand" href="/admin">Yukine Gateway Now</a>
      <div class="intro-copy">
        <div class="eyebrow">${setup ? "FIRST START" : "SIGN IN"}</div>
        <h1>metadata<span>gateway</span></h1>
        <p>这里保留网关必要的状态，不保存标题、查询串、指纹、密钥或请求正文。</p>
      </div>
      <img class="mascot" src="/admin/assets/gateway-mascot.png" alt="Yukine 网关守护角色">
    </section>
    <section class="auth-card">
      <div class="eyebrow">${setup ? "INITIAL SETUP" : "ADMIN PANEL"}</div>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(description)}</p>
      <form id="auth-form">
        ${fields}
        <button class="button button-primary" type="submit">${setup ? "创建管理员" : "进入面板"}</button>
        <div id="form-status" class="form-status" role="status" aria-live="polite"></div>
      </form>
      <div class="auth-foot"><span>TLS ONLY</span><span>SESSION 8H</span><span>CSRF SAFE</span></div>
    </section>
  </main>
  <script nonce="${escapeHtml(nonce)}">${setup ? setupScript() : loginScript()}</script>
</body>
</html>`;
}

export function dashboardPage(nonce: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Yukine Gateway Now</title>
  <style>${BASE_STYLE}
    .page { width: min(968px, calc(100% - 2rem)); margin: 0 auto; padding: 6.5rem 0 5rem; position: relative; }
    .page-head { display: grid; grid-template-columns: 1fr auto; gap: 1.5rem; align-items: start; border-top: 2px dashed var(--line); padding-top: .7rem; }
    .page-head p { margin: .45rem 0 0; color: var(--muted); font-size: .82rem; }
    .head-state { text-align: right; color: var(--pink); font-size: .75rem; }
    .head-state strong { display: block; margin-top: .35rem; color: var(--cyan); font: 700 1rem/1 "Cascadia Mono", monospace; }
    .toolbar { display: flex; align-items: center; gap: .6rem; margin: 3.1rem 0 1.2rem; }
    .toolbar-copy { flex: 1; }
    .toolbar-copy p { margin: .45rem 0 0; color: var(--muted); font-size: .75rem; }
    select { border: 1px dashed var(--pink); border-radius: 1.3rem; color: var(--ink); background: rgba(255,253,248,.82); padding: .58rem .85rem; }
    .overview-row { display: grid; grid-template-columns: 15rem 1fr; gap: 1.3rem; align-items: end; }
    .overview-card {
      border: 2px solid var(--pink);
      border-radius: .9rem;
      padding: 1.15rem;
      background: var(--paper-card);
      box-shadow: 0 .9rem 2rem rgba(170, 107, 137, .12);
    }
    .overview-title { display: flex; justify-content: space-between; gap: .7rem; align-items: center; }
    .overview-title strong { font-size: .85rem; }
    .online-pill { color: #5e9790; background: rgba(141,203,208,.16); border-radius: 1rem; padding: .3rem .55rem; font-size: .66rem; }
    .overview-card > p { margin: .45rem 0 1.15rem; color: var(--muted); font-size: .7rem; }
    .overview-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: .65rem; }
    .overview-metrics span { display: block; color: var(--muted); font-size: .58rem; }
    .overview-metrics strong { display: block; margin-top: .25rem; font: 600 1.05rem/1 "Cascadia Mono", monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mascot { position: fixed; z-index: 1; width: 6.5rem; right: 5vw; top: 38vh; filter: drop-shadow(0 1rem 1.1rem rgba(171,116,142,.12)); pointer-events: none; }
    .status-panel {
      position: relative;
      margin-top: 1.4rem;
      border: 3px solid var(--pink);
      border-radius: .75rem;
      padding: 1.2rem 1.45rem 1.45rem;
      background: rgba(255, 253, 249, .82);
      box-shadow: 0 1rem 2rem rgba(170, 107, 137, .09);
    }
    .status-caption { margin: -.4rem 0 .7rem; text-align: center; color: var(--muted); font-size: .72rem; }
    .status-strips { display: grid; gap: .45rem; }
    .status-strip {
      display: grid;
      grid-template-columns: 9rem 1fr auto;
      gap: .7rem;
      align-items: center;
      min-height: 2.25rem;
      padding: .45rem .75rem;
      border: 1px dashed var(--pink-soft);
      border-radius: .7rem;
      background: var(--paper-soft);
      font-size: .74rem;
    }
    .status-strip span:first-child { color: #82776f; font-weight: 700; text-align: right; }
    .status-strip strong { color: var(--pink); font-weight: 700; }
    .status-strip em { color: var(--muted); font: normal .65rem/1 "Cascadia Mono", monospace; }
    .chart-shell { height: 7.2rem; margin-top: 1rem; border-top: 1px dashed var(--line); padding-top: .7rem; }
    canvas { display: block; width: 100%; height: 100%; }
    .lower { display: grid; grid-template-columns: 19rem minmax(0, 1fr); gap: 1.5rem; margin-top: 2rem; }
    .section-head { margin-bottom: .75rem; }
    .section-head h2 { margin: 0; font-size: .72rem; letter-spacing: .12em; }
    .route-list, .upstream-list { display: grid; gap: .55rem; }
    .route-card {
      border: 1px solid var(--line);
      border-left: 2px solid var(--pink);
      border-radius: .2rem;
      padding: .85rem .9rem;
      background: var(--paper-card);
    }
    .route-top { display: flex; justify-content: space-between; gap: .8rem; align-items: center; }
    .route-name { color: #5f5955; font: 650 .72rem/1.3 "Cascadia Mono", monospace; overflow: hidden; text-overflow: ellipsis; }
    .route-rate { color: var(--cyan); font: 700 .7rem/1 "Cascadia Mono", monospace; }
    .route-meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: .4rem; margin-top: .65rem; color: var(--muted); font-size: .59rem; }
    .route-meta strong { display: block; margin-top: .18rem; color: #77706a; font: 550 .7rem/1 "Cascadia Mono", monospace; }
    .timeline-head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding-bottom: .65rem; border-bottom: 2px dashed var(--line); }
    .timeline-date { border: 1px solid var(--line); border-radius: .35rem; padding: .5rem .65rem; text-align: center; background: var(--paper-card); }
    .timeline-date span { display: block; color: var(--pink); font-size: .55rem; }
    .timeline-date strong { font: 700 1.1rem/1 "Cascadia Mono", monospace; }
    .upstream-row {
      display: grid;
      grid-template-columns: 4rem 1fr auto;
      gap: .7rem;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: .25rem;
      padding: .65rem .75rem;
      background: rgba(255,253,248,.72);
    }
    .upstream-row.primary { border-color: var(--pink); box-shadow: 0 0 0 1px rgba(229,160,196,.18); }
    .upstream-badge { color: var(--pink); font-size: .65rem; font-weight: 700; text-align: center; }
    .upstream-main strong { display: block; font: 650 .73rem/1.25 "Cascadia Mono", monospace; }
    .upstream-main span { display: block; margin-top: .28rem; color: var(--muted); font-size: .63rem; }
    .upstream-rate { color: var(--amber); font: 650 .68rem/1 "Cascadia Mono", monospace; }
    .status-code-panel { margin-top: 1.2rem; border-top: 2px dashed var(--line); padding-top: .9rem; }
    .code-row { display: grid; grid-template-columns: 3rem 1fr auto; gap: .7rem; align-items: center; margin: .45rem 0; font-size: .65rem; }
    .code-track { height: .42rem; border-radius: 1rem; background: rgba(222, 201, 184, .3); overflow: hidden; }
    .code-fill { height: 100%; background: var(--pink); }
    .system-foot { display: grid; grid-template-columns: repeat(3, 1fr); gap: .7rem; margin-top: 2rem; padding-top: .8rem; border-top: 2px dashed var(--line); }
    .system-card { padding: .75rem; color: var(--muted); font-size: .62rem; }
    .system-card strong { display: block; margin-top: .35rem; color: #716963; font: 600 .78rem/1.2 "Cascadia Mono", monospace; }
    .methodology { margin-top: 1rem; color: var(--muted); font-size: .65rem; line-height: 1.7; }
    .empty { padding: 1rem; color: var(--muted); text-align: center; font-size: .7rem; }
    @media (max-width: 1320px) { .mascot { display: none; } }
    @media (max-width: 780px) {
      .page { padding-top: 1.6rem; }
      .page-head { grid-template-columns: 1fr; }
      .head-state { text-align: left; }
      .toolbar { margin-top: 2rem; align-items: flex-end; flex-wrap: wrap; }
      .toolbar-copy { flex-basis: 100%; }
      .overview-row { grid-template-columns: 1fr; }
      .overview-card { max-width: none; }
      .status-panel { padding: 1rem .7rem; }
      .status-strip { grid-template-columns: 6.5rem 1fr; }
      .status-strip em { display: none; }
      .lower { grid-template-columns: 1fr; }
      .system-foot { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <img class="mascot" src="/admin/assets/gateway-mascot.png" alt="">
  <main class="page">
    <header class="page-head">
      <div>
        <a class="brand" href="/admin">Yukine Gateway Now</a>
        <p>(´• ω •´) 早上好呀~ 这里可以查看元数据网关的实时状态。</p>
      </div>
      <div class="head-state"><span id="viewer-state">1 人在看喵~</span><strong id="freshness">--:--</strong></div>
    </header>

    <section class="toolbar">
      <div class="toolbar-copy"><div class="eyebrow">PANELS</div><p>切换时间窗口，下方卡片会一起更新。</p></div>
      <label class="hidden" for="window">时间窗口</label>
      <select id="window">
        <option value="15m">最近 15 分钟</option>
        <option value="1h" selected>最近 1 小时</option>
        <option value="24h">最近 24 小时</option>
      </select>
      <button id="logout" class="button" type="button">退出</button>
    </section>

    <section class="overview-row">
      <article class="overview-card">
        <div class="overview-title"><strong>metadata gateway</strong><span class="online-pill">在线</span></div>
        <p>Yukine 的元数据主面板</p>
        <div class="overview-metrics">
          <div><span>REQUESTS</span><strong id="overview-requests">—</strong></div>
          <div><span>UPTIME</span><strong id="overview-uptime">—</strong></div>
          <div><span>STATUS</span><strong id="overview-status">等待</strong></div>
        </div>
      </article>
    </section>

    <section class="status-panel">
      <div class="status-caption">metadata gateway 现在…</div>
      <div class="status-strips">
        <div class="status-strip"><span>当前状态</span><strong id="strip-status" aria-live="polite">等待第一束信号</strong><em id="strip-rps">— req/s</em></div>
        <div class="status-strip"><span>请求可用率</span><strong id="strip-availability">—</strong><em id="strip-errors">5xx —</em></div>
        <div class="status-strip"><span>处理延迟</span><strong id="strip-latency">—</strong><em id="strip-average">AVG —</em></div>
        <div class="status-strip"><span>缓存命中</span><strong id="strip-cache">—</strong><em id="strip-cache-count">0 / 0</em></div>
        <div class="status-strip"><span>上游链路</span><strong id="strip-upstream">—</strong><em id="strip-fanout">FAN-OUT —</em></div>
      </div>
      <div class="chart-shell"><canvas id="trend-chart" aria-label="请求与错误趋势"></canvas></div>
    </section>

    <section class="lower">
      <div>
        <header class="section-head"><h2>ROUTES</h2></header>
        <div id="route-list" class="route-list"><div class="empty">等待业务流量</div></div>
      </div>
      <div>
        <header class="timeline-head">
          <div><div class="eyebrow">UPSTREAM</div><div id="trend-range" class="methodology">等待上游调用</div></div>
          <div class="timeline-date"><span id="date-month">---</span><strong id="date-day">--</strong></div>
        </header>
        <div id="upstream-list" class="upstream-list"><div class="empty">等待上游调用</div></div>
        <div id="status-code-panel" class="status-code-panel"></div>
      </div>
    </section>

    <footer class="system-foot">
      <div class="system-card">SQLITE CACHE<strong id="runtime-cache">—</strong></div>
      <div class="system-card">METRICS RETENTION<strong id="runtime-retention">—</strong></div>
      <div class="system-card">MEASUREMENT SCOPE<strong>/v1/* · NODE ONLY</strong></div>
    </footer>
    <p id="methodology" class="methodology">正在载入指标口径。</p>
  </main>
  <script nonce="${escapeHtml(nonce)}">${dashboardScript()}</script>
</body>
</html>`;
}

function setupScript(): string {
  return `
  (function () {
    'use strict';
    var form = document.getElementById('auth-form');
    var status = document.getElementById('form-status');
    var tokenInput = document.getElementById('setup-token');
    if (location.hash.length > 1) {
      try { tokenInput.value = decodeURIComponent(location.hash.slice(1)); } catch (_) {}
      history.replaceState(null, '', location.pathname);
    }
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      status.className = 'form-status';
      status.textContent = '正在创建管理员…';
      var password = document.getElementById('password').value;
      if (password !== document.getElementById('confirm').value) {
        status.textContent = '两次输入的密码不一致。';
        return;
      }
      try {
        var response = await fetch('/admin/api/setup', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: password,
            setupToken: tokenInput.value
          })
        });
        var body = await response.json().catch(function () { return {}; });
        if (!response.ok) {
          status.textContent = body.error === 'rate_limited'
            ? '尝试过于频繁，请稍后再试。'
            : '账号格式、密码长度或初始化令牌不正确。';
          return;
        }
        form.reset();
        status.className = 'form-status success';
        status.textContent = '管理员已创建，初始化入口已经关闭。正在前往登录页…';
        setTimeout(function () { location.replace('/admin/login'); }, 900);
      } catch (_) {
        status.textContent = '暂时无法连接网关，请稍后重试。';
      }
    });
  }());`;
}

function loginScript(): string {
  return `
  (function () {
    'use strict';
    var form = document.getElementById('auth-form');
    var status = document.getElementById('form-status');
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      status.className = 'form-status';
      status.textContent = '正在确认身份…';
      try {
        var response = await fetch('/admin/api/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value
          })
        });
        var body = await response.json().catch(function () { return {}; });
        if (!response.ok) {
          status.textContent = body.error === 'rate_limited'
            ? '登录尝试太多啦，请稍后再试。'
            : '账号或密码不正确。';
          return;
        }
        location.replace('/admin');
      } catch (_) {
        status.textContent = '暂时无法连接网关，请稍后重试。';
      }
    });
  }());`;
}

function dashboardScript(): string {
  return `
  (function () {
    'use strict';
    var snapshot = null;
    var csrfToken = '';
    var timer = null;
    var colors = { 200: '#8dcbd0', 400: '#deb76e', 404: '#c7b9ae', 405: '#a7c9cf', 429: '#d9a26d', 502: '#d77f82' };
    var windowSelect = document.getElementById('window');

    function compact(value) {
      if (value == null || !isFinite(value)) return '—';
      return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
    }
    function percent(value) {
      if (value == null || !isFinite(value)) return '—';
      return (value * 100).toFixed(value >= .995 ? 1 : 2) + '%';
    }
    function duration(value) {
      if (value == null || !isFinite(value)) return '—';
      return value >= 1000 ? (value / 1000).toFixed(2) + 's' : Math.round(value) + 'ms';
    }
    function uptime(seconds) {
      var days = Math.floor(seconds / 86400);
      var hours = Math.floor((seconds % 86400) / 3600);
      var minutes = Math.floor((seconds % 3600) / 60);
      return (days ? days + 'd ' : '') + hours + 'h ' + minutes + 'm';
    }
    function text(id, value) { document.getElementById(id).textContent = value; }

    async function load() {
      try {
        var response = await fetch('/admin/api/snapshot?window=' + encodeURIComponent(windowSelect.value), {
          credentials: 'same-origin',
          cache: 'no-store'
        });
        if (response.status === 401) { location.replace('/admin/login'); return; }
        if (!response.ok) throw new Error('snapshot');
        snapshot = await response.json();
        csrfToken = snapshot.csrfToken || '';
        render(snapshot);
        var generated = new Date(snapshot.generatedAt);
        text('freshness', generated.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }));
      } catch (_) {
        text('freshness', '重连中…');
      }
    }

    function render(data) {
      var summary = data.summary;
      var healthy = summary.availability == null || summary.availability >= .99;
      text('overview-requests', compact(summary.requests));
      text('overview-uptime', uptime(data.runtime.uptimeSeconds));
      text('overview-status', healthy ? '轻松' : '注意');
      text('strip-status', summary.requests ? (healthy ? '链路安静，信号流动正常。' : '出现失败请求，请查看路由。') : '还没有业务请求，正在安静等待。');
      text('strip-rps', (summary.rps == null ? '—' : summary.rps.toFixed(2)) + ' req/s');
      text('strip-availability', percent(summary.availability));
      text('strip-errors', '5xx ' + percent(summary.errorRate));
      text('strip-latency', 'P95 ' + duration(summary.latencyP95Ms));
      text('strip-average', 'AVG ' + duration(summary.latencyAverageMs));
      text('strip-cache', percent(summary.cacheHitRate));
      text('strip-cache-count', compact(data.runtime.cacheEntries) + ' / ' + compact(data.runtime.cacheMaxEntries));
      text('strip-upstream', percent(summary.upstreamAvailability));
      text('strip-fanout', 'FAN-OUT ' + (summary.fanOut == null ? '—' : summary.fanOut.toFixed(2)));
      text('runtime-cache', compact(data.runtime.cacheEntries) + ' / ' + compact(data.runtime.cacheMaxEntries) + ' entries');
      text('runtime-retention', data.retentionDays + ' days · 1 min');
      text('methodology', data.definitions.scope + ' ' + data.definitions.availability + ' ' + data.definitions.cacheHitRate);
      var now = new Date(data.generatedAt);
      text('date-month', now.toLocaleDateString('en', { month: 'short' }).toUpperCase());
      text('date-day', String(now.getDate()).padStart(2, '0'));
      renderTrend(data.trend);
      renderRoutes(data.routes);
      renderUpstream(data.upstream);
      renderStatuses(data.statuses);
    }

    function renderTrend(rows) {
      var canvas = document.getElementById('trend-chart');
      var rect = canvas.getBoundingClientRect();
      var ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      var ctx = canvas.getContext('2d');
      ctx.scale(ratio, ratio);
      var width = rect.width, height = rect.height, left = 34, right = 12, top = 12, bottom = 23;
      var w = Math.max(1, width - left - right), h = Math.max(1, height - top - bottom);
      ctx.clearRect(0, 0, width, height);
      ctx.font = '10px Cascadia Mono, monospace';
      ctx.strokeStyle = 'rgba(194,164,145,.25)';
      ctx.fillStyle = '#aa9b91';
      var max = Math.max(1, ...rows.map(function (row) { return row.requests; }));
      for (var i = 0; i <= 3; i += 1) {
        var y = top + h * i / 3;
        ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke();
        ctx.fillText(compact(max * (3 - i) / 3), 0, y + 3);
      }
      if (!rows.length) {
        ctx.fillText('等待业务流量…', left + 12, top + 24);
        text('trend-range', '暂无时间线');
        return;
      }
      function point(index, value) {
        return { x: left + (rows.length === 1 ? w / 2 : index * w / (rows.length - 1)), y: top + h - value / max * h };
      }
      ctx.beginPath();
      rows.forEach(function (row, index) { var p = point(index, row.requests); index ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
      ctx.strokeStyle = '#e5a0c4'; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath();
      rows.forEach(function (row, index) { var p = point(index, row.errors); index ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
      ctx.strokeStyle = '#8dcbd0'; ctx.lineWidth = 1.5; ctx.stroke();
      var first = new Date(rows[0].bucketStartMs), last = new Date(rows[rows.length - 1].bucketStartMs);
      ctx.fillStyle = '#aa9b91';
      ctx.fillText(first.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), left, height - 5);
      var label = last.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      ctx.fillText(label, width - right - ctx.measureText(label).width, height - 5);
      text('trend-range', rows.length + ' 个时间片 · 峰值 ' + compact(max));
    }

    function renderRoutes(rows) {
      var list = document.getElementById('route-list');
      list.replaceChildren();
      if (!rows.length) { var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '等待业务流量'; list.appendChild(empty); return; }
      rows.forEach(function (route) {
        var card = document.createElement('article'); card.className = 'route-card';
        var top = document.createElement('div'); top.className = 'route-top';
        var name = document.createElement('span'); name.className = 'route-name'; name.textContent = route.route;
        var rate = document.createElement('span'); rate.className = 'route-rate'; rate.textContent = percent(route.availability);
        top.append(name, rate);
        var meta = document.createElement('div'); meta.className = 'route-meta';
        [['请求', compact(route.requests)], ['P95', duration(route.latencyP95Ms)], ['缓存', percent(route.cacheHitRate)]].forEach(function (item) {
          var box = document.createElement('div'); box.textContent = item[0]; var strong = document.createElement('strong'); strong.textContent = item[1]; box.appendChild(strong); meta.appendChild(box);
        });
        card.append(top, meta); list.appendChild(card);
      });
    }

    function renderUpstream(rows) {
      var list = document.getElementById('upstream-list');
      list.replaceChildren();
      if (!rows.length) { var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '等待上游调用'; list.appendChild(empty); return; }
      rows.forEach(function (upstream, index) {
        var row = document.createElement('div'); row.className = 'upstream-row' + (index === 0 ? ' primary' : '');
        var badge = document.createElement('div'); badge.className = 'upstream-badge'; badge.textContent = index === 0 ? '当前' : '链路';
        var main = document.createElement('div'); main.className = 'upstream-main';
        var name = document.createElement('strong'); name.textContent = upstream.host;
        var detail = document.createElement('span'); detail.textContent = '成功 ' + upstream.success + ' · 404 ' + upstream.notFound + ' · 失败 ' + upstream.failure;
        main.append(name, detail);
        var rate = document.createElement('div'); rate.className = 'upstream-rate'; rate.textContent = percent(upstream.availability);
        row.append(badge, main, rate); list.appendChild(row);
      });
    }

    function renderStatuses(rows) {
      var panel = document.getElementById('status-code-panel');
      panel.replaceChildren();
      if (!rows.length) return;
      var title = document.createElement('div'); title.className = 'eyebrow'; title.textContent = 'STATUS CODES'; panel.appendChild(title);
      var max = Math.max(1, ...rows.map(function (row) { return row.requests; }));
      rows.forEach(function (status) {
        var row = document.createElement('div'); row.className = 'code-row';
        var code = document.createElement('span'); code.className = 'mono'; code.textContent = status.status;
        var track = document.createElement('div'); track.className = 'code-track';
        var fill = document.createElement('div'); fill.className = 'code-fill'; fill.style.width = status.requests / max * 100 + '%'; fill.style.background = colors[status.status] || '#c7b9ae'; track.appendChild(fill);
        var count = document.createElement('span'); count.className = 'mono'; count.textContent = compact(status.requests);
        row.append(code, track, count); panel.appendChild(row);
      });
    }

    document.getElementById('logout').addEventListener('click', async function () {
      try {
        await fetch('/admin/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken } });
      } finally { location.replace('/admin/login'); }
    });
    windowSelect.addEventListener('change', load);
    window.addEventListener('resize', function () { if (snapshot) renderTrend(snapshot.trend); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
    load();
    timer = setInterval(load, 5000);
    window.addEventListener('pagehide', function () { clearInterval(timer); });
  }());`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
