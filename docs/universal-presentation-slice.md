# Universal presentation slice

This slice introduces derived read-models only. `ExecutiveSummary` and
`EvidenceRecord` are built from the canonical Sherlock investigation at render
time, so historical snapshots retain their original JSON and authoritative
schema. The executive causal assessment is sourced only from
`root_cause_status`, `prime_suspect`, and `undetermined_explanation`.

Legacy case evidence is normalized as `current_case` with explicit `unknown`,
`unverified`, and `unassessed` states where the old contract has no source or
verification metadata. A source claim is never upgraded to an observation by
the adapter. Retrieved memory stays a precedent lead outside the ledger.

`confidence` remains the existing relative investigative support/prioritization
score. It is not a probability and is intentionally not normalized across
hypotheses.

## Deferred response track

The operational response track is deliberately deferred; it would introduce a
new lifecycle and authorization boundary beyond this presentation slice. A
future optional contract is:

```ts
type ActionRecord = {
  id: string;
  description: string;
  status: "proposed" | "approved" | "executed" | "verified";
  owner: string | null;
  timestamp: string | null;
  result_evidence_ids: string[];
};
type ResponseTrack = {
  containment_actions: ActionRecord[];
  corrective_actions: ActionRecord[];
  preventive_actions: ActionRecord[];
};
```

It must remain optional for legacy snapshots. Action completion or successful
mitigation must not be used as proof of a root cause; a corrective action is
not validated without its result evidence.
