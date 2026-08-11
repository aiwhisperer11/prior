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
  if (!items.length) return <p className="text-sm text-zinc-500">None recorded.</p>;

  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item.id} className="border-t border-zinc-200 pt-3 first:border-t-0 first:pt-0 dark:border-zinc-800">
          <p className="font-medium">{item.id}: {item.description}</p>
          <details className="mt-1 text-sm text-zinc-600 dark:text-zinc-400"><summary className="cursor-pointer">Why it matters</summary><p className="mt-1">{item.significance}</p></details>
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
      <h2 id="expectation-matrix-heading" className="text-xl font-semibold">Expectation matrix</h2>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {quadrants.map((quadrant) => (
          <article
            key={quadrant.key}
            className={`rounded-lg border p-4 ${quadrant.key === "expected_absent" ? "border-amber-500 bg-amber-50 dark:bg-amber-950/30" : "border-zinc-200 dark:border-zinc-800"}`}
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
