# Evidence Scout Lambda -- manual deployment

Not deployed by this repository's tooling. Same posture as `db/migrations/`:
nothing here runs automatically; an operator applies it manually, once, per
target AWS account.

## Prerequisites

- AWS SAM CLI installed and configured with credentials for the target account.
- A CockroachDB `DATABASE_URL` (sslmode=verify-full) stored in AWS Secrets Manager.
- An `OPENAI_API_KEY` stored in AWS Secrets Manager. Never pass either as a
  plaintext CloudFormation parameter or Lambda environment variable directly
  -- the template only accepts Secrets Manager ARNs.
- The handler bundle built by `sam build` from
  `lib/server/evidence-scout-lambda-bootstrap.ts`. That bootstrap loads the
  two Secrets Manager values into `DATABASE_URL` and `OPENAI_API_KEY` before
  importing the actual worker module. SAM's esbuild step emits a CommonJS
  `.js` bundle targeting ES2022; the TypeScript source imports remain unchanged.

## Deploy

```sh
cd infra/evidence-scout-lambda
sam validate --lint
sam build
sam deploy --guided \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    DatabaseUrlSecretArn=<arn> \
    OpenAiApiKeySecretArn=<arn>
```

After deploy, take the `QueueUrl` output and set it as `EVIDENCE_SCOUT_QUEUE_URL`
in the Next.js app's environment, alongside `EVIDENCE_SCOUT_EXECUTOR=sqs`.
Use the `QueueArn` output to grant the application sender only
`sqs:SendMessage` on this queue. Do not grant wildcard SQS permissions.
This template now declares a stable, explicitly named Lambda runtime role
(`"${AWS::StackName}-lambda-runtime"`), so `CAPABILITY_NAMED_IAM` is required
on deploy and update.

## Operational notes

- **Runtime role**: the Lambda uses an explicit inline-policy runtime role
  instead of SAM's implicit role synthesis. The stack does not rely on
  `AWSLambdaBasicExecutionRole`, `AWSLambdaSQSQueueExecutionRole`, or any
  other AWS managed policy. CloudFormation only needs inline-role APIs
  (`CreateRole`, `PutRolePolicy`, etc.); it does not need
  `AttachRolePolicy`/`DetachRolePolicy` for this stack.
- **Reserved concurrency (3)** bounds worst-case concurrent OpenAI
  `web_search` spend regardless of queue depth. Raise only after confirming
  the daily budget (`EVIDENCE_SCOUT_DAILY_ACTION_LIMIT`) and per-action caps
  (`MAX_QUERIES_PER_ACTION`, `MAX_CANDIDATES_PER_ACTION`) still bound total
  cost at the new concurrency.
- **CloudWatch Logs retention (dev)**: the SAM template creates the Lambda's
  log group explicitly and retains logs for 14 days in dev. No log
  subscriptions, custom metrics, or alarms are created here.
- **DLQ**: a message that fails 3 deliveries (`maxReceiveCount: 3`, aligned
  with the DB-level `attempt_count` cap) lands in `evidence-scout-search-dlq`
  and stays there for up to 14 days. Inspecting a DLQ message reveals only
  `{ actionId }` -- no case content, no secrets -- so triage is safe to do
  without additional access controls beyond queue read permission. The
  corresponding `evidence_scout_action` row will independently show
  `state='failed'` with a sanitized `failure_code` (never a raw error) once
  the DB-level lazy-reap on the next `GET /actions/:id` observes the
  expired, attempt-exhausted lease.
- **VisibilityTimeout (540s) vs. Lambda Timeout (90s) vs. DB lease (120s)**:
  these three numbers are deliberately layered, not arbitrary -- see the
  comments in `template.yaml` and `lib/server/evidence-scout-store.ts`
  (`CLAIM_LEASE_SECONDS`, `MAX_ATTEMPTS`). Changing one requires re-checking
  the others stay coherently ordered.
- **Rollback**: `sam delete` removes the explicit runtime role, queue, DLQ,
  log group, and function. Any
  `evidence_scout_action` rows left in `authorized` or `searching` state at
  that point will never complete; the API's `GET /actions/:id` reports them
  honestly as stuck (no lazy-reap fires without a working lease-expiry
  check, which still runs purely in CockroachDB and does not depend on the
  Lambda existing). If a deploy/update fails, first confirm the failed stack
  is fully deleted, then fix the template or IAM execution-role delta, run
  `sam validate --lint` and `sam build` again, and only then retry deploy
  with `CAPABILITY_NAMED_IAM`. Do not apply `db/migrations/004_evidence_scout.sql`
  as part of rollback or retry for this infrastructure-only change.
