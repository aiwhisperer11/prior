"use client";

import { useState, type KeyboardEvent } from "react";
import SherlockInvestigationView from "@/components/SherlockInvestigationView";
import { deriveExecutiveSummary, executiveEvidenceIds, normalizeEvidenceLedger } from "@/lib/investigation-presentation";
import { classifyMemoryLeads, type CurrentCaseIdentity, type MemoryLineageView, type PrecedentLeadView, type SuspectedDuplicateView, type UnclassifiedLegacyMemoryView } from "@/lib/investigation-response";
import type { SherlockInvestigation } from "@/types/sherlock";

interface Props { investigation: SherlockInvestigation; precedents: PrecedentLeadView[]; unclassifiedMemory: UnclassifiedLegacyMemoryView[]; suspectedDuplicateMemory: SuspectedDuplicateView[]; memory: MemoryLineageView | null; storage: "cockroachdb" | "local-mock"; }
export type PresentationView = "executive" | "investigator" | "audit";
const views: PresentationView[] = ["executive", "investigator", "audit"];
const title: Record<PresentationView, string> = { executive: "Executive", investigator: "Investigator", audit: "Audit & lineage" };

export function nextPresentationView(current: PresentationView, key: string): PresentationView | null {
  const index = views.indexOf(current);
  if (key === "Home") return views[0];
  if (key === "End") return views.at(-1)!;
  if (key === "ArrowRight") return views[(index + 1) % views.length]!;
  if (key === "ArrowLeft") return views[(index + views.length - 1) % views.length]!;
  return null;
}

function lineageMessage(iteration: number, memory: MemoryLineageView | null): string | null {
  if (!memory) return "Lineage was not reported for this response.";
  const valid = iteration === 1 ? memory.parentSnapshotId === null : memory.parentSnapshotId !== null;
  return valid ? null : `Historical lineage is inconsistent: iteration ${iteration} is recorded with parent_snapshot_id ${memory.parentSnapshotId ?? "null"}. No stored snapshot has been changed.`;
}

export function auditArtifactVerificationLabel(memory: MemoryLineageView | null): "verified" | "not available" {
  return memory?.auditVerificationStatus === "verified" && memory.auditArtifactKey && memory.auditArtifactSha256 && memory.auditStorageBackend && memory.auditArtifactVerifiedAt ? "verified" : "not available";
}

function MetadataItem({ label, value }: { label: string; value: string | number }) {
  return <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-50/80 p-4"><dt className="prior-eyebrow">{label}</dt><dd className="prior-mono mt-2 text-sm font-semibold text-slate-800">{value}</dd></div>;
}

