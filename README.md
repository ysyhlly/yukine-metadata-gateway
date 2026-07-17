# Yukine Metadata Gateway

本仓库同时提供 Cloudflare Worker 和 Node/Docker 两个运行时。两者共享路由、输入校验、MusicBrainz/AcoustID/iTunes/Wikidata/LRCLIB 聚合及响应模型；网关只接收元数据和可选 Chromaprint，不接收原始音频、不代理图片字节，也不提供流媒体播放解析。

## API

- `GET /health`
- `GET /v1/recordings/search`
- `GET /v1/artists/search`
- `GET /v1/lyrics/search`

录音接口的 `coverUrl` 只会返回 MusicBrainz 已声明 front artwork 的 Cover Art Archive URL，或 HTTPS `*.mzstatic.com` iTunes 图片。歌词接口接受必填 `title`，以及可选 `artist`、`album`、`durationMs`；无结果返回 `{"lyrics":null}`。

所有基础查询均失败时返回 `502 upstream_failure`。已知 404、合法空结果和头像/封面等附加增强失败不会把基础结果升级为 502。

## 本地检查

需要 Node 24：

```bash
npm ci
npm run check
npm test
npm run build:node
npm run dry-run
```

启动 Node 服务：

```bash
HOST=127.0.0.1 PORT=8787 CACHE_DB_PATH=./data/cache.sqlite npm start
```

Node 启动时必须成功打开 SQLite；数据库损坏或不可写时进程会直接退出。请求日志只包含 request ID、路由、状态、耗时、缓存命中和上游主机/状态，不包含标题、查询串、指纹或密钥。

## Docker Compose

本地构建：

```bash
docker compose build
docker compose up -d
docker compose ps
curl http://127.0.0.1:8787/health
```

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
- `CACHE_MAX_ENTRIES`（默认 10000）
- `UPSTREAM_TIMEOUT_MS`（默认 4500）
- `REQUEST_TIMEOUT_MS`（默认 10000）
- `APP_USER_AGENT`
- 可选 `ACOUSTID_API_KEY`

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

## Android

构建时配置网关：

```bash
./gradlew :app:assembleDebug \
  -PECHO_METADATA_GATEWAY_URL=https://metadata.example.com/
```

Android 会继续使用 Room 响应缓存和端点健康状态：身份元数据 TTL 为 30 天，网关歌词 TTL 为 7 天。网关歌词位于 LX、自定义歌词、本地文件、已绑定来源和精确平台来源之后；网关失败或无结果时继续原有 LRCLIB、网易云、QQ、酷狗、酷我搜索链，且不会写入 provider binding。

## 公网部署

Node 默认无鉴权且不提供浏览器 CORS。公网部署必须放在反向代理之后，由代理负责：

- TLS 终止及 HTTP 到 HTTPS 跳转；
- 访问控制（如需要）；
- 按 IP/令牌限流和并发限制；
- 仅转发 `GET` API，不记录查询串；
- 请求体禁用或限制，响应超时略大于网关的 10 秒总期限。

不要直接把 Compose 的端口绑定改成 `0.0.0.0` 暴露到公网。

## GHCR 发布

镜像固定为 `ghcr.io/ysyhlly/yukine-metadata-gateway`，发布 `linux/amd64` 与 `linux/arm64`。推送 `gateway-v1.2.3` 会生成 `1.2.3`、`sha-<commit>` 和 `latest`；含 `-rc.1` 等预发布后缀的版本不会更新 `latest`。也可从 Actions 手动输入 SemVer 发布。PR 和 `main` 的网关变更只执行检查及多架构构建，不推送镜像。
