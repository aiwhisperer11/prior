"use client";

import { useState, type FormEvent } from "react";

import caseBInput from "@/examples/case-b.json";
import baselineSnapshot from "@/examples/case-b-baseline-snapshot.json";
import iteration2Snapshot from "@/examples/case-b-iteration2-snapshot.json";
import cloudflareWafCase from "@/examples/case-cloudflare-waf-2019.json";
import googleSecOpsCase from "@/examples/case-google-secops-2026.json";
import { parseSherlockInvestigation } from "@/lib/investigation-validation";
import { parseInvestigationApiResponse, type InvestigationApiResponse } from "@/lib/investigation-response";
import type { InvestigationRequest, SherlockInvestigation } from "@/types/sherlock";
import type { ActiveRequestMode } from "@/lib/investigation-view-state";

export type MemoryUpdate = Pick<InvestigationApiResponse, "precedents" | "unclassified_memory" | "suspected_duplicate_memory" | "memory" | "storage">;

interface SherlockFormProps {
  onSnapshot: (snapshot: SherlockInvestigation) => void;
  onSnapshotsLoaded: (snapshots: SherlockInvestigation[]) => void;
  onMemory: (update: MemoryUpdate | null) => void;
  onStart: (mode: ActiveRequestMode) => void;
}

interface FormEvidence {
  label: string;
  content: string;
}

interface ApiError {
  status: number;
  message: string;
  validationErrors: string[];
}

function apiErrorFromResponse(status: number, body: unknown): ApiError {
  if (body !== null && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const validationErrors = Array.isArray(record.validation_errors)
      ? record.validation_errors.map((error) => {
          if (error !== null && typeof error === "object") {
            const entry = error as Record<string, unknown>;
            return `${typeof entry.instancePath === "string" ? entry.instancePath : "/"}: ${typeof entry.message === "string" ? entry.message : "invalid"}`;
          }
          return "Invalid response";
        })
      : [];
    return {
      status,
      message: typeof record.error === "string" ? record.error : `Request failed with status ${status}`,
      validationErrors,
    };
  }

  return { status, message: `Request failed with status ${status}`, validationErrors: [] };
}

