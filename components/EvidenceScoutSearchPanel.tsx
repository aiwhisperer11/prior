"use client";

import { useEffect, useRef, useState } from "react";

import type { MissingEvidence } from "@/types/sherlock";
import type { EvidenceScoutActionWithCandidates, SourceCandidate } from "@/types/evidence-scout";

interface Props {
  caseId: string;
  missingEvidence: MissingEvidence[];
  /** Point 7: only the candidate_id is threaded back up to the follow-up form -- never provenance content. */
  onCandidateAccepted: (candidateId: string) => void;
}

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 60_000;

/**
 * Minimal, Cloudflare-focused plan/authorize/poll/accept/reject flow. Not a
 * generic "search anything" UI -- the affordance is always scoped to one
 * named gap (a missing_evidence item, or a free-text intent the user
 * types), one action at a time, with an explicit authorization click before
 * any network call to the search endpoint fires.
 */
export default function EvidenceScoutSearchPanel({ caseId, missingEvidence, onCandidateAccepted }: Props) {
  const [selectedMissingEvidenceId, setSelectedMissingEvidenceId] = useState<string>(missingEvidence[0]?.id ?? "");
  const [queryIntent, setQueryIntent] = useState<string>(missingEvidence[0]?.description ?? "");
  const [action, setAction] = useState<EvidenceScoutActionWithCandidates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const [decidingCandidateId, setDecidingCandidateId] = useState<string | null>(null);
  const [acceptedIds, setAcceptedIds] = useState<Set<string>>(new Set());
  const pollTimer = useRef<number | null>(null);

  useEffect(() => () => { if (pollTimer.current) window.clearTimeout(pollTimer.current); }, []);

  function selectMissingEvidence(id: string) {
    setSelectedMissingEvidenceId(id);
    const item = missingEvidence.find((m) => m.id === id);
    if (item) setQueryIntent(item.description);
  }

  async function poll(actionId: string, startedAt: number) {
    try {
      const response = await fetch(`/api/investigate/evidence-scout/actions/${actionId}`);
      const body = (await response.json().catch(() => null)) as EvidenceScoutActionWithCandidates | { error: string } | null;
      if (!response.ok || !body || "error" in body) {
        setError(body && "error" in body ? body.error : `Polling failed with status ${response.status}`);
        return;
      }
      setAction(body);
      if (body.state === "completed" || body.state === "failed") return;
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        setError("Timed out waiting for the search action to complete.");
        return;
      }
      pollTimer.current = window.setTimeout(() => poll(actionId, startedAt), POLL_INTERVAL_MS);
    } catch {
      setError("The polling request could not be completed.");
    }
  }

  async function authorizeSearch() {
    if (!queryIntent.trim() || authorizing) return;
    setAuthorizing(true);
    setError(null);
    setAction(null);
    try {
      const response = await fetch("/api/investigate/evidence-scout/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          case_id: caseId,
          missing_evidence_id: selectedMissingEvidenceId || null,
          query_intent: queryIntent.trim(),
          queries: [queryIntent.trim()],
          max_candidates: 5,
          authorized: true,
        }),
      });
      const body = (await response.json().catch(() => null)) as { action_id: string; state: string } | { error: string } | null;
      if (!response.ok || !body || "error" in body) {
        setError(body && "error" in body ? body.error : `Search request failed with status ${response.status}`);
        return;
      }
      await poll(body.action_id, Date.now());
    } catch {
      setError("The search request could not be completed.");
    } finally {
      setAuthorizing(false);
    }
  }

  async function decide(candidate: SourceCandidate, decision: "accept" | "reject") {
    setDecidingCandidateId(candidate.candidate_id);
    setError(null);
    try {
      const response = await fetch(`/api/investigate/evidence-scout/candidates/${candidate.candidate_id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const body = (await response.json().catch(() => null)) as { candidate_id: string; state: string } | { error: string } | null;
      if (!response.ok || !body || "error" in body) {
        setError(body && "error" in body ? body.error : `Decision request failed with status ${response.status}`);
        return;
      }
      setAction((current) => current ? { ...current, candidates: current.candidates.map((c) => c.candidate_id === candidate.candidate_id ? { ...c, state: body.state as SourceCandidate["state"] } : c) } : current);
      if (decision === "accept") {
        setAcceptedIds((ids) => new Set(ids).add(candidate.candidate_id));
        onCandidateAccepted(candidate.candidate_id);
      }
    } catch {
      setError("The decision request could not be completed.");
    } finally {
      setDecidingCandidateId(null);
    }
  }

  const isSearching = action?.state === "authorized" || action?.state === "searching";

  return (
    <section aria-labelledby="evidence-scout-heading" className="overflow-hidden rounded-[var(--prior-radius-lg)] border border-violet-300 bg-[var(--prior-night-raised)] text-white shadow-[var(--prior-shadow)]">
      <div className="border-b border-white/10 p-5 sm:p-6"><p className="text-xs font-bold uppercase tracking-[0.16em] text-violet-300">Governed evidence acquisition</p><div className="mt-2 flex flex-wrap items-end justify-between gap-3"><div><h2 id="evidence-scout-heading" className="text-2xl font-bold">Evidence Scout</h2><p className="mt-1 max-w-3xl text-sm text-slate-300">Search never becomes evidence automatically. Review each candidate and accept it explicitly before it can be included in a re-investigation.</p></div><span className="rounded-full bg-amber-300/10 px-3 py-1 text-xs font-bold text-amber-200 ring-1 ring-amber-300/30">Human governed</span></div></div>
      <ol aria-label="Evidence Scout workflow" className="grid border-b border-white/10 sm:grid-cols-2 lg:grid-cols-4">{["Select evidence gap", "Human authorization", "Review candidates", "Accept before reinvestigation"].map((step, index) => <li key={step} className="flex items-center gap-3 border-white/10 px-5 py-3 text-xs font-semibold text-slate-200 sm:border-r last:border-r-0"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-violet-500 text-[0.68rem] font-black text-white">{index + 1}</span>{step}</li>)}</ol>
      <div className="p-5 sm:p-6">

      {missingEvidence.length > 0 && (
        <label className="mt-3 block text-sm font-medium">
          Missing evidence gap
          <select value={selectedMissingEvidenceId} onChange={(event) => selectMissingEvidence(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-600 bg-slate-950/40 p-2.5 text-white">
            {missingEvidence.map((item) => <option key={item.id} value={item.id}>{item.id}: {item.description.slice(0, 80)}</option>)}
            <option value="">Other (describe below)</option>
          </select>
        </label>
      )}
      <label className="mt-3 block text-sm font-medium">
        What are we looking for
        <textarea rows={2} value={queryIntent} onChange={(event) => setQueryIntent(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-600 bg-slate-950/40 p-2.5 text-white" />
      </label>

      <button type="button" disabled={authorizing || isSearching || !queryIntent.trim()} onClick={authorizeSearch} className="mt-4 rounded-lg bg-[var(--prior-violet)] px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-violet-950/30 transition hover:bg-violet-500 disabled:opacity-50">
        {authorizing || isSearching ? "Searching…" : "Authorize search"}
      </button>

      {error && <p role="alert" className="mt-3 text-sm text-red-800 dark:text-red-300">{error}</p>}

      {action?.state === "failed" && <p role="alert" className="mt-3 text-sm text-red-800 dark:text-red-300">Search failed: {action.failure_code ?? "unknown_error"}.</p>}

      {action?.state === "completed" && (
        <ul className="mt-4 space-y-3">
          {action.candidates.length === 0 && <li className="text-sm text-zinc-600 dark:text-zinc-400">No candidates were found. Absence of a search result is not evidence of anything.</li>}
          {action.candidates.map((candidate) => (
            <li key={candidate.candidate_id} className="rounded-xl border border-slate-700 bg-slate-950/40 p-4 text-sm">
              <p className="font-semibold">{candidate.document_title ?? candidate.publisher ?? candidate.source_url}</p>
              <p className="mt-1 text-xs text-slate-400">{candidate.tier} · {candidate.verification_status} · reliability: {candidate.source_reliability}</p>
              <p className="mt-1"><a href={candidate.source_url} target="_blank" rel="noreferrer" className="underline">{candidate.source_url}</a></p>
              <p className="mt-1">{candidate.claim_summary}</p>
              {candidate.cited_text && <blockquote className="mt-1 border-l-2 border-violet-400 pl-2 italic">&ldquo;{candidate.cited_text}&rdquo;</blockquote>}
              {candidate.verification_status === "source_located"
                ? <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">source_located candidates cannot become evidence.</p>
                : candidate.state === "pending" ? (
                  <div className="mt-2 flex gap-2">
                    <button type="button" disabled={decidingCandidateId === candidate.candidate_id} onClick={() => decide(candidate, "accept")} className="rounded border border-green-600 px-2 py-1 text-xs font-semibold text-green-800 disabled:opacity-50 dark:text-green-300">Accept</button>
                    <button type="button" disabled={decidingCandidateId === candidate.candidate_id} onClick={() => decide(candidate, "reject")} className="rounded border border-red-600 px-2 py-1 text-xs font-semibold text-red-800 disabled:opacity-50 dark:text-red-300">Reject</button>
                  </div>
                ) : <p className="mt-2 text-xs font-semibold">{candidate.state === "accepted" ? "Accepted" : "Rejected"}{acceptedIds.has(candidate.candidate_id) ? " -- will be included in the next re-investigation" : ""}</p>}
            </li>
          ))}
        </ul>
      )}
      </div>
    </section>
  );
}
