# Yukine Metadata Gateway

本仓库同时提供 Cloudflare Worker 和 Node/Docker 两个运行时。两者共享路由、输入校验、MusicBrainz/AcoustID/iTunes/Wikidata/网易云/LRCLIB 聚合及响应模型；网关只接收元数据和可选 Chromaprint，不接收原始音频、不代理图片字节，也不提供流媒体播放解析。

## API

- `GET /health`
- `GET /ready`
- `GET /openapi.json`
- `GET /v1/recordings/search`
- `GET /v1/artists/search`
- `GET /v1/lyrics/search`
- `GET /v2/recordings/search`
- `GET /v2/artists/search`
- `GET /v2/albums/search`
- `GET /v2/lyrics/search`
- `POST /v1/authorization/verify`（仅 Node 可信发行模式）
- `POST /v1/authorization/redeem/{token}`（仅 Node 可信发行模式）
- `POST /v1/authorization/activate`（仅 Node 可信发行模式）

`/health` 只表示进程存活，不会探测音乐来源；`/ready` 只检查运行时初始化和所选状态后端。OpenAPI 3.1 由同一套 Zod 4 请求/响应 schema 在构建时生成，Node 与 Worker 都从 `/openapi.json` 提供。

v2 对非法参数严格返回 `400 invalid_request`，只列字段名和错误码。每个实体均包含 `canonicalId`、`confidence` 和逐字段 `sources`；录音标识统一收敛到 `identifiers`。文本录音搜索并发收集 MusicBrainz 与 iTunes，强 MBID、ISRC 或已验证 AcoustID 证据优先；版本标记冲突和强标识冲突不会自动合并。v1 的字段、宽松参数解析和错误语义保持不变。

专辑接口接受 `title`、`artist`、`releaseGroupMbid`、`releaseMbid`、`year`、`type` 和 `limit`，默认最多返回 10 个 MusicBrainz release-group 候选。强 MBID 优先于文本上下文；两个 MBID 归属冲突时返回空数组。候选按 `confidence` 降序排列，平分时按 `canonicalId` 稳定排序；无结果返回 `{"albums":[]}`。

录音接口的 `coverUrl` 只会返回 MusicBrainz 已声明 front artwork 的 Cover Art Archive URL，或 HTTPS `*.mzstatic.com` iTunes 图片。歌词接口接受必填 `title`，以及可选 `artist`、`album`、`durationMs`；无结果返回 `{"lyrics":null}`。

艺人接口的每个 `artists[]` 都包含 `avatarUrl` 和 `description` 字符串。首个匹配结果会优先通过 MusicBrainz 关联的 Wikidata 实体增强：头像读取 `P18`，介绍优先使用简体中文或中文描述，缺失时回退英文。头像或介绍仍为空时，网关会匿名查询网易云官方域名，只有精确匹配艺人名称后才逐字段补齐；图片只接受 HTTPS `*.music.126.net`，不会代理图片字节。没有可信内容时相应字段为空字符串。

网易云仅用于艺人头像和介绍的 best-effort 补充，整段补充请求共用 2.5 秒期限；网关不接收或保存网易云 Cookie，也不迁移网易云歌词、播放、歌单或登录接口。所有基础查询均失败时返回 `502 upstream_failure`。已知 404、合法空结果和头像、介绍、封面等附加增强失败不会把基础结果升级为 502。

## 可信远端授权

Node 运行时可以显式启用 `yukine-auth/v1` 可信发行模式。默认保持关闭；关闭时当前元数据 API 的自建网关行为不变，Cloudflare Worker 也继续作为普通自建网关，不能登记为可信授权源。

启用后：

- `/v1/*`、`/v2/*` 元数据搜索必须提交 `Authorization: Bearer <API Key>`，并要求 `official_metadata_gateway` capability；
- `/health`、`/ready`、`/openapi.json` 和 `/admin` 保持独立；
- 管理面板新增“远端授权”页，可创建稳定 subject、选择 `official_metadata_gateway` / `together_listening`、设置到期时间、发行 API Key 或一次性兑换 URL，并吊销已有 Key；
- API Key、兑换 token 和激活 token 均使用至少 32 字节随机 secret。数据库只保存带服务端 pepper 的 HMAC-SHA-256 摘要与 16 字符指纹；明文只在创建或兑换成功时返回一次；
- 授权断言使用 Ed25519 签名。签名数据为 `yukine-auth/v1\n` 加移除 `signature` 后的 RFC 8785 JCS JSON；Cloud 固定 `issuerId + keyId + 公钥`，不在请求期间下载公钥；
- nonce 必须是 32 字节 base64url，成功使用后保留 15 分钟；重复 nonce 返回 `409 nonce_replay`。所有授权响应均为 `Cache-Control: no-store`。

