import ExpectationMatrix from "@/components/ExpectationMatrix";
import HypothesisCard from "@/components/HypothesisCard";
import MetricCard from "@/components/MetricCard";
import type { MissingEvidenceCriticality, SherlockInvestigation } from "@/types/sherlock";

interface SherlockInvestigationViewProps {
  investigation: SherlockInvestigation;
}

const criticalities: MissingEvidenceCriticality[] = ["critical", "useful", "noise"];

export default function SherlockInvestigationView({ investigation }: SherlockInvestigationViewProps) {
  const currentHypotheses = investigation.hypotheses.filter((hypothesis) => hypothesis.status !== "rejected").sort((a, b) => b.confidence - a.confidence);
  const graveyard = investigation.hypotheses.filter((hypothesis) => hypothesis.status === "rejected").sort((a, b) => b.confidence - a.confidence);
  const primeHypothesis = investigation.hypotheses.find((hypothesis) => hypothesis.id === investigation.prime_suspect.hypothesis_id);
  const investigationState = investigation.meta.iteration === 1 ? "Initial investigation" : "Updated investigation";

  return <article className="space-y-9">
    <header>
      <p className="text-sm text-zinc-500">Schema {investigation.schema_version} · Case {investigation.meta.case_id}</p>
      <p className="mt-1 text-sm font-medium">{investigationState}</p>
      <div className="mt-1 flex flex-wrap items-center gap-3"><h1 id="investigation-result-heading" className="text-3xl font-bold">{investigation.meta.case_title}</h1><span className="rounded-full border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700">Iteration {investigation.meta.iteration}</span></div>
      <p className="mt-1 text-zinc-600 dark:text-zinc-400">{investigation.meta.domain}</p>
      <dl className="mt-4 grid gap-3 text-sm md:grid-cols-2"><div><dt className="font-medium">Observed outcome</dt><dd>{investigation.case.observed_outcome}</dd></div><div><dt className="font-medium">Expected behavior</dt><dd>{investigation.case.expected_behavior}</dd></div></dl>
      <details className="mt-4 text-sm"><summary className="cursor-pointer font-medium">Case evidence</summary><ul className="mt-2 space-y-2">{investigation.case.evidence.map((item) => <li key={item.id} className={item.provided_in_iteration === investigation.meta.iteration ? "rounded border border-sky-400 bg-sky-50 p-2 dark:bg-sky-950/20" : ""}><strong>{item.id} · {item.label}</strong> (iteration {item.provided_in_iteration}){item.provided_in_iteration === investigation.meta.iteration ? " · New evidence" : ""}: {item.content}</li>)}</ul></details>
    </header>

    <ExpectationMatrix matrix={investigation.expectation_matrix} />

    <section aria-labelledby="anomalies-heading"><h2 id="anomalies-heading" className="text-xl font-semibold">Anomalies</h2><ul className="mt-3 space-y-3">{investigation.anomalies.map((anomaly) => <li key={anomaly.id} className="rounded border border-zinc-200 p-4 dark:border-zinc-800"><p className="font-medium">{anomaly.id}: {anomaly.description}</p><p className="mt-1 text-sm">Severity: {anomaly.severity} · Fully explained: {anomaly.fully_explained ? "yes" : "no"}</p><p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Matrix: {anomaly.matrix_item_ids.join(", ")} · Hypotheses: {anomaly.hypothesis_ids.join(", ")}</p></li>)}</ul></section>

    <section aria-labelledby="hypotheses-heading"><h2 id="hypotheses-heading" className="text-xl font-semibold">Hypotheses</h2><div className="mt-3 grid gap-3 lg:grid-cols-2">{currentHypotheses.map((hypothesis) => <HypothesisCard key={hypothesis.id} hypothesis={hypothesis} />)}</div>{graveyard.length > 0 && <div className="mt-6 rounded-lg border border-zinc-300 bg-zinc-100/70 p-4 dark:border-zinc-800 dark:bg-zinc-950/60"><h3 className="text-lg font-semibold text-zinc-700 dark:text-zinc-300">Hypothesis Graveyard</h3><p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Rejected explanations</p><div className="mt-3 grid gap-3 lg:grid-cols-2">{graveyard.map((hypothesis) => <HypothesisCard key={hypothesis.id} hypothesis={hypothesis} />)}</div></div>}</section>

    <section aria-labelledby="prime-suspect-heading" className="rounded-lg border border-zinc-300 p-5 dark:border-zinc-700"><h2 id="prime-suspect-heading" className="text-xl font-semibold">Prime suspect</h2><p className="mt-2 font-medium">{primeHypothesis?.statement ?? investigation.prime_suspect.hypothesis_id}</p><dl className="mt-3 space-y-2 text-sm"><div><dt className="font-medium">Justification</dt><dd>{investigation.prime_suspect.justification}</dd></div><div><dt className="font-medium">Condemning datum</dt><dd>{investigation.prime_suspect.condemning_datum}</dd></div><div><dt className="font-medium">Absolving datum</dt><dd>{investigation.prime_suspect.absolving_datum}</dd></div></dl></section>

    <section aria-labelledby="wald-heading"><h2 id="wald-heading" className="text-xl font-semibold">Missing evidence (WALD)</h2><p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">High-value missing evidence that would most effectively distinguish between the remaining hypotheses.</p><div className="mt-3 grid gap-3 md:grid-cols-3">{criticalities.map((criticality) => <div key={criticality} className="rounded border border-zinc-200 p-4 dark:border-zinc-800"><h3 className="font-semibold capitalize">{criticality}</h3><ul className="mt-2 space-y-3 text-sm">{investigation.missing_evidence.filter((item) => item.criticality === criticality).map((item) => <li key={item.id}><p className="font-medium">{item.id}: {item.description}</p><details className="mt-1 text-zinc-600 dark:text-zinc-400"><summary className="cursor-pointer">Impact if found</summary><p className="mt-1">{item.impact_if_found}</p></details><p className="mt-1 text-xs text-zinc-500">Hypotheses: {item.related_hypothesis_ids.join(", ") || "none"}</p></li>) || <li>None.</li>}</ul></div>)}</div></section>

    <section aria-labelledby="next-test-heading"><h2 id="next-test-heading" className="text-xl font-semibold">Next test</h2><p className="mt-2">{investigation.next_test.description}</p><p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Discriminates between: {investigation.next_test.discriminates_between.join(", ")}</p><div className="mt-3 overflow-x-auto"><table className="w-full border-collapse text-sm"><thead><tr className="border-b border-zinc-300 text-left dark:border-zinc-700"><th className="p-2">Observed result</th><th className="p-2">Favors</th><th className="p-2">Weakens</th></tr></thead><tbody>{investigation.next_test.outcome_map.map((outcome) => <tr key={`${outcome.observed_result}-${outcome.favors_hypothesis_id}`} className="border-b border-zinc-200 align-top dark:border-zinc-800"><td className="p-2">{outcome.observed_result}</td><td className="p-2">{outcome.favors_hypothesis_id ?? "None"}</td><td className="p-2">{outcome.weakens_hypothesis_id ?? "None"}</td></tr>)}</tbody></table></div></section>

    <section aria-label="Investigation metrics" className="grid gap-3 md:grid-cols-2"><MetricCard label="Coherence" score={investigation.coherence.score} explanation={investigation.coherence.explanation} /><MetricCard label="Open case index" score={investigation.open_case_index.score} explanation={investigation.open_case_index.explanation} /></section>

    <footer className="border-t border-zinc-300 pt-5 dark:border-zinc-700"><h2 className="text-xl font-semibold">Mirror question</h2><p className="mt-2 italic">{investigation.mirror_question}</p></footer>

    <section aria-labelledby="learning-heading"><h2 id="learning-heading" className="text-xl font-semibold">Learning</h2><p className="mt-2 text-sm">Baseline: {investigation.learning.is_baseline ? "yes" : "no"}</p><p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{investigation.learning.summary}</p><ul className="mt-3 space-y-2">{investigation.learning.updates.map((update) => <li key={update.hypothesis_id} className="rounded border border-zinc-200 p-3 text-sm dark:border-zinc-800"><strong>{update.hypothesis_id}</strong>: {update.previous_confidence ?? "—"} → {update.new_confidence}; {update.previous_status ?? "—"} → {update.new_status}. {update.reason}</li>)}</ul></section>
  </article>;
}
