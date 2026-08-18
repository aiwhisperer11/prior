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

/**
 * The Audit panel's only source of truth for "verified": true only when the
 * server actually reported both an artifact key and a hash (which, per
 * CockroachDBMemoryStore.save(), can only be present because the write path
 * already independently verified the artifact in audit storage before
 * persisting). A historical row without one — or a null memory object —
 * renders "not available", never "verified".
 */
export function auditArtifactVerificationLabel(memory: MemoryLineageView | null): "verified" | "not available" {
  return memory?.auditVerificationStatus === "verified" && memory.auditArtifactKey && memory.auditArtifactSha256 && memory.auditStorageBackend && memory.auditArtifactVerifiedAt
    ? "verified"
    : "not available";
}

export default function InvestigationPresentation({ investigation, precedents, unclassifiedMemory, suspectedDuplicateMemory, memory, storage }: Props) {
  const [view, setView] = useState<PresentationView>("executive");
  const summary = deriveExecutiveSummary(investigation);
  const ledger = normalizeEvidenceLedger(investigation);
  const executiveEvidence = executiveEvidenceIds(investigation);
  const currentCase: CurrentCaseIdentity = { caseId: investigation.meta.case_id, caseTitle: investigation.meta.case_title, domain: investigation.meta.domain, observedOutcome: investigation.case.observed_outcome, expectedBehavior: investigation.case.expected_behavior };
  const relatedPrecedents = classifyMemoryLeads(precedents, currentCase).related;
  const lineageIssue = lineageMessage(investigation.meta.iteration, memory);
  function selectFromKey(current: PresentationView, event: KeyboardEvent<HTMLButtonElement>) {
    const next = nextPresentationView(current, event.key);
    if (!next) return;
    event.preventDefault(); setView(next); document.getElementById(`presentation-tab-${next}`)?.focus();
  }
  return <section aria-label="Investigation presentation">
    <div className="mb-6 flex flex-wrap gap-2" role="tablist" aria-label="Investigation presentation views">
      {views.map((item) => <button key={item} id={`presentation-tab-${item}`} type="button" role="tab" aria-selected={view === item} aria-controls={`presentation-panel-${item}`} tabIndex={view === item ? 0 : -1} onKeyDown={(event) => selectFromKey(item, event)} onClick={() => setView(item)} className={`rounded border px-3 py-1 text-sm ${view === item ? "border-violet-600 bg-violet-50" : "border-zinc-300"}`}>{title[item]}</button>)}
    </div>
    {view === "executive" && <article id="presentation-panel-executive" role="tabpanel" aria-labelledby="presentation-tab-executive" className="space-y-5">
      <h2 className="text-2xl font-bold">Executive summary</h2>
      <section><h3 className="font-semibold">What occurred</h3><p>{summary.issue_overview}</p></section>
      <section><h3 className="font-semibold">Demonstrated impact</h3><p>{summary.demonstrated_impact}</p></section>
      <section><h3 className="font-semibold">Causal assessment: {summary.causal_assessment.root_cause_status}</h3><p>{summary.causal_assessment.explanation}</p>{summary.causal_assessment.prime_suspect_id && <p className="text-sm">Prime suspect: {summary.causal_assessment.prime_suspect_id}</p>}</section>
      <section><h3 className="font-semibold">Immediate decision</h3><p>{summary.immediate_decision ?? "No immediate decision is supported by the current evidence."}</p></section>
      {executiveEvidence.length > 0 && <p className="text-sm text-zinc-600">Evidence supporting the causal assessment: {executiveEvidence.join(", ")}. See Investigator for the complete ledger.</p>}
    </article>}
    {view === "investigator" && <div id="presentation-panel-investigator" role="tabpanel" aria-labelledby="presentation-tab-investigator"><section className="mb-8"><h2 className="text-2xl font-bold">Evidence ledger</h2><div className="mt-3 space-y-3">{ledger.map((record) => <article key={record.id} className="rounded border border-zinc-200 p-3 text-sm dark:border-zinc-800"><p className="font-semibold">{record.id} · {record.source.name}</p><p className="mt-1">{record.summary}</p><dl className="mt-2 grid gap-1 text-xs text-zinc-600"><div><dt className="inline font-medium">Type: </dt><dd className="inline">{record.assertion_type}</dd></div><div><dt className="inline font-medium">Source: </dt><dd className="inline">{record.source.source_id} · {record.source.name}</dd></div><div><dt className="inline font-medium">Verification: </dt><dd className="inline">{record.verification_status} · corroboration: {record.corroboration_status}</dd></div><div><dt className="inline font-medium">Provenance: </dt><dd className="inline">{record.origin} · relevance: {record.case_relevance} · source reliability: {record.source_reliability}</dd></div></dl>{record.origin === "evidence_scout_accepted" && <p className="mt-1 rounded bg-violet-100 px-2 py-1 text-xs font-medium text-violet-900 dark:bg-violet-900/40 dark:text-violet-200">Evidence Scout, human-accepted{record.source.url && <> · <a href={record.source.url} target="_blank" rel="noreferrer" className="underline">{record.source.url}</a></>}</p>}{record.supports_hypothesis_ids.length > 0 && <p className="mt-1 text-xs">Supports: {record.supports_hypothesis_ids.join(", ")}</p>}{record.weakens_hypothesis_ids.length > 0 && <p className="mt-1 text-xs">Weakens: {record.weakens_hypothesis_ids.join(", ")}</p>}</article>)}</div></section><SherlockInvestigationView investigation={investigation} showLegacyEvidence={false} /></div>}
    {view === "audit" && <article id="presentation-panel-audit" role="tabpanel" aria-labelledby="presentation-tab-audit" className="space-y-3 text-sm"><h2 className="text-2xl font-bold">Audit & lineage</h2><p>case_id: <code>{investigation.meta.case_id}</code> · iteration: {investigation.meta.iteration} · backing store: {storage}</p><dl className="grid gap-1"><div><dt className="inline font-medium">investigation_id: </dt><dd className="inline"><code>{memory?.investigationId ?? "not reported"}</code></dd></div><div><dt className="inline font-medium">snapshot_id: </dt><dd className="inline"><code>{memory?.snapshotId ?? "not reported"}</code></dd></div><div><dt className="inline font-medium">source_id: </dt><dd className="inline"><code>{memory?.sourceId ?? "not reported"}</code></dd></div><div><dt className="inline font-medium">parent_snapshot_id: </dt><dd className="inline"><code>{memory?.parentSnapshotId ?? "not reported"}</code></dd></div><div><dt className="inline font-medium">model: </dt><dd className="inline"><code>{memory?.modelVersion ?? "not reported"}</code></dd></div><div><dt className="inline font-medium">prompt: </dt><dd className="inline"><code>{memory?.promptVersion ?? "not reported"}</code></dd></div><div><dt className="inline font-medium">embeddings: </dt><dd className="inline"><code>{memory?.embeddingModel ?? "not reported"}</code></dd></div></dl>{lineageIssue && <p className="rounded border border-amber-300 p-2 text-amber-900">{lineageIssue}</p>}<section><h3 className="font-semibold">Audit artifact</h3><p>Verification: <strong>{auditArtifactVerificationLabel(memory)}</strong></p>{memory?.auditArtifactKey && memory?.auditArtifactSha256 ? <dl className="mt-1 grid gap-1"><div><dt className="inline font-medium">backend: </dt><dd className="inline"><code>{memory.auditStorageBackend ?? "unknown"}</code></dd></div><div><dt className="inline font-medium">artifact_key: </dt><dd className="inline"><code>{memory.auditArtifactKey}</code></dd></div><div><dt className="inline font-medium">artifact_sha256: </dt><dd className="inline"><code>{memory.auditArtifactSha256}</code></dd></div>{memory.auditArtifactVersionId && <div><dt className="inline font-medium">version_id: </dt><dd className="inline"><code>{memory.auditArtifactVersionId}</code></dd></div>}{memory.auditArtifactVerifiedAt && <div><dt className="inline font-medium">verified_at: </dt><dd className="inline"><code>{memory.auditArtifactVerifiedAt}</code></dd></div>}</dl> : <p className="mt-1">No audit artifact is recorded for this snapshot.</p>}</section><section><h3 className="font-semibold">Related precedents ({relatedPrecedents.length})</h3>{relatedPrecedents.length > 0 ? <ul className="mt-2 space-y-2">{relatedPrecedents.map((lead, index) => <li key={`${lead.caseId ?? lead.caseTitle}-${index}`}><strong>{lead.caseTitle}</strong>: {lead.summary}</li>)}</ul> : <p className="mt-1">None retrieved.</p>}</section>{suspectedDuplicateMemory.length > 0 && <section><h3 className="font-semibold">Suspected duplicate memory ({suspectedDuplicateMemory.length})</h3><ul className="mt-2 space-y-2">{suspectedDuplicateMemory.map((item, index) => <li key={`${item.caseId}-${index}`}><strong>{item.caseTitle}</strong> (case_id: <code>{item.caseId}</code>): {item.summary} <span className="text-zinc-500">(Reason: {item.reason})</span></li>)}</ul></section>}{unclassifiedMemory.length > 0 && <section><h3 className="font-semibold">Unclassified legacy memory ({unclassifiedMemory.length})</h3><ul className="mt-2 space-y-2">{unclassifiedMemory.map((item, index) => <li key={`${item.caseTitle}-${index}`}><strong>{item.caseTitle}</strong>: {item.summary} <span className="text-zinc-500">({item.reason})</span></li>)}</ul></section>}</article>}
  </section>;
}
