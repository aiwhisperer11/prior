import assert from "node:assert/strict";
import test from "node:test";

import { investigationEmbeddingText, l2Distance } from "../lib/server/embeddings";

test("investigationEmbeddingText joins the semantic fields and drops empty ones", () => {
  const text = investigationEmbeddingText({
    case_title: "Checkout 500 errors",
    domain: "IT incident",
    observed_outcome: "Checkout returned 500s.",
    expected_behavior: "Deploys should not break checkout.",
    learning_summary: "TLS renewal failure is the leading hypothesis.",
  });
  assert.equal(
    text,
    "Checkout 500 errors\nIT incident\nCheckout returned 500s.\nDeploys should not break checkout.\nTLS renewal failure is the leading hypothesis.",
  );
});

test("investigationEmbeddingText omits a missing learning_summary rather than embedding an empty line", () => {
  const text = investigationEmbeddingText({
    case_title: "Case X",
    domain: "domain",
    observed_outcome: "outcome",
    expected_behavior: "expected",
  });
  assert.equal(text, "Case X\ndomain\noutcome\nexpected");
});

test("l2Distance is zero for identical vectors", () => {
  assert.equal(l2Distance([1, 2, 3], [1, 2, 3]), 0);
});

test("l2Distance matches the exact Euclidean distance", () => {
  assert.equal(l2Distance([0, 0], [3, 4]), 5);
});

test("l2Distance rejects mismatched dimensions rather than silently truncating", () => {
  assert.throws(() => l2Distance([1, 2], [1, 2, 3]), /dimension mismatch/i);
});
