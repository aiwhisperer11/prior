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
  ];
}
