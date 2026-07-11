import { apiRequestCompleted, apiRequestFailed, apiRequestStarted } from '@/lib/logger'

/**
 * 统一的 HTTP 客户端 —— 所有 api/*.ts 模块都应通过 `apiRequest` 发请求,
 * 不要在业务代码里直接 fetch。它集中处理:
 *   - `/api` 前缀与 JSON 头
 *   - 同源 Cookie 携带(管理台会话与观看凭证都走 httpOnly Cookie)
 *   - x-request-id 透传 + 结构化请求日志(见 lib/logger)
 *   - 非 2xx 统一抛出 ApiError(带 status,方便上层区分 401 等)
 *
 * 观看页的部分接口需要额外带 `Authorization: Bearer <观看 token>`;
 * 由 api/watch.ts 在 init.headers 里显式注入,client 本身不持有任何 token。
 */

const API_BASE = '/api'

/** 后端返回非 2xx 时抛出;`status` 让调用方能区分 401 / 404 等。 */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method || 'GET'
  const { requestId, startedAt } = apiRequestStarted(path, method)
  let status = 0
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      credentials: 'same-origin',
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-request-id': requestId,
        ...init?.headers,
      },
    })
    status = response.status
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const message = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`
      throw new ApiError(message, response.status)
    }
    apiRequestCompleted(path, method, requestId, startedAt, response.status)
    return payload as T
  } catch (error) {
    apiRequestFailed(path, method, requestId, startedAt, error, status)
    throw error
  }
}