验证请求：

```json
{
  "protocolVersion": "yukine-auth/v1",
  "nonce": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "requestedCapabilities": ["together_listening"]
}
```

签名响应：

```json
{
  "protocolVersion": "yukine-auth/v1",
  "issuerId": "official-production",
  "subject": "sub_immutable-id",
  "active": true,
  "capabilities": ["official_metadata_gateway", "together_listening"],
  "issuedAt": "2026-07-19T00:00:00.000Z",
  "expiresAt": "2026-08-19T00:00:00.000Z",
  "nonce": "request-nonce",
  "signature": {
    "algorithm": "Ed25519",
    "keyId": "signing-2026-07",
    "value": "base64url-signature"
  }
}
```

一次性 URL 由 YUKINE Cloud 调用。网关先返回 pending API Key 和 60 秒激活 token；Cloud 预留 `(issuerId, subject)` 唯一绑定并加密保存 Key，随后调用 `/activate`。只有激活与 Cloud 绑定都成功，Key 才会返回当前设备。重复兑换返回 `410 redemption_used`。

## 本地检查

需要 Node 24：

```bash
npm ci
npm run check
npm test
npm run build:node
npm run build:cloud
npm run dry-run
```

`npm run test:external` 是 Redis/PostgreSQL 双实例集成测试，需要设置 `TEST_REDIS_URL` 和 `TEST_DATABASE_URL`；CI 会自动启动依赖并执行。

授权纵向闭环测试包含 API Key、一次性 URL、伪造签名、capability、nonce 重放和跨账号 subject 复用。共享协议位于 `packages/authorization-contract/`，Cloud 验证/绑定模块位于 `yukine-cloud/`。

启动 Node 服务（默认不启用管理面板）：

```bash
HOST=127.0.0.1 PORT=8787 CACHE_DB_PATH=./data/cache.sqlite npm start
```

默认 SQLite 模式下，Node 启动时必须成功打开数据库；数据库损坏或不可写时进程会直接退出。请求日志只包含 request ID、路由、状态、耗时、缓存层、Provider 和结果类别，不包含标题、艺人、查询串、指纹、完整 URL 或密钥。

## 可视化监控面板

Node/Docker 运行时提供 `/admin` 监控面板；Cloudflare Worker 不包含该入口。面板分为概览、性能、来源和运行时四个视图，内置中文/English 切换并在当前浏览器中记住选择；统计 `/v1/*` 与 `/v2/*` 业务请求的请求量、RPS、可用率、延迟分位数、缓存 fresh/stale/miss、Provider 结果与熔断、SingleFlight 以及实例心跳，排除健康检查与面板自身流量。SQLite 模式把分钟指标保存在独立 SQLite 数据库；external 模式使用 PostgreSQL 汇总多个实例，默认保留 30 天。旧历史没有的新维度显示为 `unknown`，不会回填虚假零值。

首次启用时必须提供至少 32 个字符的一次性引导令牌，否则新数据库会拒绝启动：

```bash
export DASHBOARD_SETUP_TOKEN="$(openssl rand -base64 32)"
export DASHBOARD_ENABLED=true
export DASHBOARD_PUBLIC_ORIGIN=https://metadata.example.com
export DASHBOARD_DB_PATH=./data/dashboard.sqlite
npm start
```

打开 `https://metadata.example.com/admin/setup#一次性引导令牌`，设置 3–64 字符的登录账号和至少 12 字节的密码。令牌放在 URL fragment 中，不会发送给服务器或进入访问日志；页面读取后会立即从地址栏移除。设置成功后应从部署环境删除 `DASHBOARD_SETUP_TOKEN` 并重启，已有管理员不会受影响。

