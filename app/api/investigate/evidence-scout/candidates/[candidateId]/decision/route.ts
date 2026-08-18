import { NextRequest, NextResponse } from "next/server";

import { getEvidenceScoutCandidateStore, type EvidenceScoutCandidateStore } from "@/lib/server/evidence-scout-store";

/**
 * POST /api/investigate/evidence-scout/candidates/:candidateId/decision --
 * the only accept/reject surface. Never returns provenance content: the
 * client only ever needs the candidate_id back to reference later in a
 * follow-up's accepted_candidate_ids (point 7). Idempotent per state
 * (lib/server/evidence-scout-store.ts's decideCandidate): repeating the
 * same decision is a no-op; the opposite decision on an already-decided
 * candidate is a 409 conflict, never a silent flip.
 */
export async function handleEvidenceScoutCandidateDecision(
  req: NextRequest,
  { params }: { params: Promise<{ candidateId: string }> },
  store: EvidenceScoutCandidateStore = getEvidenceScoutCandidateStore(),
) {
  const { candidateId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const decision = body !== null && typeof body === "object" ? (body as Record<string, unknown>).decision : undefined;
  if (decision !== "accept" && decision !== "reject") {
    return NextResponse.json({ error: 'decision must be "accept" or "reject"' }, { status: 400 });
  }

  if (decision === "accept") {
    const candidate = await store.getCandidate(candidateId);
    if (!candidate) return NextResponse.json({ error: `Unknown Evidence Scout candidate ${candidateId}` }, { status: 404 });
    if (candidate.verification_status === "source_located") {
      return NextResponse.json({ error: `candidate ${candidateId} is source_located and cannot be accepted as evidence` }, { status: 409 });
    }
  }
  const result = await store.decideCandidate(candidateId, decision);
  if (!result.ok) {
    if (result.code === "not_found") return NextResponse.json({ error: `Unknown Evidence Scout candidate ${candidateId}` }, { status: 404 });
    if (result.code === "source_located_cannot_be_accepted") {
      return NextResponse.json({ error: `candidate ${candidateId} is source_located and cannot be accepted as evidence` }, { status: 409 });
    }
    return NextResponse.json({ error: `candidate ${candidateId} was already decided differently` }, { status: 409 });
  }

  return NextResponse.json({ candidate_id: result.candidate.candidate_id, state: result.candidate.state, decided_at: result.candidate.decided_at });
}

export async function POST(req: NextRequest, context: { params: Promise<{ candidateId: string }> }) {
  return handleEvidenceScoutCandidateDecision(req, context);
}
