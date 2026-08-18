export type InvestigationView = "editing" | "investigating" | "results";
/** GBP/RUB's "evidence_scout" start mode was retired along with the mock (lib/server/evidence-scout.ts) -- Evidence Scout is no longer a way to START an investigation; it fills gaps in an existing one, see components/EvidenceScoutSearchPanel.tsx. */
export type ActiveRequestMode = "baseline";
export interface InvestigationViewState { view: InvestigationView; requestMode: ActiveRequestMode; session: number; }
export const initialInvestigationViewState: InvestigationViewState = { view: "editing", requestMode: "baseline", session: 0 };
export function startInvestigation(state: InvestigationViewState, requestMode: ActiveRequestMode): InvestigationViewState { return { ...state, view: "investigating", requestMode }; }
export function showResults(state: InvestigationViewState): InvestigationViewState { return { ...state, view: "results" }; }
export function startNewInvestigation(state: InvestigationViewState): InvestigationViewState { return { view: "editing", requestMode: "baseline", session: state.session + 1 }; }