密码使用带随机盐的 scrypt 保存；会话令牌只以 SHA-256 摘要写入所选状态后端。Cookie 为 `Secure`、`HttpOnly`、`SameSite=Strict`，默认闲置 30 分钟、最长 8 小时。设置、登录和退出接口要求固定 `DASHBOARD_PUBLIC_ORIGIN` 的同源请求，退出还要求会话 CSRF token。

## Docker Compose

本地构建：

```bash
printf 'DASHBOARD_SETUP_TOKEN=%s\n' "$(openssl rand -base64 32)" > .env
printf 'DASHBOARD_PUBLIC_ORIGIN=http://localhost:8787\n' >> .env
docker compose build
docker compose up -d
docker compose ps
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/ready
```

首次启动后从 `.env` 读取令牌，并访问 `http://localhost:8787/admin/setup#该令牌` 完成初始化。生产环境必须使用 HTTPS；HTTP 仅允许 `localhost`、`127.0.0.1` 或 `::1` 的本地开发来源。

从 GHCR 拉取：

```bash
GATEWAY_IMAGE_TAG=1.2.3 docker compose pull
GATEWAY_IMAGE_TAG=1.2.3 docker compose up -d --no-build
```

Compose 默认只绑定 `127.0.0.1:8787`，使用命名卷 `metadata-gateway-data` 保存 SQLite，容器以非 root 用户运行、根文件系统只读、`/tmp` 为 tmpfs，并移除全部 Linux capabilities。首版仅支持单实例，禁止多个容器共享同一个 SQLite 卷。

可用环境变量：

- `HOST`、`PORT`
- `CACHE_DB_PATH`
- `CACHE_TTL_SECONDS`（默认 3600）
- `CACHE_STALE_SECONDS`（默认 86400；fresh 过期后允许 stale-while-revalidate 的秒数）
- `CACHE_MAX_ENTRIES`（默认 10000）
- `MEMORY_CACHE_MAX_ENTRIES`（每实例 L1 LRU，默认 1000）
- `UPSTREAM_TIMEOUT_MS`（默认 4500）
- `REQUEST_TIMEOUT_MS`（默认 10000）
- `MAX_CONCURRENT_REQUESTS`（默认 500；Node 正在处理的请求达到上限后返回 `503 server_busy`）
- `MAX_REQUESTS_PER_SECOND`（默认 500；Node 每秒请求达到上限后返回 `429 server_rate_limited`）
- `TRUST_PROXY`（直接运行默认 `false`；Compose 在仅由本机反向代理转发时默认 `true`）
- `APP_USER_AGENT`
- `INSTANCE_ID`（实例心跳标识，默认使用主机名；多副本部署时应固定且保持唯一）
- `APP_VERSION`（默认读取当前 package 版本）
- `APP_REVISION`（镜像或发布 revision，缺失时为 `unknown`）
- 可选 `ACOUSTID_API_KEY`
- `STATE_BACKEND=sqlite|external`（默认 `sqlite`）
- external 模式必需的 `REDIS_URL` 与 `DATABASE_URL`；依赖不可用时 `/ready` 失败，不会回退到 SQLite
- `OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_SERVICE_NAME`（可选 OTLP/HTTP traces 与 metrics）
- `V2_ENABLED`（默认 `true`，可用于灰度）
- `V1_SUNSET_DATE`（可选 HTTP-date；设置后 v1 返回 `Deprecation`、`Sunset` 与规范链接）
- `DASHBOARD_ENABLED`（Compose 默认 `true`，直接运行 Node 默认 `false`）
- `DASHBOARD_DB_PATH`（Compose 为 `/data/dashboard.sqlite`）
- `DASHBOARD_PUBLIC_ORIGIN`（浏览器访问面板的固定 origin）
- 首次启动必需的 `DASHBOARD_SETUP_TOKEN`（至少 32 字符，设置成功后删除）
- `DASHBOARD_SESSION_IDLE_SECONDS`（默认 1800）
- `DASHBOARD_SESSION_ABSOLUTE_SECONDS`（默认 28800）
- `DASHBOARD_METRICS_RETENTION_DAYS`（默认 30）
- `AUTHORIZATION_ENABLED`（默认 `false`）
- 可信发行模式必需的 `AUTHORIZATION_ISSUER_ID`、`AUTHORIZATION_KEY_ID`
- 只读挂载文件 `AUTHORIZATION_PRIVATE_KEY_FILE`（Ed25519 PKCS#8 PEM）
- 只读挂载文件 `AUTHORIZATION_CREDENTIAL_PEPPER_FILE`（32 字节原始值、64 位 hex 或 43 位 base64url）
- `AUTHORIZATION_PUBLIC_ORIGIN`（兑换 URL 的固定 origin）
- `AUTHORIZATION_DB_PATH`（默认与缓存同目录的 `authorization.sqlite`）
- `DASHBOARD_SETUP_TOKEN_FILE`（可替代环境变量中的初始化令牌）
- `AUTHORIZATION_ALLOW_INSECURE_TEST` 只在 `NODE_ENV=test` 生效；生产不得开启

