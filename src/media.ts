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
    await this.request(`/v3/rtmpconns/kick/${id}`, {
      method: "POST",
    });
  }

  async kickChannelPublishers(slug: string): Promise<void> {
    const connections = await this.listRtmpConnections();
    const targetIds = connections
      .filter((connection) => connection.path === slug)
      .map((connection) => connection.id);

    await Promise.all(targetIds.map((id) => this.kickRtmpConnection(id)));
  }
}
