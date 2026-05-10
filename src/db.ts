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
    enabled: boolean;
  }): Channel {
    const timestamp = now();
    const stmt = this.db.prepare(`
      INSERT INTO channels (
        slug, label, enabled, publishPassword, viewerPassword, authVersion, createdAt, updatedAt
      )
      VALUES (@slug, @label, @enabled, @publishPassword, @viewerPassword, @authVersion, @createdAt, @updatedAt)
    `);
    const info = stmt.run({
      slug: normalizeSlug(input.slug),
      label: trimText(input.label),
      enabled: input.enabled ? 1 : 0,
      publishPassword: input.publishPassword,
      viewerPassword: input.viewerPassword,
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
