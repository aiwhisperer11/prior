import { NextRequest, NextResponse } from "next/server";

import { getMemoryStore, MemoryStoreUnavailableError } from "@/lib/server/memory-store";
import { runInvestigationFlow } from "@/lib/server/investigation-flow";
import { prepareInvestigationRequest } from "@/lib/server/sherlock-engine";

export { OPENAI_MODEL } from "@/lib/server/sherlock-engine";

export async function POST(req: NextRequest) {
  let body: unknown;

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const prepared = prepareInvestigationRequest(body);
  if (!prepared.ok) {
    return NextResponse.json(
      { error: prepared.message },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await runInvestigationFlow(prepared.request, getMemoryStore());
  } catch (error) {
    if (error instanceof MemoryStoreUnavailableError) return NextResponse.json({ error: "CockroachDB memory store is unavailable" }, { status: 503 });
    return NextResponse.json({ error: "OpenAI client is unavailable" }, { status: 502 });
  }

  if (result.ok) {
    return NextResponse.json({ investigation: result.investigation, precedents: result.precedents, storage: result.storage, memory_is_lead_not_evidence: true });
  }

  if (result.kind === "openai") {
    return NextResponse.json({ error: "OpenAI request failed" }, { status: 502 });
  }

  return NextResponse.json(
    {
      error: "Model response did not conform to the investigation schema",
      validation_errors: result.validationErrors,
    },
    { status: 502 },
  );
}
