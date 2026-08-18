"use client";

import { useEffect, useState } from "react";

import SherlockForm, { type MemoryUpdate } from "@/components/SherlockForm";
import FollowUpEvidenceForm from "@/components/FollowUpEvidenceForm";
import LearningDiff from "@/components/LearningDiff";
import InvestigationPresentation from "@/components/InvestigationPresentation";
import EvidenceScoutSearchPanel from "@/components/EvidenceScoutSearchPanel";
import { appendInvestigationSnapshot } from "@/lib/follow-up-form-state";
import type { SherlockInvestigation } from "@/types/sherlock";
import { initialInvestigationViewState, showResults, startInvestigation, startNewInvestigation, type ActiveRequestMode } from "@/lib/investigation-view-state";

export default function Home() {
  const [snapshots, setSnapshots] = useState<SherlockInvestigation[]>([]);
  const [updatedIteration, setUpdatedIteration] = useState<number | null>(null);
  const [memory, setMemory] = useState<MemoryUpdate | null>(null);
  const [acceptedCandidateIds, setAcceptedCandidateIds] = useState<string[]>([]);
  const [viewState, setViewState] = useState(initialInvestigationViewState);
  const latestSnapshot = snapshots.at(-1);

  useEffect(() => {
    if (updatedIteration !== latestSnapshot?.meta.iteration) return;

    document.getElementById("investigation-result-heading")?.scrollIntoView({ behavior: "smooth", block: "start" });
    const timeoutId = window.setTimeout(() => setUpdatedIteration(null), 4_000);
    return () => window.clearTimeout(timeoutId);
  }, [latestSnapshot?.meta.iteration, updatedIteration]);

  return (
    <main className="mx-auto w-full max-w-6xl space-y-10 px-6 py-10">
      <header><h1 className="text-3xl font-bold">Sherlock</h1><p className="mt-1 text-zinc-600 dark:text-zinc-400">A falsification-driven investigation engine.</p></header>
      {viewState.view !== "results" && <SherlockForm key={viewState.session} onStart={(mode: ActiveRequestMode) => { setSnapshots([]); setMemory(null); setAcceptedCandidateIds([]); setViewState((state) => startInvestigation(state, mode)); }} onSnapshot={(snapshot) => { setSnapshots([snapshot]); setViewState((state) => showResults(state)); }} onSnapshotsLoaded={(loaded) => { setSnapshots(loaded); setViewState((state) => showResults(state)); }} onMemory={setMemory} />}
      {viewState.view === "investigating" && <p role="status" className="rounded border border-violet-300 bg-violet-50 p-4">Starting the investigation…</p>}
      {viewState.view === "results" && latestSnapshot && <>
        <header><h2 className="text-3xl font-bold">{latestSnapshot.meta.case_title}</h2><p className="text-zinc-600">{latestSnapshot.meta.domain}</p><p className="mt-2 text-sm">{memory?.precedents.length ?? 0} retrieved precedents · {latestSnapshot.case.evidence.length} case evidence · Storage: {memory?.storage === "cockroachdb" ? "CockroachDB (live)" : "local in-memory fallback"}</p></header>
        {snapshots.length >= 2 && latestSnapshot.meta.iteration > 1 && <LearningDiff previous={snapshots.at(-2)!} latest={latestSnapshot} />}
        <InvestigationPresentation investigation={latestSnapshot} precedents={memory?.precedents ?? []} unclassifiedMemory={memory?.unclassified_memory ?? []} suspectedDuplicateMemory={memory?.suspected_duplicate_memory ?? []} memory={memory?.memory ?? null} storage={memory?.storage ?? "local-mock"} />
        <EvidenceScoutSearchPanel caseId={latestSnapshot.meta.case_id} missingEvidence={latestSnapshot.missing_evidence} onCandidateAccepted={(candidateId) => setAcceptedCandidateIds((ids) => [...ids, candidateId])} />
        <FollowUpEvidenceForm previousSnapshot={latestSnapshot} acceptedCandidateIds={acceptedCandidateIds} onSnapshot={(snapshot) => { setSnapshots((current) => appendInvestigationSnapshot(current, snapshot)); setUpdatedIteration(snapshot.meta.iteration); setAcceptedCandidateIds([]); }} onMemory={setMemory} />
        <button type="button" onClick={() => { setSnapshots([]); setMemory(null); setUpdatedIteration(null); setAcceptedCandidateIds([]); setViewState((state) => startNewInvestigation(state)); }} className="rounded border border-zinc-400 px-4 py-2 text-sm">Start new investigation</button>
      </>}
    </main>
  );
}
