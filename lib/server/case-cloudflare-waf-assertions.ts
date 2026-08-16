import type { InvestigationRequest, SherlockInvestigation } from "@/types/sherlock";
import { hypothesisFor, sharedAssertions, type CaseAssertion } from "@/lib/server/investigation-assertions-shared";

/**
 * Case source: Cloudflare, "Details of the Cloudflare outage on July 2, 2019"
 * (blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/,
 * published by CTO John Graham-Cumming). Every fact in
 * examples/case-cloudflare-waf-2019.json is drawn from that post. These
 * assertions check whether Sherlock reaches the same conclusion the real
 * responders reached: the attack theory the responders themselves briefly
 * held is a documented false lead, and the actual cause was a catastrophic-
 * backtracking regex in a new WAF rule, made possible by a CPU-usage
 * protection removed weeks earlier and a test suite that didn't cover
 * runaway CPU.
 */
export type CaseCloudflareWafAssertion = CaseAssertion;

export function evaluateCaseCloudflareWaf(
  request: InvestigationRequest,
  investigation: SherlockInvestigation,
): CaseCloudflareWafAssertion[] {
  const attack = hypothesisFor(investigation, /attack|ddos|denial.of.service/i);
  const wafRegex = hypothesisFor(investigation, /regex|regular expression|waf|cpu/i);
  const primeSuspectId = investigation.prime_suspect?.hypothesis_id ?? null;
  const primeSuspect = investigation.hypotheses.find((hypothesis) => hypothesis.id === primeSuspectId);
  const missingCpuTestAbsence = investigation.expectation_matrix.expected_absent.find(
    (item) => /cpu/i.test(item.description) && /test|protection|limit/i.test(item.description),
  );
  const attackKilledByCpuEvidence = Boolean(
    attack?.killed_by === "E6" || attack?.contradicted_by.some((link) => link.evidence_id === "E6"),
  );

  // E5 ("Incident response chat log": responders' initial speculation) is
  // legitimate as *why a hypothesis was raised as a candidate* — it must
  // never be cited as evidence that *causally supports* the hypothesis this
  // investigation ultimately treats as determined. Checking only the prime
  // suspect (not every hypothesis) matches what "supporting its cause" means
  // here: E5 backing a rejected/weakened candidate is normal; E5 backing the
  // hypothesis root_cause_status=determined rests on is not.
  const primeSuspectCitesSpeculationAsCause = Boolean(
    primeSuspect?.supported_by.some((link) => link.evidence_id === "E5"),
  );

  // E6 ("Performance team CPU profiling") localizes CPU consumption to the
  // WAF module on one machine — it speaks to *where* CPU went, not to
  // *request-level* traffic patterns. It legitimately contradicts a
  // traffic/attack/volume-framed hypothesis (that's exactly how the real
  // responders used it); citing it against a hypothesis that isn't framed in
  // those terms overstates what a CPU profile alone can show.
  const evidenceContradictsWithoutScope = investigation.hypotheses.filter((hypothesis) =>
    hypothesis.contradicted_by.some((link) => link.evidence_id === "E6") &&
    !/traffic|attack|surge|volume|ddos|denial.of.service|request/i.test(hypothesis.statement),
  );

  // E1 ("Pull request log") documents a technical defect (a backtracking-
  // prone regex) — it can support a mechanism's technical viability, but
  // nothing in it speaks to why the rule was written that way. Any hypothesis
  // or link reason citing E1 that frames this as deliberate/intentional goes
  // beyond what E1 itself shows.
  const intentLanguagePattern = /\bintentional(ly)?\b|\bdeliberate(ly)?\b|\bon purpose\b|\bmalicious(ly)?\b|\binsider\b/i;
  const e1CitedWithIntentLanguage = investigation.hypotheses.filter((hypothesis) => {
    const e1Link = hypothesis.supported_by.find((link) => link.evidence_id === "E1");
    if (!e1Link) return false;
    return intentLanguagePattern.test(hypothesis.statement) || intentLanguagePattern.test(e1Link.reason);
  });

  // General operationalization of P13: a contradicted_by reason that only
  // says the evidence fails to name/confirm/isolate the hypothesis's
  // mechanism is describing a gap in what's known, not an incompatibility.
  // Deliberately general (checks every hypothesis, not just E6-linked ones)
  // so it also catches an internal-defect rival contradicted for the same
  // reason E6 was in the observed real capture that motivated this check.
  const absenceLanguagePattern = /\bdoes not identify\b|\bdoes not confirm\b|\bdoes not mention\b|\bdoes not isolate\b|\bdoes not name\b|\bwithout (a |an )?specific\b|\bleaves .* (unresolved|without)\b|\bfails to (identify|confirm|isolate|name)\b/i;
  const contradictedByAbsenceLanguage = investigation.hypotheses.flatMap((hypothesis) =>
    hypothesis.contradicted_by
      .filter((link) => absenceLanguagePattern.test(link.reason))
      .map((link) => ({ hypothesisId: hypothesis.id, evidenceId: link.evidence_id, reason: link.reason })),
  );

  // Operationalizes P14 specifically for the prime suspect: a directly
  // attributed main mechanism must not be argued against in its own
  // contradicted_by using reproduction/execution-trace/intent gaps — those
  // are secondary details that belong in missing_evidence or explanation
  // prose, not a reason the prime suspect itself is contradicted.
  const secondaryDetailPattern = /\breproduc|\bexecution trace\b|\btrigger(ing)? (input|request)\b|\bintent\b|\bdeliberat/i;
  const primeSuspectContradictedBySecondaryDetail = primeSuspect?.contradicted_by.filter((link) => secondaryDetailPattern.test(link.reason)) ?? [];

  return [
    ...sharedAssertions(request, investigation),
    {
      name: "Root cause status is determined, with a real prime suspect",
      passed: investigation.root_cause_status === "determined" && investigation.prime_suspect !== null,
      detail: `root_cause_status is ${investigation.root_cause_status}; prime_suspect is ${primeSuspectId ?? "null"}.`,
    },
    {
      name: "Attack hypothesis is not selected on early speculation alone",
      passed: Boolean(attack && attack.id !== primeSuspectId && attack.status !== "active"),
      detail: attack ? `Attack hypothesis status is ${attack.status}; prime suspect is ${primeSuspectId ?? "none"}.` : "No attack hypothesis was returned.",
    },
    {
      name: "Attack hypothesis is weakened or rejected by the CPU-profiling evidence",
      passed: Boolean(attack && ["weakened", "rejected"].includes(attack.status) && attackKilledByCpuEvidence),
      detail: attack ? `Attack hypothesis status is ${attack.status}; killed/contradicted by E6: ${attackKilledByCpuEvidence}.` : "No attack hypothesis was returned.",
    },
    {
      name: "Missing runaway-CPU test coverage is a significant observable absence",
      passed: Boolean(missingCpuTestAbsence && missingCpuTestAbsence.significance.trim().length > 0),
      detail: missingCpuTestAbsence ? missingCpuTestAbsence.significance : "No missing CPU-protection/test absence was found in expected_absent.",
    },
    {
      name: "Prime suspect favors the WAF regex/CPU mechanism when supported",
      passed: Boolean(primeSuspect && /regex|regular expression|waf|cpu/i.test(primeSuspect.statement)),
      detail: primeSuspect ? primeSuspect.statement : "prime_suspect does not reference a returned hypothesis.",
    },
    {
      name: "Prime suspect hypothesis exists and is not the attack hypothesis",
      passed: Boolean(wafRegex && wafRegex.id === primeSuspectId),
      detail: wafRegex ? `WAF/regex hypothesis ${wafRegex.id} has status ${wafRegex.status}.` : "No WAF/regex hypothesis was returned.",
    },
    {
      name: "The speculative attack-theory chat log (E5) never causally supports the prime suspect",
      passed: !primeSuspectCitesSpeculationAsCause,
      detail: primeSuspectCitesSpeculationAsCause
        ? `${primeSuspectId} cites E5 (initial speculation) in supported_by; E5 may justify why a hypothesis was raised, never why the determined cause is correct.`
        : "E5 is not cited as support for the prime suspect.",
    },
    {
      name: "CPU-profiling evidence (E6) contradicts only traffic/attack-framed hypotheses",
      passed: evidenceContradictsWithoutScope.length === 0,
      detail: evidenceContradictsWithoutScope.length
        ? `E6 contradicts ${evidenceContradictsWithoutScope.map((h) => h.id).join(", ")}, whose statement is not framed around traffic/attack volume; a CPU profile alone does not speak to request-level telemetry.`
        : "Every E6 contradiction targets a traffic/attack-framed hypothesis.",
    },
    {
      name: "The vulnerable-regex evidence (E1) is never cited to claim intent",
      passed: e1CitedWithIntentLanguage.length === 0,
      detail: e1CitedWithIntentLanguage.length
        ? `${e1CitedWithIntentLanguage.map((h) => h.id).join(", ")} cite E1 with intent-implying language; E1 shows technical viability, not intent.`
        : "No hypothesis citing E1 uses intent-implying language.",
    },
    {
      name: "No contradicted_by reason uses mere absence-of-identification language (P13)",
      passed: contradictedByAbsenceLanguage.length === 0,
      detail: contradictedByAbsenceLanguage.length
        ? contradictedByAbsenceLanguage.map(({ hypothesisId, evidenceId, reason }) => `${hypothesisId}.contradicted_by[${evidenceId}]: "${reason}"`).join("; ")
        : "No contradicted_by reason merely states that evidence fails to identify/confirm/isolate a mechanism.",
    },
    {
      name: "Determined root cause is not argued against via pending reproduction, secondary-path exclusion, or intent (P14)",
      passed: primeSuspect ? primeSuspectContradictedBySecondaryDetail.length === 0 : true,
      detail: primeSuspectContradictedBySecondaryDetail.length
        ? `${primeSuspectId} is contradicted citing secondary-detail language: ${primeSuspectContradictedBySecondaryDetail.map((l) => `${l.evidence_id}: "${l.reason}"`).join("; ")}. Reproduction, secondary-path exclusion, and intent belong in missing_evidence or explanation prose, not as a reason the determined mechanism itself is contradicted.`
        : "The prime suspect's contradicted_by contains no reproduction/execution-trace/intent-gap language.",
    },
  ];
}
