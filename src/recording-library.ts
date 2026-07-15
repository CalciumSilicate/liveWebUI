import { spawn, spawnSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { FastifyReply } from "fastify";
import type { FastifyBaseLogger } from "fastify";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv"]);
const ISO_BMFF_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".m4a", ".3gp", ".3g2", ".mj2"]);
const META_EXTENSION = ".json";
const MP4_ATOM_SCAN_LIMIT = 512 * 1024 * 1024;

export type RecordingAssetKind = "segment" | "export";

export type RecordingAssetMeta = {
  title: string;
  note: string;
  marked: boolean;
  inPointSec: number | null;
  outPointSec: number | null;
  updatedAt: number;
};

export type RecordingAsset = {
  id: string;
  channelSlug: string;
  kind: RecordingAssetKind;
  name: string;
  title: string;
  note: string;
  marked: boolean;
  inPointSec: number | null;
  outPointSec: number | null;
  sizeBytes: number;
  mtimeMs: number;
  createdAtMs: number;
  url: string;
  downloadUrl: string;
};

export type RecordingChannelLibrary = {
  slug: string;
  segmentCount: number;
  exportCount: number;
  usedBytes: number;
  latestFile: RecordingAsset | null;
};

export type RecordingLibrarySnapshot = {
  channels: RecordingChannelLibrary[];
  assets: RecordingAsset[];
};

type ClipExportInput = {
  sourceIds: string[];
  startSec: number;
  endSec: number;
  title?: string;
};

type RecordingLibraryOptions = {
  rootDir: string;
  ffmpegBin: string;
  logger: FastifyBaseLogger;
};

type ProbeCacheEntry = {
  size: number;
  mtimeMs: number;
  ok: boolean;
};

function now(): number {
  return Date.now();
}

function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.has(extname(name).toLowerCase());
}

function readUInt64BE(buffer: Buffer, offset: number): number {
  const high = buffer.readUInt32BE(offset);
  const low = buffer.readUInt32BE(offset + 4);
  return high * 2 ** 32 + low;
}

