import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'

import { ChunkLoadBoundary } from '@/components/ChunkLoadBoundary'
import { PageLoader } from '@/components/PageLoader'
import { BRAND_NAME } from '@/config'

const AdminApp = lazy(() => import('@/pages/AdminApp'))
const Watch = lazy(() => import('@/pages/Watch'))

/**
 * 应用根 —— 两个面向不同人群的界面,用路由区分:
 *   - `/watch/:slug`  公开观看页(观看码鉴权,无需管理台登录)
 *   - 其余路径        管理台(登录后管理渠道)
 *
 * 观看页需要可分享的深链接(每渠道一个地址),所以这里引入 react-router;
 * 管理台内部页面少,由 AdminApp 自己用状态处理登录门。
 */
export default function App() {
  return (
    <ChunkLoadBoundary scopeLabel={BRAND_NAME}>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/watch/:slug" element={<Watch />} />
          <Route path="*" element={<AdminApp />} />
        </Routes>
      </Suspense>
    </ChunkLoadBoundary>
  )
}
