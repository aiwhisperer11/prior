/**
 * Real integration test against a live S3 bucket — requires
 * AUDIT_STORAGE_BACKEND=s3, AWS_S3_AUDIT_BUCKET, and AWS_REGION to be set to
 * real values, with credentials available through the AWS SDK's standard
 * provider chain (AWS_PROFILE=prior-dev locally, or an IAM role in AWS).
 *
 * Deliberately NOT matched by `tests/*.test.ts` (npm test's glob), so it
 * never runs in the fast suite and never needs a real bucket for `npm test`
 * to pass. Run explicitly with:
 *
 *   AUDIT_STORAGE_BACKEND=s3 AWS_S3_AUDIT_BUCKET=<bucket> AWS_REGION=eu-central-1 AWS_PROFILE=prior-dev \
 *     node --test --import tsx tests/integration/audit-storage-s3-live.test.ts
 *
 * Writes one small, real object per run under a "_verification/" prefix —
 * distinct from the app's own "investigations/" key namespace, so it can
 * never collide with or shadow a real investigation artifact. Because
 * AuditStorage has no delete capability (by design — see
 * docs/aws-s3-audit-storage.md), each run leaves a small residual object
 * behind; that is expected and harmless, not a bug in this test.
 *
 * As of this writing, no environment this project has run in has these
 * variables set, so this file has never executed past the guard below. It
 * exists so the real verification path is runnable on request, not
 * aspirational — per the task brief, it is never run automatically.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { getAuditStorage, S3AuditStorage } from "../../lib/server/audit-storage";

const configured = process.env.AUDIT_STORAGE_BACKEND === "s3" && Boolean(process.env.AWS_S3_AUDIT_BUCKET) && Boolean(process.env.AWS_REGION);

test(
  "S3AuditStorage against a real bucket: PutObject -> HeadObject -> GetObject -> byte and sha256 match",
  { skip: !configured && "AUDIT_STORAGE_BACKEND=s3 with AWS_S3_AUDIT_BUCKET/AWS_REGION not set" },
  async () => {
    const storage = getAuditStorage();
    assert.ok(storage instanceof S3AuditStorage, "AUDIT_STORAGE_BACKEND=s3 must resolve to a real S3AuditStorage, not a fallback");

    const content = JSON.stringify({ verification_run_at: new Date().toISOString(), purpose: "manual S3 audit-storage verification, safe to leave in place" });
    const key = `_verification/${Date.now()}.json`;

    const before = new Date();
    const artifact = await storage.putImmutable(key, content, "application/json");
    const after = new Date();
    assert.equal(artifact.verified, true);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    assert.ok(new Date(artifact.verifiedAt) >= before && new Date(artifact.verifiedAt) <= after, "verifiedAt must be a real, freshly stamped timestamp");
    // versionId is only non-null if the real bucket has versioning enabled
    // (the task's verified dev bucket does) -- report it either way rather
    // than assert a specific shape, since that's a bucket-configuration fact
    // this test doesn't control.
    console.log(`artifact.versionId: ${artifact.versionId ?? "(bucket does not report versions)"}`);

    const readBack = await storage.getImmutable(key);
    assert.equal(readBack, content, "downloaded content must byte-match what was written");

    if (artifact.versionId) {
      const byExactVersion = await storage.getImmutable(key, artifact.versionId);
      assert.equal(byExactVersion, content, "recovery by the exact VersionId returned from PutObject must match what was written");
    }

    // A second write to the same key with identical content must be
    // idempotent, not an error -- exercises the real conditional PutObject
    // (IfNoneMatch) against the real bucket's actual behavior on a 412.
    const retried = await storage.putImmutable(key, content, "application/json");
    assert.equal(retried.sha256, artifact.sha256);

    // A write to the same key with different content must fail as an
    // integrity conflict, never silently overwrite what's already there.
    await assert.rejects(storage.putImmutable(key, content + " ", "application/json"));
  },
);
