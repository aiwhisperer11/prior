# Remaining hackathon blockers: minimal plan (not implemented)

Both blockers below require external access this environment does not have
(a Managed MCP Server credential, an AWS account). Per instruction, nothing
here is implemented as a simulation — this is the exact minimal path to make
each one *really* true, with binary criteria so "done" can't be asserted
loosely.

## Blocker 1 — A verifiable operation via CockroachDB Managed MCP Server

**Current state:** `docs/cockroachdb-mcp-contract.md` documents the target
tool mapping from Cockroach Labs' own announcement; `lib/server/memory-store-mcp-adapter.ts`
implements `SemanticMemoryStore` but every method throws
"MCP Server not configured" — real code, zero live verification.

**Steps:**
1. **User:** In CockroachDB Cloud Console, open the cluster already in use
   (the real cluster behind today's `DATABASE_URL`), enable "Managed MCP
   Server", and generate a **service-account API key** (not the interactive
   OAuth flow — a service-account key is scriptable and doesn't need a
   browser). Scope: read is sufficient to satisfy this blocker; add write
   only if also demonstrating `insert_rows`.
2. **User:** Set `MCP_SERVER_ENDPOINT=https://cockroachlabs.cloud/mcp` and
   `MCP_SERVER_CREDENTIAL=<the key>` in `.env.local` — `mcpMemoryStoreConfigFromEnv()`
   already reads exactly these two variables, no code change needed to detect them.
3. **Me:** Implement the actual JSON-RPC tool-call bodies in
   `McpMemoryStore` (currently stubbed) for at least `findLatestForCase` via
   the `select_query` tool, per the mapping table already in
   `docs/cockroachdb-mcp-contract.md`.
4. **Me:** Run one real call — fetch the Google SecOps investigation already
   sitting in `investigation_memory` — through the MCP path, and independently
   run the same query directly via `pg` (already-working code) to cross-check
   the two results match byte-for-byte.
5. **Me:** Save the raw JSON-RPC request/response to
   `.sherlock/mcp-verification/<timestamp>.json` and update
   `docs/cockroachdb-mcp-contract.md`'s status line.

**Binary criteria (all required, no partial credit):**
- [ ] A real JSON-RPC response is received from `https://cockroachlabs.cloud/mcp`
      authenticated as the service account (not a mock transport).
- [ ] The data returned via MCP matches the same query's result via direct `pg`
      access, byte-for-byte.
- [ ] The raw request/response pair is committed as an artifact and linked from
      `docs/cockroachdb-mcp-contract.md`.
- [ ] `docs/cockroachdb-mcp-contract.md`'s status changes from "NOT VERIFIED" to
      "VERIFIED `<date>`" only after the above three are true.

**Blocked on:** user providing the service-account credential. Nothing else.

## Blocker 2 — Real S3 artifact storage + AWS deployment

**Current state:** `docs/aws-s3-audit-storage.md` documents the design;
`lib/server/audit-storage.ts` has a real, working `LocalAuditStorage` and a
stub `S3AuditStorage` that throws "AWS credentials not configured." No AWS
SDK installed, nothing deployed.

**Steps:**
1. **User:** Provide an AWS IAM identity scoped to least privilege — ideally
   a single IAM user/role with `s3:PutObject`, `s3:GetObject`,
   `s3:HeadObject` on one bucket only — plus the bucket name and region (an
   existing bucket, or explicit go-ahead for me to propose a bucket name for
   the user to create, since bucket creation/billing should be the user's
   action, not mine).
2. **User:** Decide the deployment target. Recommendation: **AWS Amplify
   Hosting** — native Next.js SSR/API-route support, least infrastructure to
   hand-wire compared to ECS/Lambda. Provide Amplify deploy access (Amplify
   Console access, or an IAM identity with `amplify:*` scoped to one app) or
   confirm the user will run the deploy themselves from `amplify.yml` I write.
3. **Me:** Add `@aws-sdk/client-s3` (real new dependency) and implement
   `S3AuditStorage` for real, replacing the stub.
4. **Me:** Add the `003_` migration for `audit_artifact_key` /
   `audit_artifact_sha256` columns (additive, same pattern as `002_`), and
   wire one real save path (e.g. the raw model response for a case) to upload
   to S3 and record the key+hash in CockroachDB.
5. **Me:** Upload one real artifact, then independently download it back and
   compare sha256 against the value stored in CockroachDB, proving the chain
   is real end-to-end, not just "the upload call didn't error."
6. **Me (or user, if deploy credentials aren't shared):** Deploy via Amplify;
   confirm the deployed URL serves `/api/investigate` successfully.
7. **Me:** Update `docs/aws-s3-audit-storage.md` with the bucket, region,
   artifact key/hash, and deployed URL; change status from "pending external
   integration" to "verified `<date>`".

**Binary criteria (all required, no partial credit):**
- [ ] A real S3 object exists (verified via `HeadObject`, not just a
      successful `PutObject` response).
- [ ] The object's downloaded content's sha256 matches the sha256 stored in a
      real CockroachDB row's `audit_artifact_sha256` column.
- [ ] A publicly (or authenticated-but-real) reachable AWS-hosted URL serves
      the running application — a `curl` to that URL, not `localhost`,
      succeeds.
- [ ] `docs/aws-s3-audit-storage.md`'s status changes from "pending external
      integration" to "verified `<date>`" only after the above three are true.

**Blocked on:** user providing AWS credentials/bucket and a deployment
decision. Nothing else.

## What I will not do

Mark either blocker "done" based on code existing, a stub not throwing, or a
local-only test — matching the standard already applied to the CockroachDB
vector index and the MCP contract earlier this session: real infra access is
required before the status line changes, and until then both remain
explicitly labeled unverified.
