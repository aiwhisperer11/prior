export type InvestigationView = "editing" | "investigating" | "results";
export type ActiveRequestMode = "baseline" | "evidence_scout";
export interface InvestigationViewState { view: InvestigationView; requestMode: ActiveRequestMode; session: number; }
export const initialInvestigationViewState: InvestigationViewState = { view: "editing", requestMode: "baseline", session: 0 };
export function startInvestigation(state: InvestigationViewState, requestMode: ActiveRequestMode): InvestigationViewState { return { ...state, view: "investigating", requestMode }; }
export function showResults(state: InvestigationViewState): InvestigationViewState { return { ...state, view: "results" }; }
export function startNewInvestigation(state: InvestigationViewState): InvestigationViewState { return { view: "editing", requestMode: "baseline", session: state.session + 1 }; }