### Redis/PostgreSQL 多实例

external 模式用 Redis 承载共享缓存、刷新租约、跨副本请求协调、Provider 配额与熔断状态；PostgreSQL 承载管理员、会话和分钟指标。元数据缓存不迁移，切换后会自动重新预热；管理员和历史分钟指标可幂等迁移，旧会话故意不迁移，切换后需要重新登录。

```bash
export POSTGRES_PASSWORD='replace-with-a-strong-secret'
docker compose -f compose.external.yaml --profile external up -d --build --scale metadata-gateway-external=2
docker compose -f compose.external.yaml --profile external ps
```

迁移前先备份 SQLite 数据文件，并让 PostgreSQL 可访问：

```bash
STATE_BACKEND=external \
DATABASE_URL='postgres://yukine:password@127.0.0.1:5432/yukine' \
DASHBOARD_DB_PATH='./data/dashboard.sqlite' \
npm run migrate:external-state
```

迁移工具以源数据库内容摘要记录批次，在事务中写入管理员、请求、Provider、实例心跳和熔断健康历史；重复执行不会重复导入。完成后将反向代理的 readiness 指向 `/ready`，并确认至少两个副本的共享缓存、登录会话和指标汇总。Redis 不执行昂贵键扫描，因此面板只报告共享缓存连接状态，条目数量显示为未知。

授权状态使用独立 SQLite 文件。切换 external PostgreSQL 前停止发行端并执行：

```bash
AUTHORIZATION_DB_PATH='./data/authorization.sqlite' \
DATABASE_URL='postgres://yukine:password@127.0.0.1:5432/yukine' \
npm run migrate:authorization-state
```

迁移不会复制短期 nonce；subject、Key 摘要、兑换状态、pending 激活与审计会幂等写入。

## YUKINE Cloud 授权模块

`yukine-cloud/` 首版提供框架无关的：

- `bindApiKey`
- `redeemAndBind`
- `revalidate`
- `deleteBinding`
- `requireCapability`

PostgreSQL 保存可信 issuer、公钥集合和唯一绑定；Redis 保存短期 nonce 与每用户限流。API Key 使用每记录独立 DEK 的 AES-256-GCM 信封加密，DEK 再由只读 32 字节 KEK 文件包装，AAD 包含用户 ID、issuer ID 和绑定版本。

对用户提交的兑换 URL，Cloud 会精确匹配管理员登记的 HTTPS origin、端口和路径前缀，拒绝 userinfo、query token、重定向、环回/私网/链路本地地址和 DNS 重绑定；默认超时 3 秒，响应上限 64 KiB。网关不可达、超时、签名错误、inactive 或缺 capability 时立即拒绝，不读取历史成功结果。

当前没有完整账号 JWT，因此只提供测试宿主。宿主仅在 `NODE_ENV=test` 启动，并通过 `X-Test-User-Id` 模拟未来账号 ID；不得部署为正式账号 API。

本地闭环：

```bash
npm run generate:authorization-dev-secrets
docker compose --profile cloud-test up -d --build
curl http://127.0.0.1:8788/ready
curl http://127.0.0.1:8790/ready
```

授权网关面板位于 `http://localhost:8788/admin`。生成的开发密钥位于被 Git 忽略的 `secrets/`；该 profile 使用隔离的授权网关卷、PostgreSQL 和 Redis，只允许本机端口访问。

### 数据卷备份

先停止服务，避免复制到一半的事务：

```bash
docker compose stop metadata-gateway
docker run --rm \
  -v metadata-gateway_metadata-gateway-data:/data:ro \
  -v "$PWD/backups:/backup" \
  node:24.18.0-bookworm-slim \
  tar -C /data -czf /backup/metadata-gateway-data.tgz .
docker compose start metadata-gateway
```

