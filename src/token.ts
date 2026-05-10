import { AdminTokenPayload, ViewerTokenPayload } from "./types";
import { fromBase64Url, now, signValue, toBase64Url } from "./utils";

function encode<T extends object>(secret: string, payload: T): string {
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = signValue(secret, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function decode<T extends { exp: number; kind: string }>(
  secret: string,
  token: string,
  kind: T["kind"],
): T | null {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }
  if (signValue(secret, encodedPayload) !== signature) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload)) as T;
    if (payload.kind !== kind) {
      return null;
    }
    if (payload.exp <= Math.floor(now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function createAdminToken(secret: string): string {
  return encode<AdminTokenPayload>(secret, {
    kind: "admin",
    exp: Math.floor(now() / 1000) + 60 * 60 * 24 * 7,
  });
}

export function verifyAdminToken(secret: string, token: string): AdminTokenPayload | null {
  return decode<AdminTokenPayload>(secret, token, "admin");
}

export function createViewerToken(secret: string, slug: string, authVersion: number): string {
  return encode<ViewerTokenPayload>(secret, {
    kind: "viewer",
    slug,
    authVersion,
    exp: Math.floor(now() / 1000) + 60 * 60 * 24,
  });
}

export function verifyViewerToken(secret: string, token: string): ViewerTokenPayload | null {
  return decode<ViewerTokenPayload>(secret, token, "viewer");
}
