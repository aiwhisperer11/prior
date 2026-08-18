interface MetricCardProps {
  label: string;
  score: number;
  explanation: string;
}

export default function MetricCard({ label, score, explanation }: MetricCardProps) {
  return (
    <article className="prior-card p-5">
      <h3 className="prior-eyebrow">{label}</h3>
      <p className="mt-2 text-4xl font-black text-[var(--prior-violet)]">{score}</p>
      <p className="mt-2 text-sm text-slate-600">{explanation}</p>
    </article>
  );
}
