import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

import { performEvidenceScoutSearch, type PerformSearchDependencies } from "@/lib/server/evidence-scout-search";

export interface EvidenceScoutExecutor {
  invoke(actionId: string): Promise<void>;
}

/**
 * Dev/test only. Awaited, never fire-and-forget (point 13): the returned
 * promise resolves only once the search genuinely completes or fails.
 * Callers that need a deterministic post-condition -- tests, primarily --
 * call this (or performEvidenceScoutSearch directly) and await it. The API
 * route also awaits executor.invoke(); with the local executor that means
 * search runs synchronously in-process, while with the SQS executor the
 * await only covers SendMessage acknowledgment.
 */
export class LocalEvidenceScoutExecutor implements EvidenceScoutExecutor {
  constructor(private readonly deps: PerformSearchDependencies) {}
  async invoke(actionId: string): Promise<void> {
    await performEvidenceScoutSearch(actionId, this.deps);
  }
}

/**
 * Production dispatch: durable SQS delivery to a Lambda triggered by the
 * queue's event source mapping (infra/evidence-scout-lambda/template.yaml).
 * A standard (not FIFO) queue is sufficient -- true dedup is the DB-level
 * claimAction() compare-and-swap, not the queue.
 */
export class SqsEvidenceScoutExecutor implements EvidenceScoutExecutor {
  constructor(private readonly client: SQSClient, private readonly queueUrl: string) {}
  async invoke(actionId: string): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify({ actionId }) }));
  }
}

/**
 * Fail-closed by construction, same pattern as audit-storage.ts's
 * resolveAuditStorageBackend: unset/"local" is the safe default outside
 * production; "sqs" requires full config or throws, never silently falls
 * back to local. In production specifically, the local executor is refused
 * outright even if left unset -- it runs search synchronously in-process,
 * which is correct for dev/test but would silently block the request and
 * defeat the 202+poll contract if it ever ran in a real deployment.
 */
export function getEvidenceScoutExecutor(deps: PerformSearchDependencies): EvidenceScoutExecutor {
  const mode = process.env.EVIDENCE_SCOUT_EXECUTOR?.trim();
  if (process.env.NODE_ENV === "production" && (!mode || mode === "local")) {
    throw new Error('EVIDENCE_SCOUT_EXECUTOR must be explicitly set to "sqs" in production. The local executor runs search synchronously in-process and must never be used in production.');
  }
  if (!mode || mode === "local") return new LocalEvidenceScoutExecutor(deps);
  if (mode === "sqs") {
    const queueUrl = process.env.EVIDENCE_SCOUT_QUEUE_URL?.trim();
    if (!queueUrl) throw new Error("EVIDENCE_SCOUT_EXECUTOR=sqs requires EVIDENCE_SCOUT_QUEUE_URL to be set. Refusing to fall back to local execution.");
    return new SqsEvidenceScoutExecutor(new SQSClient({}), queueUrl);
  }
  throw new Error(`EVIDENCE_SCOUT_EXECUTOR must be "local" or "sqs" (got ${JSON.stringify(mode)}).`);
}
