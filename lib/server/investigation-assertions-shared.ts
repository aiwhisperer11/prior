import type { InvestigationRequest, SherlockInvestigation } from "@/types/sherlock";

export interface CaseAssertion {
  name: string;
  passed: boolean;
  detail: string;
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
 * It does not attempt subjective prose scoring or require fixed case wording.
 */
export function genericFillerFields(investigation: SherlockInvestigation): string[] {
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

/** P1: every evidence id referenced anywhere in the output must be a supplied id. */
export function unknownEvidenceIds(
  request: InvestigationRequest,
  investigation: SherlockInvestigation,
): string[] {
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
  return referencedEvidenceIds.filter((id) => !suppliedEvidenceIds.has(id));
}

const CONTRACTIONS: Record<string, string> = {
  "n't": " not",
  "'re": " are",
  "'s": " is",
  "'ve": " have",
  "'ll": " will",
  "'d": " would",
  "'m": " am",
};

/**
 * Deterministic structural normalization, not prose scoring: expands common
 * English contractions and strips punctuation so "we hadn't seen" and "we had
 * not seen" compare equal. Without this, a faithful paraphrase the model is
 * free to make (contraction expansion) reads as a dropped user hypothesis.
 */
function normalizeForComparison(text: string): string {
  let normalized = text.toLowerCase();
  for (const [contraction, expansion] of Object.entries(CONTRACTIONS)) {
    normalized = normalized.split(contraction).join(expansion);
  }
  return normalized.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * True if every word of `shorter` appears in `longer`, in the same relative
 * order (not necessarily contiguous). Deterministic and still structural —
 * order-preserving subsequence, not fuzzy similarity — but tolerant of a
 * faithful insertion or trailing extension the model is free to make (e.g.
 * "the freshness delays" -> "the data-freshness delays and downstream ...
 * impact"), which strict substring containment rejects as a dropped
 * hypothesis even though every original word is still present in order.
 */
function isWordSubsequence(shorter: string[], longer: string[]): boolean {
  let index = 0;
  for (const word of longer) {
    if (index < shorter.length && word === shorter[index]) index += 1;
  }
  return index === shorter.length;
}

/** Every supplied user hypothesis must be retained with origin=user. */
export function userHypothesesPreserved(
  request: InvestigationRequest,
  investigation: SherlockInvestigation,
): boolean {
  return (request.user_hypotheses ?? []).every((statement) => {
    const statementWords = normalizeForComparison(statement).split(" ");
    return investigation.hypotheses.some((hypothesis) => {
      const hypothesisWords = normalizeForComparison(hypothesis.statement).split(" ");
      return (
        hypothesis.origin === "user" &&
        (isWordSubsequence(statementWords, hypothesisWords) || isWordSubsequence(hypothesisWords, statementWords))
      );
    });
  });
}

/** C3: status "rejected" requires killed_by and resurrection_condition. */
export function rejectedHypothesesSatisfyLifecycle(investigation: SherlockInvestigation): boolean {
  return investigation.hypotheses
    .filter((hypothesis) => hypothesis.status === "rejected")
    .every((hypothesis) => Boolean(hypothesis.killed_by?.trim() && hypothesis.resurrection_condition?.trim()));
}

/**
 * P9: next_test must structurally discriminate the leading question — an
 * outcome_map entry that weakens one hypothesis and favors a named rival
 * also present in discriminates_between.
 *
 * Two modes, matching root_cause_status:
 * - "determined" (prime_suspect non-null): the weakened hypothesis must be
 *   the prime suspect specifically — reads investigation.prime_suspect.hypothesis_id.
 * - "undetermined" (prime_suspect null): there is no single leading
 *   hypothesis to defend, so the requirement generalizes to "some outcome
 *   favors one genuine rival and weakens a different one" among the
 *   candidate hypotheses in discriminates_between.
 *
 * Ids listed in does_not_discriminate_from are excluded from the set of
 * required rivals — a hypothesis that is not a true competing alternative
 * (e.g. a causal precondition nested inside another's mechanism) should not
 * force a fabricated weakens/favors relationship. This never weakens P9
 * itself: if excluding declared-non-competing ids leaves fewer than two
 * genuine rivals, the check still fails — declaring away every competitor is
 * not a legitimate way to satisfy this principle.
 */
export function nextTestDiscriminatesPrimeSuspect(investigation: SherlockInvestigation): {
  passed: boolean;
  detail: string;
} {
  const primeSuspectId = investigation.prime_suspect?.hypothesis_id ?? null;
  const testHypotheses = new Set(investigation.next_test.discriminates_between);
  const knownHypothesisIds = new Set(investigation.hypotheses.map((hypothesis) => hypothesis.id));
  const declaredNonCompeting = new Set(investigation.next_test.does_not_discriminate_from);

  if (primeSuspectId !== null) {
    const competingTestHypotheses = [...testHypotheses].filter(
      (hypothesisId) =>
        hypothesisId !== primeSuspectId &&
        knownHypothesisIds.has(hypothesisId) &&
        !declaredNonCompeting.has(hypothesisId),
    );
    const primeWeakeningOutcome = investigation.next_test.outcome_map.find(
      (outcome) =>
        outcome.observed_result.trim().length > 0 &&
        outcome.weakens_hypothesis_id === primeSuspectId &&
        outcome.favors_hypothesis_id !== null &&
        outcome.favors_hypothesis_id !== primeSuspectId &&
        testHypotheses.has(outcome.favors_hypothesis_id) &&
        !declaredNonCompeting.has(outcome.favors_hypothesis_id),
    );

    const passed =
      testHypotheses.has(primeSuspectId) && competingTestHypotheses.length > 0 && Boolean(primeWeakeningOutcome);

    const rivalIds = [...testHypotheses].filter((id) => id !== primeSuspectId);
    return {
      passed,
      detail: primeWeakeningOutcome
        ? `${primeWeakeningOutcome.observed_result} favors ${primeWeakeningOutcome.favors_hypothesis_id} and weakens ${primeWeakeningOutcome.weakens_hypothesis_id}.`
        : competingTestHypotheses.length === 0 && rivalIds.length > 0
          ? `Every non-prime-suspect id in discriminates_between (${rivalIds.join(", ")}) is declared in does_not_discriminate_from; P9 still requires at least one genuine rival.`
          : "No discriminating outcome weakens the prime suspect in favor of a named competitor.",
    };
  }

  // root_cause_status "undetermined": no prime suspect to anchor on. Require
  // an outcome that favors one genuine rival and weakens a different one.
  const genuineRivals = [...testHypotheses].filter(
    (id) => knownHypothesisIds.has(id) && !declaredNonCompeting.has(id),
  );
  const discriminatingOutcome = investigation.next_test.outcome_map.find(
    (outcome) =>
      outcome.observed_result.trim().length > 0 &&
      outcome.favors_hypothesis_id !== null &&
      outcome.weakens_hypothesis_id !== null &&
      outcome.favors_hypothesis_id !== outcome.weakens_hypothesis_id &&
      genuineRivals.includes(outcome.favors_hypothesis_id) &&
      genuineRivals.includes(outcome.weakens_hypothesis_id),
  );
  const passed = genuineRivals.length >= 2 && Boolean(discriminatingOutcome);
  return {
    passed,
    detail: discriminatingOutcome
      ? `${discriminatingOutcome.observed_result} favors ${discriminatingOutcome.favors_hypothesis_id} and weakens ${discriminatingOutcome.weakens_hypothesis_id}.`
      : genuineRivals.length < 2
        ? `Fewer than two genuine rivals remain in discriminates_between after excluding does_not_discriminate_from (${genuineRivals.join(", ") || "none"}); root_cause_status is undetermined, so P9 requires at least two.`
        : "No discriminating outcome favors one genuine rival while weakening a different one.",
  };
}

/** does_not_discriminate_from must only reference ids actually in discriminates_between and known to the case. */
export function invalidNonDiscriminatingIds(investigation: SherlockInvestigation): string[] {
  const testHypotheses = new Set(investigation.next_test.discriminates_between);
  const knownHypothesisIds = new Set(investigation.hypotheses.map((hypothesis) => hypothesis.id));
  return investigation.next_test.does_not_discriminate_from.filter(
    (id) => !testHypotheses.has(id) || !knownHypothesisIds.has(id),
  );
}

export function hypothesisFor(
  investigation: SherlockInvestigation,
  matcher: RegExp,
): SherlockInvestigation["hypotheses"][number] | undefined {
  return investigation.hypotheses.find((hypothesis) => matcher.test(hypothesis.statement));
}

export function sharedAssertions(
  request: InvestigationRequest,
  investigation: SherlockInvestigation,
): CaseAssertion[] {
  const unknownIds = unknownEvidenceIds(request, investigation);
  const userHypothesesOk = userHypothesesPreserved(request, investigation);
  const rejectedLifecycleOk = rejectedHypothesesSatisfyLifecycle(investigation);
  const nextTest = nextTestDiscriminatesPrimeSuspect(investigation);
  const filler = genericFillerFields(investigation);
  const invalidNonDiscriminating = invalidNonDiscriminatingIds(investigation);

  return [
    {
      name: "Evidence IDs are supplied IDs only",
      passed: unknownIds.length === 0,
      detail: unknownIds.length ? `Unknown IDs: ${unknownIds.join(", ")}` : "All structured evidence references are supplied IDs.",
    },
    {
      name: "User hypotheses preserve origin=user",
      passed: userHypothesesOk,
      detail: userHypothesesOk ? "Every supplied user hypothesis is retained with origin=user." : "A supplied user hypothesis is missing or has the wrong origin.",
    },
    {
      name: "Rejected hypotheses satisfy lifecycle fields",
      passed: rejectedLifecycleOk,
      detail: "Every rejected hypothesis must include killed_by and resurrection_condition.",
    },
    {
      name: "next_test structurally discriminates the prime suspect",
      passed: nextTest.passed,
      detail: nextTest.detail,
    },
    {
      name: "Generic filler is rejected by the documented narrow heuristic",
      passed: filler.length === 0,
      detail: filler.length ? `Generic filler: ${filler.join(" | ")}` : "No exact sentinel or 'further analysis' filler was found.",
    },
    {
      name: "does_not_discriminate_from ids are valid and within discriminates_between",
      passed: invalidNonDiscriminating.length === 0,
      detail: invalidNonDiscriminating.length
        ? `Invalid ids: ${invalidNonDiscriminating.join(", ")}`
        : "Every declared non-competing id is a known hypothesis within discriminates_between.",
    },
  ];
}
