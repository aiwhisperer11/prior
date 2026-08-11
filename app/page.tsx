"use client";

import { useEffect, useState } from "react";

import SherlockForm from "@/components/SherlockForm";
import FollowUpEvidenceForm from "@/components/FollowUpEvidenceForm";
import LearningDiff from "@/components/LearningDiff";
import SherlockInvestigationView from "@/components/SherlockInvestigationView";
import { appendInvestigationSnapshot } from "@/lib/follow-up-form-state";
import type { SherlockInvestigation } from "@/types/sherlock";

export default function Home() {
  const [snapshots, setSnapshots] = useState<SherlockInvestigation[]>([]);
  const [updatedIteration, setUpdatedIteration] = useState<number | null>(null);
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
      <SherlockForm onSnapshot={(snapshot) => setSnapshots((current) => [...current, snapshot])} onSnapshotsLoaded={setSnapshots} />
      {snapshots.length >= 2 && <LearningDiff previous={snapshots.at(-2)!} latest={latestSnapshot!} />}
      {latestSnapshot && <FollowUpEvidenceForm previousSnapshot={latestSnapshot} onSnapshot={(snapshot) => { setSnapshots((current) => appendInvestigationSnapshot(current, snapshot)); setUpdatedIteration(snapshot.meta.iteration); }} />}
      {latestSnapshot && updatedIteration === latestSnapshot.meta.iteration && <p role="status" className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-200">Investigation updated.</p>}
      {latestSnapshot && <SherlockInvestigationView investigation={latestSnapshot} />}
    </main>
  );
}
