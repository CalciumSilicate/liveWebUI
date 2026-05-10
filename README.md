# liveWebUI

多渠道 RTMP 直播服务，包含：

- 管理后台
- 渠道启停
- 渠道推流码 / 观看码
- WebRTC 极速观看
- HLS 兼容观看
- 评论区

## Ports

- `42110`: Web / Admin / Watch / Comment WS
- `42111`: RTMP publish
- `42112`: MediaMTX HLS
- `42113`: MediaMTX WebRTC / WHEP
- `42114/udp`: MediaMTX WebRTC UDP
- `42115`: MediaMTX WebRTC TCP fallback

## Run

```bash
cp .env.example .env
# 编辑 .env，设置强 ADMIN_PASSWORD / SESSION_SECRET / PUBLIC_WEBRTC_HOSTS
./scripts/fetch-mediamtx.sh
./scripts/prepare-app-image.sh
docker compose up -d --build
```

后台地址：`http://127.0.0.1:42110/admin`

`PUBLIC_WEBRTC_HOSTS` 必须填客户端实际访问的公网域名或公网 IP，且 `42114/udp`、`42115/tcp` 需要对外可达。

如果宿主机没有 `node` / `npm`，或者 `npm ci` 缺少本地编译环境，先安装：

```bash
sudo apt-get install -y nodejs npm build-essential python3
```

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
