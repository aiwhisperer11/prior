import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** See docs/aws-s3-audit-storage.md for the design and current status. */
export interface AuditArtifact {
  key: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  /** True only when putImmutable independently verified what is actually stored (HeadObject + GetObject + byte/hash/metadata comparison), never merely because the write call returned without error. */
  verified: boolean;
  /** The exact S3 object version this write produced, when the bucket has versioning enabled and S3 reports one. Null for LocalAuditStorage (no versioning concept) and for an S3 bucket without versioning enabled. */
  versionId: string | null;
  /** Server-controlled timestamp of when verification completed successfully — stamped here, never accepted from a caller. */
  verifiedAt: string;
}

export interface AuditStorage {
  putImmutable(key: string, content: string, contentType: string): Promise<AuditArtifact>;
  /** versionId, when given, pins retrieval to that exact object version rather than "current" (S3AuditStorage only — LocalAuditStorage has no versioning concept and ignores it, since a key only ever has one version there). */
  getImmutable(key: string, versionId?: string): Promise<string | null>;
}

/** The audit backend is unreachable or misconfigured — never treated as "nothing to audit"; callers must not persist or report success. */
export class AuditStorageUnavailableError extends Error {
  constructor(message: string, cause?: unknown) { super(message, { cause }); }
}

/**
 * A key already holds content that does not match what was just written —
 * both are real, immutable artifacts, so this is reported as a conflict for
 * a human to reconcile, never silently overwritten or silently accepted.
 */
export class AuditIntegrityError extends Error {}

