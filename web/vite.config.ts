import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const apiPort = process.env.APP_API_PORT || '42110'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        chunkFileNames: 'assets/chunk-[hash].js',
      },
    },
  },
  server: {
    port: 5278,
    proxy: {
      // 后端提供 API、鉴权 Cookie、媒体代理与评论 WebSocket;dev 下全部转发到 Fastify。
      '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true },
      '/media': { target: `http://localhost:${apiPort}`, changeOrigin: true },
      '/ws': { target: `http://localhost:${apiPort}`, changeOrigin: true, ws: true },
    },
  },
})
