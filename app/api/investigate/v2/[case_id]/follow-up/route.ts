import { NextRequest, NextResponse } from "next/server";
import { createV2FollowUpSnapshot } from "@/lib/server/v2-snapshot-store";
import { parseV2FollowUpRequest } from "@/lib/server/v2-follow-up-validator";

export async function POST(request: NextRequest, { params }: { params: Promise<{ case_id: string }> }) {
  const { case_id } = await params;

  const body = await request.json().catch(() => null);
  if (body === null) return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });

  const parsed = parseV2FollowUpRequest(body);
  if (!parsed.ok) return NextResponse.json({ error: "follow-up request failed validation", issues: parsed.errors }, { status: 400 });

  const result = createV2FollowUpSnapshot(case_id, parsed.request.parent_snapshot_id, parsed.request.new_evidence);
  if (!result.ok) return NextResponse.json({ error: "follow-up snapshot could not be created", issue: result.error }, { status: 400 });

  const snapshot = result.snapshot;
  return NextResponse.json({
    case_id,
    compiler_version: snapshot.compiler_version,
    template_selection: snapshot.compiled_case_file?.template ?? null,
    unmatched_evidence: snapshot.compiled_case_file?.template.unmatched_evidence ?? [],
    snapshot,
  });
}
