import Hls from 'hls.js'

import type { ChannelView, ViewerMode } from '@/api/watch'
import { nsKey } from '@/config'
import { MediaMTXWebRTCReader } from '@/lib/webrtc-reader'

/**
 * 观看页播放控制器 —— 把 WebRTC(极速)/HLS(兼容)双路播放、失败回退、断线重连
 * 这类命令式逻辑从 React 里剥出来,直接操作一个 <video> 元素。
 *
 * 设计沿用旧实现:每次切换播放自增 generation,异步回调用 generation 判活,避免旧的
 * 播放尝试污染新的会话。React 侧只需:创建时给它 video 元素与取 token 的函数,轮询到
 * 新的频道状态就调 updateChannel,用户点模式切换就调 setMode。
 */

const FALLBACK_TIMEOUT_MS = 3500

interface PlayerCallbacks {
  /** 取当前观看 token(用于 HLS 鉴权头与 WebRTC WHEP)。 */
  getToken: () => string
  /** 播放提示文案变化(如「极速连接中」「已切兼容」),空串表示无提示。 */
  onNote: (note: string) => void
  /** 当前生效的播放模式变化,用于高亮模式按钮。 */
  onModeChange: (mode: ViewerMode | '') => void
}

function modeStorageKey(slug: string): string {
  return nsKey(`mode:${slug}`)
}

export class PlayerController {
  private readonly video: HTMLVideoElement
  private readonly cb: PlayerCallbacks
  private readonly slug: string

  private channel: ChannelView | null = null
  private currentMode: ViewerMode | '' = ''
  private preferredMode: ViewerMode
  private generation = 0
  private rtcReader: InstanceType<typeof MediaMTXWebRTCReader> | null = null
  private hls: Hls | null = null
  private fallbackTimer: number | null = null

  constructor(video: HTMLVideoElement, slug: string, cb: PlayerCallbacks) {
    this.video = video
    this.slug = slug
    this.cb = cb
    const stored = window.localStorage.getItem(modeStorageKey(slug))
    this.preferredMode = stored === 'hls' ? 'hls' : 'webrtc'
  }

  /** 用最新频道状态驱动播放:离线则清理,在线则按偏好选路并在需要时(重新)起播。 */
  updateChannel(channel: ChannelView): void {
    this.channel = channel

    if (!channel.sourceOnline) {
      this.cleanup()
      this.cb.onNote('')
      this.setMode('')
      return
    }

    const resolved = this.resolveMode(channel)
    if (!this.hasActivePlayback() || this.currentMode !== resolved) {
      void this.activate(resolved, false)
    }
  }

  /** 用户手动切换模式,记住偏好。 */
  selectMode(mode: ViewerMode): void {
    if (!this.channel) return
    void this.activate(mode, true)
  }

  destroy(): void {
    this.cleanup()
  }

  private setMode(mode: ViewerMode | ''): void {
    if (this.currentMode !== mode) {
      this.currentMode = mode
      this.cb.onModeChange(mode)
    }
  }

  private resolveMode(channel: ChannelView): ViewerMode {
    if (this.preferredMode === 'webrtc' && channel.modes.webrtc.available) return 'webrtc'
    if (this.preferredMode === 'hls' && channel.modes.hls.available) return 'hls'
    return channel.defaultMode || (channel.modes.webrtc.available ? 'webrtc' : 'hls')
  }

  private hasActivePlayback(): boolean {
    return Boolean(this.rtcReader || this.hls || this.video.srcObject || this.video.getAttribute('src'))
  }

  private cleanup(): void {
    this.generation += 1

    if (this.fallbackTimer !== null) {
      window.clearTimeout(this.fallbackTimer)
      this.fallbackTimer = null
    }
    if (this.rtcReader) {
      this.rtcReader.close()
      this.rtcReader = null
    }
    if (this.hls) {
      this.hls.destroy()
      this.hls = null
    }

    this.video.pause()
    this.video.srcObject = null
    this.video.removeAttribute('src')
    this.video.load()
    this.video.muted = true
  }

