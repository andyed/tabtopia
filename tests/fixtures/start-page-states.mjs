const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 6, 21, 18, 0, 0);

export const fixtureNow = NOW;

export const startPageFixtures = Object.freeze({
  launch: fixture({
    windows: [windowWithTabs(1, true, [tabtopiaTab(100, 1)])]
  }),
  threshold: fixture({
    windows: [
      windowWithTabs(1, true, [tabtopiaTab(100, 1)]),
      windowWithTabs(2, false, tabs(3, 2, NOW - (5 * MINUTE)))
    ],
    historyItems: [history("https://alpha.example/", NOW - (4 * MINUTE))]
  }),
  reinstatement: fixture({
    windows: [
      windowWithTabs(1, true, [tabtopiaTab(100, 1)]),
      windowWithTabs(4, false, tabs(12, 4, NOW - (47 * MINUTE)))
    ],
    historyItems: [history("https://alpha.example/", NOW - (47 * MINUTE))]
  }),
  reorientation: fixture({
    windows: [
      windowWithTabs(1, true, [tabtopiaTab(100, 1)]),
      windowWithTabs(4, false, tabs(12, 4, NOW - (8 * HOUR)))
    ],
    historyItems: [history("https://alpha.example/", NOW - (8 * HOUR))]
  }),
  continuation: fixture({
    windows: [
      windowWithTabs(1, true, [
        tabtopiaTab(100, 1),
        ...tabs(5, 1, NOW - (2 * MINUTE))
      ])
    ],
    historyItems: [history("https://alpha.example/", NOW - MINUTE)]
  }),
  handoff: fixture({
    windows: [windowWithTabs(1, true, [tabtopiaTab(100, 1)])],
    historyItems: [
      history("https://research.example/one", NOW - (8 * MINUTE)),
      history("https://research.example/two", NOW - (12 * MINUTE)),
      history("https://notes.example/three", NOW - (15 * MINUTE))
    ],
    visitsByUrl: {
      "https://research.example/one": [{ visitTime: NOW - (8 * MINUTE), isLocal: false }],
      "https://research.example/two": [{ visitTime: NOW - (12 * MINUTE), isLocal: false }],
      "https://notes.example/three": [{ visitTime: NOW - (15 * MINUTE), isLocal: false }]
    }
  })
});

function fixture(overrides) {
  return {
    now: NOW,
    timezoneOffsetMinutes: 0,
    currentWindowId: 1,
    windows: [],
    historyItems: [],
    visitsByUrl: {},
    activityByTab: {},
    ...overrides
  };
}

function windowWithTabs(id, focused, windowTabs) {
  return { id, focused, tabs: windowTabs };
}

function tabs(count, windowId, lastAccessed) {
  return Array.from({ length: count }, (_, index) => ({
    id: (windowId * 1000) + index,
    windowId,
    title: `Work ${index + 1}`,
    url: `https://work${index + 1}.example/path`,
    active: index === 0,
    lastAccessed: lastAccessed - (index * 1000)
  }));
}

function tabtopiaTab(id, windowId) {
  return {
    id,
    windowId,
    title: "tabtopia",
    url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/src/newtab/newtab.html",
    active: true,
    lastAccessed: NOW
  };
}

function history(url, lastVisitTime) {
  return { id: url, url, title: url, lastVisitTime };
}
