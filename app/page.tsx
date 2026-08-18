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
    <div className="min-h-screen bg-[var(--prior-canvas)]">
      <header className="border-b border-white/10 bg-[var(--prior-night)] text-white shadow-[var(--prior-shadow)]">
        <div className="mx-auto flex w-full max-w-[1360px] items-center justify-between gap-6 px-5 py-5 sm:px-8">
          <div className="flex items-center gap-4"><div aria-hidden="true" className="grid size-10 place-items-center rounded-xl bg-[var(--prior-violet)] text-lg font-black shadow-lg shadow-violet-950/30">P</div><div><h1 className="text-xl font-black tracking-[0.18em]">PRIOR</h1><p className="text-sm text-slate-300">Falsification-driven intelligence, governed by evidence.</p></div></div>
          <div className="hidden items-center gap-2 text-xs font-semibold text-slate-300 sm:flex"><span className="size-2 rounded-full bg-emerald-400" />Causal intelligence console</div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1360px] space-y-8 px-4 py-7 sm:px-8 sm:py-10">
      {viewState.view !== "results" && <SherlockForm key={viewState.session} onStart={(mode: ActiveRequestMode) => { setSnapshots([]); setMemory(null); setAcceptedCandidateIds([]); setViewState((state) => startInvestigation(state, mode)); }} onSnapshot={(snapshot) => { setSnapshots([snapshot]); setViewState((state) => showResults(state)); }} onSnapshotsLoaded={(loaded) => { setSnapshots(loaded); setViewState((state) => showResults(state)); }} onMemory={setMemory} />}
      {viewState.view === "investigating" && <p role="status" className="prior-card border-violet-300 bg-[var(--prior-violet-soft)] p-4 font-medium text-violet-950">Starting the investigation…</p>}
      {viewState.view === "results" && latestSnapshot && <>
        <header className="overflow-hidden rounded-[var(--prior-radius-lg)] bg-[var(--prior-night-raised)] p-6 text-white shadow-[var(--prior-shadow)] sm:p-8"><p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-300">Active case · Iteration {latestSnapshot.meta.iteration}</p><div className="mt-3 flex flex-wrap items-start justify-between gap-5"><div><h2 id="investigation-result-heading" className="max-w-4xl text-2xl font-bold tracking-tight sm:text-3xl">{latestSnapshot.meta.case_title}</h2><p className="mt-1 text-slate-300">{latestSnapshot.meta.domain}</p></div><div className="flex max-w-xl flex-wrap gap-2"><span className="rounded-full bg-emerald-400/15 px-3 py-1 text-xs font-bold text-emerald-300 ring-1 ring-emerald-300/30">{latestSnapshot.root_cause_status === "determined" ? "Determined" : latestSnapshot.root_cause_status}</span>{latestSnapshot.prime_suspect && <span className="rounded-full bg-violet-400/15 px-3 py-1 text-xs font-bold text-violet-200 ring-1 ring-violet-300/30">Prime suspect {latestSnapshot.prime_suspect.hypothesis_id}</span>}<span className="rounded-full bg-cyan-400/15 px-3 py-1 text-xs font-bold text-cyan-200 ring-1 ring-cyan-300/30">{memory?.storage === "cockroachdb" ? "CockroachDB live" : "Local memory"}</span><span className="rounded-full bg-white/8 px-3 py-1 text-xs font-semibold text-slate-200 ring-1 ring-white/15">{latestSnapshot.case.evidence.length} evidence</span><span className="rounded-full bg-white/8 px-3 py-1 text-xs font-semibold text-slate-200 ring-1 ring-white/15">{memory?.precedents.length ?? 0} precedents</span></div></div></header>
        {snapshots.length >= 2 && latestSnapshot.meta.iteration > 1 && <LearningDiff previous={snapshots.at(-2)!} latest={latestSnapshot} />}
        <InvestigationPresentation investigation={latestSnapshot} precedents={memory?.precedents ?? []} unclassifiedMemory={memory?.unclassified_memory ?? []} suspectedDuplicateMemory={memory?.suspected_duplicate_memory ?? []} memory={memory?.memory ?? null} storage={memory?.storage ?? "local-mock"} />
        <div id="evidence-scout"><EvidenceScoutSearchPanel caseId={latestSnapshot.meta.case_id} missingEvidence={latestSnapshot.missing_evidence} onCandidateAccepted={(candidateId) => setAcceptedCandidateIds((ids) => [...ids, candidateId])} /></div>
        <FollowUpEvidenceForm previousSnapshot={latestSnapshot} acceptedCandidateIds={acceptedCandidateIds} onSnapshot={(snapshot) => { setSnapshots((current) => appendInvestigationSnapshot(current, snapshot)); setUpdatedIteration(snapshot.meta.iteration); setAcceptedCandidateIds([]); }} onMemory={setMemory} />
        <button type="button" onClick={() => { setSnapshots([]); setMemory(null); setUpdatedIteration(null); setAcceptedCandidateIds([]); setViewState((state) => startNewInvestigation(state)); }} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold shadow-sm hover:border-violet-400 hover:text-violet-800">Start new investigation</button>
      </>}
      </main>
    </div>
  );
}
