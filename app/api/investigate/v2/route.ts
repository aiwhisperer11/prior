import { NextRequest, NextResponse } from "next/server";
import { createV2Snapshot } from "@/lib/server/v2-snapshot-store";
import { parseV2CreateRequest } from "@/lib/server/v2-input-validator";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (body === null) return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });

  const parsed = parseV2CreateRequest(body);
  if (!parsed.ok) return NextResponse.json({ error: "v2 input failed validation", issues: parsed.errors }, { status: 400 });

  const result = createV2Snapshot(parsed.input, parsed.parentSnapshotId);
  if (!result.ok) return NextResponse.json({ error: "snapshot could not be created", issue: result.error }, { status: 400 });

  const snapshot = result.snapshot;
  return NextResponse.json({
    input_mode: parsed.input.input_mode,
    compiler_version: snapshot.compiler_version,
    template_selection: snapshot.compiled_case_file?.template ?? null,
    warnings: [],
    unmatched_evidence: snapshot.compiled_case_file?.template.unmatched_evidence ?? [],
    snapshot,
  });
}
