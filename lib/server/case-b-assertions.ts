import type { InvestigationRequest, SherlockInvestigation } from "@/types/sherlock";
import { hypothesisFor, sharedAssertions, type CaseAssertion } from "@/lib/server/investigation-assertions-shared";

export type CaseBAssertion = CaseAssertion;

export function evaluateCaseB(
  request: InvestigationRequest,
  investigation: SherlockInvestigation,
): CaseBAssertion[] {
  const deploy = hypothesisFor(investigation, /deploy/i);
  const database = hypothesisFor(investigation, /database.*overload|overload.*database/i);
  const primeSuspectId = investigation.prime_suspect?.hypothesis_id ?? null;
  const primeSuspect = investigation.hypotheses.find((hypothesis) => hypothesis.id === primeSuspectId);
  const tlsAbsence = investigation.expectation_matrix.expected_absent.find(
    (item) => /tls.*renewal|renewal.*tls/i.test(item.description) && /log|confirmation|entry/i.test(item.description),
  );
  const deployHasContradiction = Boolean(
    deploy?.contradicted_by.some((link) => link.evidence_id === "E1") ||
      deploy?.expected_but_absent_ids.some((id) =>
        investigation.missing_evidence.some(
          (missing) => missing.id === id && /rollback|deploy/i.test(missing.description),
        ),
      ),
  );
  const retryReasoning = [
    investigation.coherence.explanation,
    investigation.prime_suspect?.justification ?? "",
    investigation.learning.summary,
    ...investigation.hypotheses.flatMap((hypothesis) => [
      ...hypothesis.supported_by.map((link) => link.reason),
      ...hypothesis.contradicted_by.map((link) => link.reason),
    ]),
  ].join("\n");

  return [
    ...sharedAssertions(request, investigation),
    {
      name: "Root cause status is determined, with a real prime suspect",
      passed: investigation.root_cause_status === "determined" && investigation.prime_suspect !== null,
      detail: `root_cause_status is ${investigation.root_cause_status}; prime_suspect is ${investigation.prime_suspect ? investigation.prime_suspect.hypothesis_id : "null"}.`,
    },
    {
      name: "Deploy is not selected by temporal proximity alone",
      passed: Boolean(deploy && deploy.id !== primeSuspectId && deploy.status !== "active"),
      detail: deploy ? `Deploy status is ${deploy.status}; prime suspect is ${primeSuspectId ?? "none"}.` : "No deploy hypothesis was returned.",
    },
    {
      name: "Missing or contradictory deploy artifacts weaken deploy",
      passed: Boolean(deploy && ["weakened", "rejected"].includes(deploy.status) && deployHasContradiction),
      detail: deploy ? `Deploy status is ${deploy.status}; contradiction link present: ${deployHasContradiction}.` : "No deploy hypothesis was returned.",
    },
    {
      name: "Missing TLS renewal artifact is a significant observable absence",
      passed: Boolean(tlsAbsence && tlsAbsence.significance.trim().length > 0),
      detail: tlsAbsence ? tlsAbsence.significance : "No TLS renewal log absence was found in expected_absent.",
    },
    {
      name: "DB overload is weakened or rejected by contradictory evidence",
      passed: Boolean(database && ["weakened", "rejected"].includes(database.status) && database.contradicted_by.some((link) => link.evidence_id === "E2")),
      detail: database ? `Database status is ${database.status}.` : "No database-overload hypothesis was returned.",
    },
    {
      name: "Prime suspect favors TLS or certificate failure when supported",
      passed: Boolean(primeSuspect && /tls|certificate|renewal/i.test(primeSuspect.statement)),
      detail: primeSuspect ? primeSuspect.statement : "prime_suspect does not reference a returned hypothesis.",
    },
    {
      name: "The 23:38 retry sweep participates in causal reasoning",
      passed: /23:38|retry sweep/i.test(retryReasoning),
      detail: "Checked coherence, prime-suspect justification, learning summary, and evidence-link reasons.",
    },
  ];
}
