import type { InvestigationRequest, SherlockInvestigation } from "@/types/sherlock";
import { sharedAssertions, type CaseAssertion } from "@/lib/server/investigation-assertions-shared";

/**
 * Case source: Google Cloud, status.cloud.google.com/security/incidents/wCAYU8nZcNY1sMVJPb7p
 * ("Google SecOps data freshness delays", 2026-07-31 10:11 PDT - 2026-08-01 22:53 PDT).
 * Captured 2026-08-12. Every fact in examples/case-google-secops-2026.json is a
 * direct quote or timestamp from that page. Google resolved the incident
 * operationally but never published a root cause. These assertions do not test
 * whether Sherlock guesses the right mechanism (there is no public ground truth
 * to guess) — they test whether it correctly distinguishes fact from hypothesis
 * and declares the cause undetermined instead of inventing one.
 *
 * "Undetermined" is checked structurally via root_cause_status/prime_suspect/
 * undetermined_explanation (schema fields), not via text-pattern matching on
 * hypothesis statements — root_cause_status is an epistemic field independent
 * of the hypotheses array; "the cause is undetermined" must never itself be a
 * hypothesis or a prime_suspect (see C4/P5 in lib/sherlock-prompt.ts).
 *
 * Criterion 8 (complementary hypotheses must not be penalized for coexisting) is
 * satisfied by construction, not by a runtime check here: these assertions reuse
 * nextTestDiscriminatesPrimeSuspect via sharedAssertions(), which already accepts
 * next_test.does_not_discriminate_from for hypotheses that are not true rivals
 * (built and tested earlier this session) — nothing below penalizes multiple
 * simultaneously-active mechanism hypotheses.
 */
export type CaseGoogleSecOpsAssertion = CaseAssertion;

const MECHANISM_PATTERNS: Array<[string, RegExp]> = [
  ["pipeline failure", /pipeline (failure|fault|error|bug)/i],
  ["backlog/capacity", /(backlog|capacity|overload|congestion|queue(d|ing)? (build[- ]?up|depth))/i],
  // Allows up to 4 intervening descriptive words ("shared regional data-availability
  // dependency"), not just direct adjacency — a real live run used exactly this
  // phrasing for a genuine shared-dependency hypothesis; requiring immediate
  // adjacency was an evaluator false negative, not a reasoning gap.
  ["shared dependency", /(shared|upstream|downstream)(\s+[\w-]+){0,4}\s+(dependency|dependenc|service|component)/i],
  ["defective deploy/config", /(defective|faulty|bad|broken) (deploy|release|rollout|change|config)|region-specific (configuration|rollout|control-plane)/i],
  ["index corruption", /(index|indices) (corrupt|inconsisten|integrity)/i],
];

/** Guards against the model still smuggling the epistemic conclusion into a hypothesis statement despite root_cause_status existing. */
const RESTATES_UNDETERMINED_AS_HYPOTHESIS_PATTERN =
  /root cause (is|remains|has not been) (undetermined|not (been )?(determined|established|confirmed|identified))|cause (remains|is) undetermined|no root cause (was |is |has been )?(published|stated|confirmed|disclosed)|cannot be (determined|established|confirmed) from (the )?available (public )?evidence/i;

const CONFIRMED_LANGUAGE_PATTERN =
  /\b(is|as|was) (the )?confirmed (root )?cause\b|\bconfirmed as (the )?(root )?cause\b|\bdefinitively (caused|proven)\b|\bproven to be the cause\b|\bestablished as the cause\b/i;

const INTERNAL_DATA_PATTERN =
  /internal (engineering )?(telemetry|log|metric|data)|deploy (log|history|record)|capacity (metric|utilization|dashboard)|post ?mortem|incident report|ingestion (pipeline|queue) (log|metric)|index (build |integrity )?(log|audit)|engineering (postmortem|report)|configuration.*(change|control-plane).*history|control-plane state/i;

const MENTIONS_CAUSE_PATTERN = /\b(the |root )?cause\b/i;
const RESOLUTION_WITHOUT_CONFIRMING_PATTERN =
  /(resolv|mitigat)\w*[^.]*?(without|does not|doesn't|is not|isn't|never|does not equal|should not be (read|interpreted|taken))[^.]*?(confirm|determin|establish|prov|identif|stat(e|ing)|name|publish|disclos)\w*/i;

function separatesRecoveryFromCauseText(text: string): boolean {
  return MENTIONS_CAUSE_PATTERN.test(text) && RESOLUTION_WITHOUT_CONFIRMING_PATTERN.test(text);
}

function rootCauseStructurallyUndetermined(investigation: SherlockInvestigation): boolean {
  return (
    investigation.root_cause_status === "undetermined" &&
    investigation.prime_suspect === null &&
    Boolean(investigation.undetermined_explanation?.trim())
  );
}

function noHypothesisRestatesUndeterminedAsMechanism(investigation: SherlockInvestigation): boolean {
  return !investigation.hypotheses.some((h) => RESTATES_UNDETERMINED_AS_HYPOTHESIS_PATTERN.test(h.statement));
}

function noHypothesisPresentedAsConfirmed(investigation: SherlockInvestigation): boolean {
  return !investigation.hypotheses.some((h) => CONFIRMED_LANGUAGE_PATTERN.test(h.statement));
}

