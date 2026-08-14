import assert from "node:assert/strict";
import test from "node:test";
import { initialInvestigationViewState, showResults, startInvestigation, startNewInvestigation } from "../lib/investigation-view-state";

test("starting GBP/RUB replaces the Case B visual session and reaches coherent results", () => { const caseB = showResults(startInvestigation(initialInvestigationViewState, "baseline")); const gbp = showResults(startInvestigation(caseB, "evidence_scout")); assert.equal(gbp.view, "results"); assert.equal(gbp.requestMode, "evidence_scout"); });
test("a first result has no learning diff state and Start new investigation clears the active mode", () => { const results = showResults(startInvestigation(initialInvestigationViewState, "evidence_scout")); const reset = startNewInvestigation(results); assert.equal(results.view, "results"); assert.equal(reset.view, "editing"); assert.equal(reset.requestMode, "baseline"); assert.equal(reset.session, 1); });
