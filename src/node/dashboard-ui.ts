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
      <label><span data-i18n="username">管理员账号</span>
        <input id="username" autocomplete="username" minlength="3" maxlength="64" required>
      </label>
      <label><span data-i18n="password">登录密码</span>
        <input id="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required>
      </label>
      <label><span data-i18n="confirm">再次确认</span>
        <input id="confirm" type="password" autocomplete="new-password" minlength="12" maxlength="256" required>
      </label>
      <label><span data-i18n="setupToken">一次性初始化令牌</span>
        <input id="setup-token" type="password" autocomplete="off" required>
      </label>
      <p class="field-note" data-i18n="passwordNote">密码至少 12 个字符。安全入口会从 URL 的 #fragment 读取令牌，它不会进入服务器访问日志。</p>
    `
    : `
      <label><span data-i18n="username">管理员账号</span>
        <input id="username" autocomplete="username" maxlength="64" required autofocus>
      </label>
      <label><span data-i18n="password">登录密码</span>
        <input id="password" type="password" autocomplete="current-password" maxlength="256" required>
      </label>
    `;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Yukine Gateway</title>
  <link rel="icon" type="image/png" href="/admin/assets/gateway-mascot.png">
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
    .auth-language { position: fixed; z-index: 3; top: 1rem; right: 1rem; display: grid; gap: .25rem; color: var(--muted); font-size: .62rem; }
    .auth-language select { border: 1px dashed var(--pink); border-radius: 1rem; color: var(--ink); background: rgba(255,253,248,.94); padding: .4rem .65rem; }
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
  <label class="auth-language" for="language"><span data-i18n="language">语言</span><select id="language">
    <option value="zh">中文</option><option value="en">English</option>
  </select></label>
  <main class="auth-wrap">
    <section class="intro">
      <a class="brand" href="/admin">Yukine Gateway Now</a>
      <div class="intro-copy">
        <div class="eyebrow">${setup ? "FIRST START" : "SIGN IN"}</div>
        <h1>metadata<span>gateway</span></h1>
        <p data-i18n="privacy">这里保留网关必要的状态，不保存标题、查询串、指纹、密钥或请求正文。</p>
      </div>
      <img id="auth-mascot" class="mascot" src="/admin/assets/gateway-mascot.png" alt="Yukine 网关守护角色">
    </section>
    <section class="auth-card">
      <div class="eyebrow">${setup ? "INITIAL SETUP" : "ADMIN PANEL"}</div>
      <h2 data-i18n="title">${escapeHtml(title)}</h2>
      <p data-i18n="description">${escapeHtml(description)}</p>
      <form id="auth-form">
        ${fields}
        <button class="button button-primary" type="submit" data-i18n="submit">${setup ? "创建管理员" : "进入面板"}</button>
        <div id="form-status" class="form-status" role="status" aria-live="polite"></div>
      </form>
      <div class="auth-foot"><span>TLS ONLY</span><span>SESSION 8H</span><span>CSRF SAFE</span></div>
    </section>
  </main>
  <script nonce="${escapeHtml(nonce)}">${authLanguageScript(mode)}${setup ? setupScript() : loginScript()}</script>
</body>
</html>`;
}

