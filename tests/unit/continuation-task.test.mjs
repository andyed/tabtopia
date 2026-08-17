import test from "node:test";
import assert from "node:assert/strict";

import { projectContinuationTask } from "../../src/lib/continuation-task.js";

const BASE = Date.UTC(2026, 7, 16, 12, 0, 0);

test("a Google query with multiple followed results becomes a search exploration", () => {
  const searchA = page(
    "search:a",
    "new movies streaming - Google Search",
    "https://www.google.com/search?q=new+movies+streaming&sourceid=chrome-mobile",
    0
  );
  const searchB = page(
    "search:b",
    "new movies streaming - Google Search",
    "https://www.google.com/search?source=chrome.ob&q=new+movies+streaming#results",
    1
  );
  const forbes = page("result:forbes", "What to watch", "https://forbes.com/watch", 2);
  const justWatch = page("result:justwatch", "Streaming guide", "https://justwatch.com/us", 3);
  const detail = page("result:detail", "Project Hail Mary", "https://justwatch.com/movie/project-hail-mary", 4);

  const task = projectContinuationTask({
    items: [searchA, searchB, forbes, justWatch, detail],
    edges: [
      edge(searchA.key, forbes.key, 2),
      edge(searchB.key, justWatch.key, 3),
      edge(justWatch.key, detail.key, 4)
    ]
  });

  assert.equal(task.kind, "search-exploration");
  assert.equal(task.label, "Search · new movies streaming");
  assert.equal(task.target.url, searchB.url, "the latest exact search URL remains the action target");
  assert.equal(task.evidence.branchCount, 2);
  assert.equal(task.evidence.resultCount, 3);
  assert.equal(task.evidence.pathDepth, 2);
  assert.ok(task.depth > 0.6);
});

test("a search with fewer than two followed results stays ordinary history", () => {
  const search = page("search", "Query", "https://google.com/search?q=single+answer", 0);
  const result = page("result", "Answer", "https://answer.example/", 1);

  assert.equal(projectContinuationTask({
    items: [search, result],
    edges: [edge(search.key, result.key, 1)]
  }), null);
});

test("Maps URL churn collapses into semantic place and directions stages", () => {
  const search = page(
    "maps:search",
    "Google Maps",
    "https://www.google.com/maps/search/coffee+shops/@37.05,-122.01,12z",
    0
  );
  const placeZoomed = page(
    "maps:place:a",
    "Google Maps",
    "https://www.google.com/maps/place/Blueberry+Dr/@37.05012,-122.01234,17z/data=!4m2",
    1
  );
  const placePanned = page(
    "maps:place:b",
    "Google Maps",
    "https://www.google.com/maps/place/Blueberry+Dr/@37.06,-122.02,15z/data=!4m8",
    2
  );
  const directions = page(
    "maps:dir",
    "Google Maps",
    "https://www.google.com/maps/dir/Santa+Cruz/Blueberry+Dr/@37.05,-122.01,12.5z",
    3
  );

  const task = projectContinuationTask({
    items: [search, placeZoomed, placePanned, directions],
    edges: [
      edge(search.key, placeZoomed.key, 1),
      edge(placePanned.key, directions.key, 3)
    ]
  });

  assert.equal(task.kind, "maps-continuation");
  assert.equal(task.label, "Directions · Santa Cruz → Blueberry Dr");
  assert.equal(task.target.url, directions.url);
  assert.equal(task.evidence.stageCount, 3, "two viewport variants share one place state");
  assert.equal(task.evidence.placeCount, 1);
  assert.equal(task.evidence.hasDirections, true);
  assert.equal(task.label.includes("37.05"), false, "Home labels do not expose raw coordinates");
  assert.ok(task.depth >= 0.9);
});

test("multiple Maps places form comparison depth without directions", () => {
  const first = page("maps:a", "Google Maps", "https://google.com/maps/place/Alpha+Cafe/@1,2,15z", 0);
  const second = page("maps:b", "Google Maps", "https://google.com/maps/place/Beta+Cafe/@1,2,15z", 1);
  const third = page("maps:c", "Google Maps", "https://google.com/maps/place/Gamma+Cafe/@1,2,15z", 2);

  const task = projectContinuationTask({ items: [first, second, third], edges: [] });

  assert.equal(task.label, "Compare 3 places");
  assert.equal(task.depthBand, "developing");
  assert.equal(task.evidence.placeCount, 3);
});

function page(key, title, url, minute) {
  return {
    key,
    title,
    url,
    open: false,
    lastActivityAt: BASE + (minute * 60_000)
  };
}

function edge(sourceKey, targetKey, minute) {
  return {
    source: sourceKey,
    target: targetKey,
    types: ["referrer"],
    evidence: [{
      type: "referrer",
      sourceKey,
      targetKey,
      origin: "visit-referral",
      timestamp: BASE + (minute * 60_000)
    }]
  };
}
