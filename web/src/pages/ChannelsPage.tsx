import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'

import {
  createChannel,
  deleteChannel,
  listChannels,
  setChannelEnabled,
  updateChannel,
  type AdminChannel,
} from '@/api/admin'
import { ApiError } from '@/api/client'
import { ChannelCard } from '@/components/admin/ChannelCard'
import { ChannelFormDialog, type ChannelFormValues } from '@/components/admin/ChannelFormDialog'
import { InlineLoader } from '@/components/PageLoader'
import { PageShell, PageStat, PageStatStrip, PageSurface } from '@/components/layout/PageScaffold'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { useConfirm } from '@/components/ui/use-confirm'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { cn } from '@/lib/utils'

const POLL_INTERVAL_MS = 5000

interface ChannelsPageProps {
  /** 子操作遇到 401 时回调,由外层踢回登录页。 */
  onUnauthorized: () => void
}

type DialogState =
  | { mode: 'create' }
  | { mode: 'edit'; channel: AdminChannel }
  | null

export default function ChannelsPage({ onUnauthorized }: ChannelsPageProps) {
  const confirm = useConfirm()
  const { showToast } = useGlobalToast()

  const [channels, setChannels] = useState<AdminChannel[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set())
  const [dialog, setDialog] = useState<DialogState>(null)

  // 遇到 401 统一踢回登录;其余错误返回 message 供上层展示。返回 true 表示已处理鉴权失效。
  const isUnauthorized = useCallback(
    (err: unknown): boolean => {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized()
        return true
      }
      return false
    },
    [onUnauthorized],
  )

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent) setRefreshing(true)
      try {
        const list = await listChannels()
        setChannels(list)
        setError(null)
      } catch (err) {
        if (isUnauthorized(err)) return
        if (!silent) setError(err instanceof Error ? err.message : '加载失败')
      } finally {
        if (!silent) setRefreshing(false)
      }
    },
    [isUnauthorized],
  )

  // 首屏加载 + 定时静默轮询(不打断界面,仅刷新运行态)。
  useEffect(() => {
    void load(false)
    const timer = window.setInterval(() => void load(true), POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  const withBusy = useCallback(async (id: number, action: () => Promise<void>) => {
    setBusyIds((prev) => new Set(prev).add(id))
    try {
      await action()
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }, [])

  const handleCreate = async (values: ChannelFormValues) => {
    await createChannel(values)
    setDialog(null)
    showToast('success', `渠道「${values.label}」已创建`)
    await load(true)
  }

  const handleEdit = async (id: number, values: ChannelFormValues) => {
    await updateChannel(id, {
      label: values.label,
      slug: values.slug,
      publishPassword: values.publishPassword,
      viewerPassword: values.viewerPassword,
      relayUrl: values.relayUrl,
    })
    setDialog(null)
    showToast('success', '渠道已更新')
    await load(true)
  }

  const handleToggle = (channel: AdminChannel, enabled: boolean) =>
    withBusy(channel.id, async () => {
      try {
        await setChannelEnabled(channel.id, enabled)
        showToast('success', enabled ? '渠道已启用' : '渠道已停用')
        await load(true)
      } catch (err) {
        if (isUnauthorized(err)) return
        showToast('error', err instanceof Error ? err.message : '操作失败')
      }
    })

  const handleDelete = (channel: AdminChannel) =>
    withBusy(channel.id, async () => {
      const ok = await confirm({
        title: `删除渠道「${channel.label}」`,
        description: '删除后该渠道的推流码、观看码与评论都会移除,且不可恢复。',
        confirmText: '删除',
        variant: 'destructive',
      })
      if (!ok) return
      try {
        await deleteChannel(channel.id)
        showToast('success', '渠道已删除')
        await load(true)
      } catch (err) {
        if (isUnauthorized(err)) return
        showToast('error', err instanceof Error ? err.message : '删除失败')
      }
    })

  const stats = useMemo(() => {
    const list = channels ?? []
    return {
      total: list.length,
      live: list.filter((c) => c.sourceOnline).length,
      enabled: list.filter((c) => c.enabled).length,
      readers: list.reduce((sum, c) => sum + c.readers, 0),
    }
  }, [channels])

  return (
    <PageShell
      title="渠道"
      description="管理直播渠道:启停、推流码 / 观看码、推流与观看地址。"
      width="7xl"
      actions={
        <>
          <Button variant="outline" className="gap-2" onClick={() => void load(false)} disabled={refreshing}>
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            刷新
          </Button>
          <Button className="gap-2" onClick={() => setDialog({ mode: 'create' })}>
            <Plus className="h-4 w-4" />
            新建渠道
          </Button>
        </>
      }
    >
      {error && !channels ? (
        <PageSurface>
          <ErrorState message={error} onRetry={() => void load(false)} />
        </PageSurface>
      ) : !channels ? (
        <div className="flex h-64 items-center justify-center">
          <InlineLoader />
        </div>
      ) : (
        <div className="space-y-6">
          <PageStatStrip>
            <PageStat label="渠道总数" value={stats.total} />
            <PageStat label="直播中" value={stats.live} note="源在线" />
            <PageStat label="已启用" value={stats.enabled} />
            <PageStat label="在线观众" value={stats.readers} note="极速 + 兼容" />
          </PageStatStrip>

          {channels.length === 0 ? (
            <PageSurface>
              <EmptyState
                title="还没有渠道"
                description="点击右上角「新建渠道」创建第一个直播渠道。"
              />
            </PageSurface>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
              {channels.map((channel) => (
                <ChannelCard
                  key={channel.id}
                  channel={channel}
                  busy={busyIds.has(channel.id)}
                  onEdit={() => setDialog({ mode: 'edit', channel })}
                  onToggle={(enabled) => void handleToggle(channel, enabled)}
                  onDelete={() => void handleDelete(channel)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <ChannelFormDialog
        open={dialog?.mode === 'create'}
        onOpenChange={(open) => !open && setDialog(null)}
        mode="create"
        onSubmit={handleCreate}
      />
      <ChannelFormDialog
        open={dialog?.mode === 'edit'}
        onOpenChange={(open) => !open && setDialog(null)}
        mode="edit"
        initialValues={dialog?.mode === 'edit' ? dialog.channel : undefined}
        onSubmit={(values) =>
          dialog?.mode === 'edit' ? handleEdit(dialog.channel.id, values) : Promise.resolve()
        }
      />
    </PageShell>
  )
}