  private tryPlay(): void {
    const promise = this.video.play()
    if (promise && typeof promise.catch === 'function') {
      promise.catch(() => {})
    }
  }

  private async activate(mode: ViewerMode, persist: boolean): Promise<void> {
    if (!this.channel) return

    this.setMode(mode)
    if (persist) {
      this.preferredMode = mode
      window.localStorage.setItem(modeStorageKey(this.slug), mode)
    }

    this.cleanup()

    if (!this.channel.sourceOnline) {
      this.cb.onNote('')
      return
    }

    const generation = this.generation
    if (mode === 'webrtc' && this.channel.modes.webrtc.available) {
      this.startWebRtc(this.channel, generation)
      return
    }
    if (this.channel.modes.hls.available) {
      this.startHls(this.channel, generation)
      return
    }
    this.cb.onNote('不可用')
  }

  private startWebRtc(channel: ChannelView, generation: number): void {
    this.cb.onNote('极速连接中')

    let trackSeen = false
    const fallback = () => {
      if (generation !== this.generation || this.currentMode !== 'webrtc') return
      this.cb.onNote('已切兼容')
      void this.activate('hls', false)
    }

    this.fallbackTimer = window.setTimeout(() => {
      if (!trackSeen) fallback()
    }, FALLBACK_TIMEOUT_MS)

    const fallbackStream = new MediaStream()

    this.rtcReader = new MediaMTXWebRTCReader({
      url: channel.modes.webrtc.whepUrl,
      token: this.cb.getToken(),
      onError: (err: string) => {
        if (generation !== this.generation || this.currentMode !== 'webrtc') return
        console.error(err)
        if (!trackSeen) fallback()
        else this.cb.onNote('极速波动')
      },
      onTrack: (evt: RTCTrackEvent) => {
        if (generation !== this.generation) return

        trackSeen = true
        if (this.fallbackTimer !== null) {
          window.clearTimeout(this.fallbackTimer)
          this.fallbackTimer = null
        }

        if (evt.streams && evt.streams[0]) {
          this.video.srcObject = evt.streams[0]
        } else {
          fallbackStream.addTrack(evt.track)
          this.video.srcObject = fallbackStream
        }

        this.cb.onNote('')
        this.tryPlay()
      },
    })
  }

  private startHls(channel: ChannelView, generation: number): void {
    const playlistUrl = channel.modes.hls.playlistUrl
    if (!playlistUrl) {
      this.cb.onNote('兼容不可用')
      return
    }

    this.cb.onNote('')

    // 优先用 hls.js(MSE)。桌面 Chrome 对 canPlayType('application/vnd.apple.mpegurl')
    // 会返回 "maybe" 却根本不能原生播 HLS —— 所以不能先看 canPlayType,必须 hls.js 优先,
    // 原生分支只留给真正支持的 Safari / iOS(那里 Hls.isSupported() 为 false)。
    if (Hls.isSupported()) {
      const hls = new Hls({
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 4,
        maxBufferLength: 2,
        backBufferLength: 10,
        enableWorker: true,
        xhrSetup: (xhr) => {
          xhr.setRequestHeader('Authorization', `Bearer ${this.cb.getToken()}`)
        },
      })
      this.hls = hls

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (generation !== this.generation) return
        if (data?.fatal) this.cb.onNote('兼容异常')
      })
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (generation === this.generation) this.tryPlay()
      })

      hls.loadSource(playlistUrl)
      hls.attachMedia(this.video)
      return
    }

    // Safari / iOS:原生 HLS,鉴权走同源 Cookie(原生请求无法自定义 header)。
    if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.video.src = playlistUrl
      this.video.addEventListener(
        'loadedmetadata',
        () => {
          if (generation === this.generation) this.tryPlay()
        },
        { once: true },
      )
      return
    }

    this.cb.onNote('兼容不可用')
  }
}
