import type { FalsificationExpectationMatrix, MatrixItem } from "@/types/sherlock";

interface ExpectationMatrixProps {
  matrix: FalsificationExpectationMatrix;
}

const quadrants: Array<{
  key: keyof FalsificationExpectationMatrix;
  title: string;
  description: string;
}> = [
  { key: "expected_present", title: "Expected present", description: "What happened as expected." },
  { key: "unexpected_present", title: "Unexpected present", description: "What appeared unexpectedly." },
  { key: "expected_absent", title: "Expected absent", description: "What should have happened but did not." },
  { key: "unexpected_absent", title: "Unexpected absent", description: "What a hypothesis predicted but is missing." },
];

function MatrixItems({ items }: { items: MatrixItem[] }) {
  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item.id} className="border-t border-zinc-200 pt-3 first:border-t-0 first:pt-0 dark:border-zinc-800">
          <p className="font-medium">{item.id}: {item.description}</p>
          {item.significance.trim() && <details className="mt-1 text-sm text-zinc-600 dark:text-zinc-400"><summary className="cursor-pointer">Why it matters</summary><p className="mt-1">{item.significance}</p></details>}
          <p className="mt-1 text-xs text-zinc-500">
            Evidence: {item.evidence_ids.join(", ") || "none"} · Hypotheses: {item.related_hypothesis_ids.join(", ") || "none"}
          </p>
        </li>
      ))}
    </ul>
  );
}

export default function ExpectationMatrix({ matrix }: ExpectationMatrixProps) {
  return (
    <section aria-labelledby="expectation-matrix-heading">
      <div><p className="prior-eyebrow">Observed versus expected</p><h2 id="expectation-matrix-heading" className="prior-section-title mt-1">Expectation matrix</h2></div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {quadrants.filter((quadrant) => matrix[quadrant.key].length > 0).map((quadrant) => (
          <article
            key={quadrant.key}
            className={`rounded-[var(--prior-radius)] border p-4 shadow-[var(--prior-shadow-sm)] ${quadrant.key === "expected_absent" ? "border-amber-400 bg-[var(--prior-amber-soft)]" : quadrant.key === "unexpected_present" ? "border-cyan-200 bg-[var(--prior-cyan-soft)]" : "border-[var(--prior-border)] bg-[var(--prior-surface)]"}`}
          >
            <h3 className="font-semibold">{quadrant.title}</h3>
            <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">{quadrant.description}</p>
            <MatrixItems items={matrix[quadrant.key]} />
          </article>
        ))}
      </div>
    </section>
  );
}
