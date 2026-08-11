import type { SherlockInvestigation } from "@/types/sherlock";

export interface FollowUpEvidence {
  label: string;
  content: string;
}

export interface FollowUpFormState {
  evidence: FollowUpEvidence[];
  loading: boolean;
  error: string | null;
}

export const FOLLOW_UP_REQUEST_TIMEOUT_MS = 65_000;

export const initialFollowUpFormState: FollowUpFormState = {
  evidence: [{ label: "", content: "" }],
  loading: false,
  error: null,
};

type FollowUpFormAction =
  | { type: "evidence-changed"; index: number; field: keyof FollowUpEvidence; value: string }
  | { type: "example-loaded"; evidence: FollowUpEvidence[] }
  | { type: "evidence-added" }
  | { type: "evidence-removed"; index: number }
  | { type: "request-started" }
  | { type: "request-succeeded" }
  | { type: "request-failed"; error: string };

export function followUpFormReducer(state: FollowUpFormState, action: FollowUpFormAction): FollowUpFormState {
  switch (action.type) {
    case "evidence-changed":
      return { ...state, evidence: state.evidence.map((item, index) => index === action.index ? { ...item, [action.field]: action.value } : item) };
    case "example-loaded":
      return { ...state, evidence: action.evidence, error: null };
    case "evidence-added":
      return { ...state, evidence: [...state.evidence, { label: "", content: "" }] };
    case "evidence-removed":
      return { ...state, evidence: state.evidence.filter((_, index) => index !== action.index) };
    case "request-started":
      return state.loading ? state : { ...state, loading: true, error: null };
    case "request-succeeded":
      return { evidence: [{ label: "", content: "" }], loading: false, error: null };
    case "request-failed":
      return { ...state, loading: false, error: action.error };
  }
}

export function appendInvestigationSnapshot(
  snapshots: SherlockInvestigation[],
  snapshot: SherlockInvestigation,
): SherlockInvestigation[] {
  return [...snapshots, snapshot];
}
