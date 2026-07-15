> [!WARNING]
> 本项目仅供自用，且代码由 AI 生成；如果要公开使用，必须先经过完整审计并按实际生产要求修改。

# liveWebUI

多渠道 RTMP 直播服务，包含：

- 管理后台
- 渠道启停
- 渠道推流码 / 观看码
- WebRTC 极速观看
- HLS 兼容观看
- 评论区
- 自动录制、按时长分片、按空间预算滚动清理

## 架构

- **后端** `src/`：Fastify + better-sqlite3，负责鉴权、渠道 CRUD、MediaMTX 路径同步、推拉流转码、媒体代理与评论 WebSocket。同时把前端构建产物作为静态站点托管。
- **前端** `web/`：Vite 6 · React 19 · TypeScript · Tailwind · shadcn/ui 的单页应用。
  - `/`、`/admin`：管理台（登录后管理渠道）。
  - `/watch/:slug`：公开观看页（观看码鉴权 + 播放 + 评论）。
  - 由后端在同源下托管，`/api`、`/media`、`/ws` 均走后端；未命中的前端路由回退到 `index.html`。

## Ports

- `42110`: Web / Admin / Watch / Comment WS
- `42111`: RTMP publish
- `42112`: MediaMTX HLS
- `42113`: MediaMTX WebRTC / WHEP
- `42114/udp`: MediaMTX WebRTC UDP
- `42115`: MediaMTX WebRTC TCP fallback

## Recording

- 管理台每个渠道可单独开启「自动录制」。
- 直播源在线时,后端用 FFmpeg 以 `-c copy` 方式录制源流,按配置的秒数自动切成 MP4 分片。
- 默认保存到 `data/recordings/<slug>/`;可用 `RECORDINGS_DIR` 覆盖。
- 每个渠道有独立空间预算(MB),超出后自动删除最旧分片。
- 删除渠道时会删除该渠道录制目录。

## Run

```bash
cp .env.example .env
# 编辑 .env，设置强 ADMIN_PASSWORD / SESSION_SECRET / PUBLIC_WEBRTC_HOSTS
./scripts/fetch-mediamtx.sh
./scripts/prepare-app-image.sh
docker compose up -d --build
```

`prepare-app-image.sh` 会先构建前端 SPA（`web/dist`）再构建后端，`docker compose` 用 `Dockerfile.app` 把两者打进镜像。

后台地址：`http://127.0.0.1:42110/admin`

`PUBLIC_WEBRTC_HOSTS` 必须填客户端实际访问的公网域名或公网 IP，且 `42114/udp`、`42115/tcp` 需要对外可达。

如果宿主机没有 `node` / `npm`，或者 `npm ci` 缺少本地编译环境，先安装：

```bash
sudo apt-get install -y nodejs npm build-essential python3
```

## 本地开发

Windows 本地开发统一使用一个 `uv` 命令。它会在同一个终端里启动 MediaMTX、后端和前端 dev server，不再额外弹多个 PowerShell 窗口：

```powershell
uv run scripts/dev.py
```

默认监听 `0.0.0.0`，默认后台密码是 `callmegpt`，按 `Ctrl+C` 会停止全部子进程。如本机没有 MediaMTX 或 FFmpeg，脚本会自动下载到 `vendor/` 下用于本地开发。默认端口是 Web/API `42110`、RTMP `42111`、HLS `42112`、前端 dev server `5278`。

常用入口：

```powershell
npm run dev
npm run dev:local
```

如果要显式设置密码：

```powershell
uv run scripts/dev.py --admin-password callmegpt
```

只清理当前项目占用的本地 dev 进程，不启动新实例：

```powershell
uv run scripts/dev.py --stop-only
```

旧的 PowerShell 入口 `npm run dev:ps` 仅作为兼容入口，会转发到同一个 `uv` supervisor，不再打开多个窗口。

也可以调试时手动拆开跑。前端 dev server 通过代理把 `/api`、`/media`、`/ws` 转发到后端：

```bash
# 终端 1：后端(默认 42110),需要 ADMIN_PASSWORD / SESSION_SECRET 等环境变量
npm install
npm run dev:backend

# 终端 2：前端 dev server(http://localhost:5278)
npm run dev:web
```

一次性构建全部产物：`npm run build:all`（等价于先 `build:web` 再 `build`）。

## OBS / FFmpeg

推流地址在后台渠道列表里会直接生成，格式如下：

```text
rtmp://127.0.0.1:42111/<slug>?user=<slug>&pass=<publishPassword>
```

## Watch

观看页默认优先 `极速` 模式（WebRTC），失败时可手动切到 `兼容`（HLS）。


## Security

- 不要提交 `.env`、`data/`、`vendor/`、`node_modules/`、`dist/`；仓库的 `.gitignore` 已默认排除。
- 生产部署前必须修改 `.env` 里的 `ADMIN_PASSWORD` 和 `SESSION_SECRET`。
- 对公网开放时，确保 RTMP / WebRTC / HLS 端口符合你的防火墙策略。
