import { MediaPath, MediaRtmpConn } from "./types";

type ListResponse<T> = {
  items: T[];
};

export class MediaService {
  constructor(private readonly apiUrl: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.apiUrl}${path}`, init);
    if (!response.ok) {
      throw new Error(`MediaMTX API ${path} failed: ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async listPaths(): Promise<MediaPath[]> {
    const response = await this.request<ListResponse<MediaPath>>("/v3/paths/list");
    return response.items ?? [];
  }

  async getPath(name: string): Promise<MediaPath | null> {
    try {
      return await this.request<MediaPath>(`/v3/paths/get/${encodeURIComponent(name)}`);
    } catch {
      return null;
    }
  }

  async listRtmpConnections(): Promise<MediaRtmpConn[]> {
    const response = await this.request<ListResponse<MediaRtmpConn>>("/v3/rtmpconns/list");
    return response.items ?? [];
  }

  async kickRtmpConnection(id: string): Promise<void> {
    await this.request(`/v3/rtmpconns/kick/${encodeURIComponent(id)}`, {
      method: "POST",
    });
  }

  async kickChannelPublishers(slug: string): Promise<void> {
    const connections = await this.listRtmpConnections();
    // 仅踢推流连接;转码进程作为 reader 也连在同一 path 上,不能一并踢掉。
    const targetIds = connections
      .filter((connection) => connection.path === slug && connection.state === "publish")
      .map((connection) => connection.id);

    // 尽力踢掉全部推流连接,单个失败不影响其余,但仍向调用方上报失败。
    const results = await Promise.allSettled(
      targetIds.map((id) => this.kickRtmpConnection(id)),
    );
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) {
      throw new Error(`failed to kick ${failed}/${targetIds.length} publisher(s) for ${slug}`);
    }
  }
}
