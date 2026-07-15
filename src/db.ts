import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  Channel,
  ChannelRecord,
  ChannelUpdateInput,
  CommentRecord,
  CommentView,
} from "./types";
import { normalizeSlug, now, trimText } from "./utils";

function mapChannel(record: ChannelRecord): Channel {
  return {
    ...record,
    enabled: record.enabled === 1,
    recordingEnabled: record.recordingEnabled === 1,
  };
}

export class AppDatabase {
  private readonly db: Database.Database;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        publishPassword TEXT NOT NULL,
        viewerPassword TEXT NOT NULL,
        relayUrl TEXT NOT NULL DEFAULT '',
        relayStreamKey TEXT NOT NULL DEFAULT '',
        recordingEnabled INTEGER NOT NULL DEFAULT 0,
        recordingSegmentSeconds INTEGER NOT NULL DEFAULT 300,
        recordingBudgetMb INTEGER NOT NULL DEFAULT 2048,
        authVersion INTEGER NOT NULL DEFAULT 1,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channelId INTEGER NOT NULL,
        authorName TEXT NOT NULL,
        body TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY(channelId) REFERENCES channels(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_comments_channel_created
      ON comments(channelId, createdAt DESC);
    `);

    const channelColumns = this.db
      .prepare<[], { name: string }>("PRAGMA table_info(channels)")
      .all();
    const hasColumn = (name: string) => channelColumns.some((column) => column.name === name);

    // 迁移:为早于「转推」功能创建的旧库补上 relayUrl 列。
    if (!hasColumn("relayUrl")) {
      this.db.exec("ALTER TABLE channels ADD COLUMN relayUrl TEXT NOT NULL DEFAULT ''");
    }
    if (!hasColumn("relayStreamKey")) {
      this.db.exec("ALTER TABLE channels ADD COLUMN relayStreamKey TEXT NOT NULL DEFAULT ''");
    }
    if (!hasColumn("recordingEnabled")) {
      this.db.exec("ALTER TABLE channels ADD COLUMN recordingEnabled INTEGER NOT NULL DEFAULT 0");
    }
    if (!hasColumn("recordingSegmentSeconds")) {
      this.db.exec("ALTER TABLE channels ADD COLUMN recordingSegmentSeconds INTEGER NOT NULL DEFAULT 300");
    }
    if (!hasColumn("recordingBudgetMb")) {
      this.db.exec("ALTER TABLE channels ADD COLUMN recordingBudgetMb INTEGER NOT NULL DEFAULT 2048");
    }
  }

  listChannels(): Channel[] {
    const rows = this.db
      .prepare<[], ChannelRecord>("SELECT * FROM channels ORDER BY createdAt DESC, id DESC")
      .all();
    return rows.map(mapChannel);
  }

  getChannelById(id: number): Channel | null {
    const row = this.db.prepare<[number], ChannelRecord>("SELECT * FROM channels WHERE id = ?").get(id);
    return row ? mapChannel(row) : null;
  }

  getChannelBySlug(slug: string): Channel | null {
    const row = this.db
      .prepare<[string], ChannelRecord>("SELECT * FROM channels WHERE slug = ?")
      .get(normalizeSlug(slug));
    return row ? mapChannel(row) : null;
  }

  createChannel(input: {
    slug: string;
    label: string;
    publishPassword: string;
    viewerPassword: string;
    relayUrl: string;
    relayStreamKey: string;
    recordingEnabled: boolean;
    recordingSegmentSeconds: number;
    recordingBudgetMb: number;
    enabled: boolean;
  }): Channel {
    const timestamp = now();
    const stmt = this.db.prepare(`
      INSERT INTO channels (
        slug, label, enabled, publishPassword, viewerPassword, relayUrl, relayStreamKey,
        recordingEnabled, recordingSegmentSeconds, recordingBudgetMb,
        authVersion, createdAt, updatedAt
      )
      VALUES (
        @slug, @label, @enabled, @publishPassword, @viewerPassword, @relayUrl, @relayStreamKey,
        @recordingEnabled, @recordingSegmentSeconds, @recordingBudgetMb,
        @authVersion, @createdAt, @updatedAt
      )
    `);
    const info = stmt.run({
      slug: normalizeSlug(input.slug),
      label: trimText(input.label),
      enabled: input.enabled ? 1 : 0,
      publishPassword: input.publishPassword,
      viewerPassword: input.viewerPassword,
      relayUrl: input.relayUrl,
      relayStreamKey: input.relayStreamKey,
      recordingEnabled: input.recordingEnabled ? 1 : 0,
      recordingSegmentSeconds: input.recordingSegmentSeconds,
      recordingBudgetMb: input.recordingBudgetMb,
      authVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const channel = this.getChannelById(Number(info.lastInsertRowid));
    if (!channel) {
      throw new Error("failed to create channel");
    }
    return channel;
  }

  updateChannel(id: number, input: ChannelUpdateInput): { before: Channel; after: Channel } {
    const before = this.getChannelById(id);
    if (!before) {
      throw new Error("channel not found");
    }

    const slug = input.slug !== undefined ? normalizeSlug(input.slug) : before.slug;
    const label = input.label !== undefined ? trimText(input.label) : before.label;
    const publishPassword =
      input.publishPassword !== undefined ? input.publishPassword : before.publishPassword;
    const viewerPassword =
      input.viewerPassword !== undefined ? input.viewerPassword : before.viewerPassword;
    const relayUrl = input.relayUrl !== undefined ? input.relayUrl : before.relayUrl;
    const relayStreamKey =
      input.relayStreamKey !== undefined ? input.relayStreamKey : before.relayStreamKey;
    const recordingEnabled =
      input.recordingEnabled !== undefined ? input.recordingEnabled : before.recordingEnabled;
    const recordingSegmentSeconds =
      input.recordingSegmentSeconds !== undefined
        ? input.recordingSegmentSeconds
        : before.recordingSegmentSeconds;
    const recordingBudgetMb =
      input.recordingBudgetMb !== undefined ? input.recordingBudgetMb : before.recordingBudgetMb;
    const authVersion =
      slug !== before.slug || viewerPassword !== before.viewerPassword
        ? before.authVersion + 1
        : before.authVersion;

    this.db
      .prepare(`
        UPDATE channels
        SET slug = @slug,
            label = @label,
            publishPassword = @publishPassword,
            viewerPassword = @viewerPassword,
            relayUrl = @relayUrl,
            relayStreamKey = @relayStreamKey,
            recordingEnabled = @recordingEnabled,
            recordingSegmentSeconds = @recordingSegmentSeconds,
            recordingBudgetMb = @recordingBudgetMb,
            authVersion = @authVersion,
            updatedAt = @updatedAt
        WHERE id = @id
      `)
      .run({
        id,
        slug,
        label,
        publishPassword,
        viewerPassword,
        relayUrl,
        relayStreamKey,
        recordingEnabled: recordingEnabled ? 1 : 0,
        recordingSegmentSeconds,
        recordingBudgetMb,
        authVersion,
        updatedAt: now(),
      });

    const after = this.getChannelById(id);
    if (!after) {
      throw new Error("channel not found after update");
    }
    return { before, after };
  }

  setChannelEnabled(id: number, enabled: boolean): { before: Channel; after: Channel } {
    const before = this.getChannelById(id);
    if (!before) {
      throw new Error("channel not found");
    }
    if (before.enabled === enabled) {
      return { before, after: before };
    }

    this.db
      .prepare(`
        UPDATE channels
        SET enabled = @enabled,
            authVersion = authVersion + 1,
            updatedAt = @updatedAt
        WHERE id = @id
      `)
      .run({
        id,
        enabled: enabled ? 1 : 0,
        updatedAt: now(),
      });

    const after = this.getChannelById(id);
    if (!after) {
      throw new Error("channel not found after update");
    }
    return { before, after };
  }

  deleteChannel(id: number): Channel | null {
    const channel = this.getChannelById(id);
    if (!channel) {
      return null;
    }
    this.db.prepare("DELETE FROM channels WHERE id = ?").run(id);
    return channel;
  }

  addComment(channelId: number, authorName: string, body: string): CommentView {
    const createdAt = now();
    const stmt = this.db.prepare(`
      INSERT INTO comments (channelId, authorName, body, createdAt)
      VALUES (@channelId, @authorName, @body, @createdAt)
    `);
    const info = stmt.run({
      channelId,
      authorName: trimText(authorName),
      body: trimText(body),
      createdAt,
    });

    this.db.prepare(`
      DELETE FROM comments
      WHERE id IN (
        SELECT id FROM comments
        WHERE channelId = ?
        ORDER BY createdAt DESC, id DESC
        LIMIT -1 OFFSET 200
      )
    `).run(channelId);

    const row = this.db
      .prepare<
        [number],
        CommentRecord & { channelSlug: string }
      >(`
        SELECT comments.*, channels.slug AS channelSlug
        FROM comments
        JOIN channels ON channels.id = comments.channelId
        WHERE comments.id = ?
      `)
      .get(Number(info.lastInsertRowid));

    if (!row) {
      throw new Error("failed to create comment");
    }

    return {
      id: row.id,
      channelId: row.channelId,
      channelSlug: row.channelSlug,
      authorName: row.authorName,
      body: row.body,
      createdAt: row.createdAt,
    };
  }

  listRecentComments(channelId: number, limit: number): CommentView[] {
    const rows = this.db
      .prepare<
        [number, number],
        CommentRecord & { channelSlug: string }
      >(`
        SELECT comments.*, channels.slug AS channelSlug
        FROM comments
        JOIN channels ON channels.id = comments.channelId
        WHERE channelId = ?
        ORDER BY comments.createdAt DESC, comments.id DESC
        LIMIT ?
      `)
      .all(channelId, limit);

    return rows
      .reverse()
      .map((row: CommentRecord & { channelSlug: string }) => ({
        id: row.id,
        channelId: row.channelId,
        channelSlug: row.channelSlug,
        authorName: row.authorName,
        body: row.body,
        createdAt: row.createdAt,
      }));
  }
}
