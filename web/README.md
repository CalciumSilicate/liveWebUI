# liveWebUI 前端(web)

直播控制台的单页前端。基于内部「前端典范模板」派生,技术栈:
Vite 6 · React 19 · TypeScript · Tailwind · shadcn/ui(Radix)· lucide · motion。

## 开发

```bash
npm install
npm run dev      # http://localhost:5278,/api、/media、/ws 代理到后端(默认 42110)
npm run build    # tsc -b && vite build,产物在 dist/
npm run lint
```

dev 需要后端在 42110 运行(`cd .. && npm run dev`),或用 `APP_API_PORT` 改代理目标(见 `vite.config.ts`)。

## 结构

| 层 | 位置 | 说明 |
|----|------|------|
| 路由 | `src/App.tsx` | `/watch/:slug` → 观看页;其余 → 管理台 |
| 管理台 | `src/pages/AdminApp.tsx`、`ChannelsPage.tsx`、`components/admin/*` | 登录门 + 渠道 CRUD |
| 观看页 | `src/pages/Watch.tsx`、`lib/player-controller.ts`、`lib/webrtc-reader.ts` | 观看码鉴权 + WebRTC/HLS 播放 + 评论 |
| API 层 | `src/api/{client,admin,watch}.ts` | 所有请求经 `apiRequest`;管理台走 Cookie,观看页带 Bearer token |
| 设计系统 / 基建 | `src/index.css`(`ops-*` 类)、`components/ui/*`、`components/layout/*`、`theme`、`i18n`、`lib/*` | 来自模板,尽量复用不改结构 |
| 品牌 / 命名空间 | `src/config.ts` | `BRAND_NAME`、`live:` 前缀的 `nsKey()` |

## 约定

- 页面不直接 `fetch` —— 走 `api/*.ts` 的类型化函数。
- 页面壳用 `PageShell` / `PageSurface` / `PageStat`,不散写卡片样式。
- 危险操作(删除)用 `useConfirm()`,反馈用 `useGlobalToast()`。
- 颜色一律 HSL token(`hsl(var(--primary))`),light/dark 两套定义在 `index.css`。

播放相关的命令式逻辑(双路播放、失败回退、断线重连)封装在 `lib/player-controller.ts`,
`lib/webrtc-reader.ts` 是 MediaMTX 官方 WHEP reader 的原样移植(vendored,`@ts-nocheck`)。
