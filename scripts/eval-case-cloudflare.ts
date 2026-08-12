import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { evaluateCaseCloudflareWaf } from "../lib/server/case-cloudflare-waf-assertions";
import {
  isInvestigationRequest,
  runSherlockInvestigation,
} from "../lib/server/sherlock-engine";
import type { InvestigationRequest } from "../types/sherlock";

const fixturePath = resolve(process.cwd(), "examples/case-cloudflare-waf-2019.json");
const artifactPath = resolve(process.cwd(), ".sherlock/case-cloudflare-live-result.json");

/** Next.js loads .env.local automatically; a standalone tsx script must load it itself. */
function loadEnvLocal(): void {
  const envPath = resolve(process.cwd(), ".env.local");
  if (!process.env.OPENAI_API_KEY && existsSync(envPath)) process.loadEnvFile(envPath);
}

async function writeRawResult(rawResponse: string): Promise<void> {
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, rawResponse, "utf8");
}

async function main(): Promise<void> {
  loadEnvLocal();
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is required to evaluate the Cloudflare WAF case.");
    process.exitCode = 1;
    return;
  }

  const request: unknown = JSON.parse(await readFile(fixturePath, "utf8"));
  if (!isInvestigationRequest(request)) {
    console.error("Cloudflare WAF case fixture does not match the investigation input contract.");
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

  const assertions = evaluateCaseCloudflareWaf(request as InvestigationRequest, result.investigation);
  const failures = assertions.filter((assertion) => !assertion.passed);
  for (const assertion of assertions) {
    console.log(`${assertion.passed ? "PASS" : "FAIL"}: ${assertion.name}`);
    console.log(`  ${assertion.detail}`);
  }

  if (failures.length) {
    console.error(`Cloudflare WAF case evaluation failed: ${failures.length} assertion(s) failed.`);
    process.exitCode = 1;
    return;
  }

  console.log("Cloudflare WAF case evaluation passed all assertions.");
}

main().catch(() => {
  console.error("Cloudflare WAF case evaluation could not be completed.");
  process.exitCode = 1;
});
