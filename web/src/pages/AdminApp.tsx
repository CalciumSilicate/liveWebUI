import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { FolderOpen, LogOut, Radio, Video } from 'lucide-react'

import { adminLogout, getAdminSession } from '@/api/admin'
import { PageLoader } from '@/components/PageLoader'
import { ThemeToggleButton } from '@/components/theme'
import { Button } from '@/components/ui/button'
import { PageSubnav, PageSubnavButton } from '@/components/layout/PageScaffold'
import { BRAND_NAME } from '@/config'

import Login from '@/pages/Login'

const ChannelsPage = lazy(() => import('@/pages/ChannelsPage'))
const RecordingsPage = lazy(() => import('@/pages/RecordingsPage'))
type AdminPage = 'channels' | 'recordings'

/**
 * 管理台:一层「鉴权门」+ 顶栏外壳。
 *
 * 鉴权状态由后端 httpOnly Cookie 维持,首屏查一次会话决定进登录页还是控制台。
 * 内部只有「渠道」一个页面,不做多级导航;子页在遇到 401 时回调 handleUnauthorized 踢回登录。
 */
export default function AdminApp() {
  const [checking, setChecking] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [page, setPage] = useState<AdminPage>('channels')

  useEffect(() => {
    document.title = `管理台 · ${BRAND_NAME}`
  }, [])

  useEffect(() => {
    let cancelled = false
    getAdminSession()
      .then((status) => {
        if (!cancelled) setAuthenticated(status)
      })
      .catch(() => {
        if (!cancelled) setAuthenticated(false)
      })
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleUnauthorized = useCallback(() => setAuthenticated(false), [])

  const handleLogout = async () => {
    try {
      await adminLogout()
    } finally {
      setAuthenticated(false)
    }
  }

  if (checking) return <PageLoader />
  if (!authenticated) return <Login onAuthenticated={() => setAuthenticated(true)} />

  return (
    <div className="flex min-h-screen flex-col bg-muted/30">
      <header className="sticky top-0 z-10 flex h-16 items-center gap-3 border-b bg-background px-4 md:px-6">
        <div className="dashboard-brand-mark flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-md shadow-primary/25">
          <Radio className="h-5 w-5" />
        </div>
        <h1 className="truncate text-base font-semibold tracking-tight md:text-lg">{BRAND_NAME}</h1>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggleButton />
          <Button variant="outline" className="gap-2" onClick={handleLogout}>
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">退出登录</span>
          </Button>
        </div>
      </header>

      <main className="flex-1 p-4 md:p-6">
        <PageSubnav className="mx-auto mb-5 max-w-7xl">
          <PageSubnavButton active={page === 'channels'} onClick={() => setPage('channels')}>
            <Radio className="mr-1.5 inline h-3.5 w-3.5" />
            渠道
          </PageSubnavButton>
          <PageSubnavButton active={page === 'recordings'} onClick={() => setPage('recordings')}>
            <Video className="mr-1.5 inline h-3.5 w-3.5" />
            录制
          </PageSubnavButton>
          <span className="ml-auto hidden items-center gap-1 text-xs text-muted-foreground md:flex">
            <FolderOpen className="h-3.5 w-3.5" />
            本地文件库
          </span>
        </PageSubnav>
        <Suspense fallback={<PageLoader />}>
          {page === 'channels' ? (
            <ChannelsPage onUnauthorized={handleUnauthorized} />
          ) : (
            <RecordingsPage onUnauthorized={handleUnauthorized} />
          )}
        </Suspense>
      </main>
    </div>
  )
}
