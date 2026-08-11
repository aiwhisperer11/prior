import type { InvestigationRequest, SherlockHypothesis, SherlockInvestigation } from "@/types/sherlock";

export interface CaseBAssertion {
  name: string;
  passed: boolean;
  detail: string;
}

function hypothesisFor(
  investigation: SherlockInvestigation,
  matcher: RegExp,
): SherlockHypothesis | undefined {
  return investigation.hypotheses.find((hypothesis) => matcher.test(hypothesis.statement));
}

function allText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allText);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(allText);
  return [];
}

/**
 * This intentionally narrow P11 check rejects only exact empty-information
 * sentinels and the explicitly prohibited non-test phrase "further analysis".
 * It does not attempt subjective prose scoring or require fixed Case B wording.
 */
function genericFillerFields(investigation: SherlockInvestigation): string[] {
  const exactSentinels = new Set([
    "unknown",
    "not applicable",
    "n/a",
    "none",
    "insufficient information",
  ]);

  return allText(investigation).filter((text) => {
    const normalized = text.trim().toLowerCase().replace(/[.!]+$/, "");
    return exactSentinels.has(normalized) || /\bfurther analysis\b/i.test(text);
  });
}

export function evaluateCaseB(
  request: InvestigationRequest,
  investigation: SherlockInvestigation,
): CaseBAssertion[] {
  const suppliedEvidenceIds = new Set(request.evidence.map((evidence) => evidence.id));
  const referencedEvidenceIds = [
    ...investigation.case.evidence.map((evidence) => evidence.id),
    ...[
      ...investigation.expectation_matrix.expected_present,
      ...investigation.expectation_matrix.unexpected_present,
      ...investigation.expectation_matrix.expected_absent,
      ...investigation.expectation_matrix.unexpected_absent,
    ].flatMap((item) => item.evidence_ids),
    ...investigation.hypotheses.flatMap((hypothesis) => [
      ...hypothesis.supported_by.map((link) => link.evidence_id),
      ...hypothesis.contradicted_by.map((link) => link.evidence_id),
      ...(hypothesis.killed_by?.match(/^E\d+$/) ? [hypothesis.killed_by] : []),
    ]),
  ];
  const unknownEvidenceIds = referencedEvidenceIds.filter((id) => !suppliedEvidenceIds.has(id));

  const deploy = hypothesisFor(investigation, /deploy/i);
  const database = hypothesisFor(investigation, /database.*overload|overload.*database/i);
  const primeSuspect = investigation.hypotheses.find(
    (hypothesis) => hypothesis.id === investigation.prime_suspect.hypothesis_id,
  );
  const userHypothesesPreserved = (request.user_hypotheses ?? []).every((statement) => {
    const normalizedStatement = statement.trim().toLowerCase();
    return investigation.hypotheses.some((hypothesis) => {
      const normalizedHypothesis = hypothesis.statement.trim().toLowerCase();
      return (
        hypothesis.origin === "user" &&
        (normalizedHypothesis.includes(normalizedStatement) ||
          normalizedStatement.includes(normalizedHypothesis))
      );
    });
  });
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
    investigation.prime_suspect.justification,
    investigation.learning.summary,
    ...investigation.hypotheses.flatMap((hypothesis) => [
      ...hypothesis.supported_by.map((link) => link.reason),
      ...hypothesis.contradicted_by.map((link) => link.reason),
    ]),
  ].join("\n");
  const testHypotheses = new Set(investigation.next_test.discriminates_between);
  const knownHypothesisIds = new Set(investigation.hypotheses.map((hypothesis) => hypothesis.id));
  const competingTestHypotheses = [...testHypotheses].filter(
    (hypothesisId) => hypothesisId !== investigation.prime_suspect.hypothesis_id && knownHypothesisIds.has(hypothesisId),
  );
  const primeWeakeningOutcome = investigation.next_test.outcome_map.find(
    (outcome) =>
      outcome.observed_result.trim().length > 0 &&
      outcome.weakens_hypothesis_id === investigation.prime_suspect.hypothesis_id &&
      outcome.favors_hypothesis_id !== null &&
      outcome.favors_hypothesis_id !== investigation.prime_suspect.hypothesis_id &&
      testHypotheses.has(outcome.favors_hypothesis_id),
  );

  return [
    {
      name: "Evidence IDs are supplied IDs only",
      passed: unknownEvidenceIds.length === 0,
      detail: unknownEvidenceIds.length ? `Unknown IDs: ${unknownEvidenceIds.join(", ")}` : "All structured evidence references are supplied IDs.",
    },
    {
      name: "User hypotheses preserve origin=user",
      passed: userHypothesesPreserved,
      detail: userHypothesesPreserved ? "Every supplied user hypothesis is retained with origin=user." : "A supplied user hypothesis is missing or has the wrong origin.",
    },
    {
      name: "Deploy is not selected by temporal proximity alone",
      passed: Boolean(deploy && deploy.id !== investigation.prime_suspect.hypothesis_id && deploy.status !== "active"),
      detail: deploy ? `Deploy status is ${deploy.status}; prime suspect is ${investigation.prime_suspect.hypothesis_id}.` : "No deploy hypothesis was returned.",
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
      name: "Rejected hypotheses satisfy lifecycle fields",
      passed: investigation.hypotheses.filter((hypothesis) => hypothesis.status === "rejected").every(
        (hypothesis) => Boolean(hypothesis.killed_by?.trim() && hypothesis.resurrection_condition?.trim()),
      ),
      detail: "Every rejected hypothesis must include killed_by and resurrection_condition.",
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
    {
      name: "next_test structurally discriminates the prime suspect",
      passed:
        testHypotheses.has(investigation.prime_suspect.hypothesis_id) &&
        competingTestHypotheses.length > 0 &&
        Boolean(primeWeakeningOutcome),
      detail: primeWeakeningOutcome
        ? `${primeWeakeningOutcome.observed_result} favors ${primeWeakeningOutcome.favors_hypothesis_id} and weakens ${primeWeakeningOutcome.weakens_hypothesis_id}.`
        : "No discriminating outcome weakens the prime suspect in favor of a named competitor.",
    },
    {
      name: "Generic filler is rejected by the documented narrow heuristic",
      passed: genericFillerFields(investigation).length === 0,
      detail: genericFillerFields(investigation).length
        ? `Generic filler: ${genericFillerFields(investigation).join(" | ")}`
        : "No exact sentinel or 'further analysis' filler was found.",
    },
  ];
}
