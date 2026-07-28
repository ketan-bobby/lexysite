/**
 * storage-region.ts — Region-prefixed object storage paths (Phase 0)
 *
 * Wraps the existing single-bucket layout in a region-aware façade so that
 * when Phase 1 splits buckets per region (lexy-us, lexy-in, lexy-eu in their
 * respective AWS regions), the change is one file instead of every upload
 * site in the codebase.
 *
 * Today:
 *   bucketFor("us") → process.env.S3_BUCKET (single bucket)
 *   keyFor("us", "resumes/abc.pdf") → "us/resumes/abc.pdf"  (prefix in key)
 *
 * Phase 1:
 *   bucketFor("us") → "lexy-us-east-1"
 *   bucketFor("in") → "lexy-ap-south-1"
 *   keyFor("us", k) → k                 (no prefix; bucket is region-scoped)
 *
 * Reading existing objects: the prefix-in-key form for Phase 0 means
 * pre-existing objects (no prefix) live alongside new region-prefixed ones.
 * When we cut over to per-region buckets, a one-shot migration script
 * copies objects into their region bucket and drops the prefix.
 */
import type { Region } from "./region";

const DEFAULT_BUCKET = process.env.S3_BUCKET || process.env.OBJECT_STORAGE_BUCKET || "lexy-uploads";

/** Return the bucket name for the given region. Single-bucket today. */
export function bucketFor(_region: Region): string {
  return DEFAULT_BUCKET;
}

/**
 * Build a region-prefixed key from a raw key. Idempotent: passing a key that
 * already starts with `${region}/` returns it unchanged so callers can be
 * sloppy and the helper still produces the right path.
 */
export function keyFor(region: Region, rawKey: string): string {
  const prefix = `${region}/`;
  const k = rawKey.replace(/^\/+/, "");
  return k.startsWith(prefix) ? k : prefix + k;
}

/** Convenience: full s3:// URI for the given region + raw key. */
export function uriFor(region: Region, rawKey: string): string {
  return `s3://${bucketFor(region)}/${keyFor(region, rawKey)}`;
}
