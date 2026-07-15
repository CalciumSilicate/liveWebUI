import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Download,
  Film,
  Loader2,
  RefreshCw,
  Scissors,
  Star,
  Trash2,
  Video,
} from 'lucide-react'

import {
  deleteRecording,
  exportRecordingClip,
  listRecordings,
  updateRecording,
  type RecordingAsset,
  type RecordingLibrarySnapshot,
} from '@/api/admin'
import { ApiError } from '@/api/client'
import { PageLoader } from '@/components/PageLoader'
import { VideoPlayer } from '@/components/VideoPlayer'
import { PageShell, PageStat, PageStatStrip, PageSurface } from '@/components/layout/PageScaffold'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useConfirm } from '@/components/ui/use-confirm'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { cn } from '@/lib/utils'

const POLL_INTERVAL_MS = 8000

interface RecordingsPageProps {
  onUnauthorized: () => void
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / 1024 / 1024
  if (mb < 1024) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

function formatDateTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-'
  return new Date(ms).toLocaleString()
}

function formatDuration(seconds: number | null): string {
  if (!Number.isFinite(seconds ?? NaN) || seconds === null) return '-'
  const hour = Math.floor(seconds / 3600)
  const minute = Math.floor((seconds % 3600) / 60)
  const second = Math.floor(seconds % 60)
  if (hour > 0) return `${hour}:${minute.toString().padStart(2, '0')}:${second.toString().padStart(2, '0')}`
  return `${minute}:${second.toString().padStart(2, '0')}`
}

function canExport(asset: RecordingAsset | null, start: number | null, end: number | null): boolean {
  return Boolean(asset && start !== null && end !== null && Number.isFinite(start) && Number.isFinite(end) && end > start)
}

