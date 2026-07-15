import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Maximize, Minimize, Pause, Play, Volume2, VolumeX } from 'lucide-react'

import { nsKey } from '@/config'
import { cn } from '@/lib/utils'

const VOLUME_KEY = nsKey('player-volume')

function readStoredVolume(): number {
  if (typeof window === 'undefined') return 0.15
  const raw = window.localStorage.getItem(VOLUME_KEY)
  const value = raw === null ? 0.15 : Number(raw)
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.15
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const hour = Math.floor(seconds / 3600)
  const minute = Math.floor((seconds % 3600) / 60)
  const second = Math.floor(seconds % 60)
  if (hour > 0) {
    return `${hour}:${minute.toString().padStart(2, '0')}:${second.toString().padStart(2, '0')}`
  }
  return `${minute}:${second.toString().padStart(2, '0')}`
}

export interface VideoPlayerProps {
  src?: string
  className?: string
  videoClassName?: string
  loop?: boolean
  autoPlay?: boolean
  muted?: boolean
  preload?: HTMLVideoElement['preload']
  overlay?: ReactNode
  onTimeSnapshot?: (current: number, duration: number) => void
}

export const VideoPlayer = forwardRef<HTMLVideoElement, VideoPlayerProps>(function VideoPlayer(
  {
    src,
    className,
    videoClassName,
    loop,
    autoPlay = true,
    muted: initialMuted = false,
    preload = 'metadata',
    overlay,
    onTimeSnapshot,
  },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<number | null>(null)

  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [volume, setVolume] = useState(readStoredVolume)
  const [muted, setMuted] = useState(initialMuted)
  const [fullscreen, setFullscreen] = useState(false)
  const [showControls, setShowControls] = useState(true)

  useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement)

  const reveal = useCallback(() => {
    setShowControls(true)
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) setShowControls(false)
    }, 2600)
  }, [])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play()
    else video.pause()
  }, [])

  const seekTo = useCallback((ratio: number) => {
    const video = videoRef.current
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return
    video.currentTime = Math.max(0, Math.min(1, ratio)) * video.duration
    reveal()
  }, [reveal])

  const handleProgressPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const seek = (clientX: number) => seekTo((clientX - rect.left) / rect.width)
    seek(event.clientX)
    const onMove = (moveEvent: PointerEvent) => seek(moveEvent.clientX)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const toggleMute = () => {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
    setMuted(video.muted)
    reveal()
  }

  const changeVolume = (value: number) => {
    const video = videoRef.current
    if (video) {
      video.volume = value
      video.muted = value === 0
    }
    setVolume(value)
    setMuted(value === 0)
    window.localStorage.setItem(VOLUME_KEY, String(value))
    reveal()
  }

  const toggleFullscreen = () => {
    const container = containerRef.current
    if (!container) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void container.requestFullscreen()
  }

  useEffect(() => {
    const onFullscreen = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFullscreen)
    return () => document.removeEventListener('fullscreenchange', onFullscreen)
  }, [])

  useEffect(() => () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const video = videoRef.current
      if (!video) return
      if (event.key === ' ') {
        event.preventDefault()
        togglePlay()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        video.currentTime = Math.max(0, video.currentTime - 5)
        reveal()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        video.currentTime = Math.min(video.duration || video.currentTime, video.currentTime + 5)
        reveal()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reveal, togglePlay])

  const progress = duration > 0 ? (current / duration) * 100 : 0
  const bufferedPct = duration > 0 ? (buffered / duration) * 100 : 0

  return (
    <div
      ref={containerRef}
      className={cn('group relative flex items-center justify-center overflow-hidden bg-black text-white', className)}
      onMouseMove={reveal}
      onMouseLeave={() => {
        if (videoRef.current && !videoRef.current.paused) setShowControls(false)
      }}
    >
      <video
        ref={videoRef}
        src={src}
        className={cn('block h-full w-full bg-black object-contain', videoClassName)}
        autoPlay={autoPlay}
        loop={loop}
        muted={muted}
        playsInline
        preload={preload}
        onClick={togglePlay}
        onPlay={() => {
          setPlaying(true)
          reveal()
        }}
        onPause={() => {
          setPlaying(false)
          setShowControls(true)
        }}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget
          setDuration(Number.isFinite(video.duration) ? video.duration : 0)
          video.volume = muted ? 0 : volume
          video.muted = muted
          onTimeSnapshot?.(video.currentTime || 0, Number.isFinite(video.duration) ? video.duration : 0)
        }}
        onTimeUpdate={(event) => {
          const video = event.currentTarget
          const nextCurrent = video.currentTime || 0
          const nextDuration = Number.isFinite(video.duration) ? video.duration : 0
          setCurrent(nextCurrent)
          setDuration(nextDuration)
          onTimeSnapshot?.(nextCurrent, nextDuration)
        }}
        onProgress={(event) => {
          const video = event.currentTarget
          if (video.buffered.length) setBuffered(video.buffered.end(video.buffered.length - 1))
        }}
        onEnded={() => {
          setPlaying(false)
          setShowControls(true)
        }}
      />

      {overlay}

      {!playing ? (
        <button
          type="button"
          onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center bg-black/15 transition hover:bg-black/25"
          aria-label="播放"
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-black/55 text-white shadow-xl backdrop-blur-sm">
            <Play className="ml-1 h-8 w-8" />
          </span>
        </button>
      ) : null}

      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/45 to-transparent px-3 pb-3 pt-12 transition-opacity duration-200',
          showControls ? 'opacity-100' : 'opacity-0',
        )}
      >
        <div className="pointer-events-auto">
          <div className="group/bar relative mb-2 flex h-3 cursor-pointer items-center" onPointerDown={handleProgressPointer}>
            <div className="relative h-1 w-full rounded-full bg-white/25">
              <div className="absolute inset-y-0 left-0 rounded-full bg-white/30" style={{ width: `${bufferedPct}%` }} />
              <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${progress}%` }} />
              <div
                className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary opacity-0 shadow transition-opacity group-hover/bar:opacity-100"
                style={{ left: `${progress}%` }}
              />
            </div>
          </div>

          <div className="flex items-center gap-3 text-white">
            <button type="button" onClick={togglePlay} aria-label={playing ? '暂停' : '播放'} className="transition hover:text-primary">
              {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
            </button>

            <div className="group/vol flex items-center gap-1.5">
              <button type="button" onClick={toggleMute} aria-label="静音" className="transition hover:text-primary">
                {muted || volume === 0 ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(event) => changeVolume(Number(event.target.value))}
                aria-label="音量"
                className="h-1 w-0 cursor-pointer accent-primary opacity-0 transition-all duration-200 group-hover/vol:w-16 group-hover/vol:opacity-100"
              />
            </div>

            <span className="text-xs tabular-nums text-white/90">
              {formatTime(current)} / {formatTime(duration)}
            </span>

            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label={fullscreen ? '退出全屏' : '全屏'}
              className="ml-auto transition hover:text-primary"
            >
              {fullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </div>

      <div className={cn('pointer-events-none absolute inset-x-0 bottom-0 h-[3px] bg-white/15 transition-opacity duration-300', showControls ? 'opacity-0' : 'opacity-100')}>
        <div className="h-full bg-sky-500" style={{ width: `${progress}%` }} />
      </div>
    </div>
  )
})
