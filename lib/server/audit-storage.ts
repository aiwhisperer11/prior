import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** See docs/aws-s3-audit-storage.md for the target design and current status. */
export interface AuditArtifact {
  key: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
}

export interface AuditStorage {
  putImmutable(key: string, content: string, contentType: string): Promise<AuditArtifact>;
  getImmutable(key: string): Promise<string | null>;
}

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
    return { key, sha256: sha256Of(content), sizeBytes: Buffer.byteLength(content, "utf8"), contentType };
  }

  async getImmutable(key: string): Promise<string | null> {
    try {
      return await readFile(join(this.baseDir, key), "utf8");
    } catch {
      return null;
    }
  }
}

/**
 * Target S3 adapter — pending external integration (see
 * docs/aws-s3-audit-storage.md). Throws for every call rather than silently
 * writing locally or pretending to succeed; not wired into getMemoryStore()
 * or any save path.
 */
export class S3AuditStorage implements AuditStorage {
  async putImmutable(_key: string, _content: string, _contentType: string): Promise<AuditArtifact> {
    throw new Error("AWS credentials not configured — S3AuditStorage is a target design, not a live integration. See docs/aws-s3-audit-storage.md.");
  }

  async getImmutable(_key: string): Promise<string | null> {
    throw new Error("AWS credentials not configured — S3AuditStorage is a target design, not a live integration. See docs/aws-s3-audit-storage.md.");
  }
}