恢复时停止服务，把备份解压回同一命名卷，再启动并检查 `/health`。不要把数据库、WAL 或备份提交到 Git。

### 升级与回滚

升级前备份数据卷并记录当前不可变标签：

```bash
GATEWAY_IMAGE_TAG=1.2.4 docker compose pull
GATEWAY_IMAGE_TAG=1.2.4 docker compose up -d --no-build
docker compose ps
```

若健康检查失败，改回上一版本（例如 `GATEWAY_IMAGE_TAG=1.2.3`）并重新 `up -d --no-build`。生产环境建议固定版本或镜像 digest，不要依赖 `latest` 回滚。

## Cloudflare Worker

Wrangler 默认入口仍是 `src/index.ts`：

```bash
npm ci
npx wrangler secret put ACOUSTID_API_KEY
npm run check:worker
npm run deploy
```

Worker 保持 Cloudflare Cache 和 isolate 内 SingleFlight，通过 `waitUntil()` 执行 stale 后台刷新；不会连接 Redis/PostgreSQL，也不会打包 Node OpenTelemetry SDK。

Worker 首版不实现可信授权发行、凭据管理或 Cloud 绑定协议，因此不能被 YUKINE Cloud 登记为可信 issuer。

## Android

构建时配置网关：

```bash
./gradlew :app:assembleDebug \
  -PECHO_METADATA_GATEWAY_URL=https://metadata.example.com/
```

Android 会继续使用 Room 响应缓存和端点健康状态：身份元数据 TTL 为 30 天，网关歌词 TTL 为 7 天。网关歌词位于 LX、自定义歌词、本地文件、已绑定来源和精确平台来源之后；网关失败或无结果时继续原有 LRCLIB、网易云、QQ、酷狗、酷我搜索链，且不会写入 provider binding。

## 公网部署

业务 API 默认无鉴权且不提供浏览器 CORS；管理面板有独立登录。公网部署必须放在反向代理之后，由代理负责：

- TLS 终止及 HTTP 到 HTTPS 跳转；
- 访问控制（如需要）；
- 按 IP/令牌限流和并发限制；
- 普通自建模式业务 API 仅转发 `GET`；可信发行模式另为 `/v1/authorization/verify`、`/v1/authorization/redeem/*` 和 `/v1/authorization/activate` 放行 `POST`；
- 管理面板为 `/admin/api/setup`、`/admin/api/login`、`/admin/api/logout` 和 `/admin/api/authorization/*` 放行 `POST`；
- 对设置和登录接口施加更严格的按 IP 限流，不记录查询串或请求体；
- 反向代理不得记录 `/v1/authorization/redeem/*` 的原始路径；应用日志会固定写为 `/v1/authorization/redeem/[redacted]`，代理也必须做等价脱敏；
- 请求体禁用或限制，响应超时略大于网关的 10 秒总期限。

生产反向代理应设置与 Node 一致的并发上限和每 IP 请求速率：

```nginx
limit_conn_zone $server_name zone=metadata_gateway_connections:10m;
limit_req_zone $binary_remote_addr zone=metadata_gateway:10m rate=500r/s;

server {
    limit_conn metadata_gateway_connections 500;
    limit_conn_status 503;

    location / {
        limit_req zone=metadata_gateway burst=500 nodelay;
        limit_req_status 429;
    }
}
```

不要直接把 Compose 的端口绑定改成 `0.0.0.0` 暴露到公网。

## GHCR 发布

镜像固定为 `ghcr.io/ysyhlly/yukine-metadata-gateway`，发布 `linux/amd64` 与 `linux/arm64`。推送 `gateway-v1.2.3` 会生成 `1.2.3`、`sha-<commit>` 和 `latest`；含 `-rc.1` 等预发布后缀的版本不会更新 `latest`。也可从 Actions 手动输入 SemVer 发布。PR 和 `main` 的网关变更只执行检查及多架构构建，不推送镜像。

Cloud 测试宿主镜像为 `ghcr.io/ysyhlly/yukine-cloud`；推送 `cloud-v1.2.3` 使用同样的 SemVer、SHA 与稳定版 `latest` 规则。该镜像仍是账号系统接入前的授权模块测试宿主，不应作为正式 `/v1/me` 服务发布。