function sha256Of(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Real, working dev/local adapter. Writes under .sherlock/audit/ (already gitignored). */
export class LocalAuditStorage implements AuditStorage {
  constructor(private readonly baseDir: string = resolve(process.cwd(), ".sherlock/audit")) {}

  async putImmutable(key: string, content: string, contentType: string): Promise<AuditArtifact> {
    const filePath = join(this.baseDir, key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    // Read back rather than trusting the write call returned without error,
    // for the same reason S3AuditStorage does: a successful call is not the
    // same claim as "this is what is actually stored".
    const readBack = await readFile(filePath, "utf8");
    const sha256 = sha256Of(content);
    if (readBack !== content) throw new AuditIntegrityError(`Local audit artifact ${key}: read-back content did not match what was written.`);
    return { key, sha256, sizeBytes: Buffer.byteLength(content, "utf8"), contentType, verified: true, versionId: null, verifiedAt: new Date().toISOString() };
  }

  async getImmutable(key: string): Promise<string | null> {
    // No versioning concept in the local filesystem adapter — a key has
    // exactly one version, so an optional versionId argument (if a caller
    // passes one) is a no-op rather than an error.
    try {
      return await readFile(join(this.baseDir, key), "utf8");
    } catch {
      return null;
    }
  }
}

export interface S3AuditStorageConfig {
  bucket: string;
  region: string;
  /** Optional key prefix, e.g. "dev/" or "prod/". No leading/trailing slash required. */
  prefix?: string;
}

/** Minimal surface this class actually calls — lets tests inject a deterministic fake instead of a real S3Client. */
export type S3ClientLike = Pick<S3Client, "send">;

function errorName(error: unknown): string | undefined {
  return error !== null && typeof error === "object" ? (error as { name?: string }).name : undefined;
}

function httpStatusCode(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return metadata?.httpStatusCode;
}

function isPreconditionFailed(error: unknown): boolean {
  return errorName(error) === "PreconditionFailed" || httpStatusCode(error) === 412;
}

function isNotFound(error: unknown): boolean {
  return errorName(error) === "NoSuchKey" || errorName(error) === "NotFound" || httpStatusCode(error) === 404;
}

/**
 * Real S3 adapter (see docs/aws-s3-audit-storage.md). Uses the AWS SDK's
 * standard credential provider chain — this class never reads or accepts an
 * access key/secret itself; construct it with `getAuditStorage()`, which
 * reads only the bucket/region/prefix env vars, never credentials.
 */
export class S3AuditStorage implements AuditStorage {
  private readonly client: S3ClientLike;

  constructor(private readonly config: S3AuditStorageConfig, client?: S3ClientLike) {
    this.client = client ?? new S3Client({ region: config.region });
  }

  private fullKey(key: string): string {
    const prefix = this.config.prefix?.replace(/^\/+|\/+$/g, "");
    return prefix ? `${prefix}/${key}` : key;
  }

  /**
   * Write-once semantics via a conditional PutObject (IfNoneMatch: "*"):
   * - key absent -> writes, then independently verifies.
   * - key present with identical content/hash -> idempotent success (the
   *   retried write is treated as a no-op, not a duplicate or an error).
   * - key present with different content -> AuditIntegrityError; never
   *   overwritten.
   * A write call returning without error is never itself treated as proof of
   * a successful, correct upload — every path below re-reads what S3 reports
   * (HeadObject) and what it actually serves (GetObject) and compares
   * against the intended content before returning.
   */
  async putImmutable(key: string, content: string, contentType: string): Promise<AuditArtifact> {
    const fullKey = this.fullKey(key);
    const sha256 = sha256Of(content);
    const sizeBytes = Buffer.byteLength(content, "utf8");

    let putResult;
    try {
      putResult = await this.client.send(new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: fullKey,
        Body: content,
        ContentType: contentType,
        IfNoneMatch: "*",
        Metadata: { sha256 },
      }));
    } catch (error) {
      if (!isPreconditionFailed(error)) throw new AuditStorageUnavailableError(`Audit artifact ${key}: PutObject failed.`, error);
      // Key already exists. Fetch what's actually there and decide idempotent-success vs. integrity conflict below — never overwrite.
      const existing = await this.fetchExisting(key, fullKey);
      if (existing.sha256 !== sha256) {
        throw new AuditIntegrityError(
          `Audit artifact ${key}: a different artifact already exists at this key (existing sha256 ${existing.sha256}, new content sha256 ${sha256}). Refusing to overwrite.`,
        );
      }
      // The existing object is the one that stays authoritative going
      // forward, so verification is pinned to its version, not ours.
      return this.verify(key, fullKey, content, sha256, sizeBytes, contentType, existing.versionId);
    }

    // Pin verification to the exact version this write produced (when the
    // bucket reports one) — never "whatever is latest", which could be a
    // different write racing this one even though our conditional PutObject
    // itself succeeded.
    return this.verify(key, fullKey, content, sha256, sizeBytes, contentType, putResult.VersionId ?? null);
  }

  async getImmutable(key: string, versionId?: string): Promise<string | null> {
    const fullKey = this.fullKey(key);
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: fullKey, VersionId: versionId }));
      const body = await response.Body?.transformToString("utf-8");
      return body ?? null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new AuditStorageUnavailableError(`Audit artifact ${key}: GetObject failed.`, error);
    }
  }

  private async fetchExisting(key: string, fullKey: string): Promise<{ content: string; sha256: string; versionId: string | null }> {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: fullKey }));
      const content = (await response.Body?.transformToString("utf-8")) ?? "";
      return { content, sha256: sha256Of(content), versionId: response.VersionId ?? null };
    } catch (error) {
      throw new AuditStorageUnavailableError(`Audit artifact ${key}: existing object could not be read for idempotency comparison.`, error);
    }
  }

  /**
   * Independent verification, never inferred from a prior call's success:
   * HeadObject (size, content-type, stored sha256 metadata, SSE-S3 when
   * reported) and GetObject (actual byte content), both compared against
   * what was intended to be written. When versionId is known, both reads are
   * pinned to that exact version (VersionId param) rather than "current" —
   * eliminating any window where a concurrent write could be verified
   * against the wrong object version.
   */
  private async verify(key: string, fullKey: string, expectedContent: string, expectedSha256: string, expectedSizeBytes: number, expectedContentType: string, versionId: string | null): Promise<AuditArtifact> {
    let head;
    try {
      head = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: fullKey, VersionId: versionId ?? undefined }));
    } catch (error) {
      throw new AuditStorageUnavailableError(`Audit artifact ${key}: HeadObject verification failed.`, error);
    }
    if (head.ContentLength !== expectedSizeBytes) throw new AuditIntegrityError(`Audit artifact ${key}: HeadObject reports ${head.ContentLength} bytes; expected ${expectedSizeBytes}.`);
    if (head.ContentType !== expectedContentType) throw new AuditIntegrityError(`Audit artifact ${key}: HeadObject content-type "${head.ContentType}" does not match expected "${expectedContentType}".`);
    if (head.Metadata?.sha256 !== expectedSha256) throw new AuditIntegrityError(`Audit artifact ${key}: HeadObject sha256 metadata does not match the computed hash.`);
    // Reported "when AWS reports it": some paths (e.g. bucket default encryption not echoed on every response) may omit this field; only a reported-and-wrong value is an integrity failure.
    if (head.ServerSideEncryption && head.ServerSideEncryption !== "AES256") throw new AuditIntegrityError(`Audit artifact ${key}: expected SSE-S3 (AES256), HeadObject reports ${head.ServerSideEncryption}.`);

    let get;
    try {
      get = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: fullKey, VersionId: versionId ?? undefined }));
    } catch (error) {
      throw new AuditStorageUnavailableError(`Audit artifact ${key}: GetObject verification failed.`, error);
    }
    const downloaded = (await get.Body?.transformToString("utf-8")) ?? "";
    if (downloaded !== expectedContent) throw new AuditIntegrityError(`Audit artifact ${key}: downloaded content does not byte-match what was written.`);
    if (sha256Of(downloaded) !== expectedSha256) throw new AuditIntegrityError(`Audit artifact ${key}: downloaded content's sha256 does not match.`);

    return { key, sha256: expectedSha256, sizeBytes: expectedSizeBytes, contentType: expectedContentType, verified: true, versionId, verifiedAt: new Date().toISOString() };
  }
}