function hasMoovAtom(file: string, size: number): boolean {
  if (size < 16) return false;
  const fd = openSync(file, "r");
  const header = Buffer.alloc(16);
  let offset = 0;
  try {
    while (offset + 8 <= size && offset < MP4_ATOM_SCAN_LIMIT) {
      const read = readSync(fd, header, 0, 16, offset);
      if (read < 8) return false;

      const atomSize32 = header.readUInt32BE(0);
      const atomType = header.toString("ascii", 4, 8);
      let atomSize = atomSize32;
      let headerSize = 8;

      if (atomSize32 === 1) {
        if (read < 16) return false;
        atomSize = readUInt64BE(header, 8);
        headerSize = 16;
      } else if (atomSize32 === 0) {
        atomSize = size - offset;
      }

      if (atomType === "moov") return true;
      if (!Number.isFinite(atomSize) || atomSize < headerSize) return false;
      offset += atomSize;
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

function isFinalizedVideoFile(name: string, file: string, size: number): boolean {
  if (!isVideoFile(name)) return false;
  if (!ISO_BMFF_EXTENSIONS.has(extname(name).toLowerCase())) return true;
  return hasMoovAtom(file, size);
}

function safeBaseName(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80) || "clip";
}

function defaultMeta(): RecordingAssetMeta {
  return {
    title: "",
    note: "",
    marked: false,
    inPointSec: null,
    outPointSec: null,
    updatedAt: 0,
  };
}

function parseAssetId(id: string): { slug: string; kind: RecordingAssetKind; name: string } | null {
  const parts = id.split("/");
  if (parts.length !== 3) return null;
  const [slug, kind, name] = parts;
  if (!slug || (kind !== "segment" && kind !== "export") || !name || name.includes("/") || name.includes("\\")) {
    return null;
  }
  return { slug, kind, name };
}

function toAssetId(slug: string, kind: RecordingAssetKind, name: string): string {
  return `${slug}/${kind}/${name}`;
}

function rangeHeader(range: string | undefined, size: number): { start: number; end: number } | null {
  if (!range) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return null;
  const rawStart = match[1];
  const rawEnd = match[2];
  if (!rawStart && !rawEnd) return null;

  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

export class RecordingLibrary {
  private readonly probeCache = new Map<string, ProbeCacheEntry>();

  constructor(private readonly options: RecordingLibraryOptions) {
    mkdirSync(options.rootDir, { recursive: true });
  }

  list(): RecordingLibrarySnapshot {
    const assets: RecordingAsset[] = [];
    const channels: RecordingChannelLibrary[] = [];

    for (const slug of this.channelSlugs()) {
      const channelAssets = [
        ...this.listKind(slug, "segment"),
        ...this.listKind(slug, "export"),
      ].sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));

      const segmentCount = channelAssets.filter((asset) => asset.kind === "segment").length;
      const exportCount = channelAssets.filter((asset) => asset.kind === "export").length;
      const usedBytes = channelAssets.reduce((sum, asset) => sum + asset.sizeBytes, 0);

      if (channelAssets.length > 0) {
        channels.push({
          slug,
          segmentCount,
          exportCount,
          usedBytes,
          latestFile: channelAssets[0] ?? null,
        });
        assets.push(...channelAssets);
      }
    }

    channels.sort((a, b) => (b.latestFile?.mtimeMs ?? 0) - (a.latestFile?.mtimeMs ?? 0));
    assets.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
    return { channels, assets };
  }

  get(id: string): RecordingAsset | null {
    const parsed = parseAssetId(id);
    if (!parsed) return null;
    return this.assetFromFile(parsed.slug, parsed.kind, parsed.name);
  }

  patch(id: string, input: Partial<RecordingAssetMeta>): RecordingAsset | null {
    const asset = this.get(id);
    if (!asset) return null;
    const meta = {
      ...this.readMeta(asset.channelSlug, asset.kind, asset.name),
      ...this.normalizeMetaPatch(input),
      updatedAt: now(),
    };
    this.writeMeta(asset.channelSlug, asset.kind, asset.name, meta);
    return this.get(id);
  }

  delete(id: string): boolean {
    const parsed = parseAssetId(id);
    if (!parsed) return false;
    const file = this.filePath(parsed.slug, parsed.kind, parsed.name);
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    rmSync(this.metaPath(parsed.slug, parsed.kind, parsed.name), { force: true });
    return true;
  }

  async exportClip(input: ClipExportInput): Promise<RecordingAsset> {
    if (input.sourceIds.length === 0) {
      throw new Error("至少选择一个录制分片");
    }
    if (!Number.isFinite(input.startSec) || !Number.isFinite(input.endSec) || input.endSec <= input.startSec) {
      throw new Error("入点/出点无效");
    }

    const sources = input.sourceIds
      .map((id) => this.get(id))
      .filter((asset): asset is RecordingAsset => Boolean(asset));
    if (sources.length !== input.sourceIds.length) {
      throw new Error("录制分片不存在");
    }

    const slug = sources[0].channelSlug;
    if (!sources.every((asset) => asset.channelSlug === slug)) {
      throw new Error("不能跨渠道导出切片");
    }

    sources.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));

    const exportDir = this.kindDir(slug, "export");
    mkdirSync(exportDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
    const base = safeBaseName(input.title || `${slug}-${stamp}`);
    const outputName = `${base}-${stamp}.mp4`;
    const outputPath = join(exportDir, outputName);

    const concatList = join(exportDir, `${outputName}.concat.txt`);
    const concatBody = sources
      .map((asset) => `file '${this.filePath(asset.channelSlug, asset.kind, asset.name).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
      .join("\n");
    writeFileSync(concatList, concatBody, "utf8");

    try {
      await this.runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatList,
        "-ss",
        String(Math.max(0, input.startSec)),
        "-to",
        String(Math.max(0, input.endSec)),
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        outputPath,
      ]);
    } catch (error) {
      rmSync(outputPath, { force: true });
      rmSync(this.metaPath(slug, "export", outputName), { force: true });
      throw error;
    } finally {
      rmSync(concatList, { force: true });
    }

    const meta = defaultMeta();
    meta.title = input.title?.trim() || base;
    meta.inPointSec = Math.max(0, input.startSec);
    meta.outPointSec = Math.max(0, input.endSec);
    meta.updatedAt = now();
    this.writeMeta(slug, "export", outputName, meta);

    const asset = this.assetFromFile(slug, "export", outputName);
    if (!asset) throw new Error("导出失败");
    return asset;
  }

  sendFile(reply: FastifyReply, id: string, range: string | undefined, download: boolean): FastifyReply | null {
    const asset = this.get(id);
    if (!asset) return null;
    const file = this.filePath(asset.channelSlug, asset.kind, asset.name);
    const stats = statSync(file);
    const type = "video/mp4";

    reply.header("accept-ranges", "bytes");
    reply.header("content-type", type);
    reply.header("cache-control", "private, max-age=0");
    if (download) {
      reply.header("content-disposition", `attachment; filename="${encodeURIComponent(asset.name)}"`);
    }

    if (range) {
      const parsed = rangeHeader(range, stats.size);
      if (!parsed) {
        reply.header("content-range", `bytes */${stats.size}`);
        return reply.code(416).send();
      }
      const { start, end } = parsed;
      reply.header("content-length", String(end - start + 1));
      reply.header("content-range", `bytes ${start}-${end}/${stats.size}`);
      return reply.code(206).send(createReadStream(file, { start, end }));
    }

    reply.header("content-length", String(stats.size));
    return reply.send(createReadStream(file));
  }

  private channelSlugs(): string[] {
    try {
      return readdirSync(this.options.rootDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith("."))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  private listKind(slug: string, kind: RecordingAssetKind): RecordingAsset[] {
    const dir = this.kindDir(slug, kind);
    try {
      return readdirSync(dir)
        .filter(isVideoFile)
        .map((name) => this.assetFromFile(slug, kind, name))
        .filter((asset): asset is RecordingAsset => Boolean(asset));
    } catch {
      return [];
    }
  }

  private assetFromFile(slug: string, kind: RecordingAssetKind, name: string): RecordingAsset | null {
    const file = this.filePath(slug, kind, name);
    if (!existsSync(file) || !isVideoFile(name)) return null;
    const stats = statSync(file);
    if (!this.isReadableAsset(name, file, stats.size, stats.mtimeMs)) return null;
    const meta = this.readMeta(slug, kind, name);
    const id = toAssetId(slug, kind, name);
    return {
      id,
      channelSlug: slug,
      kind,
      name,
      title: meta.title || basename(name, extname(name)),
      note: meta.note,
      marked: meta.marked,
      inPointSec: meta.inPointSec,
      outPointSec: meta.outPointSec,
      sizeBytes: stats.size,
      mtimeMs: stats.mtimeMs,
      createdAtMs: stats.birthtimeMs,
      url: `/api/admin/recordings/${encodeURIComponent(id)}/media`,
      downloadUrl: `/api/admin/recordings/${encodeURIComponent(id)}/download`,
    };
  }

  private kindDir(slug: string, kind: RecordingAssetKind): string {
    if (kind === "segment") return resolve(this.options.rootDir, slug);
    return resolve(this.options.rootDir, slug, "exports");
  }

  private filePath(slug: string, kind: RecordingAssetKind, name: string): string {
    const file = resolve(this.kindDir(slug, kind), name);
    const root = resolve(this.options.rootDir);
    if (file !== root && !file.startsWith(root + sep)) {
      throw new Error("invalid path");
    }
    return file;
  }

  private metaPath(slug: string, kind: RecordingAssetKind, name: string): string {
    return `${this.filePath(slug, kind, name)}${META_EXTENSION}`;
  }

  private readMeta(slug: string, kind: RecordingAssetKind, name: string): RecordingAssetMeta {
    const path = this.metaPath(slug, kind, name);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RecordingAssetMeta>;
      return { ...defaultMeta(), ...this.normalizeMetaPatch(parsed), updatedAt: Number(parsed.updatedAt ?? 0) || 0 };
    } catch {
      return defaultMeta();
    }
  }

  private writeMeta(slug: string, kind: RecordingAssetKind, name: string, meta: RecordingAssetMeta): void {
    const path = this.metaPath(slug, kind, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(meta, null, 2), "utf8");
  }

  private normalizeMetaPatch(input: Partial<RecordingAssetMeta>): Partial<RecordingAssetMeta> {
    const patch: Partial<RecordingAssetMeta> = {};
    if (input.title !== undefined) patch.title = String(input.title).trim().slice(0, 120);
    if (input.note !== undefined) patch.note = String(input.note).trim().slice(0, 1000);
    if (input.marked !== undefined) patch.marked = input.marked === true;
    if (input.inPointSec !== undefined) {
      const value = Number(input.inPointSec);
      patch.inPointSec = Number.isFinite(value) && value >= 0 ? value : null;
    }
    if (input.outPointSec !== undefined) {
      const value = Number(input.outPointSec);
      patch.outPointSec = Number.isFinite(value) && value >= 0 ? value : null;
    }
    return patch;
  }

  private isReadableAsset(name: string, file: string, size: number, mtimeMs: number): boolean {
    if (!isFinalizedVideoFile(name, file, size)) return false;
    const extension = extname(name).toLowerCase();
    if (!ISO_BMFF_EXTENSIONS.has(extension)) return true;

    const cached = this.probeCache.get(file);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
      return cached.ok;
    }

    const ok = this.ffprobeReadable(file);
    this.probeCache.set(file, { size, mtimeMs, ok });
    return ok;
  }

  private ffprobeReadable(file: string): boolean {
    const result = spawnSync(
      this.options.ffmpegBin.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1"),
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
      { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 },
    );
    return result.status === 0;
  }

  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.options.ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          resolvePromise();
        } else {
          this.options.logger.warn({ code, stderr }, "clip export ffmpeg failed");
          reject(new Error(stderr.trim() || "ffmpeg 导出失败"));
        }
      });
    });
  }
}