function citedEvidenceIds(investigation: SherlockInvestigation): Set<string> {
  const ids = new Set<string>();
  for (const quadrant of [
    investigation.expectation_matrix.expected_present,
    investigation.expectation_matrix.unexpected_present,
    investigation.expectation_matrix.expected_absent,
    investigation.expectation_matrix.unexpected_absent,
  ]) {
    for (const item of quadrant) for (const id of item.evidence_ids) ids.add(id);
  }
  for (const hypothesis of investigation.hypotheses) {
    for (const link of [...hypothesis.supported_by, ...hypothesis.contradicted_by]) ids.add(link.evidence_id);
  }
  return ids;
}

function atLeastTwoPlausibleMechanismHypotheses(investigation: SherlockInvestigation): { count: number; matched: string[] } {
  const matched = new Set<string>();
  for (const hypothesis of investigation.hypotheses) {
    for (const [name, pattern] of MECHANISM_PATTERNS) {
      if (pattern.test(hypothesis.statement)) matched.add(name);
    }
  }
  return { count: matched.size, matched: [...matched] };
}

function missingEvidenceAsksForInternalData(investigation: SherlockInvestigation): boolean {
  return investigation.missing_evidence.some((item) => INTERNAL_DATA_PATTERN.test(item.description));
}

function separatesRecoveryFromCause(investigation: SherlockInvestigation): boolean {
  const text = [
    investigation.coherence.explanation,
    investigation.learning.summary,
    investigation.prime_suspect?.justification ?? "",
    investigation.undetermined_explanation ?? "",
    investigation.open_case_index.explanation,
  ].join(" \n ");
  return separatesRecoveryFromCauseText(text);
}

function everyHypothesisIsEvidenceLinked(investigation: SherlockInvestigation): boolean {
  return investigation.hypotheses.every(
    (h) => h.supported_by.length > 0 || h.contradicted_by.length > 0 || h.expected_but_absent_ids.length > 0,
  );
}

export function evaluateCaseGoogleSecOps(
  request: InvestigationRequest,
  investigation: SherlockInvestigation,
): CaseGoogleSecOpsAssertion[] {
  const mechanisms = atLeastTwoPlausibleMechanismHypotheses(investigation);
  const citedIds = citedEvidenceIds(investigation);
  const suppliedIds = new Set(request.evidence.map((e) => e.id));
  const citedSuppliedIds = [...citedIds].filter((id) => suppliedIds.has(id));

  return [
    ...sharedAssertions(request, investigation),
    {
      name: "root_cause_status is structurally undetermined (not modeled as a hypothesis)",
      passed: rootCauseStructurallyUndetermined(investigation),
      detail: rootCauseStructurallyUndetermined(investigation)
        ? `root_cause_status=${investigation.root_cause_status}, prime_suspect=null, undetermined_explanation is filled.`
        : `root_cause_status=${investigation.root_cause_status}, prime_suspect=${investigation.prime_suspect ? investigation.prime_suspect.hypothesis_id : "null"}, undetermined_explanation=${investigation.undetermined_explanation ? "present" : "missing"}.`,
    },
    {
      name: "No hypothesis restates the undetermined conclusion as a mechanism",
      passed: noHypothesisRestatesUndeterminedAsMechanism(investigation),
      detail: noHypothesisRestatesUndeterminedAsMechanism(investigation)
        ? "No hypothesis statement duplicates the root_cause_status conclusion."
        : "A hypothesis statement restates 'cause is undetermined' as if it were a candidate mechanism; that belongs only in root_cause_status/undetermined_explanation.",
    },
    {
      name: "No hypothesis is presented as a confirmed cause",
      passed: noHypothesisPresentedAsConfirmed(investigation),
      detail: noHypothesisPresentedAsConfirmed(investigation)
        ? "No hypothesis statement uses confirmed/proven/definitive language."
        : "A hypothesis statement uses confirmed/proven/definitive language, converting a hypothesis into a stated fact.",
    },
    {
      name: "Cites facts from the official chronology",
      passed: citedSuppliedIds.length >= 3,
      detail: `${citedSuppliedIds.length} distinct supplied evidence id(s) cited across the matrix and hypothesis links: ${citedSuppliedIds.join(", ") || "none"}.`,
    },
    {
      name: "Proposes at least two plausible, distinct mechanism hypotheses",
      passed: mechanisms.count >= 2,
      detail: `${mechanisms.count} distinct mechanism categor${mechanisms.count === 1 ? "y" : "ies"} matched: ${mechanisms.matched.join(", ") || "none"}.`,
    },
    {
      name: "Missing evidence names internal data that would advance the case",
      passed: missingEvidenceAsksForInternalData(investigation),
      detail: missingEvidenceAsksForInternalData(investigation)
        ? "At least one missing_evidence item names non-public internal data (telemetry, deploy history, capacity metrics, postmortem, etc.)."
        : "No missing_evidence item names internal engineering data that would move the investigation forward.",
    },
    {
      name: "Separates operational recovery from causal explanation",
      passed: separatesRecoveryFromCause(investigation),
      detail: separatesRecoveryFromCause(investigation)
        ? "Reasoning text explicitly distinguishes resolution/mitigation from confirming a cause."
        : "No reasoning field explicitly states that resolution does not confirm the cause.",
    },
    {
      name: "Every hypothesis is linked to at least one evidence-based reason",
      passed: everyHypothesisIsEvidenceLinked(investigation),
      detail: everyHypothesisIsEvidenceLinked(investigation)
        ? "Every hypothesis has supporting evidence, contradicting evidence, or an expected-but-absent link."
        : "At least one hypothesis has no supporting evidence, contradicting evidence, or expected-but-absent link.",
    },
  ];
}
