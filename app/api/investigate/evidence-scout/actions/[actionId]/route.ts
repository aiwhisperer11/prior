import { NextRequest, NextResponse } from "next/server";

import { getEvidenceScoutCandidateStore, type EvidenceScoutCandidateStore } from "@/lib/server/evidence-scout-store";

/**
 * GET /api/investigate/evidence-scout/actions/:actionId -- polling endpoint.
 * getAction() opportunistically repairs an expired, attempt-exhausted lease
 * to 'failed' on read (see lib/server/evidence-scout-store.ts), so a stuck
 * action is never reported as "searching" forever without a working lease.
 */
export async function handleEvidenceScoutGetAction(
  _req: NextRequest,
  { params }: { params: Promise<{ actionId: string }> },
  store: EvidenceScoutCandidateStore = getEvidenceScoutCandidateStore(),
) {
  const { actionId } = await params;
  const action = await store.getAction(actionId);
  if (!action) return NextResponse.json({ error: `Unknown Evidence Scout action ${actionId}` }, { status: 404 });
  return NextResponse.json(action);
}

export async function GET(req: NextRequest, context: { params: Promise<{ actionId: string }> }) {
  return handleEvidenceScoutGetAction(req, context);
}
