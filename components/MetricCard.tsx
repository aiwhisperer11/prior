interface MetricCardProps {
  label: string;
  score: number;
  explanation: string;
}

export default function MetricCard({ label, score, explanation }: MetricCardProps) {
  return (
    <article className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <h3 className="text-sm font-medium text-zinc-600 dark:text-zinc-400">{label}</h3>
      <p className="mt-1 text-3xl font-bold">{score}</p>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{explanation}</p>
    </article>
  );
}
