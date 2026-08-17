import test from "node:test";
import assert from "node:assert/strict";

import { buildTypeaheadCompletion } from "../../src/lib/typeahead-completion.js";

test("completes the highest-ranked title that extends the query", () => {
  const completion = buildTypeaheadCompletion("Alp", [
    result("alpha", "Alpha Page", "alpha.example", "/notes"),
    result("alpine", "Alpine Guide", "alpine.example", "/")
  ]);

  assert.deepEqual(completion, {
    query: "Alp",
    value: "Alpha Page",
    suffix: "ha Page",
    kind: "title",
    resultId: "alpha"
  });
});

test("uses a page location when its title is not a prefix match", () => {
  const completion = buildTypeaheadCompletion("docs.ex", [
    result("docs", "API reference", "docs.example", "/guide")
  ]);

  assert.equal(completion.value, "docs.example/guide");
  assert.equal(completion.suffix, "ample/guide");
  assert.equal(completion.kind, "location");
});

test("skips non-prefix matches and can use the next ranked eligible result", () => {
  const completion = buildTypeaheadCompletion("Alp", [
    result("summary", "Unrelated title", "notes.example", "/alpha"),
    result("eligible", "Alpine Guide", "alpine.example", "/")
  ]);

  assert.equal(completion.resultId, "eligible");
  assert.equal(completion.value, "Alpine Guide");
});

test("does not rewrite exact, empty, or leading-space queries", () => {
  const results = [result("alpha", "Alpha Page", "alpha.example", "/")];
  assert.equal(buildTypeaheadCompletion("Alpha Page", results), null);
  assert.equal(buildTypeaheadCompletion("", results), null);
  assert.equal(buildTypeaheadCompletion(" Alpha", results), null);
});

function result(id, title, domain, path) {
  return { id, title, domain, path };
}
