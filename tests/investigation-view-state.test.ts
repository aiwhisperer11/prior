import assert from "node:assert/strict";
import test from "node:test";
import { initialInvestigationViewState, showResults, startInvestigation, startNewInvestigation } from "../lib/investigation-view-state";

test("starting a second investigation replaces the prior visual session and reaches coherent results", () => { const first = showResults(startInvestigation(initialInvestigationViewState, "baseline")); const second = showResults(startInvestigation(first, "baseline")); assert.equal(second.view, "results"); assert.equal(second.requestMode, "baseline"); });
test("a first result has no learning diff state and Start new investigation clears the active mode", () => { const results = showResults(startInvestigation(initialInvestigationViewState, "baseline")); const reset = startNewInvestigation(results); assert.equal(results.view, "results"); assert.equal(reset.view, "editing"); assert.equal(reset.requestMode, "baseline"); assert.equal(reset.session, 1); });
