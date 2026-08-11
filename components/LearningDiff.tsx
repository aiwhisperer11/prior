import type { SherlockInvestigation } from "@/types/sherlock";

interface LearningDiffProps {
  previous: SherlockInvestigation;
  latest: SherlockInvestigation;
}

export default function LearningDiff({ previous, latest }: LearningDiffProps) {
  const previousById = new Map(previous.hypotheses.map((hypothesis) => [hypothesis.id, hypothesis]));
  const changes = latest.hypotheses.map((hypothesis) => {
    const prior = previousById.get(hypothesis.id);
    return { hypothesis, prior, delta: prior ? hypothesis.confidence - prior.confidence : null };
  });
  const graveyardEntries = changes.filter(({ hypothesis, prior }) => hypothesis.status === "rejected" && prior?.status !== "rejected");

  return <section aria-labelledby="learning-diff-heading" className="rounded-lg border-2 border-amber-400 bg-amber-50 p-5 dark:bg-amber-950/20">
    <h2 id="learning-diff-heading" className="text-xl font-semibold">What changed in iteration {latest.meta.iteration}</h2>
    <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">Model learning summary: {latest.learning.summary}</p>
    {graveyardEntries.length > 0 && <div className="mt-4 rounded border border-amber-600 bg-amber-100 p-3 dark:bg-amber-950"><strong>Entered the Hypothesis Graveyard:</strong> {graveyardEntries.map(({ hypothesis }) => `${hypothesis.id} (${hypothesis.statement})`).join("; ")}</div>}
    <ul className="mt-4 space-y-3">{changes.map(({ hypothesis, prior, delta }) => <li key={hypothesis.id} className="rounded border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-950"><div className="flex flex-wrap justify-between gap-2"><strong>{hypothesis.id}</strong><span>{prior ? `${prior.confidence} → ${hypothesis.confidence} (${delta === 0 ? "flat" : delta && delta > 0 ? `↑ +${delta}` : `↓ ${delta}`})` : `new → ${hypothesis.confidence}`}</span></div><p className="mt-1">Status: <strong>{prior?.status ?? "new"} → {hypothesis.status}</strong></p>{hypothesis.status === "revived" && <p className="mt-1 text-sky-800 dark:text-sky-300">Revived: {hypothesis.resurrection_condition}</p>}</li>)}</ul>
  </section>;
}
