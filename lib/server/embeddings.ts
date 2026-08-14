import type OpenAI from "openai";

import { getOpenAIClient } from "@/lib/openai";
import type { SherlockInvestigation } from "@/types/sherlock";

/** text-embedding-3-small: 1536 dimensions, matches the VECTOR(1536) column in db/migrations/002_investigation_memory_lineage_vector.sql. */
export const EMBEDDING_MODEL = "text-embedding-3-small";

export interface Embedding {
  vector: number[];
  model: string;
}

export type Embedder = (text: string) => Promise<Embedding>;

/** Real OpenAI embeddings call — no mock. Used by CockroachDBMemoryStore/LocalMemoryStore in production. */
export async function embedText(text: string, client: OpenAI = getOpenAIClient()): Promise<Embedding> {
  const response = await client.embeddings.create({ model: EMBEDDING_MODEL, input: text });
  const vector = response.data[0]?.embedding;
  if (!vector) throw new Error("OpenAI embeddings response contained no vector");
  return { vector, model: EMBEDDING_MODEL };
}

/**
 * The text embedded for semantic memory retrieval: a compact semantic summary
 * of what the investigation is about, not the full snapshot. Keeping this a
 * pure function (no client) makes the exact embedded text independently
 * testable without a network call.
 */
export function investigationEmbeddingText(input: {
  case_title: string;
  domain: string;
  observed_outcome: string;
  expected_behavior: string;
  learning_summary?: string;
}): string {
  return [
    input.case_title,
    input.domain,
    input.observed_outcome,
    input.expected_behavior,
    input.learning_summary,
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n");
}

export async function embedInvestigation(investigation: SherlockInvestigation, client?: OpenAI): Promise<Embedding> {
  return embedText(
    investigationEmbeddingText({
      case_title: investigation.meta.case_title,
      domain: investigation.meta.domain,
      observed_outcome: investigation.case.observed_outcome,
      expected_behavior: investigation.case.expected_behavior,
      learning_summary: investigation.learning.summary,
    }),
    client,
  );
}

/** L2 distance — matches CockroachDB's vector index `<->` operator so local ranking agrees with the real index's ordering. */
export function l2Distance(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i]! - b[i]!;
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}
