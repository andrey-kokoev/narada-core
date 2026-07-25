import { createHash } from "node:crypto";
import type { Sha256Digest } from "./contracts.js";

type JsonPrimitive = string | number | boolean | null;
type CanonicalValue = JsonPrimitive | CanonicalValue[] | { [key: string]: CanonicalValue };

function normalize(value: unknown, inArray = false): CanonicalValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not support non-finite numbers");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item, true) ?? null);
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(record).sort()) {
      const item = normalize(record[key], false);
      if (item !== undefined) normalized[key] = item;
    }
    return normalized;
  }
  if (inArray) return null;
  return undefined;
}

export function canonicalJson(value: unknown): string {
  const normalized = normalize(value);
  if (normalized === undefined) {
    throw new TypeError("Top-level canonical value must be JSON-serializable");
  }
  return JSON.stringify(normalized);
}

export function sha256Bytes(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function semanticDigest(value: unknown): Sha256Digest {
  return sha256Bytes(canonicalJson(value));
}

export function digestHex(digest: Sha256Digest): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(digest);
  if (!match) throw new TypeError(`Invalid SHA-256 digest: ${digest}`);
  return match[1];
}
