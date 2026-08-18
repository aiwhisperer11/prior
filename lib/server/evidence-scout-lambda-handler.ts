import { Pool } from "pg";

import { cockroachPoolOptions } from "@/lib/server/cockroach-pool";
import { CockroachDBEvidenceScoutCandidateStore, type EvidenceScoutCandidateStore } from "@/lib/server/evidence-scout-store";
import { performEvidenceScoutSearch } from "@/lib/server/evidence-scout-search";

/**
 * Lambda entrypoint, triggered by the SQS event source mapping
 * (infra/evidence-scout-lambda/template.yaml). Deliberately thin: all real
 * logic lives in performEvidenceScoutSearch, shared verbatim with
 * LocalEvidenceScoutExecutor so dev/test and production run identical
 * search logic, differing only in dispatch transport.
 *
 * SQS delivers at-least-once and may invoke this handler more than once for
 * the same actionId (duplicate delivery) or redeliver after the queue's
 * VisibilityTimeout elapses if a prior invocation crashed mid-flight
 * (crash recovery). Both are handled by claimAction()'s guarded UPDATE
 * inside performEvidenceScoutSearch, not by anything in this file -- a
 * duplicate or late invocation simply fails to claim and returns.
 *
 * BatchSize is 1 (see the SAM template), so `event.Records` always has
 * exactly one message; ReportBatchItemFailures is still declared so a
 * throw here is reported per-message rather than failing the whole batch,
 * matching AWS's documented partial-batch-failure contract for SQS
 * triggers.
 */

interface SqsRecord {
  messageId: string;
  body: string;
}
interface SqsEvent {
  Records: SqsRecord[];
}
interface BatchItemFailure {
  itemIdentifier: string;
}
interface SqsBatchResponse {
  batchItemFailures: BatchItemFailure[];
}

export interface EvidenceScoutLambdaHandlerDependencies {
  performSearch?: typeof performEvidenceScoutSearch;
  storeFactory?: () => EvidenceScoutCandidateStore;
  logError?: (entry: EvidenceScoutRecordFailureLog) => void;
}

export interface EvidenceScoutRecordFailureLog {
  event: "evidence_scout_record_failed";
  messageId: string;
  actionId: string | null;
  errorName: string;
  errorMessage: string;
}

function redactKnownValue(message: string, value: string | undefined): string {
  return value && value.length >= 4 ? message.split(value).join("[REDACTED]") : message;
}

function sanitizeErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : typeof error === "string" ? error : "Non-Error value thrown";
  message = redactKnownValue(message, process.env.DATABASE_URL);
  message = redactKnownValue(message, process.env.OPENAI_API_KEY);
  message = message
    .replace(/\b(?:https?|postgres(?:ql)?):\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(password|passwd|token|api[_-]?key|secret|credential)s?\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ");
  return message.slice(0, 1024);
}

function errorName(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownThrownValue";
  return error.name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 128) || "Error";
}

function defaultLogError(entry: EvidenceScoutRecordFailureLog): void {
  console.error(JSON.stringify(entry));
}

let pool: Pool | undefined;
function getPool(): Pool {
  if (!pool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required in the Lambda environment.");
    pool = new Pool(cockroachPoolOptions(databaseUrl));
  }
  return pool;
}

export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
  return createEvidenceScoutLambdaHandler()(event);
}

export function createEvidenceScoutLambdaHandler(deps: EvidenceScoutLambdaHandlerDependencies = {}) {
  const performSearch = deps.performSearch ?? performEvidenceScoutSearch;
  const storeFactory = deps.storeFactory ?? (() => new CockroachDBEvidenceScoutCandidateStore(getPool()));
  const logError = deps.logError ?? defaultLogError;

  return async function evidenceScoutLambdaHandler(event: SqsEvent): Promise<SqsBatchResponse> {
    const batchItemFailures: BatchItemFailure[] = [];
    let store: EvidenceScoutCandidateStore | undefined;

    for (const record of event.Records) {
      let actionId: string | null = null;
      try {
        const parsed = JSON.parse(record.body) as { actionId?: unknown };
        if (typeof parsed.actionId !== "string" || !parsed.actionId) throw new Error("SQS message body missing actionId");
        actionId = parsed.actionId;
        store ??= storeFactory();
        await performSearch(actionId, { store });
      } catch (error) {
        logError({
          event: "evidence_scout_record_failed",
          messageId: record.messageId,
          actionId,
          errorName: errorName(error),
          errorMessage: sanitizeErrorMessage(error),
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }

    return { batchItemFailures };
  };
}
