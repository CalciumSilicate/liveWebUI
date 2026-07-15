export type ChannelRecord = {
  id: number;
  slug: string;
  label: string;
  enabled: number;
  publishPassword: string;
  viewerPassword: string;
  relayUrl: string;
  relayStreamKey: string;
  recordingEnabled: number;
  recordingSegmentSeconds: number;
  recordingBudgetMb: number;
  authVersion: number;
  createdAt: number;
  updatedAt: number;
};

export type Channel = {
  id: number;
  slug: string;
  label: string;
  enabled: boolean;
  publishPassword: string;
  viewerPassword: string;
  // 转推服务器地址;空字符串表示不转推。旧数据可能仍包含完整推流地址。
  relayUrl: string;
  // 平台提供的转推推流码;运行时与 relayUrl 组合。
  relayStreamKey: string;
  // 自动录制配置:源流在线时按分片写入本地 recordings 目录,并按预算滚动清理。
  recordingEnabled: boolean;
  recordingSegmentSeconds: number;
  recordingBudgetMb: number;
  authVersion: number;
  createdAt: number;
  updatedAt: number;
};

export type ChannelUpdateInput = {
  slug?: string;
  label?: string;
  publishPassword?: string;
  viewerPassword?: string;
  relayUrl?: string;
  relayStreamKey?: string;
  recordingEnabled?: boolean;
  recordingSegmentSeconds?: number;
  recordingBudgetMb?: number;
};

export type CommentRecord = {
  id: number;
  channelId: number;
  authorName: string;
  body: string;
  createdAt: number;
};

export type CommentView = {
  id: number;
  channelId: number;
  channelSlug: string;
  authorName: string;
  body: string;
  createdAt: number;
};

export type ViewerTokenPayload = {
  slug: string;
  authVersion: number;
  exp: number;
  kind: "viewer";
};

export type AdminTokenPayload = {
  exp: number;
  kind: "admin";
};

export type MediaPath = {
  name: string;
  available: boolean;
  online: boolean;
  readers?: Array<{ id: string; type: string }>;
};

export type MediaRtmpConn = {
  id: string;
  path: string;
  state: string;
};

export type ChannelRuntime = {
  sourceOnline: boolean;
  playbackOnline: boolean;
  readers: number;
};

export type RecordingFile = {
  name: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
};

export type RecordingStats = {
  enabled: boolean;
  active: boolean;
  segmentSeconds: number;
  budgetMb: number;
  usedBytes: number;
  budgetBytes: number;
  fileCount: number;
  directory: string;
  latestFile: RecordingFile | null;
};
