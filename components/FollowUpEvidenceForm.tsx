"use client";

import { useReducer, useRef, useState, type FormEvent } from "react";

import followUpExample from "@/examples/case-b-evidence-e5.json";
import {
  FOLLOW_UP_REQUEST_TIMEOUT_MS,
  followUpFormReducer,
  initialFollowUpFormState,
} from "@/lib/follow-up-form-state";
import { parseInvestigationApiResponse } from "@/lib/investigation-response";
import type { SherlockInvestigation } from "@/types/sherlock";
import type { MemoryUpdate } from "@/components/SherlockForm";

interface FollowUpEvidenceFormProps {
  previousSnapshot: SherlockInvestigation;
  /** Point 7: only opaque candidate_id references, never provenance content -- the server resolves everything else from durable candidate rows. */
  acceptedCandidateIds?: string[];
  onSnapshot: (snapshot: SherlockInvestigation) => void;
  onMemory: (update: MemoryUpdate) => void;
}

export default function FollowUpEvidenceForm({ previousSnapshot, acceptedCandidateIds = [], onSnapshot, onMemory }: FollowUpEvidenceFormProps) {
  const [state, dispatch] = useReducer(followUpFormReducer, initialFollowUpFormState);
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const { evidence, loading, error } = state;

  const canSubmit = (evidence.length > 0 && evidence.every((item) => item.label.trim() && item.content.trim())) || acceptedCandidateIds.length > 0;

  function updateEvidence(index: number, field: "label" | "content", value: string) {
    dispatch({ type: "evidence-changed", index, field, value });
  }

  async function reinvestigate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || loading || inFlight.current) return;
    inFlight.current = true;
    dispatch({ type: "request-started" });
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), FOLLOW_UP_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch("/api/investigate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          previous_snapshot: previousSnapshot,
          ...(evidence.length > 0 ? { new_evidence: evidence } : {}),
          ...(acceptedCandidateIds.length > 0 ? { accepted_candidate_ids: acceptedCandidateIds } : {}),
        }),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = body !== null && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string"
          ? (body as Record<string, unknown>).error as string
          : `Request failed with status ${response.status}`;
        dispatch({ type: "request-failed", error: `Error ${response.status}: ${message}` });
        return;
      }
      const parsed = parseInvestigationApiResponse(body);
      if (!parsed.ok) {
        dispatch({ type: "request-failed", error: `The API returned an invalid investigation: ${parsed.errors.map((entry) => `${entry.instancePath}: ${entry.message}`).join("; ")}` });
        return;
      }
      onMemory({ precedents: parsed.response.precedents, unclassified_memory: parsed.response.unclassified_memory, suspected_duplicate_memory: parsed.response.suspected_duplicate_memory, memory: parsed.response.memory, storage: parsed.response.storage });
      onSnapshot(parsed.response.investigation);
      setMemoryNotice(parsed.response.storage === "local-mock"
        ? `Mock local memory fallback. ${parsed.response.precedents.length} precedent lead(s) retrieved; memory is not evidence.`
        : `${parsed.response.precedents.length} CockroachDB precedent lead(s) retrieved; memory is not evidence.`);
      dispatch({ type: "request-succeeded" });
    } catch (requestError) {
      dispatch({
        type: "request-failed",
        error: requestError instanceof Error && requestError.name === "AbortError"
          ? "The re-investigation timed out. Please try again."
          : "The re-investigation request could not be completed. Please try again.",
      });
    } finally {
      window.clearTimeout(timeoutId);
      inFlight.current = false;
    }
  }

  return <details className="prior-card group overflow-hidden border-cyan-200">
    <summary className="cursor-pointer list-none p-5 marker:hidden sm:p-6"><div className="flex items-center justify-between gap-4"><div><p className="prior-eyebrow text-cyan-700">Secondary workflow</p><h2 id="new-evidence-heading" className="mt-1 text-xl font-bold text-[var(--prior-night)]">New evidence</h2><p className="text-sm text-slate-600">Re-investigate iteration {previousSnapshot.meta.iteration + 1} from the latest snapshot.</p>{acceptedCandidateIds.length > 0 && <p className="text-sm font-semibold text-violet-800">{acceptedCandidateIds.length} accepted Evidence Scout candidate(s) will be included.</p>}</div><span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-cyan-100 text-xl font-bold text-cyan-800 transition group-open:rotate-45">+</span></div></summary>
    <div className="border-t border-cyan-100 p-5 sm:p-6"><button type="button" disabled={loading} onClick={() => dispatch({ type: "example-loaded", evidence: followUpExample.map((item) => ({ ...item })) })} className="rounded-lg border border-cyan-400 bg-white px-3 py-2 text-sm font-semibold text-cyan-900 disabled:opacity-50">Add example follow-up evidence</button>
    <form onSubmit={reinvestigate} className="mt-4 space-y-3">
      {evidence.map((item, index) => <div key={index} className="grid gap-2 md:grid-cols-[1fr_2fr_auto]"><input required disabled={loading} value={item.label} onChange={(event) => updateEvidence(index, "label", event.target.value)} aria-label={`New evidence ${index + 1} label`} placeholder="Label" className="rounded border border-zinc-300 bg-transparent p-2 disabled:opacity-50 dark:border-zinc-700" /><textarea required disabled={loading} rows={2} value={item.content} onChange={(event) => updateEvidence(index, "content", event.target.value)} aria-label={`New evidence ${index + 1} content`} placeholder="Content" className="rounded border border-zinc-300 bg-transparent p-2 disabled:opacity-50 dark:border-zinc-700" /><button type="button" disabled={loading} onClick={() => dispatch({ type: "evidence-removed", index })} className="text-sm text-red-700 disabled:opacity-50">Remove</button></div>)}
      <div className="flex flex-wrap items-center gap-2"><button type="button" disabled={loading} onClick={() => dispatch({ type: "evidence-added" })} className="rounded border border-zinc-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-zinc-700">Add evidence</button><button type="submit" disabled={loading || !canSubmit} className="inline-flex items-center gap-2 rounded bg-sky-800 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{loading && <span aria-hidden="true" className="size-3 animate-spin rounded-full border-2 border-current border-r-transparent" />}{loading ? "Investigating…" : "Re-investigate"}</button></div>
      {loading && <p role="status" className="text-sm text-slate-600">PRIOR is evaluating the new evidence against every hypothesis. This may take up to a minute.</p>}
      {memoryNotice && <p role="status" className="text-sm text-amber-800 dark:text-amber-300">{memoryNotice}</p>}
      {error && <p role="alert" className="text-sm text-red-800 dark:text-red-300">{error}</p>}
    </form></div>
  </details>;
}
