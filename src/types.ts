export type ChannelRecord = {
  id: number;
  slug: string;
  label: string;
  enabled: number;
  publishPassword: string;
  viewerPassword: string;
  relayUrl: string;
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
  // 转推目标 RTMP 完整地址(含推流码);空字符串表示不转推。
  relayUrl: string;
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