export default function SherlockForm({ onSnapshot, onSnapshotsLoaded, onMemory, onStart }: SherlockFormProps) {
  const [caseId, setCaseId] = useState("case-ui");
  const [caseTitle, setCaseTitle] = useState("Untitled investigation");
  const [domain, setDomain] = useState("General investigation");
  const [observedOutcome, setObservedOutcome] = useState("");
  const [expectedBehavior, setExpectedBehavior] = useState("");
  const [evidence, setEvidence] = useState<FormEvidence[]>([{ label: "", content: "" }]);
  const [userHypotheses, setUserHypotheses] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [isOpen, setIsOpen] = useState(true);
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null);

  function updateEvidence(index: number, field: keyof FormEvidence, value: string) {
    setEvidence((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item));
  }

  function updateHypothesis(index: number, value: string) {
    setUserHypotheses((items) => items.map((item, itemIndex) => itemIndex === index ? value : item));
  }

  function loadExample() {
    setCaseId(caseBInput.case_id);
    setCaseTitle(caseBInput.case_title);
    setDomain(caseBInput.domain);
    setObservedOutcome(caseBInput.observed_outcome);
    setExpectedBehavior(caseBInput.expected_behavior);
    setEvidence(caseBInput.evidence.map(({ label, content }) => ({ label, content })));
    setUserHypotheses(caseBInput.user_hypotheses ?? []);
    setError(null);
  }

  function loadCloudflareWafExample() {
    setCaseId(cloudflareWafCase.case_id);
    setCaseTitle(cloudflareWafCase.case_title);
    setDomain(cloudflareWafCase.domain);
    setObservedOutcome(cloudflareWafCase.observed_outcome);
    setExpectedBehavior(cloudflareWafCase.expected_behavior);
    setEvidence(cloudflareWafCase.evidence.map(({ label, content }) => ({ label, content })));
    setUserHypotheses(cloudflareWafCase.user_hypotheses ?? []);
    setError(null);
  }

  function loadGoogleSecOpsExample() {
    setCaseId(googleSecOpsCase.case_id);
    setCaseTitle(googleSecOpsCase.case_title);
    setDomain(googleSecOpsCase.domain);
    setObservedOutcome(googleSecOpsCase.observed_outcome);
    setExpectedBehavior(googleSecOpsCase.expected_behavior);
    setEvidence(googleSecOpsCase.evidence.map(({ label, content }) => ({ label, content })));
    setUserHypotheses(googleSecOpsCase.user_hypotheses ?? []);
    setError(null);
  }
  function loadOfflineSnapshots(includeIteration2: boolean) {
    const parsed = parseSherlockInvestigation(baselineSnapshot);
    const parsedIteration2 = parseSherlockInvestigation(iteration2Snapshot);
    if (parsed.ok && parsedIteration2.ok) {
      onSnapshotsLoaded(includeIteration2 ? [parsed.investigation, parsedIteration2.investigation] : [parsed.investigation]);
      onMemory(null);
      setError(null);
      setIsOpen(false);
      return;
    }

    setError({
      status: 0,
      message: "An offline snapshot does not match the investigation schema.",
      validationErrors: [
        ...(parsed.ok ? [] : parsed.errors.map((entry) => `${entry.instancePath}: ${entry.message}`)),
        ...(parsedIteration2.ok ? [] : parsedIteration2.errors.map((entry) => `${entry.instancePath}: ${entry.message}`)),
      ],
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onStart("baseline");
    setLoading(true);
    setError(null);

    const request: InvestigationRequest = {
      case_id: caseId,
      case_title: caseTitle,
      domain,
      observed_outcome: observedOutcome,
      expected_behavior: expectedBehavior,
      evidence: evidence.map((item, index) => ({ id: `E${index + 1}`, label: item.label, content: item.content })),
      ...(userHypotheses.some((hypothesis) => hypothesis.trim())
        ? { user_hypotheses: userHypotheses.filter((hypothesis) => hypothesis.trim()) }
        : {}),
    };

    try {
      const response = await fetch("/api/investigate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setError(apiErrorFromResponse(response.status, body));
        return;
      }

      const parsed = parseInvestigationApiResponse(body);
      if (!parsed.ok) {
        setError({
          status: response.status,
          message: "The API returned a response that does not match the investigation schema.",
          validationErrors: parsed.errors.map((entry) => `${entry.instancePath}: ${entry.message}`),
        });
        return;
      }

      onMemory({ precedents: parsed.response.precedents, unclassified_memory: parsed.response.unclassified_memory, suspected_duplicate_memory: parsed.response.suspected_duplicate_memory, memory: parsed.response.memory, storage: parsed.response.storage });
      onSnapshot(parsed.response.investigation);
      setMemoryNotice(parsed.response.storage === "local-mock"
        ? `Mock local memory fallback. ${parsed.response.precedents.length} precedent lead(s) retrieved; memory is not evidence.`
        : `${parsed.response.precedents.length} CockroachDB precedent lead(s) retrieved; memory is not evidence.`);
      setIsOpen(false);
    } catch {
      setError({ status: 0, message: "The investigation request could not be completed.", validationErrors: [] });
    } finally {
      setLoading(false);
    }
  }

  const canSubmit = Boolean(
    observedOutcome.trim() &&
    expectedBehavior.trim() &&
    evidence.length > 0 &&
    evidence.every((item) => item.label.trim() && item.content.trim()),
  );

  return (
    <details open={isOpen} onToggle={(event) => setIsOpen(event.currentTarget.open)} className="prior-card overflow-hidden p-5 sm:p-7">
      <summary id="investigation-form-heading" className="cursor-pointer text-xl font-bold text-[var(--prior-night)]">New investigation</summary>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={loadExample} className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">Load example</button>
          <button type="button" onClick={loadCloudflareWafExample} className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">Load Cloudflare WAF example</button>
          <button type="button" onClick={loadGoogleSecOpsExample} className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">Load Google SecOps example</button>
          <div>
            <p className="text-sm font-medium">Example case</p>
            <div className="mt-1 flex flex-wrap gap-2">
              <button type="button" onClick={() => loadOfflineSnapshots(false)} className="rounded border border-zinc-300 px-3 py-2 text-left text-sm dark:border-zinc-700"><span className="block">View initial investigation</span><span className="block text-xs text-zinc-600 dark:text-zinc-400">Iteration 1 · baseline</span></button>
              <button type="button" onClick={() => loadOfflineSnapshots(true)} className="rounded border border-zinc-300 px-3 py-2 text-left text-sm dark:border-zinc-700"><span className="block">View updated investigation</span><span className="block text-xs text-zinc-600 dark:text-zinc-400">Iteration 2 · after new evidence</span></button>
            </div>
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="mt-5 space-y-5">
        {memoryNotice && <p role="status" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{memoryNotice}</p>}
        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-sm font-medium">Case title<input value={caseTitle} onChange={(event) => setCaseTitle(event.target.value)} className="mt-1 block w-full rounded border border-zinc-300 bg-transparent p-2 dark:border-zinc-700" /></label>
          <label className="text-sm font-medium">Domain<input value={domain} onChange={(event) => setDomain(event.target.value)} className="mt-1 block w-full rounded border border-zinc-300 bg-transparent p-2 dark:border-zinc-700" /></label>
        </div>
        <label className="block text-sm font-medium">Observed outcome<textarea required rows={4} value={observedOutcome} onChange={(event) => setObservedOutcome(event.target.value)} className="mt-1 block w-full rounded border border-zinc-300 bg-transparent p-2 dark:border-zinc-700" /></label>
        <label className="block text-sm font-medium">Expected behavior<textarea required rows={4} value={expectedBehavior} onChange={(event) => setExpectedBehavior(event.target.value)} className="mt-1 block w-full rounded border border-zinc-300 bg-transparent p-2 dark:border-zinc-700" /></label>

        <fieldset>
          <legend className="font-medium">Evidence</legend>
          <div className="mt-2 space-y-3">
            {evidence.map((item, index) => <div key={index} className="grid gap-2 rounded border border-zinc-200 p-3 md:grid-cols-[8rem_1fr_auto] dark:border-zinc-800">
              <p className="self-center text-sm font-semibold">E{index + 1}</p>
              <div className="grid gap-2 md:grid-cols-2">
                <input required value={item.label} onChange={(event) => updateEvidence(index, "label", event.target.value)} placeholder="Label" aria-label={`Evidence E${index + 1} label`} className="rounded border border-zinc-300 bg-transparent p-2 dark:border-zinc-700" />
                <textarea required rows={2} value={item.content} onChange={(event) => updateEvidence(index, "content", event.target.value)} placeholder="Content" aria-label={`Evidence E${index + 1} content`} className="rounded border border-zinc-300 bg-transparent p-2 dark:border-zinc-700" />
              </div>
              <button type="button" onClick={() => setEvidence((items) => items.filter((_, itemIndex) => itemIndex !== index))} className="text-sm text-red-700">Remove</button>
            </div>)}
          </div>
          <button type="button" onClick={() => setEvidence((items) => [...items, { label: "", content: "" }])} className="mt-2 rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">Add evidence</button>
        </fieldset>

        <fieldset>
          <legend className="font-medium">User hypotheses (optional)</legend>
          <div className="mt-2 space-y-2">
            {userHypotheses.map((hypothesis, index) => <div key={index} className="flex gap-2"><input value={hypothesis} onChange={(event) => updateHypothesis(index, event.target.value)} aria-label={`User hypothesis ${index + 1}`} className="min-w-0 flex-1 rounded border border-zinc-300 bg-transparent p-2 dark:border-zinc-700" /><button type="button" onClick={() => setUserHypotheses((items) => items.filter((_, itemIndex) => itemIndex !== index))} className="text-sm text-red-700">Remove</button></div>)}
          </div>
          <button type="button" onClick={() => setUserHypotheses((items) => [...items, ""])} className="mt-2 rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">Add hypothesis</button>
        </fieldset>

        {error && <div role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900"><p><strong>{error.status ? `Error ${error.status}` : "Error"}:</strong> {error.message}</p>{error.validationErrors.length > 0 && <ul className="mt-2 list-disc pl-5">{error.validationErrors.map((entry) => <li key={entry}>{entry}</li>)}</ul>}</div>}
        <button type="submit" disabled={loading || !canSubmit} className="rounded-lg bg-[var(--prior-violet)] px-4 py-2.5 text-sm font-bold text-white shadow-md disabled:opacity-50">{loading ? "Investigating…" : "Investigate"}</button>
      </form>
    </details>
  );
}