export function dashboardPage(nonce: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Yukine Gateway Observatory</title>
  <link rel="icon" type="image/png" href="/admin/assets/gateway-mascot.png">
  <style>${BASE_STYLE}
    .skip-link { position: fixed; left: 1rem; top: -5rem; z-index: 20; padding: .65rem 1rem; background: #fff; border: 2px solid var(--cyan); border-radius: .6rem; }
    .skip-link:focus { top: 1rem; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
    .page { width: min(1080px, calc(100% - 2rem)); margin: 0 auto; padding: 4.8rem 0 5rem; position: relative; }
    .page-head { display: grid; grid-template-columns: 1fr auto; gap: 1.5rem; align-items: start; border-top: 2px dashed var(--line); padding-top: .8rem; }
    .page-head p { margin: .45rem 0 0; color: var(--muted); font-size: .82rem; }
    .head-state { display: grid; justify-items: end; gap: .25rem; color: var(--muted); font-size: .7rem; }
    .connection { display: inline-flex; align-items: center; gap: .4rem; color: #5e9790; font-weight: 700; }
    .connection::before { content: ""; width: .48rem; height: .48rem; border-radius: 50%; background: var(--cyan); box-shadow: 0 0 0 .22rem rgba(141,203,208,.15); }
    .connection.offline { color: #bd6469; }
    .connection.offline::before { background: #d77f82; box-shadow: 0 0 0 .22rem rgba(215,127,130,.15); }
    .freshness { color: var(--pink); font: 700 .78rem/1.2 "Cascadia Mono", monospace; }
    .toolbar { display: flex; align-items: end; gap: .65rem; margin: 2.2rem 0 1rem; flex-wrap: wrap; }
    .toolbar-copy { flex: 1; min-width: 15rem; }
    .toolbar-copy p { margin: .4rem 0 0; color: var(--muted); font-size: .72rem; }
    .control { display: grid; gap: .28rem; }
    .control-label { color: var(--muted); font-size: .58rem; font-weight: 700; letter-spacing: .08em; }
    select { border: 1px dashed var(--pink); border-radius: 1.3rem; color: var(--ink); background: rgba(255,253,248,.9); padding: .58rem .85rem; }
    .refresh-button[disabled] { opacity: .55; cursor: wait; }
    .dashboard-tabs { display: flex; gap: .38rem; overflow-x: auto; padding: .45rem; border: 1px solid var(--line); border-radius: 1rem; background: rgba(255,253,248,.62); scrollbar-width: thin; }
    .dashboard-tab { flex: 1 0 auto; min-width: 7rem; border: 0; border-radius: .72rem; padding: .7rem 1rem; color: var(--muted); background: transparent; font-weight: 750; letter-spacing: .06em; }
    .dashboard-tab[aria-selected="true"] { color: #5f5650; background: #fffaf2; box-shadow: 0 .35rem .9rem rgba(170,107,137,.13), inset 0 0 0 1px var(--pink-soft); }
    .dashboard-panel { padding-top: 1.25rem; }
    .dashboard-panel[hidden] { display: none; }
    .section-title { display: flex; justify-content: space-between; align-items: end; gap: 1rem; margin: 1.5rem 0 .75rem; }
    .section-title h2 { margin: 0; font-size: .76rem; letter-spacing: .13em; text-transform: uppercase; }
    .section-title p { margin: .25rem 0 0; color: var(--muted); font-size: .65rem; }
    .hero-grid { display: grid; grid-template-columns: 1.15fr repeat(3, minmax(0, .72fr)); gap: .75rem; }
    .hero-card, .metric-card, .paper-panel { border: 1px solid var(--line); background: rgba(255,253,248,.84); box-shadow: 0 .8rem 1.8rem rgba(170,107,137,.08); }
    .hero-card { grid-row: span 2; border: 2px solid var(--pink); border-radius: 1rem; padding: 1.2rem; }
    .hero-card h1 { margin: .4rem 0 .25rem; font: 760 1.35rem/1.15 Georgia, "Noto Serif SC", serif; }
    .hero-card p { margin: 0; color: var(--muted); font-size: .7rem; line-height: 1.6; }
    .hero-status { display: flex; align-items: center; justify-content: space-between; gap: .8rem; margin-top: 1.25rem; }
    .hero-status strong { color: var(--pink); font-size: .8rem; }
    .state-pill { border-radius: 2rem; padding: .32rem .62rem; color: #4f8782; background: rgba(141,203,208,.18); font-size: .62rem; font-weight: 800; }
    .state-pill.warn { color: #9f5b36; background: rgba(222,183,110,.2); }
    .state-pill.bad { color: #aa4e58; background: rgba(215,127,130,.18); }
    .metric-card { border-radius: .82rem; padding: .9rem; min-height: 5.3rem; }
    .metric-card span { color: var(--muted); font-size: .58rem; letter-spacing: .08em; }
    .metric-card strong { display: block; margin-top: .5rem; color: #655d57; font: 720 1.18rem/1 "Cascadia Mono", monospace; }
    .metric-card em { display: block; margin-top: .42rem; color: var(--muted); font: normal .58rem/1.3 "Cascadia Mono", monospace; }
    .status-grid { display: grid; grid-template-columns: 1.3fr .7fr; gap: .8rem; }
    .paper-panel { border-radius: .9rem; padding: 1rem; }
    .status-lines { display: grid; gap: .45rem; }
    .status-line { display: grid; grid-template-columns: 7.5rem 1fr auto; gap: .7rem; align-items: center; padding: .55rem .7rem; border: 1px dashed var(--pink-soft); border-radius: .65rem; font-size: .7rem; }
    .status-line span { color: var(--muted); text-align: right; }
    .status-line strong { color: var(--pink); }
    .status-line em { color: var(--muted); font: normal .62rem/1 "Cascadia Mono", monospace; }
    .code-row { display: grid; grid-template-columns: 3rem 1fr auto; gap: .65rem; align-items: center; margin: .55rem 0; font-size: .64rem; }
    .code-track { height: .45rem; border-radius: 1rem; background: rgba(222,201,184,.3); overflow: hidden; }
    .code-fill { height: 100%; border-radius: inherit; }
    .chart-controls { display: flex; justify-content: space-between; gap: .8rem; align-items: end; flex-wrap: wrap; }
    .chart-shell { min-height: 18rem; margin-top: .8rem; border-top: 1px dashed var(--line); padding-top: .8rem; overflow: hidden; }
    .trend-svg { display: block; width: 100%; min-height: 17rem; }
    .chart-legend { display: flex; flex-wrap: wrap; gap: .75rem; color: var(--muted); font-size: .62rem; }
    .legend-item { display: inline-flex; align-items: center; gap: .35rem; }
    .legend-swatch { width: .7rem; height: .22rem; border-radius: 1rem; }
    .route-table-wrap, .instance-table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: .8rem; background: rgba(255,253,248,.78); }
    .data-table { width: 100%; border-collapse: collapse; min-width: 760px; font-size: .67rem; }
    .data-table th { padding: .7rem .75rem; color: var(--muted); text-align: left; letter-spacing: .07em; border-bottom: 1px dashed var(--line); }
    .data-table td { padding: .72rem .75rem; border-bottom: 1px solid rgba(222,201,184,.45); }
    .data-table tbody tr:last-child td { border-bottom: 0; }
    .data-table .number { text-align: right; font-family: "Cascadia Mono", monospace; }
    .route-path { color: #625b56; font-family: "Cascadia Mono", monospace; font-weight: 700; }
    .provider-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; }
    .provider-card { border: 1px solid var(--line); border-left: 4px solid var(--cyan); border-radius: .85rem; padding: 1rem; background: rgba(255,253,248,.83); }
    .provider-card.open { border-left-color: #d77f82; background: rgba(255,244,241,.86); }
    .provider-card.half_open { border-left-color: var(--amber); }
    .provider-head { display: flex; justify-content: space-between; align-items: start; gap: .8rem; }
    .provider-name { font: 750 .82rem/1.2 "Cascadia Mono", monospace; }
    .provider-hosts { margin-top: .28rem; color: var(--muted); font-size: .58rem; }
    .provider-metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: .5rem; margin-top: .85rem; }
    .provider-metrics span { color: var(--muted); font-size: .54rem; }
    .provider-metrics strong { display: block; margin-top: .22rem; font: 680 .7rem/1 "Cascadia Mono", monospace; }
    .provider-detail { margin-top: .75rem; padding-top: .65rem; border-top: 1px dashed var(--line); color: var(--muted); font: .58rem/1.65 "Cascadia Mono", monospace; word-break: break-word; }
    .cache-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: .75rem; }
    .cache-card { padding: 1rem; border: 1px solid var(--line); border-radius: .8rem; background: rgba(255,253,248,.78); }
    .cache-card strong { display: block; margin-top: .4rem; color: var(--pink); font: 700 1.15rem/1 "Cascadia Mono", monospace; }
    .cache-card span { color: var(--muted); font-size: .62rem; }
    .instance-list { display: grid; gap: .75rem; }
    .instance-card { border: 1px solid var(--line); border-radius: .9rem; padding: 1rem; background: rgba(255,253,248,.83); }
    .instance-card.offline { border-color: rgba(215,127,130,.7); opacity: .82; }
    .instance-head { display: flex; justify-content: space-between; gap: 1rem; align-items: start; }
    .instance-id { font: 740 .78rem/1.2 "Cascadia Mono", monospace; word-break: break-all; }
    .instance-meta { margin-top: .3rem; color: var(--muted); font-size: .6rem; }
    .instance-metrics { display: grid; grid-template-columns: repeat(5, 1fr); gap: .65rem; margin-top: .85rem; }
    .instance-metrics span { color: var(--muted); font-size: .55rem; }
    .instance-metrics strong { display: block; margin-top: .2rem; font: 650 .68rem/1.2 "Cascadia Mono", monospace; }
    .methodology { margin-top: 1.3rem; padding-top: .8rem; border-top: 2px dashed var(--line); color: var(--muted); font-size: .64rem; line-height: 1.7; }
    .empty { padding: 1.4rem; color: var(--muted); text-align: center; font-size: .7rem; }
    .mascot { position: fixed; z-index: 1; width: 6.5rem; right: 3vw; top: 39vh; filter: drop-shadow(0 1rem 1.1rem rgba(171,116,142,.12)); pointer-events: none; }
    @media (max-width: 1320px) { .mascot { display: none; } }
    @media (max-width: 820px) {
      .page { padding-top: 1.4rem; }
      .page-head { grid-template-columns: 1fr; }
      .head-state { justify-items: start; }
      .toolbar-copy { flex-basis: 100%; }
      .hero-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .hero-card { grid-column: 1 / -1; grid-row: auto; }
      .status-grid, .provider-grid { grid-template-columns: 1fr; }
      .instance-metrics { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 520px) {
      .page { width: min(100% - 1rem, 1080px); }
      .toolbar { align-items: stretch; }
      .control, .control select, .refresh-button { flex: 1; }
      .hero-grid, .cache-grid { grid-template-columns: 1fr; }
      .status-line { grid-template-columns: 1fr; gap: .25rem; }
      .status-line span { text-align: left; }
      .provider-metrics { grid-template-columns: repeat(2, 1fr); }
      .dashboard-tab { min-width: 6.4rem; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#dashboard-content" data-i18n="skip">跳到监控内容</a>
  <img class="mascot" src="/admin/assets/gateway-mascot.png" alt="">
  <main class="page">
    <header class="page-head">
      <div>
        <a class="brand" href="/admin">Yukine Gateway Observatory</a>
        <p data-i18n="tagline">(´• ω •´) 请求流、缓存与来源状态都汇聚在这里。</p>
      </div>
      <div class="head-state">
        <span id="connection-state" class="connection" role="status" aria-live="polite">正在连接</span>
        <span id="freshness" class="freshness">尚未刷新</span>
      </div>
    </header>

    <section class="toolbar">
      <div class="toolbar-copy"><div class="eyebrow">LIVE CONTROL</div><p data-i18n="privacy">所有数字来自认证后的分钟聚合，不含查询内容与密钥。</p></div>
      <label class="control" for="language"><span class="control-label" data-i18n="language">语言</span><select id="language">
          <option value="zh">中文</option><option value="en">English</option>
      </select></label>
      <label class="control" for="window"><span class="control-label" data-i18n="window">时间窗口</span><select id="window">
          <option value="15m" data-i18n="window15m">最近 15 分钟</option>
          <option value="1h" selected data-i18n="window1h">最近 1 小时</option>
          <option value="24h" data-i18n="window24h">最近 24 小时</option>
      </select></label>
      <button id="refresh" class="button refresh-button" type="button" data-i18n="refresh">立即刷新</button>
      <button id="logout" class="button" type="button" data-i18n="logout">退出</button>
    </section>

    <nav class="dashboard-tabs" role="tablist" aria-label="管理面板视图">
      <button class="dashboard-tab" id="tab-overview" role="tab" aria-selected="true" aria-controls="panel-overview" data-tab="overview" data-i18n="overview">概览</button>
      <button class="dashboard-tab" id="tab-performance" role="tab" aria-selected="false" aria-controls="panel-performance" data-tab="performance" data-i18n="performance" tabindex="-1">性能</button>
      <button class="dashboard-tab" id="tab-providers" role="tab" aria-selected="false" aria-controls="panel-providers" data-tab="providers" data-i18n="providers" tabindex="-1">来源</button>
      <button class="dashboard-tab" id="tab-runtime" role="tab" aria-selected="false" aria-controls="panel-runtime" data-tab="runtime" data-i18n="runtime" tabindex="-1">运行时</button>
    </nav>

    <div id="dashboard-content">
      <section id="panel-overview" class="dashboard-panel" role="tabpanel" aria-labelledby="tab-overview">
        <div class="hero-grid">
          <article class="hero-card">
            <div class="eyebrow">GATEWAY PULSE</div>
            <h1 data-i18n="gatewayNow">元数据网关现在…</h1>
            <p id="overview-copy" data-i18n="readingSignal">正在读取第一束运行信号。</p>
            <div class="hero-status"><strong id="overview-status">等待</strong><span id="overview-ready" class="state-pill">检查中</span></div>
          </article>
          <article class="metric-card"><span>REQUESTS</span><strong id="overview-requests">—</strong><em id="overview-rps">— req/s</em></article>
          <article class="metric-card"><span>AVAILABILITY</span><strong id="overview-availability">—</strong><em id="overview-errors">5xx — · 4xx —</em></article>
          <article class="metric-card"><span>P95 LATENCY</span><strong id="overview-p95">—</strong><em id="overview-p99">P99 —</em></article>
          <article class="metric-card"><span>CACHE HIT</span><strong id="overview-cache">—</strong><em id="overview-cache-detail">fresh — · stale —</em></article>
          <article class="metric-card"><span>UPSTREAM</span><strong id="overview-upstream">—</strong><em id="overview-fanout">fan-out —</em></article>
          <article class="metric-card"><span>UPTIME</span><strong id="overview-uptime">—</strong><em id="overview-instances">— instances</em></article>
        </div>
        <div class="section-title"><div><h2>Signal summary</h2><p data-i18n="signalSummary">请求状态、延迟和缓存的快速诊断。</p></div></div>
        <div class="status-grid">
          <section class="paper-panel status-lines" aria-label="核心状态">
            <div class="status-line"><span data-i18n="requestLatency">请求延迟</span><strong id="strip-latency">—</strong><em id="strip-latency-detail">P50 — · P99 — · MAX —</em></div>
            <div class="status-line"><span data-i18n="cacheFreshness">缓存新鲜度</span><strong id="strip-cache">—</strong><em id="strip-cache-detail">fresh — · stale — · miss —</em></div>
            <div class="status-line"><span data-i18n="upstreamAttempts">上游尝试</span><strong id="strip-upstream-attempts">—</strong><em id="strip-upstream-detail">fan-out —</em></div>
          </section>
          <section class="paper-panel" aria-labelledby="status-heading"><div id="status-heading" class="eyebrow">STATUS CODES</div><div id="status-code-panel"><div class="empty" data-i18n="waitingTraffic">等待业务流量</div></div></section>
        </div>
        <div class="section-title"><div><h2>Upstream hosts</h2><p data-i18n="upstreamHostsHelp">保留旧主机维度，方便核对链路。</p></div></div>
        <div id="upstream-list" class="provider-grid"><div class="empty" data-i18n="waitingUpstream">等待上游调用</div></div>
      </section>

      <section id="panel-performance" class="dashboard-panel" role="tabpanel" aria-labelledby="tab-performance" hidden>
        <div class="section-title">
          <div><h2>Performance timeline</h2><p id="trend-range" data-i18n="waitingTraffic">等待业务流量</p></div>
          <label class="control" for="chart-metric"><span class="control-label" data-i18n="chartMetric">图表指标</span><select id="chart-metric">
            <option value="requests" data-i18n="chartRequests">请求 / RPS</option>
            <option value="latency" data-i18n="chartLatency">P50 / P95 / P99 延迟</option>
            <option value="cache">fresh / stale / miss</option>
          </select></label>
        </div>
        <section class="paper-panel">
          <div id="chart-legend" class="chart-legend" aria-hidden="true"></div>
          <div class="chart-shell">
            <svg id="trend-chart" class="trend-svg" role="img" viewBox="0 0 960 280" aria-labelledby="trend-title trend-desc">
              <title id="trend-title">网关性能趋势</title>
              <desc id="trend-desc">等待业务流量。</desc>
              <g id="trend-plot"></g>
            </svg>
          </div>
          <table id="trend-data-table" class="sr-only"><caption data-i18n="chartData">趋势图数据</caption><thead></thead><tbody></tbody></table>
        </section>
        <div class="section-title">
          <div><h2>Routes</h2><p data-i18n="routesHelp">按业务路由比较容量、错误和延迟。</p></div>
          <label class="control" for="route-sort"><span class="control-label" data-i18n="sort">排序方式</span><select id="route-sort">
            <option value="requests" data-i18n="requests">请求量</option>
            <option value="errorRate" data-i18n="errorRate">5xx 错误率</option>
            <option value="latencyP95Ms" data-i18n="p95Latency">P95 延迟</option>
            <option value="cacheHitRate" data-i18n="cacheHitRate">缓存命中率</option>
            <option value="fanOut">fan-out</option>
          </select></label>
        </div>
        <div class="route-table-wrap"><table class="data-table"><thead><tr><th data-i18n="route">路由</th><th class="number" data-i18n="requestCount">请求</th><th class="number" data-i18n="availability">可用率</th><th class="number">5xx</th><th class="number">P95</th><th class="number" data-i18n="cache">缓存</th><th class="number">FAN-OUT</th></tr></thead><tbody id="route-table-body"></tbody></table></div>
      </section>

      <section id="panel-providers" class="dashboard-panel" role="tabpanel" aria-labelledby="tab-providers" hidden>
        <div class="section-title"><div><h2>Provider health</h2><p data-i18n="providerHelp">低基数来源指标、熔断状态与并发压力。</p></div></div>
        <div id="provider-list" class="provider-grid"><div class="empty" data-i18n="providerWaiting">等待 Provider 状态</div></div>
        <div class="section-title"><div><h2>Cache behavior</h2><p data-i18n="cacheHelp">按上游尝试统计缓存状态和层级。</p></div></div>
        <div id="cache-grid" class="cache-grid"><div class="empty" data-i18n="oldCacheUnknown">新维度尚无历史</div></div>
      </section>

      <section id="panel-runtime" class="dashboard-panel" role="tabpanel" aria-labelledby="tab-runtime" hidden>
        <div class="section-title"><div><h2>Instances</h2><p data-i18n="instancesHelp">15 秒心跳；超过 45 秒未更新会标记为离线。</p></div></div>
        <div id="instance-list" class="instance-list"><div class="empty" data-i18n="instanceWaiting">等待实例心跳</div></div>
      </section>
    </div>

    <p id="methodology" class="methodology">正在载入指标口径。</p>
  </main>
  <script nonce="${escapeHtml(nonce)}">${dashboardScript()}</script>
</body>
</html>`;
}

function authLanguageScript(mode: "setup" | "login"): string {
  const setup = mode === "setup";
  const messages = {
    zh: {
      language: "语言",
      privacy: "这里保留网关必要的状态，不保存标题、查询串、指纹、密钥或请求正文。",
      title: setup ? "第一次见面，请先创建管理员" : "欢迎回来",
      description: setup
        ? "账号创建成功后，匿名初始化入口会立刻关闭。"
        : "登录后查看网关的实时状态、缓存和上游链路。",
      username: "管理员账号",
      password: "登录密码",
      confirm: "再次确认",
      setupToken: "一次性初始化令牌",
      passwordNote: "密码至少 12 个字符。安全入口会从 URL 的 #fragment 读取令牌，它不会进入服务器访问日志。",
      submit: setup ? "创建管理员" : "进入面板",
      creating: "正在创建管理员…",
      mismatch: "两次输入的密码不一致。",
      rateLimited: "尝试过于频繁，请稍后再试。",
      invalidSetup: "账号格式、密码长度或初始化令牌不正确。",
      created: "管理员已创建，初始化入口已经关闭。正在前往登录页…",
      unavailable: "暂时无法连接网关，请稍后重试。",
      signingIn: "正在确认身份…",
      badLogin: "账号或密码不正确。"
    },
    en: {
      language: "Language",
      privacy: "This console keeps only essential gateway state. It never stores titles, query strings, fingerprints, keys, or request bodies.",
      title: setup ? "Create the first administrator" : "Welcome back",
      description: setup
        ? "The anonymous setup entry closes immediately after the account is created."
        : "Sign in to inspect live gateway, cache, and upstream health.",
      username: "Administrator username",
      password: "Password",
      confirm: "Confirm password",
      setupToken: "One-time setup token",
      passwordNote: "Use at least 12 characters. The secure entry reads the token from the URL fragment, which never reaches server access logs.",
      submit: setup ? "Create administrator" : "Open dashboard",
      creating: "Creating administrator…",
      mismatch: "The two passwords do not match.",
      rateLimited: "Too many attempts. Please try again later.",
      invalidSetup: "Check the username, password length, and setup token.",
      created: "Administrator created and setup closed. Redirecting to sign in…",
      unavailable: "The gateway is temporarily unavailable. Please try again.",
      signingIn: "Verifying your identity…",
      badLogin: "The username or password is incorrect."
    }
  };
  return `
  (function () {
    var messages = ${JSON.stringify(messages)};
    var language = 'zh';
    try {
      language = localStorage.getItem('yukine-admin-language')
        || (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en');
    } catch (_) {}
    if (!messages[language]) language = 'zh';
    function apply(next) {
      language = messages[next] ? next : 'zh';
      document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
      document.querySelectorAll('[data-i18n]').forEach(function (element) {
        var value = messages[language][element.dataset.i18n];
        if (value) element.textContent = value;
      });
      document.getElementById('language').value = language;
      document.getElementById('auth-mascot').alt = language === 'zh'
        ? 'Yukine 网关守护角色'
        : 'Yukine gateway guardian';
      document.title = messages[language].title + ' · Yukine Gateway';
      try { localStorage.setItem('yukine-admin-language', language); } catch (_) {}
    }
    window.yukineT = function (key) { return messages[language][key] || key; };
    document.getElementById('language').addEventListener('change', function (event) {
      apply(event.target.value);
    });
    apply(language);
  }());`;
}

function setupScript(): string {
  return `
  (function () {
    'use strict';
    var form = document.getElementById('auth-form');
    var status = document.getElementById('form-status');
    var tokenInput = document.getElementById('setup-token');
    var t = window.yukineT;
    if (location.hash.length > 1) {
      try { tokenInput.value = decodeURIComponent(location.hash.slice(1)); } catch (_) {}
      history.replaceState(null, '', location.pathname);
    }
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      status.className = 'form-status';
      status.textContent = t('creating');
      var password = document.getElementById('password').value;
      if (password !== document.getElementById('confirm').value) {
        status.textContent = t('mismatch');
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
            ? t('rateLimited')
            : t('invalidSetup');
          return;
        }
        form.reset();
        status.className = 'form-status success';
        status.textContent = t('created');
        setTimeout(function () { location.replace('/admin/login'); }, 900);
      } catch (_) {
        status.textContent = t('unavailable');
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
    var t = window.yukineT;
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      status.className = 'form-status';
      status.textContent = t('signingIn');
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
            ? t('rateLimited')
            : t('badLogin');
          return;
        }
        location.replace('/admin');
      } catch (_) {
        status.textContent = t('unavailable');
      }
    });
  }());`;
}

const DASHBOARD_MESSAGES = {
  zh: {
    skip: "跳到监控内容",
    tagline: "(´• ω •´) 请求流、缓存与来源状态都汇聚在这里。",
    connecting: "正在连接",
    notRefreshed: "尚未刷新",
    privacy: "所有数字来自认证后的分钟聚合，不含查询内容与密钥。",
    language: "语言",
    window: "时间窗口",
    window15m: "最近 15 分钟",
    window1h: "最近 1 小时",
    window24h: "最近 24 小时",
    refresh: "立即刷新",
    logout: "退出",
    overview: "概览",
    performance: "性能",
    providers: "来源",
    runtime: "运行时",
    gatewayNow: "元数据网关现在…",
    readingSignal: "正在读取第一束运行信号。",
    signalSummary: "请求状态、延迟和缓存的快速诊断。",
    requestLatency: "请求延迟",
    cacheFreshness: "缓存新鲜度",
    upstreamAttempts: "上游尝试",
    upstreamHostsHelp: "保留旧主机维度，方便核对链路。",
    waitingTraffic: "等待业务流量",
    chartMetric: "图表指标",
    chartRequests: "请求 / RPS",
    chartLatency: "P50 / P95 / P99 延迟",
    routesHelp: "按业务路由比较容量、错误和延迟。",
    sort: "排序方式",
    requests: "请求量",
    errorRate: "5xx 错误率",
    p95Latency: "P95 延迟",
    cacheHitRate: "缓存命中率",
    route: "路由",
    requestCount: "请求",
    availability: "可用率",
    cache: "缓存",
    providerHelp: "低基数来源指标、熔断状态与并发压力。",
    cacheHelp: "按上游尝试统计缓存状态和层级。",
    instancesHelp: "15 秒心跳；超过 45 秒未更新会标记为离线。",
    manualRefreshing: "正在手动刷新",
    refreshing: "正在刷新",
    connected: "已连接 · 5 秒刷新",
    updatedAt: "更新于",
    retained: "保留上次成功数据",
    noData: "尚无可用数据",
    disconnected: "连接中断 · 正在重试",
    unknown: "未知",
    none: "无",
    offline: "离线",
    needsAttention: "需要关注",
    stable: "运行平稳",
    errorsRising: "错误上升",
    instanceNotReady: "部分运行实例未就绪，请先查看运行时页。",
    flowing: "业务流量、来源和缓存信号正在稳定流动。",
    elevated5xx: "网关仍在响应，但 5xx 比例已超过健康阈值。",
    waitingReady: "网关已就绪，正在安静等待业务请求。",
    noReady: "尚未发现已就绪的在线实例。",
    oldHistoryUnknown: "旧历史未记录缓存新鲜度",
    waitingUpstream: "等待上游调用",
    latencyTrend: "延迟分位数趋势",
    cacheTrend: "缓存新鲜度趋势",
    requestTrend: "请求与 RPS 趋势",
    noTrend: "等待当前窗口的指标数据",
    noTimeline: "暂无时间线",
    noTrendDescription: "当前窗口没有可用的趋势数据。",
    chartData: "趋势图数据",
    slices: "个时间片 · 峰值",
    accessibleChart: "，详细数据可由读屏表格访问。",
    chartRows: " 个时间片。",
    time: "时间",
    attempts: "尝试",
    success: "成功",
    failure: "失败",
    noHost: "尚无主机记录",
    result: "结果",
    layer: "层级",
    recentFailure: "最近失败",
    openedAt: "熔断于",
    historicalDimensionUnknown: "历史维度未知",
    providerWaiting: "等待 Provider 状态",
    instanceWaiting: "等待实例心跳",
    oldCacheUnknown: "旧历史未记录缓存层与新鲜度；新请求到达后会自动出现。",
    sharedCacheUnknown: "共享缓存已连接，数量未知",
    notConnected: "未连接",
    heartbeat: "心跳",
    signingOut: "正在退出",
    methodology: "仅统计 Node 运行时的 /v1/* 与 /v2/* 业务请求；健康探针和面板流量已排除。可用率为 1 − 5xx 请求数 ÷ 总请求数。缓存命中率只使用已知 fresh/stale/miss 样本；旧历史显示未知。实例每 15 秒写入心跳，超过 45 秒未更新即标记为离线。"
  },
  en: {
    skip: "Skip to monitoring content",
    tagline: "(´• ω •´) Request, cache, and provider signals meet here.",
    connecting: "Connecting",
    notRefreshed: "Not refreshed yet",
    privacy: "All values come from authenticated minute aggregates. Query content and keys are excluded.",
    language: "Language",
    window: "Time window",
    window15m: "Last 15 minutes",
    window1h: "Last hour",
    window24h: "Last 24 hours",
    refresh: "Refresh now",
    logout: "Sign out",
    overview: "Overview",
    performance: "Performance",
    providers: "Providers",
    runtime: "Runtime",
    gatewayNow: "The metadata gateway is…",
    readingSignal: "Reading the first runtime signal.",
    signalSummary: "A quick diagnosis of requests, latency, and cache behavior.",
    requestLatency: "Request latency",
    cacheFreshness: "Cache freshness",
    upstreamAttempts: "Upstream attempts",
    upstreamHostsHelp: "The legacy host dimension remains available for link verification.",
    waitingTraffic: "Waiting for business traffic",
    chartMetric: "Chart metric",
    chartRequests: "Requests / RPS",
    chartLatency: "P50 / P95 / P99 latency",
    routesHelp: "Compare volume, errors, and latency by business route.",
    sort: "Sort by",
    requests: "Request volume",
    errorRate: "5xx error rate",
    p95Latency: "P95 latency",
    cacheHitRate: "Cache hit rate",
    route: "Route",
    requestCount: "Requests",
    availability: "Availability",
    cache: "Cache",
    providerHelp: "Low-cardinality provider metrics, breaker state, and concurrency pressure.",
    cacheHelp: "Cache freshness and layer distribution by upstream attempt.",
    instancesHelp: "Heartbeats arrive every 15 seconds; instances are offline after 45 seconds.",
    manualRefreshing: "Refreshing manually",
    refreshing: "Refreshing",
    connected: "Connected · refreshes every 5s",
    updatedAt: "Updated",
    retained: "Showing last successful data",
    noData: "No data available yet",
    disconnected: "Disconnected · retrying",
    unknown: "unknown",
    none: "none",
    offline: "OFFLINE",
    needsAttention: "Needs attention",
    stable: "Running smoothly",
    errorsRising: "Errors rising",
    instanceNotReady: "One or more runtime instances are not ready. Check the Runtime tab.",
    flowing: "Traffic, provider, and cache signals are flowing normally.",
    elevated5xx: "The gateway is responding, but the 5xx rate is above the healthy threshold.",
    waitingReady: "The gateway is ready and waiting for business traffic.",
    noReady: "No ready online instance has been observed.",
    oldHistoryUnknown: "Historical cache freshness is unknown",
    waitingUpstream: "Waiting for upstream calls",
    latencyTrend: "Latency percentile trend",
    cacheTrend: "Cache freshness trend",
    requestTrend: "Requests and RPS trend",
    noTrend: "Waiting for metrics in this window",
    noTimeline: "No timeline yet",
    noTrendDescription: "No trend data is available for the current window.",
    chartData: "Chart data",
    slices: "time slices · peak",
    accessibleChart: ". A screen-reader table contains the detailed data.",
    chartRows: " time slices.",
    time: "Time",
    attempts: "Attempts",
    success: "Success",
    failure: "Failures",
    noHost: "No host recorded yet",
    result: "Outcomes",
    layer: "Layers",
    recentFailure: "Recent failures",
    openedAt: "Opened",
    historicalDimensionUnknown: "Historical dimension unknown",
    providerWaiting: "Waiting for provider health",
    instanceWaiting: "Waiting for instance heartbeats",
    oldCacheUnknown: "Historical cache layer and freshness are unknown. New requests will populate them.",
    sharedCacheUnknown: "Shared cache connected; entry count unknown",
    notConnected: "Not connected",
    heartbeat: "Heartbeat",
    signingOut: "Signing out",
    methodology: "Only Node /v1/* and /v2/* business requests are counted; health and dashboard traffic are excluded. Availability is 1 − 5xx requests ÷ all requests. Cache rates use only known fresh/stale/miss samples; older history stays unknown. Instances heartbeat every 15 seconds and become offline after 45 seconds."
  }
} as const;

function dashboardScript(): string {
  return `
  (function () {
    'use strict';
    var snapshot = null;
    var csrfToken = '';
    var timer = null;
    var activeRequest = null;
    var colors = { 200: '#8dcbd0', 400: '#deb76e', 404: '#c7b9ae', 405: '#a7c9cf', 429: '#d9a26d', 502: '#d77f82' };
    var windowSelect = document.getElementById('window');
    var refreshButton = document.getElementById('refresh');
    var chartMetric = document.getElementById('chart-metric');
    var routeSort = document.getElementById('route-sort');
    var languageSelect = document.getElementById('language');
    var svgNamespace = 'http://www.w3.org/2000/svg';
    var connectionStatus = 'connecting';
    var connectionOffline = false;
    var freshnessStatus = 'notRefreshed';
    var freshnessAt = null;
    var messages = ${JSON.stringify(DASHBOARD_MESSAGES)};
    var language = 'zh';
    try {
      language = localStorage.getItem('yukine-admin-language')
        || (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en');
    } catch (_) {}
    if (!messages[language]) language = 'zh';

    function t(key) { return messages[language][key] || key; }
    function locale() { return language === 'zh' ? 'zh-CN' : 'en-US'; }
    function applyLanguage(next) {
      language = messages[next] ? next : 'zh';
      document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
      document.querySelectorAll('[data-i18n]').forEach(function (element) {
        var value = t(element.dataset.i18n);
        if (value) element.textContent = value;
      });
      languageSelect.value = language;
      document.querySelector('[role="tablist"]').setAttribute(
        'aria-label',
        language === 'zh' ? '管理面板视图' : 'Dashboard views'
      );
      document.title = language === 'zh'
        ? 'Yukine Gateway Observatory'
        : 'Yukine Gateway Observatory';
      try { localStorage.setItem('yukine-admin-language', language); } catch (_) {}
      setConnection(connectionStatus, connectionOffline);
      setFreshness(freshnessStatus, freshnessAt);
      if (snapshot) render(snapshot);
    }

    function compact(value) {
      if (value == null || !isFinite(value)) return '—';
      return new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(value);
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
    function text(id, value) {
      var element = document.getElementById(id);
      if (element) element.textContent = value;
    }
    function number(value, digits) {
      return value == null || !isFinite(value) ? '—' : Number(value).toFixed(digits);
    }
    function time(value) {
      if (value == null) return t('unknown');
      return new Date(value).toLocaleString(locale(), {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      });
    }
    function entries(record) {
      return Object.keys(record || {}).sort().map(function (key) {
        return key + ' ' + compact(record[key]);
      }).join(' · ') || t('none');
    }
    function setConnection(status, offline) {
      connectionStatus = status;
      connectionOffline = Boolean(offline);
      var element = document.getElementById('connection-state');
      element.textContent = t(status);
      element.classList.toggle('offline', connectionOffline);
    }
    function setFreshness(status, value) {
      freshnessStatus = status;
      freshnessAt = value || null;
      if (status === 'updatedAt' && freshnessAt) {
        text('freshness', t(status) + ' ' + new Date(freshnessAt).toLocaleTimeString(locale(), {
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        }));
      } else {
        text('freshness', t(status));
      }
    }
    function setReadyPill(element, ready, online) {
      element.className = 'state-pill' + (!online ? ' bad' : ready ? '' : ' warn');
      element.textContent = !online ? t('offline') : ready ? 'READY' : 'NOT READY';
    }
    function empty(container, label) {
      var node = document.createElement('div');
      node.className = 'empty';
      node.textContent = label;
      container.appendChild(node);
    }

    async function load(manual) {
      if (activeRequest) activeRequest.abort();
      var request = new AbortController();
      activeRequest = request;
      refreshButton.disabled = true;
      setConnection(manual ? 'manualRefreshing' : 'refreshing', false);
      try {
        var response = await fetch('/admin/api/snapshot?window=' + encodeURIComponent(windowSelect.value), {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: request.signal
        });
        if (response.status === 401) { location.replace('/admin/login'); return; }
        if (!response.ok) throw new Error('snapshot');
        snapshot = await response.json();
        csrfToken = snapshot.csrfToken || '';
        render(snapshot);
        setFreshness('updatedAt', snapshot.generatedAt);
        setConnection('connected', false);
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        setFreshness(snapshot ? 'retained' : 'noData', null);
        setConnection('disconnected', true);
      } finally {
        if (activeRequest === request) {
          activeRequest = null;
          refreshButton.disabled = false;
        }
      }
    }

    function render(data) {
      var summary = data.summary;
      var instances = data.instances || [];
      var onlineInstances = instances.filter(function (instance) { return instance.online; });
      var readyInstances = onlineInstances.filter(function (instance) { return instance.ready; });
      var healthy = summary.availability == null || summary.availability >= .99;
      var ready = onlineInstances.length > 0 && readyInstances.length === onlineInstances.length;
      var current = onlineInstances[0] || instances[0] || null;
      text('overview-requests', compact(summary.requests));
      text('overview-rps', number(summary.rps, 2) + ' req/s');
      text('overview-availability', percent(summary.availability));
      text('overview-errors', '5xx ' + percent(summary.errorRate) + ' · 4xx ' + percent(summary.clientErrorRate));
      text('overview-p95', duration(summary.latencyP95Ms));
      text('overview-p99', 'P99 ' + duration(summary.latencyP99Ms));
      text('overview-cache', percent(data.cache && data.cache.metricsKnown ? data.cache.freshRate + data.cache.staleRate : summary.cacheHitRate));
      text('overview-cache-detail', data.cache && data.cache.metricsKnown
        ? 'fresh ' + percent(data.cache.freshRate) + ' · stale ' + percent(data.cache.staleRate)
        : t('historicalDimensionUnknown'));
      text('overview-upstream', percent(summary.upstreamAvailability));
      text('overview-fanout', 'fan-out ' + number(summary.fanOut, 2));
      text('overview-uptime', current ? uptime(current.uptimeSeconds) : uptime(data.runtime.uptimeSeconds));
      text('overview-instances', readyInstances.length + ' ready / ' + instances.length + ' total');
      text('overview-status', !ready ? t('needsAttention') : healthy ? t('stable') : t('errorsRising'));
      text('overview-copy', summary.requests
        ? (!ready ? t('instanceNotReady')
          : healthy ? t('flowing')
            : t('elevated5xx'))
        : (ready ? t('waitingReady') : t('noReady')));
      var overviewReady = document.getElementById('overview-ready');
      setReadyPill(overviewReady, ready, onlineInstances.length > 0);
      text('strip-latency', 'P95 ' + duration(summary.latencyP95Ms));
      text('strip-latency-detail', 'P50 ' + duration(summary.latencyP50Ms) + ' · P99 ' + duration(summary.latencyP99Ms) + ' · MAX ' + duration(summary.latencyMaxMs));
      text('strip-cache', data.cache && data.cache.metricsKnown ? percent(data.cache.freshRate + data.cache.staleRate) : 'unknown');
      text('strip-cache-detail', data.cache && data.cache.metricsKnown
        ? 'fresh ' + compact(data.cache.states.fresh || 0) + ' · stale ' + compact(data.cache.states.stale || 0) + ' · miss ' + compact(data.cache.states.miss || 0)
        : t('oldHistoryUnknown'));
      text('strip-upstream-attempts', compact(summary.upstreamAttempts));
      text('strip-upstream-detail', 'fan-out ' + number(summary.fanOut, 2) + ' · ' + t('availability') + ' ' + percent(summary.upstreamAvailability));
      text('methodology', t('methodology'));
      renderRoutes(data.routes);
      renderUpstream(data.upstream);
      renderStatuses(data.statuses);
      renderProviders(data.providers || []);
      renderCache(data.cache);
      renderInstances(instances);
      renderTrend(data);
    }

    function renderTrend(data) {
      var mode = chartMetric.value;
      var rows = mode === 'cache'
        ? ((data.cache && data.cache.trend) || [])
        : ((data.performance && data.performance.trend) || []);
      var plot = document.getElementById('trend-plot');
      var legend = document.getElementById('chart-legend');
      var title = document.getElementById('trend-title');
      var description = document.getElementById('trend-desc');
      var table = document.getElementById('trend-data-table');
      plot.replaceChildren();
      legend.replaceChildren();
      table.tHead.replaceChildren();
      table.tBodies[0].replaceChildren();
      var series;
      if (mode === 'latency') {
        title.textContent = t('latencyTrend');
        series = [
          { key: 'latencyP50Ms', label: 'P50', color: '#8dcbd0' },
          { key: 'latencyP95Ms', label: 'P95', color: '#e5a0c4' },
          { key: 'latencyP99Ms', label: 'P99', color: '#d77f82' }
        ];
      } else if (mode === 'cache') {
        title.textContent = t('cacheTrend');
        rows = rows.map(function (row) {
          var total = row.fresh + row.stale + row.miss;
          return {
            bucketStartMs: row.bucketStartMs,
            fresh: total ? row.fresh / total : null,
            stale: total ? row.stale / total : null,
            miss: total ? row.miss / total : null
          };
        });
        series = [
          { key: 'fresh', label: 'fresh', color: '#8dcbd0' },
          { key: 'stale', label: 'stale', color: '#deb76e' },
          { key: 'miss', label: 'miss', color: '#d77f82' }
        ];
      } else {
        title.textContent = t('requestTrend');
        series = [
          { key: 'requests', label: t('requestCount'), color: '#e5a0c4' },
          { key: 'rps', label: 'RPS', color: '#8dcbd0' }
        ];
      }
      series.forEach(function (item) {
        var node = document.createElement('span');
        node.className = 'legend-item';
        var swatch = document.createElement('i');
        swatch.className = 'legend-swatch';
        swatch.style.background = item.color;
        var label = document.createElement('span');
        label.textContent = item.label;
        node.append(swatch, label);
        legend.appendChild(node);
      });
      renderTrendTable(table, rows, series, mode);
      if (!rows.length) {
        var emptyLabel = svgText(480, 135, t('noTrend'), 'middle');
        emptyLabel.setAttribute('fill', '#aa9b91');
        plot.appendChild(emptyLabel);
        text('trend-range', t('noTimeline'));
        description.textContent = t('noTrendDescription');
        return;
      }
      var left = 58, right = 20, top = 18, bottom = 38, width = 960, height = 280;
      var innerWidth = width - left - right, innerHeight = height - top - bottom;
      var values = [];
      series.forEach(function (item) {
        rows.forEach(function (row) {
          if (row[item.key] != null && isFinite(row[item.key])) values.push(row[item.key]);
        });
      });
      var maximum = Math.max(1, ...values);
      for (var index = 0; index <= 4; index += 1) {
        var y = top + innerHeight * index / 4;
        var line = svgElement('line', {
          x1: left, y1: y, x2: width - right, y2: y,
          stroke: 'rgba(194,164,145,.3)', 'stroke-dasharray': '4 5'
        });
        plot.appendChild(line);
        var axisValue = maximum * (4 - index) / 4;
        var axisLabel = mode === 'cache' ? percent(axisValue) : mode === 'latency' ? duration(axisValue) : compact(axisValue);
        var axisText = svgText(left - 8, y + 4, axisLabel, 'end');
        axisText.setAttribute('fill', '#aa9b91');
        plot.appendChild(axisText);
      }
      series.forEach(function (item) {
        var points = rows.map(function (row, index) {
          var value = row[item.key];
          if (value == null || !isFinite(value)) return null;
          var x = left + (rows.length === 1 ? innerWidth / 2 : index * innerWidth / (rows.length - 1));
          var y = top + innerHeight - value / maximum * innerHeight;
          return x.toFixed(1) + ',' + y.toFixed(1);
        }).filter(Boolean);
        if (!points.length) return;
        var polyline = svgElement('polyline', {
          points: points.join(' '), fill: 'none', stroke: item.color,
          'stroke-width': item.key === 'rps' ? 2 : 2.5,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round'
        });
        plot.appendChild(polyline);
      });
      var first = new Date(rows[0].bucketStartMs), last = new Date(rows[rows.length - 1].bucketStartMs);
      var firstLabel = svgText(left, height - 10, first.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), 'start');
      var lastLabel = svgText(width - right, height - 10, last.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), 'end');
      firstLabel.setAttribute('fill', '#aa9b91');
      lastLabel.setAttribute('fill', '#aa9b91');
      plot.append(firstLabel, lastLabel);
      text('trend-range', rows.length + ' ' + t('slices') + ' ' + (mode === 'cache' ? percent(maximum) : mode === 'latency' ? duration(maximum) : compact(maximum)));
      description.textContent = title.textContent + ': ' + rows.length + t('chartRows') + t('accessibleChart');
    }

    function svgElement(name, attributes) {
      var node = document.createElementNS(svgNamespace, name);
      Object.keys(attributes).forEach(function (key) { node.setAttribute(key, String(attributes[key])); });
      return node;
    }

    function svgText(x, y, value, anchor) {
      var node = svgElement('text', {
        x: x, y: y, 'text-anchor': anchor, 'font-size': 11,
        'font-family': 'Cascadia Mono, monospace'
      });
      node.textContent = value;
      return node;
    }

    function renderTrendTable(table, rows, series, mode) {
      var headRow = document.createElement('tr');
      [t('time')].concat(series.map(function (item) { return item.label; })).forEach(function (label) {
        var cell = document.createElement('th');
        cell.scope = 'col';
        cell.textContent = label;
        headRow.appendChild(cell);
      });
      table.tHead.appendChild(headRow);
      rows.forEach(function (row) {
        var tableRow = document.createElement('tr');
        var timestamp = document.createElement('th');
        timestamp.scope = 'row';
        timestamp.textContent = time(row.bucketStartMs);
        tableRow.appendChild(timestamp);
        series.forEach(function (item) {
          var cell = document.createElement('td');
          var value = row[item.key];
          cell.textContent = mode === 'cache' ? percent(value) : mode === 'latency' ? duration(value) : number(value, item.key === 'rps' ? 3 : 0);
          tableRow.appendChild(cell);
        });
        table.tBodies[0].appendChild(tableRow);
      });
    }

    function renderRoutes(rows) {
      var body = document.getElementById('route-table-body');
      body.replaceChildren();
      var sortKey = routeSort.value;
      var sorted = rows.slice().sort(function (left, right) {
        var leftValue = left[sortKey] == null ? -1 : left[sortKey];
        var rightValue = right[sortKey] == null ? -1 : right[sortKey];
        return rightValue - leftValue || left.route.localeCompare(right.route);
      });
      if (!sorted.length) {
        var row = document.createElement('tr');
        var cell = document.createElement('td');
        cell.colSpan = 7;
        cell.className = 'empty';
        cell.textContent = t('waitingTraffic');
        row.appendChild(cell);
        body.appendChild(row);
        return;
      }
      sorted.forEach(function (route) {
        var row = document.createElement('tr');
        [
          [route.route, 'route-path'],
          [compact(route.requests), 'number'],
          [percent(route.availability), 'number'],
          [percent(route.errorRate), 'number'],
          [duration(route.latencyP95Ms), 'number'],
          [percent(route.cacheHitRate), 'number'],
          [number(route.fanOut, 2), 'number']
        ].forEach(function (item) {
          var cell = document.createElement('td');
          cell.textContent = item[0];
          cell.className = item[1];
          row.appendChild(cell);
        });
        body.appendChild(row);
      });
    }

    function renderUpstream(rows) {
      var list = document.getElementById('upstream-list');
      list.replaceChildren();
      if (!rows.length) { empty(list, t('waitingUpstream')); return; }
      rows.forEach(function (upstream) {
        var card = document.createElement('article');
        card.className = 'provider-card';
        var head = document.createElement('div');
        head.className = 'provider-head';
        var name = document.createElement('strong');
        name.className = 'provider-name';
        name.textContent = upstream.host;
        var rate = document.createElement('span');
        rate.className = 'state-pill';
        rate.textContent = percent(upstream.availability);
        head.append(name, rate);
        var detail = document.createElement('div');
        detail.className = 'provider-detail';
        detail.textContent = t('attempts') + ' ' + compact(upstream.attempts) + ' · ' + t('success') + ' ' + compact(upstream.success) +
          ' · 404 ' + compact(upstream.notFound) + ' · ' + t('failure') + ' ' + compact(upstream.failure);
        card.append(head, detail);
        list.appendChild(card);
      });
    }

    function renderStatuses(rows) {
      var panel = document.getElementById('status-code-panel');
      panel.replaceChildren();
      if (!rows.length) { empty(panel, t('waitingTraffic')); return; }
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

    function renderProviders(rows) {
      var list = document.getElementById('provider-list');
      list.replaceChildren();
      if (!rows.length) { empty(list, t('providerWaiting')); return; }
      rows.forEach(function (provider) {
        var state = provider.health && provider.health.state ? provider.health.state : 'unknown';
        var card = document.createElement('article');
        card.className = 'provider-card ' + state;
        var head = document.createElement('div');
        head.className = 'provider-head';
        var identity = document.createElement('div');
        var name = document.createElement('div');
        name.className = 'provider-name';
        name.textContent = provider.provider;
        var hosts = document.createElement('div');
        hosts.className = 'provider-hosts';
        hosts.textContent = provider.hosts.length ? provider.hosts.join(' · ') : t('noHost');
        identity.append(name, hosts);
        var pill = document.createElement('span');
        pill.className = 'state-pill' + (state === 'open' ? ' bad' : state === 'half_open' ? ' warn' : '');
        pill.textContent = state.toUpperCase();
        head.append(identity, pill);
        var metrics = document.createElement('div');
        metrics.className = 'provider-metrics';
        [
          ['REQUESTS', provider.metricsKnown ? compact(provider.attempts) : 'unknown'],
          ['AVAILABLE', provider.metricsKnown ? percent(provider.availability) : 'unknown'],
          ['P95', provider.metricsKnown ? duration(provider.latencyP95Ms) : 'unknown'],
          ['CONCURRENCY', provider.health.active + '/' + provider.health.limit + ' +' + provider.health.queued]
        ].forEach(function (item) {
          var box = document.createElement('div');
          var label = document.createElement('span');
          label.textContent = item[0];
          var value = document.createElement('strong');
          value.textContent = item[1];
          box.append(label, value);
          metrics.appendChild(box);
        });
        var detail = document.createElement('div');
        detail.className = 'provider-detail';
        detail.textContent = t('result') + ': ' + entries(provider.outcomes) + '\\n' + t('cache') + ': ' + entries(provider.cacheStates) +
          '\\n' + t('layer') + ': ' + entries(provider.cacheLayers) + '\\n' + t('recentFailure') + ': ' + compact(provider.health.recentFailures) +
          (provider.health.openedAt ? ' · ' + t('openedAt') + ' ' + time(provider.health.openedAt) : '');
        card.append(head, metrics, detail);
        list.appendChild(card);
      });
    }

    function renderCache(cache) {
      var grid = document.getElementById('cache-grid');
      grid.replaceChildren();
      if (!cache || !cache.metricsKnown) {
        empty(grid, t('oldCacheUnknown'));
        return;
      }
      [
        ['FRESH', cache.states.fresh || 0, cache.freshRate],
        ['STALE', cache.states.stale || 0, cache.staleRate],
        ['MISS', cache.states.miss || 0, cache.missRate]
      ].forEach(function (item) {
        var card = document.createElement('article');
        card.className = 'cache-card';
        var label = document.createElement('span');
        label.textContent = item[0] + ' · ' + percent(item[2]);
        var value = document.createElement('strong');
        value.textContent = compact(item[1]);
        card.append(label, value);
        grid.appendChild(card);
      });
      var layers = document.createElement('article');
      layers.className = 'cache-card';
      var layersLabel = document.createElement('span');
      layersLabel.textContent = 'CACHE LAYERS';
      var layersValue = document.createElement('strong');
      layersValue.style.fontSize = '.72rem';
      layersValue.style.lineHeight = '1.45';
      layersValue.textContent = entries(cache.layers);
      layers.append(layersLabel, layersValue);
      grid.appendChild(layers);
    }

    function renderInstances(rows) {
      var list = document.getElementById('instance-list');
      list.replaceChildren();
      if (!rows.length) { empty(list, t('instanceWaiting')); return; }
      rows.forEach(function (instance) {
        var card = document.createElement('article');
        card.className = 'instance-card' + (instance.online ? '' : ' offline');
        var head = document.createElement('div');
        head.className = 'instance-head';
        var identity = document.createElement('div');
        var name = document.createElement('div');
        name.className = 'instance-id';
        name.textContent = instance.instanceId;
        var meta = document.createElement('div');
        meta.className = 'instance-meta';
        meta.textContent = 'v' + instance.version + ' · revision ' + instance.revision + ' · ' +
          instance.runtime + ' · ' + instance.stateBackend + ' · ' + t('heartbeat') + ' ' + time(instance.heartbeatAt);
        identity.append(name, meta);
        var pill = document.createElement('span');
        setReadyPill(pill, instance.ready, instance.online);
        head.append(identity, pill);
        var metrics = document.createElement('div');
        metrics.className = 'instance-metrics';
        var l2Entries = instance.cache.l2.entries == null
          ? (instance.cache.l2.connected ? t('sharedCacheUnknown') : t('notConnected'))
          : compact(instance.cache.l2.entries) + (instance.cache.l2.maxEntries == null ? '' : '/' + compact(instance.cache.l2.maxEntries));
        [
          ['UPTIME', uptime(instance.uptimeSeconds)],
          ['L1 MEMORY', compact(instance.cache.l1.entries) + '/' + compact(instance.cache.l1.maxEntries)],
          ['L2 ' + String(instance.cache.l2.layer).toUpperCase(), l2Entries],
          ['SINGLEFLIGHT', instance.singleflight.flights + ' flights · ' + instance.singleflight.waiters + ' waiters'],
          ['INGRESS', instance.ingress.active + '/' + instance.ingress.limit + ' · ' + instance.ingress.requestsThisSecond + '/' + instance.ingress.rateLimit + ' rps']
        ].forEach(function (item) {
          var box = document.createElement('div');
          var label = document.createElement('span');
          label.textContent = item[0];
          var value = document.createElement('strong');
          value.textContent = item[1];
          box.append(label, value);
          metrics.appendChild(box);
        });
        card.append(head, metrics);
        list.appendChild(card);
      });
    }

    function activateTab(tab, focus) {
      var tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      tabs.forEach(function (candidate) {
        var active = candidate === tab;
        candidate.setAttribute('aria-selected', String(active));
        candidate.tabIndex = active ? 0 : -1;
        document.getElementById(candidate.getAttribute('aria-controls')).hidden = !active;
      });
      if (focus) tab.focus();
      if (tab.dataset.tab === 'performance' && snapshot) renderTrend(snapshot);
    }

    document.querySelector('[role="tablist"]').addEventListener('click', function (event) {
      var tab = event.target.closest('[role="tab"]');
      if (tab) activateTab(tab, false);
    });
    document.querySelector('[role="tablist"]').addEventListener('keydown', function (event) {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      var tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      var index = tabs.indexOf(document.activeElement);
      if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = tabs.length - 1;
      else index = (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault();
      activateTab(tabs[index], true);
    });

    document.getElementById('logout').addEventListener('click', async function (event) {
      var button = event.currentTarget;
      button.disabled = true;
      button.textContent = t('signingOut');
      try {
        await fetch('/admin/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken } });
      } finally { location.replace('/admin/login'); }
    });
    refreshButton.addEventListener('click', function () { load(true); });
    languageSelect.addEventListener('change', function (event) {
      applyLanguage(event.target.value);
    });
    windowSelect.addEventListener('change', function () { load(true); });
    chartMetric.addEventListener('change', function () { if (snapshot) renderTrend(snapshot); });
    routeSort.addEventListener('change', function () { if (snapshot) renderRoutes(snapshot.routes); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(false); });
    applyLanguage(language);
    load(false);
    timer = setInterval(function () { if (!document.hidden) load(false); }, 5000);
    window.addEventListener('pagehide', function () {
      clearInterval(timer);
      if (activeRequest) activeRequest.abort();
    });
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
