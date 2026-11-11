const { test, expect } = require("./fixtures");
// Install the optional MCP dependencies with npm --prefix mcp install.
const { WebSocketServer } = require("../../mcp/node_modules/ws");
const { once } = require("node:events");

test("MCP reads exact URLs including fragments and literal wildcards", async ({ context, server }) => {
  const replies = new Map();
  let socket;
  const bridge = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(bridge, "listening");
  bridge.on("connection", connection => {
    socket = connection;
    connection.on("message", raw => {
      const message = JSON.parse(String(raw));
      if (message.type === "TAB_CONTENT_RESULT") replies.set(message.id, message);
    });
  });
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker");
    await worker.evaluate(async bridgeUrl => {
      await chrome.storage.local.set({ bridgeUrl });
    }, `ws://127.0.0.1:${bridge.address().port}`);

    const plain = await context.newPage();
    await plain.goto(server + "/alpha");
    const fragment = await context.newPage();
    await fragment.goto(server + "/alpha#/email-analyst");
    await fragment.evaluate(() => {
      document.body.innerHTML = "<h1>Email Analyst fixture</h1><p>This is the exact fragment route requested by the agent, with enough text to exercise content extraction.</p><button>Analyze mail</button>";
    });
    await expect.poll(() => Boolean(socket)).toBe(true);

    let requestId = 0;
    const read = async (url, view = "text") => {
      const id = String(++requestId);
      socket.send(JSON.stringify({ type: "GET_TAB_CONTENT", id, url, view }));
      await expect.poll(() => replies.has(id)).toBe(true);
      return replies.get(id);
    };

    // Both the bridge lookup and the text extractor must preserve the fragment.
    for (const view of ["text", "outline", "interactive"]) {
      const result = await read(fragment.url(), view);
      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(result.content.url).toBe(fragment.url());
      expect(JSON.stringify(result.content.content)).toContain(
        view === "interactive" ? "Analyze mail" : "Email Analyst fixture"
      );
    }
    expect((await read(plain.url())).content.content).toContain("Alpha Page");
    expect(await read(server + "/alpha#/missing")).toMatchObject({ success: false, error: "tab not open" });

    // A URL is an identity, not a Chrome match pattern. '*' must stay literal.
    const wildcard = await context.newPage();
    await wildcard.goto(server + "/alpha?filter=*");
    expect((await read(wildcard.url())).success).toBe(true);
    expect(await read(server + "/a*")).toMatchObject({ success: false, error: "tab not open" });
    await wildcard.close();
    expect(await read(server + "/alpha?filter=*")).toMatchObject({ success: false, error: "tab not open" });
    await fragment.close();
    expect(await read(server + "/alpha#/email-analyst")).toMatchObject({ success: false, error: "tab not open" });
  } finally {
    for (const client of bridge.clients) client.terminate();
    await new Promise(resolve => bridge.close(resolve));
  }
});
