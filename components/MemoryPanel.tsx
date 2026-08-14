import type { MemoryLineageView, PrecedentLeadView } from "@/lib/investigation-response";

interface MemoryPanelProps {
  precedents: PrecedentLeadView[];
  memory: MemoryLineageView | null;
  storage: "cockroachdb" | "local-mock";
}

export default function MemoryPanel({ precedents, memory, storage }: MemoryPanelProps) {
  return (
    <section className="rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm dark:border-amber-800 dark:bg-amber-950/20">
      <h2 className="text-xl font-semibold">Agentic memory</h2>
      <p className="mt-1 text-zinc-700 dark:text-zinc-300">
        Backing store: {storage === "cockroachdb" ? "CockroachDB (live)" : "Local in-memory dev fallback (no DATABASE_URL configured)"}. Memory is a lead, never evidence.
      </p>

      <h3 className="mt-4 font-medium">Retrieved precedents ({precedents.length})</h3>
      {precedents.length === 0 ? (
        <p className="mt-1 text-zinc-600 dark:text-zinc-400">No prior investigations retrieved as precedents.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {precedents.map((lead, index) => (
            <li key={`${lead.caseId ?? lead.caseTitle}-${index}`} className="rounded border border-amber-200 p-3 dark:border-amber-900">
              <p className="font-medium">
                {lead.caseTitle} {lead.isMock && <span className="text-xs font-normal text-amber-700 dark:text-amber-400">[MOCK]</span>}
              </p>
              <p className="mt-1">{lead.summary}</p>
              {lead.whyRelevant && <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">Why retrieved: {lead.whyRelevant}</p>}
              {typeof lead.similarityScore === "number" && (
                <p className="text-xs text-zinc-600 dark:text-zinc-400">Similarity (L2 distance): {lead.similarityScore.toFixed(4)}</p>
              )}
              <p className="mt-1 text-xs font-semibold text-amber-800 dark:text-amber-400">Precedent, not case evidence.</p>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-4 font-medium">Persisted to {storage === "cockroachdb" ? "CockroachDB" : "the local dev store"}</h3>
      {memory ? (
        <dl className="mt-2 grid gap-1 text-xs">
          <div><dt className="inline font-medium">investigation_id: </dt><dd className="inline font-mono">{memory.investigationId}</dd></div>
          <div><dt className="inline font-medium">snapshot (source_id): </dt><dd className="inline font-mono">{memory.sourceId}</dd></div>
          <div><dt className="inline font-medium">parent_snapshot_id: </dt><dd className="inline font-mono">{memory.parentSnapshotId ?? "none — first snapshot for this case"}</dd></div>
          <div><dt className="inline font-medium">model_version: </dt><dd className="inline font-mono">{memory.modelVersion}</dd></div>
          <div><dt className="inline font-medium">prompt_version: </dt><dd className="inline font-mono">{memory.promptVersion}</dd></div>
          <div><dt className="inline font-medium">embedding_model: </dt><dd className="inline font-mono">{memory.embeddingModel}</dd></div>
        </dl>
      ) : (
        <p className="mt-1 text-zinc-600 dark:text-zinc-400">No lineage record available for this response.</p>
      )}
    </section>
  );
}
