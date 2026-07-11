import { apiRequest } from '@/api/client'
import { nsKey } from '@/config'

/**
 * 观看页接口 —— 凭观看码换取 token,再用 token 拉状态 / 评论 / 建立 WebSocket。
 *
 * 观看鉴权是「每渠道一个 token」:后端在 /access 时同时下发 httpOnly Cookie(供
 * 媒体代理 /media/* 自动携带)与一份 token 字符串(供评论 WS 与 WebRTC WHEP 显式携带,
 * 这两处无法依赖 Cookie)。token 存 sessionStorage,刷新页面后仍可恢复播放与评论。
 */

export type ViewerMode = 'webrtc' | 'hls'

export interface ChannelView {
  slug: string
  label: string
  enabled: boolean
  sourceOnline: boolean
  webrtcOnline: boolean
  hlsOnline: boolean
  readers: number
  defaultMode: ViewerMode
  modes: {
    webrtc: { available: boolean; online: boolean; whepUrl: string }
    hls: { available: boolean; online: boolean; playlistUrl: string }
  }
}

export interface CommentView {
  id: number
  channelId: number
  channelSlug: string
  authorName: string
  body: string
  createdAt: number
}

function tokenKey(slug: string): string {
  return nsKey(`viewer:${slug}`)
}

export function getStoredToken(slug: string): string {
  if (typeof window === 'undefined') return ''
  return window.sessionStorage.getItem(tokenKey(slug)) || ''
}

export function setStoredToken(slug: string, token: string): void {
  window.sessionStorage.setItem(tokenKey(slug), token)
}

export function clearStoredToken(slug: string): void {
  window.sessionStorage.removeItem(tokenKey(slug))
}

function bearer(token: string): HeadersInit {
  return token ? { authorization: `Bearer ${token}` } : {}
}

export interface AccessResult {
  token: string
  channel: ChannelView
}

export async function requestAccess(slug: string, password: string): Promise<AccessResult> {
  const result = await apiRequest<AccessResult>(`/public/channels/${slug}/access`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
  setStoredToken(slug, result.token)
  return result
}

export function getChannel(slug: string, token: string): Promise<ChannelView> {
  return apiRequest<ChannelView>(`/public/channels/${slug}`, { headers: bearer(token) })
}

export function getComments(slug: string, token: string): Promise<CommentView[]> {
  return apiRequest<CommentView[]>(`/public/channels/${slug}/comments`, { headers: bearer(token) })
}

/** 评论 WebSocket 地址(token 走 query,因为 WS 握手无法自定义头部)。 */
export function commentsSocketUrl(slug: string, token: string): string {
  const url = new URL(
    `/ws/comments?channel=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`,
    window.location.origin,
  )
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}
