import type { EvidenceItem, SherlockHypothesis } from "@/types/sherlock";

interface HypothesisCardProps {
  hypothesis: SherlockHypothesis;
  evidenceById: Map<string, EvidenceItem>;
}

const statusStyle: Record<SherlockHypothesis["status"], string> = {
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  weakened: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  rejected: "bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-300",
  revived: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
};

const confidenceStyle: Record<SherlockHypothesis["status"], string> = {
  active: "text-emerald-700 dark:text-emerald-300",
  weakened: "text-amber-700 dark:text-amber-300",
  rejected: "text-zinc-500 dark:text-zinc-400",
  revived: "text-sky-700 dark:text-sky-300",
};

const cardStyle: Record<SherlockHypothesis["status"], string> = {
  active: "border-emerald-200 bg-white",
  weakened: "border-amber-200 bg-amber-50/40 dark:border-amber-900 dark:bg-amber-950/10",
  rejected: "border-zinc-300 border-dashed bg-zinc-100/80 opacity-80 dark:border-zinc-800 dark:bg-zinc-900/70",
  revived: "border-sky-200 bg-sky-50/40 dark:border-sky-900 dark:bg-sky-950/10",
};

export default function HypothesisCard({ hypothesis, evidenceById }: HypothesisCardProps) {
  return (
    <article className={`rounded-[var(--prior-radius)] border p-5 shadow-[var(--prior-shadow-sm)] ${cardStyle[hypothesis.status]}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-zinc-500">{hypothesis.id} · {hypothesis.origin === "user" ? "seed hypothesis" : "engine-generated hypothesis"}</p>
          <h3 className="mt-1 font-semibold">{hypothesis.statement}</h3>
        </div>
        <div className="text-right">
          <div className="flex items-end justify-end gap-2">
            <p className={`text-4xl font-bold leading-none ${confidenceStyle[hypothesis.status]}`}>{hypothesis.confidence}</p>
            <span className={`rounded-full px-2 py-1 text-xs font-semibold uppercase ${statusStyle[hypothesis.status]}`}>
              {hypothesis.status}
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">investigative support score</p>
        </div>
      </div>

      <p className="mt-2 text-xs text-zinc-500">A relative support/prioritization score, not a probability; scores need not total 100.</p>
      {(hypothesis.supported_by.length > 0 || hypothesis.contradicted_by.length > 0) && <details className="mt-4 text-sm">
        <summary className="cursor-pointer font-medium">{hypothesis.supported_by.length} supporting · {hypothesis.contradicted_by.length} contradicting</summary>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {hypothesis.supported_by.length > 0 && <div>
            <h4 className="font-medium">Supported by</h4>
            <ul className="mt-1 space-y-1 text-zinc-600 dark:text-zinc-400">
              {hypothesis.supported_by.map((link) => <li key={`${link.evidence_id}-${link.reason}`}><strong>{link.evidence_id}</strong>: {link.reason}{evidenceById.get(link.evidence_id) && <p className="mt-1 text-xs">{evidenceById.get(link.evidence_id)!.content}</p>}</li>)}
            </ul>
          </div>}
          {hypothesis.contradicted_by.length > 0 && <div>
            <h4 className="font-medium">Contradicted by</h4>
            <ul className="mt-1 space-y-1 text-zinc-600 dark:text-zinc-400">
              {hypothesis.contradicted_by.map((link) => <li key={`${link.evidence_id}-${link.reason}`}><strong>{link.evidence_id}</strong>: {link.reason}{evidenceById.get(link.evidence_id) && <p className="mt-1 text-xs">{evidenceById.get(link.evidence_id)!.content}</p>}</li>)}
            </ul>
          </div>}
        </div>
      </details>}

      <dl className="mt-4 space-y-2 text-sm">
        {hypothesis.expected_but_absent_ids.length > 0 && <div><dt className="font-medium">Expected but absent</dt><dd>{hypothesis.expected_but_absent_ids.join(", ")}</dd></div>}
        {hypothesis.would_be_refuted_by.trim() && <div><dt className="font-medium">Would be refuted by</dt><dd>{hypothesis.would_be_refuted_by}</dd></div>}
        {hypothesis.status === "rejected" && <>
          <div><dt className="font-medium">Killed by</dt><dd>{hypothesis.killed_by}</dd></div>
          <div><dt className="font-medium">Resurrection condition</dt><dd>{hypothesis.resurrection_condition}</dd></div>
        </>}
      </dl>
    </article>
  );
}
