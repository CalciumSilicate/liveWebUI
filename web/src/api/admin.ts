import { apiRequest } from '@/api/client'

/**
 * 管理台接口 —— 会话 + 渠道 CRUD。
 *
 * 管理台鉴权走后端下发的 httpOnly Cookie(admin_session),前端不持有 token,
 * apiRequest 已 `credentials: 'same-origin'` 自动携带 Cookie。
 */

/** 后端 `/api/admin/channels` 返回的渠道行:数据库字段 + 运行态 + 推拉流地址。 */
export interface AdminChannel {
  id: number
  slug: string
  label: string
  enabled: boolean
  publishPassword: string
  viewerPassword: string
  relayUrl: string
  authVersion: number
  createdAt: number
  updatedAt: number
  pushUrl: string
  watchUrl: string
  online: boolean
  readers: number
  state: string
  sourceOnline: boolean
  hlsOnline: boolean
  webrtcOnline: boolean
  hlsReaders: number
  webrtcReaders: number
  relayConfigured: boolean
  relaying: boolean
}

export interface ChannelCreateInput {
  slug: string
  label: string
  publishPassword: string
  viewerPassword: string
  relayUrl: string
  enabled: boolean
}

export interface ChannelUpdateInput {
  slug?: string
  label?: string
  publishPassword?: string
  viewerPassword?: string
  relayUrl?: string
}

export async function getAdminSession(): Promise<boolean> {
  const result = await apiRequest<{ authenticated: boolean }>('/admin/session')
  return Boolean(result.authenticated)
}

export async function adminLogin(password: string): Promise<void> {
  await apiRequest('/admin/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
}

export async function adminLogout(): Promise<void> {
  await apiRequest('/admin/logout', { method: 'POST', body: '{}' })
}

export function listChannels(): Promise<AdminChannel[]> {
  return apiRequest<AdminChannel[]>('/admin/channels')
}

export function createChannel(input: ChannelCreateInput): Promise<AdminChannel> {
  return apiRequest<AdminChannel>('/admin/channels', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateChannel(id: number, input: ChannelUpdateInput): Promise<AdminChannel> {
  return apiRequest<AdminChannel>(`/admin/channels/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export function setChannelEnabled(id: number, enabled: boolean): Promise<AdminChannel> {
  return apiRequest<AdminChannel>(`/admin/channels/${id}/${enabled ? 'enable' : 'disable'}`, {
    method: 'POST',
    body: '{}',
  })
}

export function deleteChannel(id: number): Promise<{ ok: boolean }> {
  return apiRequest<{ ok: boolean }>(`/admin/channels/${id}`, { method: 'DELETE' })
}
