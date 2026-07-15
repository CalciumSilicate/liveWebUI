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
  relayStreamKey: string
  recordingEnabled: boolean
  recordingSegmentSeconds: number
  recordingBudgetMb: number
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
  recording: {
    enabled: boolean
    active: boolean
    segmentSeconds: number
    budgetMb: number
    usedBytes: number
    budgetBytes: number
    fileCount: number
    directory: string
    latestFile: {
      name: string
      path: string
      sizeBytes: number
      mtimeMs: number
    } | null
  }
}

export interface ChannelCreateInput {
  slug: string
  label: string
  publishPassword: string
  viewerPassword: string
  relayUrl: string
  relayStreamKey: string
  recordingEnabled: boolean
  recordingSegmentSeconds: number
  recordingBudgetMb: number
  enabled: boolean
}

export interface ChannelUpdateInput {
  slug?: string
  label?: string
  publishPassword?: string
  viewerPassword?: string
  relayUrl?: string
  relayStreamKey?: string
  recordingEnabled?: boolean
  recordingSegmentSeconds?: number
  recordingBudgetMb?: number
}

export interface RecordingAsset {
  id: string
  channelSlug: string
  kind: 'segment' | 'export'
  name: string
  title: string
  note: string
  marked: boolean
  inPointSec: number | null
  outPointSec: number | null
  sizeBytes: number
  mtimeMs: number
  createdAtMs: number
  url: string
  downloadUrl: string
}

export interface RecordingLibrarySnapshot {
  channels: Array<{
    slug: string
    segmentCount: number
    exportCount: number
    usedBytes: number
    latestFile: RecordingAsset | null
  }>
  assets: RecordingAsset[]
}

export interface RecordingAssetPatch {
  title?: string
  note?: string
  marked?: boolean
  inPointSec?: number | null
  outPointSec?: number | null
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

export function listRecordings(): Promise<RecordingLibrarySnapshot> {
  return apiRequest<RecordingLibrarySnapshot>('/admin/recordings')
}

export function updateRecording(id: string, input: RecordingAssetPatch): Promise<RecordingAsset> {
  return apiRequest<RecordingAsset>(`/admin/recordings/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export function deleteRecording(id: string): Promise<{ ok: boolean }> {
  return apiRequest<{ ok: boolean }>(`/admin/recordings/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export function exportRecordingClip(input: {
  sourceIds: string[]
  startSec: number
  endSec: number
  title?: string
}): Promise<RecordingAsset> {
  return apiRequest<RecordingAsset>('/admin/recordings/export', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}
