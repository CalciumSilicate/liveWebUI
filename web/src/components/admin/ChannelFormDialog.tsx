import { FormEvent, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

export interface ChannelFormValues {
  label: string
  slug: string
  publishPassword: string
  viewerPassword: string
  relayUrl: string
  enabled: boolean
}

const EMPTY: ChannelFormValues = {
  label: '',
  slug: '',
  publishPassword: '',
  viewerPassword: '',
  relayUrl: '',
  enabled: true,
}

interface ChannelFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'create' | 'edit'
  initialValues?: Partial<ChannelFormValues>
  /** 提交处理:抛错时对话框内展示错误信息;成功时由外层关闭对话框。 */
  onSubmit: (values: ChannelFormValues) => Promise<void>
}

/**
 * 新建 / 编辑渠道对话框。字段与后端校验一致:slug 为 3-32 位小写字母/数字/连字符。
 * 编辑态不含「启用」开关 —— 启停是独立操作,由卡片上的开关处理。
 */
export function ChannelFormDialog({
  open,
  onOpenChange,
  mode,
  initialValues,
  onSubmit,
}: ChannelFormDialogProps) {
  const [values, setValues] = useState<ChannelFormValues>(EMPTY)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 每次打开时用 initialValues 重置表单。
  useEffect(() => {
    if (open) {
      setValues({ ...EMPTY, ...initialValues })
      setError('')
      setSubmitting(false)
    }
  }, [open, initialValues])

  const patch = (part: Partial<ChannelFormValues>) => setValues((prev) => ({ ...prev, ...part }))

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await onSubmit({
        ...values,
        slug: values.slug.trim().toLowerCase(),
        label: values.label.trim(),
        relayUrl: values.relayUrl.trim(),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{mode === 'create' ? '新建渠道' : '编辑渠道'}</DialogTitle>
            <DialogDescription>
              推流码用于 OBS/FFmpeg 推流鉴权,观看码用于观众进入观看页。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="channel-label">名称</Label>
              <Input
                id="channel-label"
                value={values.label}
                onChange={(e) => patch({ label: e.target.value })}
                placeholder="例如:一号直播间"
                maxLength={40}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="channel-slug">Slug</Label>
              <Input
                id="channel-slug"
                value={values.slug}
                onChange={(e) => patch({ slug: e.target.value })}
                placeholder="3-32 位小写字母 / 数字 / -"
                maxLength={32}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="channel-publish">推流码</Label>
                <Input
                  id="channel-publish"
                  value={values.publishPassword}
                  onChange={(e) => patch({ publishPassword: e.target.value })}
                  maxLength={64}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="channel-viewer">观看码</Label>
                <Input
                  id="channel-viewer"
                  value={values.viewerPassword}
                  onChange={(e) => patch({ viewerPassword: e.target.value })}
                  maxLength={64}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="channel-relay">转推目标 RTMP(可选)</Label>
              <Input
                id="channel-relay"
                value={values.relayUrl}
                onChange={(e) => patch({ relayUrl: e.target.value })}
                placeholder="rtmp://目标服务器/app/串流码"
              />
              <p className="text-xs text-muted-foreground">
                填写后,本平台会把该直播间的流原样转推到此地址(如 B 站 / 抖音 / YouTube);留空则不转推。
              </p>
            </div>
            {mode === 'create' ? (
              <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2.5">
                <div className="space-y-0.5">
                  <Label htmlFor="channel-enabled">创建后立即启用</Label>
                  <p className="text-xs text-muted-foreground">停用状态下观众无法进入、推流会被拒绝。</p>
                </div>
                <Switch
                  id="channel-enabled"
                  checked={values.enabled}
                  onCheckedChange={(checked) => patch({ enabled: checked })}
                />
              </div>
            ) : null}
          </div>

          {error ? <p className="mb-2 text-sm text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              取消
            </Button>
            <Button type="submit" className="gap-2" disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {mode === 'create' ? '创建' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