export default function InvestigationPresentation({ investigation, precedents, unclassifiedMemory, suspectedDuplicateMemory, memory, storage }: Props) {
  const [view, setView] = useState<PresentationView>("executive");
  const summary = deriveExecutiveSummary(investigation);
  const ledger = normalizeEvidenceLedger(investigation);
  const executiveEvidence = executiveEvidenceIds(investigation);
  const currentCase: CurrentCaseIdentity = { caseId: investigation.meta.case_id, caseTitle: investigation.meta.case_title, domain: investigation.meta.domain, observedOutcome: investigation.case.observed_outcome, expectedBehavior: investigation.case.expected_behavior };
  const relatedPrecedents = classifyMemoryLeads(precedents, currentCase).related;
  const lineageIssue = lineageMessage(investigation.meta.iteration, memory);
  const verification = auditArtifactVerificationLabel(memory);

  function selectFromKey(current: PresentationView, event: KeyboardEvent<HTMLButtonElement>) {
    const next = nextPresentationView(current, event.key);
    if (!next) return;
    event.preventDefault(); setView(next); document.getElementById(`presentation-tab-${next}`)?.focus();
  }

  return <section aria-label="Investigation presentation">
    <div className="sticky top-0 z-20 -mx-4 border-y border-slate-200 bg-[color:var(--prior-canvas)]/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border" role="tablist" aria-label="Investigation presentation views"><div className="flex gap-1 overflow-x-auto">
      {views.map((item) => <button key={item} id={`presentation-tab-${item}`} type="button" role="tab" aria-selected={view === item} aria-controls={`presentation-panel-${item}`} tabIndex={view === item ? 0 : -1} onKeyDown={(event) => selectFromKey(item, event)} onClick={() => setView(item)} className={`min-w-max rounded-lg px-4 py-2.5 text-sm font-bold transition ${view === item ? "bg-[var(--prior-night)] text-white shadow-md" : "text-slate-600 hover:bg-white hover:text-violet-800"}`}>{title[item]}</button>)}
    </div></div>

    {view === "executive" && <article id="presentation-panel-executive" role="tabpanel" aria-labelledby="presentation-tab-executive" className="mt-6 grid gap-4 lg:grid-cols-12">
      <section className="prior-card border-violet-200 bg-gradient-to-br from-white to-[var(--prior-violet-soft)] p-6 lg:col-span-8 lg:row-span-2"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="prior-eyebrow text-violet-700">Causal assessment</p><h2 className="mt-2 text-2xl font-bold tracking-tight text-[var(--prior-night)]">Root cause {summary.causal_assessment.root_cause_status}</h2></div>{summary.causal_assessment.prime_suspect_id && <span className="rounded-full bg-[var(--prior-violet)] px-4 py-2 text-sm font-black text-white shadow-lg shadow-violet-900/15">Prime suspect {summary.causal_assessment.prime_suspect_id}</span>}</div><p className="mt-5 max-w-3xl text-base leading-7 text-slate-700">{summary.causal_assessment.explanation}</p>{executiveEvidence.length > 0 && <p className="mt-6 border-t border-violet-200 pt-4 text-sm font-medium text-violet-950">Evidence supporting the causal assessment: {executiveEvidence.join(", ")}. See Investigator for the complete ledger.</p>}</section>
      <section className="prior-card p-5 lg:col-span-4"><p className="prior-eyebrow text-cyan-700">Situation</p><h3 className="prior-section-title mt-2">What occurred</h3><p className="mt-3 text-sm leading-6 text-slate-700">{summary.issue_overview}</p></section>
      <section className="prior-card p-5 lg:col-span-4"><p className="prior-eyebrow text-cyan-700">Observed consequence</p><h3 className="prior-section-title mt-2">Demonstrated impact</h3><p className="mt-3 text-sm leading-6 text-slate-700">{summary.demonstrated_impact}</p></section>
      <section className="prior-card border-amber-200 bg-[var(--prior-amber-soft)] p-5 lg:col-span-12"><div className="grid gap-3 md:grid-cols-[13rem_1fr]"><div><p className="prior-eyebrow text-amber-800">Decision point</p><h3 className="prior-section-title mt-2">Immediate decision</h3></div><p className="text-sm leading-6 text-amber-950">{summary.immediate_decision ?? "No immediate decision is supported by the current evidence."}</p></div></section>
      <a href="#evidence-scout" className="group flex items-center justify-between rounded-[var(--prior-radius)] bg-[var(--prior-violet)] p-5 text-white shadow-[var(--prior-shadow)] transition hover:bg-violet-700 lg:col-span-12"><span><span className="block text-xs font-bold uppercase tracking-[0.16em] text-violet-200">Primary evidence action</span><span className="mt-1 block text-lg font-bold">Open Evidence Scout</span></span><span aria-hidden="true" className="text-2xl transition group-hover:translate-x-1">→</span></a>
    </article>}

    {view === "investigator" && <div id="presentation-panel-investigator" role="tabpanel" aria-labelledby="presentation-tab-investigator" className="mt-6">
      <nav aria-label="Investigator sections" className="sticky top-[4.65rem] z-10 mb-5 overflow-x-auto rounded-xl border border-slate-200 bg-white/95 p-2 shadow-sm backdrop-blur"><div className="flex min-w-max gap-1">{[["#prime-suspect-heading", "Assessment"], ["#evidence-ledger", "Evidence"], ["#expectation-matrix-heading", "Expectation matrix"], ["#hypotheses-heading", "Hypotheses"], ["#wald-heading", "Missing evidence"], ["#next-test-heading", "Next test"], ["#evidence-scout", "Evidence Scout"]].map(([href, label]) => <a key={href} href={href} className="rounded-lg px-3 py-2 text-xs font-bold text-slate-600 hover:bg-violet-50 hover:text-violet-800">{label}</a>)}</div></nav>
      <section id="evidence-ledger" className="mb-7 scroll-mt-36"><div className="flex items-end justify-between gap-4"><div><p className="prior-eyebrow">Evidence system</p><h2 className="mt-1 text-2xl font-bold text-[var(--prior-night)]">Evidence ledger</h2></div><span className="rounded-full bg-[var(--prior-cyan-soft)] px-3 py-1 text-xs font-bold text-cyan-800">{ledger.length} records</span></div><div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{ledger.map((record) => <article key={record.id} className="prior-card flex min-w-0 flex-col p-4 text-sm"><div className="flex items-start justify-between gap-3"><p className="font-bold text-[var(--prior-night)]"><span className="mr-2 rounded bg-cyan-100 px-2 py-1 text-xs text-cyan-800">{record.id}</span>{record.source.name}</p><span className="text-[0.68rem] font-bold uppercase tracking-wide text-slate-500">{record.verification_status}</span></div><p className="mt-3 flex-1 leading-6 text-slate-700">{record.summary}</p><dl className="mt-4 space-y-1.5 border-t border-slate-100 pt-3 text-xs text-slate-600"><div><dt className="inline font-bold">Type: </dt><dd className="inline">{record.assertion_type}</dd></div><div><dt className="inline font-bold">Source: </dt><dd className="inline">{record.source.source_id} · {record.source.name}</dd></div><div><dt className="inline font-bold">Corroboration: </dt><dd className="inline">{record.corroboration_status}</dd></div><div><dt className="inline font-bold">Provenance: </dt><dd className="inline">{record.origin} · relevance: {record.case_relevance} · source reliability: {record.source_reliability}</dd></div></dl>{record.origin === "evidence_scout_accepted" && <p className="mt-3 rounded-lg bg-[var(--prior-violet-soft)] px-3 py-2 text-xs font-bold text-violet-900">Evidence Scout, human-accepted{record.source.url && <> · <a href={record.source.url} target="_blank" rel="noreferrer" className="underline">{record.source.url}</a></>}</p>}{record.supports_hypothesis_ids.length > 0 && <p className="mt-2 text-xs"><strong>Supports:</strong> {record.supports_hypothesis_ids.join(", ")}</p>}{record.weakens_hypothesis_ids.length > 0 && <p className="mt-1 text-xs"><strong>Weakens:</strong> {record.weakens_hypothesis_ids.join(", ")}</p>}</article>)}</div></section>
      <SherlockInvestigationView investigation={investigation} showLegacyEvidence={false} />
    </div>}

    {view === "audit" && <article id="presentation-panel-audit" role="tabpanel" aria-labelledby="presentation-tab-audit" className="mt-6 space-y-5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-4"><div><p className="prior-eyebrow">Trust record</p><h2 className="mt-1 text-2xl font-bold text-[var(--prior-night)]">Audit & lineage</h2></div><span className={`rounded-full px-4 py-2 text-xs font-black uppercase tracking-wide ${verification === "verified" ? "bg-[var(--prior-green-soft)] text-green-800 ring-1 ring-green-600/20" : "bg-slate-200 text-slate-700"}`}>{verification}</span></div>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><MetadataItem label="Case" value={investigation.meta.case_id} /><MetadataItem label="Investigation" value={memory?.investigationId ?? "not reported"} /><MetadataItem label="Snapshot" value={memory?.snapshotId ?? "not reported"} /><MetadataItem label="Source" value={memory?.sourceId ?? "not reported"} /><MetadataItem label="Parent snapshot" value={memory?.parentSnapshotId ?? "not reported"} /><MetadataItem label="Iteration" value={investigation.meta.iteration} /><MetadataItem label="Backing store" value={storage} /><MetadataItem label="Model" value={memory?.modelVersion ?? "not reported"} /><MetadataItem label="Prompt" value={memory?.promptVersion ?? "not reported"} /><MetadataItem label="Embeddings" value={memory?.embeddingModel ?? "not reported"} /></dl>
      {lineageIssue && <p className="rounded-xl border border-amber-300 bg-[var(--prior-amber-soft)] p-4 font-medium text-amber-950">{lineageIssue}</p>}
      <section className="prior-card p-5"><div className="flex items-center justify-between gap-3"><h3 className="prior-section-title">Audit artifact</h3><span className="text-xs font-bold uppercase tracking-wide text-slate-500">Verification: {verification}</span></div>{memory?.auditArtifactKey && memory?.auditArtifactSha256 ? <dl className="mt-4 grid gap-3 md:grid-cols-2"><MetadataItem label={memory.auditStorageBackend === "local" ? "Artifact verifier" : "Backend"} value={memory.auditStorageBackend ?? "unknown"} /><MetadataItem label="Artifact" value={memory.auditArtifactKey} /><MetadataItem label="Artifact SHA-256" value={memory.auditArtifactSha256} />{memory.auditArtifactVersionId && <MetadataItem label="Version" value={memory.auditArtifactVersionId} />}{memory.auditArtifactVerifiedAt && <MetadataItem label="Verified at" value={memory.auditArtifactVerifiedAt} />}</dl> : <p className="mt-3 text-slate-600">No audit artifact is recorded for this snapshot.</p>}</section>
      <section><div className="flex items-end justify-between gap-3"><h3 className="prior-section-title">Related precedents</h3><span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-bold">{relatedPrecedents.length}</span></div>{relatedPrecedents.length > 0 ? <ul className="mt-3 grid gap-3 md:grid-cols-2">{relatedPrecedents.map((lead, index) => <li key={`${lead.caseId ?? lead.caseTitle}-${index}`} className="prior-card p-4"><strong className="text-[var(--prior-night)]">{lead.caseTitle}</strong><p className="mt-2 leading-6 text-slate-600">{lead.summary}</p></li>)}</ul> : <p className="mt-2 text-slate-600">None retrieved.</p>}</section>
      {suspectedDuplicateMemory.length > 0 && <section><h3 className="prior-section-title">Suspected duplicate memory ({suspectedDuplicateMemory.length})</h3><ul className="mt-3 grid gap-3 md:grid-cols-2">{suspectedDuplicateMemory.map((item, index) => <li key={`${item.caseId}-${index}`} className="prior-card p-4"><strong>{item.caseTitle}</strong><p className="prior-mono mt-1 text-xs">Case: {item.caseId}</p><p className="mt-2 text-slate-600">{item.summary} <span>(Reason: {item.reason})</span></p></li>)}</ul></section>}
      {unclassifiedMemory.length > 0 && <section><h3 className="prior-section-title">Unclassified legacy memory ({unclassifiedMemory.length})</h3><ul className="mt-3 grid gap-3 md:grid-cols-2">{unclassifiedMemory.map((item, index) => <li key={`${item.caseTitle}-${index}`} className="prior-card p-4"><strong>{item.caseTitle}</strong><p className="mt-2 text-slate-600">{item.summary} <span>({item.reason})</span></p></li>)}</ul></section>}
    </article>}
  </section>;
}
