import { useState, type ReactNode } from 'react'
import { Check, Copy, HardDrive, Pencil, Radio, Trash2, Users, Video } from 'lucide-react'

import type { AdminChannel } from '@/api/admin'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'

/** 一行「标签 + 只读地址 + 复制按钮」,用于展示推流 / 观看地址。 */
function CopyLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await copyText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // 复制失败保持静默:地址仍完整显示,用户可手动选中复制。
    }
  }

  return (
    <div className="min-w-0 space-y-1">
      <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/30 px-2.5 py-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90">{value}</code>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={handleCopy}
          aria-label={`复制${label}`}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  )
}

/** 运行态小徽标:在线绿色,离线灰色。 */
function FlagBadge({ online, children }: { online: boolean; children: ReactNode }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'text-[11px] font-medium',
        online
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : 'text-muted-foreground',
      )}
    >
      {children}
    </Badge>
  )
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / 1024 / 1024
  if (mb < 1024) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

interface ChannelCardProps {
  channel: AdminChannel
  busy: boolean
  onEdit: () => void
  onToggle: (enabled: boolean) => void
  onDelete: () => void
}

export function ChannelCard({ channel, busy, onEdit, onToggle, onDelete }: ChannelCardProps) {
  const live = channel.sourceOnline

  return (
    <section
      className={cn(
        'flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 shadow-sm transition-opacity md:p-5',
        !channel.enabled && 'opacity-70',
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                live ? 'bg-emerald-500 shadow-[0_0_0_3px_hsl(var(--background)),0_0_0_5px_rgb(16_185_129/0.25)]' : 'bg-muted-foreground/40',
              )}
            />
            <h3 className="truncate text-base font-semibold tracking-tight">{channel.label}</h3>
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">{channel.slug}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">{channel.enabled ? '已启用' : '已停用'}</span>
          <Switch
            checked={channel.enabled}
            disabled={busy}
            onCheckedChange={onToggle}
            aria-label={channel.enabled ? '停用渠道' : '启用渠道'}
          />
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={live ? 'default' : 'secondary'} className="text-[11px]">
          {channel.state}
        </Badge>
        <FlagBadge online={channel.sourceOnline}>源 {channel.sourceOnline ? '在线' : '离线'}</FlagBadge>
        <FlagBadge online={channel.webrtcOnline}>极速 {channel.webrtcReaders}</FlagBadge>
        <FlagBadge online={channel.hlsOnline}>兼容 {channel.hlsReaders}</FlagBadge>
        <Badge variant="outline" className="gap-1 text-[11px] text-muted-foreground">
          <Users className="h-3 w-3" />
          {channel.readers}
        </Badge>
        {channel.relayConfigured ? (
          <Badge
            variant="outline"
            className={cn(
              'gap-1 text-[11px] font-medium',
              channel.relaying
                ? 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                : 'text-muted-foreground',
            )}
          >
            <Radio className="h-3 w-3" />
            {channel.relaying ? '转推中' : '转推待命'}
          </Badge>
        ) : null}
        {channel.recording.enabled ? (
          <Badge
            variant="outline"
            className={cn(
              'gap-1 text-[11px] font-medium',
              channel.recording.active
                ? 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
                : 'text-muted-foreground',
            )}
          >
            <Video className="h-3 w-3" />
            {channel.recording.active ? '录制中' : '录制待命'}
          </Badge>
        ) : null}
      </div>

      <div className="grid gap-3">
        <CopyLine label="推流地址" value={channel.pushUrl} />
        <CopyLine label="观看地址" value={channel.watchUrl} />
        {channel.relayConfigured ? <CopyLine label="转推地址" value={channel.relayUrl} /> : null}
        {channel.relayStreamKey ? <CopyLine label="转推码" value={channel.relayStreamKey} /> : null}
        {channel.recording.enabled ? (
          <div className="rounded-lg border bg-muted/20 px-2.5 py-2 text-xs text-muted-foreground">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground/80">
              <HardDrive className="h-3.5 w-3.5" />
              录制: {formatBytes(channel.recording.usedBytes)} / {formatBytes(channel.recording.budgetBytes)}
            </div>
            <div className="truncate">
              {channel.recording.fileCount} 个分片 · 每 {channel.recording.segmentSeconds} 秒 ·{' '}
              {channel.recording.latestFile ? channel.recording.latestFile.name : '暂无文件'}
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t pt-3">
        <div className="text-[11px] text-muted-foreground">观看码:{channel.viewerPassword}</div>
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onEdit} disabled={busy}>
            <Pencil className="h-3.5 w-3.5" />
            编辑
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            disabled={busy}
            aria-label="删除渠道"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </section>
  )
}
