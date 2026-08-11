import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { evaluateCaseB } from "../lib/server/case-b-assertions";
import {
  isInvestigationRequest,
  runSherlockInvestigation,
} from "../lib/server/sherlock-engine";
import type { InvestigationRequest } from "../types/sherlock";

const fixturePath = resolve(process.cwd(), "examples/case-b.json");
const artifactPath = resolve(process.cwd(), ".sherlock/case-b-live-result.json");

async function writeRawResult(rawResponse: string): Promise<void> {
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, rawResponse, "utf8");
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is required to evaluate Case B.");
    process.exitCode = 1;
    return;
  }

  const request: unknown = JSON.parse(await readFile(fixturePath, "utf8"));
  if (!isInvestigationRequest(request)) {
    console.error("Case B fixture does not match the investigation input contract.");
    process.exitCode = 1;
    return;
  }

  const result = await runSherlockInvestigation(request);
  await writeRawResult(result.rawResponses.at(-1) ?? "");
  console.log(`Raw model result written to ${artifactPath}`);

  if (!result.ok) {
    console.error(
      result.kind === "validation"
        ? "Model result failed authoritative-schema validation."
        : "OpenAI request failed.",
    );
    if (result.validationErrors.length) {
      console.error(JSON.stringify(result.validationErrors, null, 2));
    }
    process.exitCode = 1;
    return;
  }

  const assertions = evaluateCaseB(request as InvestigationRequest, result.investigation);
  const failures = assertions.filter((assertion) => !assertion.passed);
  for (const assertion of assertions) {
    console.log(`${assertion.passed ? "PASS" : "FAIL"}: ${assertion.name}`);
    console.log(`  ${assertion.detail}`);
  }

  if (failures.length) {
    console.error(`Case B evaluation failed: ${failures.length} assertion(s) failed.`);
    process.exitCode = 1;
    return;
  }

  console.log("Case B evaluation passed all assertions.");
}

main().catch(() => {
  console.error("Case B evaluation could not be completed.");
  process.exitCode = 1;
});
