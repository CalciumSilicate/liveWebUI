import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Loader2, LogIn, Radio, Send } from 'lucide-react'

import {
  clearStoredToken,
  commentsSocketUrl,
  getChannel,
  getComments,
  getStoredToken,
  requestAccess,
  type ChannelView,
  type CommentView,
  type ViewerMode,
} from '@/api/watch'
import { PageLoader } from '@/components/PageLoader'
import { ThemeToggleButton } from '@/components/theme'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { BRAND_NAME, nsKey } from '@/config'
import { PlayerController } from '@/lib/player-controller'
import { cn } from '@/lib/utils'

const POLL_INTERVAL_MS = 5000
const AUTHOR_KEY = nsKey('author')

const MODE_LABELS: Array<{ key: ViewerMode; label: string }> = [
  { key: 'webrtc', label: '极速' },
  { key: 'hls', label: '兼容' },
]

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function Watch() {
  const { slug = '' } = useParams()

  const [checking, setChecking] = useState(true)
  const [authorized, setAuthorized] = useState(false)
  const [channel, setChannel] = useState<ChannelView | null>(null)
  const [note, setNote] = useState('')
  const [activeMode, setActiveMode] = useState<ViewerMode | ''>('')

  const [password, setPassword] = useState('')
  const [accessError, setAccessError] = useState('')
  const [accessSubmitting, setAccessSubmitting] = useState(false)

  const [comments, setComments] = useState<CommentView[]>([])
  const [author, setAuthor] = useState('')
  const [commentText, setCommentText] = useState('')
  const [commentError, setCommentError] = useState('')

  const videoRef = useRef<HTMLVideoElement>(null)
  const controllerRef = useRef<PlayerController | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const tokenRef = useRef('')
  const channelRef = useRef<ChannelView | null>(null)
  const composingRef = useRef(false)
  const commentsEndRef = useRef<HTMLDivElement>(null)

  const setChannelBoth = useCallback((next: ChannelView | null) => {
    channelRef.current = next
    setChannel(next)
  }, [])

  const setTokenBoth = useCallback((next: string) => {
    tokenRef.current = next
  }, [])

  // 观看会话失效:清理 token / 播放 / 评论,退回观看码输入态。
  const resetAccess = useCallback(
    (message: string) => {
      clearStoredToken(slug)
      setTokenBoth('')
      setAuthorized(false)
      setChannelBoth(null)
      setNote('')
      setActiveMode('')
      setComments([])
      setAccessError(message)
      wsRef.current?.close()
      wsRef.current = null
      controllerRef.current?.destroy()
      controllerRef.current = null
    },
    [slug, setChannelBoth, setTokenBoth],
  )

  useEffect(() => {
    setAuthor(window.localStorage.getItem(AUTHOR_KEY) ?? '')
  }, [])

  useEffect(() => {
    document.title = channel?.label ? `${channel.label} · ${BRAND_NAME}` : `观看 · ${BRAND_NAME}`
  }, [channel?.label])

  // 首屏:若 sessionStorage 有 token 就验证一次,通过则直接进入观看。
  useEffect(() => {
    const stored = getStoredToken(slug)
    if (!stored) {
      setChecking(false)
      return
    }
    let cancelled = false
    getChannel(slug, stored)
      .then((ch) => {
        if (cancelled) return
        setTokenBoth(stored)
        setChannelBoth(ch)
        setAuthorized(true)
      })
      .catch(() => {
        if (!cancelled) clearStoredToken(slug)
      })
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => {
      cancelled = true
    }
  }, [slug, setChannelBoth, setTokenBoth])

  // 授权后创建播放控制器,并把已知的频道状态推给它起播。
  useEffect(() => {
    if (!authorized) return
    const video = videoRef.current
    if (!video) return

    const controller = new PlayerController(video, slug, {
      getToken: () => tokenRef.current,
      onNote: setNote,
      onModeChange: setActiveMode,
    })
    controllerRef.current = controller
    if (channelRef.current) controller.updateChannel(channelRef.current)

    return () => {
      controller.destroy()
      controllerRef.current = null
    }
  }, [authorized, slug])

  // 授权后轮询频道状态,驱动播放与在线态刷新。
  useEffect(() => {
    if (!authorized) return
    let cancelled = false
    const poll = async () => {
      try {
        const ch = await getChannel(slug, tokenRef.current)
        if (cancelled) return
        setChannelBoth(ch)
        controllerRef.current?.updateChannel(ch)
      } catch (err) {
        if (cancelled) return
        resetAccess(err instanceof Error ? err.message : '连接已断开,请重新进入')
      }
    }
    void poll()
    const timer = window.setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [authorized, slug, resetAccess, setChannelBoth])

  // 授权后加载历史评论并建立实时 WebSocket。
  useEffect(() => {
    if (!authorized) return
    let cancelled = false

    getComments(slug, tokenRef.current)
      .then((list) => {
        if (!cancelled) setComments(list)
      })
      .catch(() => {})

    const ws = new WebSocket(commentsSocketUrl(slug, tokenRef.current))
    wsRef.current = ws

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data)
        if (payload.type === 'comment') {
          setComments((prev) => [...prev, payload.comment as CommentView])
        } else if (payload.type === 'error') {
          setCommentError('发送失败')
        }
      } catch {
        setCommentError('连接异常')
      }
    }

    ws.onclose = (event) => {
      const wasActive = wsRef.current === ws
      wsRef.current = null
      if (cancelled || !wasActive) return
      const message =
        event.code === 4001 || event.code === 4003 ? '请重新进入' : '评论连接已断开,请重新进入'
      resetAccess(message)
    }

    return () => {
      cancelled = true
      if (wsRef.current === ws) wsRef.current = null
      ws.close()
    }
  }, [authorized, slug, resetAccess])

  // 新评论到达时滚到底部。
  useEffect(() => {
    commentsEndRef.current?.scrollIntoView({ block: 'end' })
  }, [comments])

  const handleAccess = async (event: FormEvent) => {
    event.preventDefault()
    setAccessError('')
    setAccessSubmitting(true)
    try {
      const result = await requestAccess(slug, password)
      setTokenBoth(result.token)
      setChannelBoth(result.channel)
      setAuthorized(true)
      setPassword('')
    } catch (err) {
      setAccessError(err instanceof Error ? err.message : '访问被拒绝')
    } finally {
      setAccessSubmitting(false)
    }
  }

  const sendComment = () => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setCommentError(
        ws?.readyState === WebSocket.CONNECTING ? '评论连接中,请稍后' : '评论未连接,请重新进入',
      )
      return
    }
    const name = author.trim()
    const body = commentText.trim()
    if (!name || !body) {
      setCommentError('名字和评论不能为空')
      return
    }
    window.localStorage.setItem(AUTHOR_KEY, name)
    ws.send(JSON.stringify({ type: 'comment', authorName: name, body }))
    setCommentText('')
    setCommentError('')
  }

  const handleCommentKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter') return
    if (event.shiftKey || event.nativeEvent.isComposing || composingRef.current) return
    event.preventDefault()
    sendComment()
  }

  if (checking) return <PageLoader />

  const live = Boolean(channel?.sourceOnline)

  return (
    <div className="flex min-h-screen flex-col bg-muted/30 lg:h-screen lg:min-h-0 lg:overflow-hidden">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b bg-background px-4 md:px-6">
        <div className="dashboard-brand-mark flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-md shadow-primary/25">
          <Radio className="h-5 w-5" />
        </div>
        <h1 className="truncate text-base font-semibold tracking-tight md:text-lg">
          {channel?.label || slug}
        </h1>
        {authorized ? (
          <Badge
            variant={live ? 'default' : 'secondary'}
            className={cn('ml-1', live && 'bg-emerald-500 text-white hover:bg-emerald-500')}
          >
            {live ? '直播中' : '未直播'}
          </Badge>
        ) : null}
        <div className="ml-auto">
          <ThemeToggleButton />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4 md:p-6 lg:min-h-0 lg:overflow-hidden">
        {!authorized ? (
          <div className="flex flex-1 items-center justify-center">
            <form
              onSubmit={handleAccess}
              className="glass-card w-full max-w-sm rounded-2xl p-6"
            >
              <div className="mb-5 space-y-1">
                <h2 className="text-lg font-semibold tracking-tight">输入观看码</h2>
                <p className="text-sm text-muted-foreground">该直播需要观看码才能进入。</p>
              </div>
              {/* 隐藏用户名字段,便于密码管理器归档。 */}
              <input type="text" name="username" autoComplete="username" value={slug} readOnly hidden />
              <div className="space-y-2">
                <Label htmlFor="viewer-password">观看码</Label>
                <Input
                  id="viewer-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  autoFocus
                />
              </div>
              {accessError ? <p className="mt-3 text-sm text-destructive">{accessError}</p> : null}
              <Button type="submit" className="mt-5 w-full gap-2" disabled={accessSubmitting || !password}>
                {accessSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                进入观看
              </Button>
            </form>
          </div>
        ) : (
          <div className="grid flex-1 gap-4 lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_360px]">
            {/* 播放区 */}
            <div className="flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto">
              <div className="relative aspect-video overflow-hidden rounded-xl border bg-black shadow-sm">
                <video
                  ref={videoRef}
                  className="h-full w-full bg-black"
                  controls
                  playsInline
                  muted
                  autoPlay
                  preload="metadata"
                />
                {!live ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-sm text-white/80">
                    未直播
                  </div>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1 rounded-md border border-border/70 bg-background/80 p-0.5">
                  {MODE_LABELS.map(({ key, label }) => {
                    const available = Boolean(channel?.modes[key].available)
                    return (
                      <Button
                        key={key}
                        type="button"
                        size="sm"
                        variant={activeMode === key ? 'default' : 'ghost'}
                        className="h-7 rounded-md px-3 text-xs"
                        disabled={!available}
                        onClick={() => controllerRef.current?.selectMode(key)}
                      >
                        {label}
                      </Button>
                    )
                  })}
                </div>
                {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
              </div>
            </div>

            {/* 评论区 */}
            <aside className="flex h-[70vh] flex-col overflow-hidden rounded-xl border bg-card shadow-sm lg:h-auto lg:min-h-0">
              <div className="border-b p-3">
                <Input
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  placeholder="你的名字"
                  maxLength={24}
                />
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
                {comments.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">还没有评论,来说点什么。</p>
                ) : (
                  comments.map((comment) => (
                    <div key={comment.id} className="space-y-0.5">
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-medium text-foreground">{comment.authorName}</span>
                        <span className="text-[11px] text-muted-foreground">{formatTime(comment.createdAt)}</span>
                      </div>
                      <p className="break-words text-sm text-foreground/90">{comment.body}</p>
                    </div>
                  ))
                )}
                <div ref={commentsEndRef} />
              </div>

              <div className="space-y-2 border-t p-3">
                <Textarea
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  onKeyDown={handleCommentKeyDown}
                  onCompositionStart={() => {
                    composingRef.current = true
                  }}
                  onCompositionEnd={() => {
                    composingRef.current = false
                  }}
                  rows={2}
                  maxLength={200}
                  placeholder="发条评论,Enter 发送"
                  className="resize-none"
                />
                {commentError ? <p className="text-xs text-destructive">{commentError}</p> : null}
                <Button type="button" className="w-full gap-2" onClick={sendComment}>
                  <Send className="h-4 w-4" />
                  发送
                </Button>
              </div>
            </aside>
          </div>
        )}
      </main>
    </div>
  )
}