export type AuditStorageBackend = "local" | "s3";

function resolveAuditStorageBackend(): AuditStorageBackend {
  const raw = process.env.AUDIT_STORAGE_BACKEND?.trim();
  if (!raw || raw === "local") return "local";
  if (raw === "s3") return "s3";
  throw new Error(`AUDIT_STORAGE_BACKEND must be "local" or "s3" (got ${JSON.stringify(raw)}).`);
}

/**
 * Explicit backend selection, fail-closed: AUDIT_STORAGE_BACKEND=s3 with
 * missing bucket/region never falls back to local storage — it throws.
 * AUDIT_STORAGE_BACKEND unset or "local" uses the real local dev adapter.
 * Reads only bucket/region/prefix; credentials are always resolved by the
 * AWS SDK's own default provider chain (AWS_PROFILE locally, an IAM role in
 * AWS), never read or handled by this function.
 */
export function getAuditStorage(): AuditStorage {
  const backend = resolveAuditStorageBackend();
  if (backend === "local") return new LocalAuditStorage();

  const bucket = process.env.AWS_S3_AUDIT_BUCKET?.trim();
  const region = process.env.AWS_REGION?.trim();
  if (!bucket) throw new Error("AUDIT_STORAGE_BACKEND=s3 requires AWS_S3_AUDIT_BUCKET to be set. Refusing to fall back to local storage.");
  if (!region) throw new Error("AUDIT_STORAGE_BACKEND=s3 requires AWS_REGION to be set. Refusing to fall back to local storage.");
  const prefix = process.env.AWS_S3_AUDIT_PREFIX?.trim() || undefined;
  return new S3AuditStorage({ bucket, region, prefix });
}