export default function RecordingsPage({ onUnauthorized }: RecordingsPageProps) {
  const confirm = useConfirm()
  const { showToast } = useGlobalToast()
  const videoRef = useRef<HTMLVideoElement>(null)

  const [snapshot, setSnapshot] = useState<RecordingLibrarySnapshot | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [channelFilter, setChannelFilter] = useState('all')
  const [kindFilter, setKindFilter] = useState<'all' | 'segment' | 'export'>('all')
  const [markedOnly, setMarkedOnly] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)

  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [marked, setMarked] = useState(false)
  const [inPoint, setInPoint] = useState<number | null>(null)
  const [outPoint, setOutPoint] = useState<number | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  const handleUnauthorized = useCallback((err: unknown): boolean => {
    if (err instanceof ApiError && err.status === 401) {
      onUnauthorized()
      return true
    }
    return false
  }, [onUnauthorized])

  const load = useCallback(async (silent: boolean) => {
    if (!silent) setRefreshing(true)
    try {
      const next = await listRecordings()
      setSnapshot(next)
      setError(null)
      if (selectedId && !next.assets.some((asset) => asset.id === selectedId)) {
        setSelectedId(next.assets[0]?.id ?? null)
      } else if (!selectedId && next.assets.length > 0) {
        setSelectedId(next.assets[0].id)
      }
    } catch (err) {
      if (handleUnauthorized(err)) return
      if (!silent) setError(err instanceof Error ? err.message : '录制文件加载失败')
    } finally {
      if (!silent) setRefreshing(false)
    }
  }, [handleUnauthorized, selectedId])

  useEffect(() => {
    void load(false)
    const timer = window.setInterval(() => void load(true), POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  const assets = snapshot?.assets ?? []
  const selected = assets.find((asset) => asset.id === selectedId) ?? null

  const filteredAssets = useMemo(() => {
    return assets.filter((asset) => {
      if (channelFilter !== 'all' && asset.channelSlug !== channelFilter) return false
      if (kindFilter !== 'all' && asset.kind !== kindFilter) return false
      if (markedOnly && !asset.marked) return false
      return true
    })
  }, [assets, channelFilter, kindFilter, markedOnly])

  const stats = useMemo(() => {
    return {
      total: assets.length,
      segments: assets.filter((asset) => asset.kind === 'segment').length,
      exports: assets.filter((asset) => asset.kind === 'export').length,
      bytes: assets.reduce((sum, asset) => sum + asset.sizeBytes, 0),
    }
  }, [assets])

  useEffect(() => {
    if (!selected) {
      setTitle('')
      setNote('')
      setMarked(false)
      setInPoint(null)
      setOutPoint(null)
      setCurrentTime(0)
      setDuration(0)
      return
    }
    setTitle(selected.title)
    setNote(selected.note)
    setMarked(selected.marked)
    setInPoint(selected.inPointSec)
    setOutPoint(selected.outPointSec)
    setCurrentTime(0)
  }, [selected?.id])

  const saveSelected = async (extra?: Partial<RecordingAsset>) => {
    if (!selected) return
    setSaving(true)
    try {
      const next = await updateRecording(selected.id, {
        title,
        note,
        marked,
        inPointSec: inPoint,
        outPointSec: outPoint,
        ...extra,
      })
      setSnapshot((prev) => prev ? {
        ...prev,
        assets: prev.assets.map((asset) => asset.id === next.id ? next : asset),
      } : prev)
      showToast('success', '录制信息已保存')
    } catch (err) {
      if (handleUnauthorized(err)) return
      showToast('error', err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const toggleMarked = async () => {
    if (!selected) return
    const nextMarked = !marked
    setMarked(nextMarked)
    await saveSelected({ marked: nextMarked })
  }

  const deleteSelected = async () => {
    if (!selected) return
    const ok = await confirm({
      title: `删除「${selected.title}」`,
      description: '删除后会移除本地视频文件和对应元数据，无法恢复。',
      confirmText: '删除',
      variant: 'destructive',
    })
    if (!ok) return
    try {
      await deleteRecording(selected.id)
      showToast('success', '录制文件已删除')
      setSelectedId(null)
      await load(true)
    } catch (err) {
      if (handleUnauthorized(err)) return
      showToast('error', err instanceof Error ? err.message : '删除失败')
    }
  }

  const exportClip = async () => {
    if (!selected || !canExport(selected, inPoint, outPoint)) return
    setExporting(true)
    try {
      const exported = await exportRecordingClip({
        sourceIds: filteredAssets
          .filter((asset) => asset.channelSlug === selected.channelSlug && asset.kind === 'segment')
          .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))
          .map((asset) => asset.id),
        startSec: inPoint as number,
        endSec: outPoint as number,
        title: title ? `${title}-切片` : `${selected.channelSlug}-切片`,
      })
      showToast('success', '切片已导出')
      await load(true)
      setSelectedId(exported.id)
    } catch (err) {
      if (handleUnauthorized(err)) return
      showToast('error', err instanceof Error ? err.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  if (!snapshot && !error) return <PageLoader />

  return (
    <PageShell
      title="录制"
      description="查看、删除、编辑录制分片；把同一渠道的录制分片按时间拼接后设置入点/出点导出切片。"
      width="full"
      actions={
        <Button variant="outline" className="gap-2" onClick={() => void load(false)} disabled={refreshing}>
          <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
          刷新
        </Button>
      }
    >
      {error && !snapshot ? (
        <PageSurface>
          <ErrorState message={error} onRetry={() => void load(false)} />
        </PageSurface>
      ) : assets.length === 0 ? (
        <PageSurface>
          <EmptyState title="还没有录制文件" description="在渠道里开启自动录制后，直播在线时会自动产生分片。" />
        </PageSurface>
      ) : (
        <div className="space-y-6">
          <PageStatStrip>
            <PageStat label="文件总数" value={stats.total} />
            <PageStat label="录制分片" value={stats.segments} />
            <PageStat label="导出切片" value={stats.exports} />
            <PageStat label="占用空间" value={formatBytes(stats.bytes)} />
          </PageStatStrip>

          <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
            <PageSurface
              title="文件库"
              description="按渠道、类型和标记筛选。"
              bodyClassName="space-y-3"
            >
              <div className="grid grid-cols-3 gap-2">
                <select
                  value={channelFilter}
                  onChange={(event) => setChannelFilter(event.target.value)}
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                >
                  <option value="all">全部渠道</option>
                  {snapshot?.channels.map((channel) => (
                    <option key={channel.slug} value={channel.slug}>{channel.slug}</option>
                  ))}
                </select>
                <select
                  value={kindFilter}
                  onChange={(event) => setKindFilter(event.target.value as 'all' | 'segment' | 'export')}
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                >
                  <option value="all">全部类型</option>
                  <option value="segment">录制分片</option>
                  <option value="export">导出切片</option>
                </select>
                <Button
                  type="button"
                  variant={markedOnly ? 'default' : 'outline'}
                  className="gap-1.5"
                  onClick={() => setMarkedOnly((value) => !value)}
                >
                  <Star className={cn('h-3.5 w-3.5', markedOnly && 'fill-current')} />
                  标记
                </Button>
              </div>

              <div className="max-h-[680px] space-y-2 overflow-y-auto pr-1">
                {filteredAssets.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">没有符合筛选的录制文件。</p>
                ) : (
                  filteredAssets.map((asset) => (
                    <button
                      key={asset.id}
                      type="button"
                      onClick={() => setSelectedId(asset.id)}
                      className={cn(
                        'w-full rounded-xl border p-3 text-left transition hover:bg-muted/50',
                        selected?.id === asset.id ? 'border-primary/70 bg-primary/5' : 'border-border/70 bg-background/70',
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                          {asset.kind === 'export' ? <Scissors className="h-4 w-4" /> : <Film className="h-4 w-4" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <p className="truncate text-sm font-medium">{asset.title}</p>
                            {asset.marked ? <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" /> : null}
                          </div>
                          <p className="truncate font-mono text-[11px] text-muted-foreground">{asset.name}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <Badge variant="outline" className="text-[11px]">{asset.channelSlug}</Badge>
                            <Badge variant={asset.kind === 'export' ? 'default' : 'secondary'} className="text-[11px]">
                              {asset.kind === 'export' ? '导出' : '分片'}
                            </Badge>
                            <span className="text-[11px] text-muted-foreground">{formatBytes(asset.sizeBytes)}</span>
                          </div>
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </PageSurface>

            <PageSurface
              title={selected ? selected.title : '预览'}
              description={selected ? `${selected.channelSlug} · ${selected.name}` : '选择一个录制文件开始编辑。'}
              actions={selected ? (
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant={marked ? 'default' : 'outline'} size="sm" className="gap-1.5" onClick={() => void toggleMarked()}>
                    <Star className={cn('h-3.5 w-3.5', marked && 'fill-current')} />
                    {marked ? '已标记' : '标记'}
                  </Button>
                  <a href={selected.downloadUrl} className="inline-flex">
                    <Button type="button" variant="outline" size="sm" className="gap-1.5">
                      <Download className="h-3.5 w-3.5" />
                      下载
                    </Button>
                  </a>
                  <Button type="button" variant="ghost" size="sm" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => void deleteSelected()}>
                    <Trash2 className="h-3.5 w-3.5" />
                    删除
                  </Button>
                </div>
              ) : null}
              bodyClassName="space-y-4"
            >
              {!selected ? (
                <div className="flex min-h-[520px] flex-col items-center justify-center gap-3 text-muted-foreground">
                  <Video className="h-10 w-10" />
                  <p className="text-sm">选择左侧录制文件。</p>
                </div>
              ) : (
                <>
                  <div className="overflow-hidden rounded-2xl border bg-black">
                    <VideoPlayer
                      key={selected.id}
                      ref={videoRef}
                      src={selected.url}
                      className="aspect-video w-full"
                      videoClassName="max-h-[70vh]"
                      onTimeSnapshot={(current, nextDuration) => {
                        setCurrentTime(current)
                        setDuration(nextDuration)
                      }}
                    />
                  </div>

                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
                    <div className="space-y-3 rounded-xl border bg-background/70 p-4">
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label htmlFor="recording-title">标题</Label>
                          <Input id="recording-title" value={title} onChange={(event) => setTitle(event.target.value)} />
                        </div>
                        <div className="space-y-1.5">
                          <Label>当前时间</Label>
                          <div className="flex h-10 items-center rounded-md border bg-muted/30 px-3 text-sm tabular-nums">
                            {formatDuration(currentTime)} / {formatDuration(duration)}
                          </div>
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="recording-note">备注</Label>
                        <Textarea
                          id="recording-note"
                          value={note}
                          onChange={(event) => setNote(event.target.value)}
                          rows={3}
                          placeholder="手动标记重点、素材说明或后续处理计划。"
                        />
                      </div>

                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label htmlFor="recording-in">入点(秒)</Label>
                          <div className="flex gap-2">
                            <Input
                              id="recording-in"
                              type="number"
                              min={0}
                              step="0.1"
                              value={inPoint ?? ''}
                              onChange={(event) => setInPoint(event.target.value === '' ? null : Number(event.target.value))}
                            />
                            <Button type="button" variant="outline" onClick={() => setInPoint(Number(currentTime.toFixed(1)))}>
                              取当前
                            </Button>
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="recording-out">出点(秒)</Label>
                          <div className="flex gap-2">
                            <Input
                              id="recording-out"
                              type="number"
                              min={0}
                              step="0.1"
                              value={outPoint ?? ''}
                              onChange={(event) => setOutPoint(event.target.value === '' ? null : Number(event.target.value))}
                            />
                            <Button type="button" variant="outline" onClick={() => setOutPoint(Number(currentTime.toFixed(1)))}>
                              取当前
                            </Button>
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Button type="button" className="gap-2" onClick={() => void saveSelected()} disabled={saving}>
                          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                          保存编辑
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="gap-2"
                          disabled={!canExport(selected, inPoint, outPoint) || exporting}
                          onClick={() => void exportClip()}
                        >
                          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
                          拼接并导出切片
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          当前切片: {formatDuration(inPoint)} - {formatDuration(outPoint)}
                        </span>
                      </div>
                    </div>

                    <div className="space-y-3 rounded-xl border bg-background/70 p-4 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">类型</span>
                        <Badge variant={selected.kind === 'export' ? 'default' : 'secondary'}>
                          {selected.kind === 'export' ? '导出切片' : '录制分片'}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">渠道</span>
                        <span className="font-mono">{selected.channelSlug}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">大小</span>
                        <span>{formatBytes(selected.sizeBytes)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">修改时间</span>
                        <span className="text-right">{formatDateTime(selected.mtimeMs)}</span>
                      </div>
                      <div className="rounded-lg bg-muted/35 p-3 text-xs text-muted-foreground">
                        导出时会按左侧筛选结果中同一渠道的录制分片，按时间顺序拼接为一条虚拟时间线，再按入点/出点切出 MP4。
                      </div>
                    </div>
                  </div>
                </>
              )}
            </PageSurface>
          </div>
        </div>
      )}
    </PageShell>
  )
}
