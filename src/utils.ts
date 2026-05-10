import { createHmac, timingSafeEqual } from "node:crypto";

export function now(): number {
  return Date.now();
}

export function toBase64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

export function fromBase64Url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

export function signValue(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}

export function validateSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$|^[a-z0-9]{3,32}$/.test(value);
}

export function trimText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function formatShortDate(timestamp: number): string {
  return new Date(timestamp).toISOString();
}
