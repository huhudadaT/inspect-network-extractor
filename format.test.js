// Lifts the pure region out of panel.js verbatim so there is no second copy
// to drift. Run: node test/format.test.js
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "panel.js"), "utf8");
const start = source.indexOf("/* ===== pure: start ===== */");
const end = source.indexOf("/* ===== pure: end ===== */");
assert.ok(start !== -1 && end !== -1, "pure region markers not found in panel.js");

const sandbox = { URL, URLSearchParams, console, TextDecoder };
vm.createContext(sandbox);
vm.runInContext(
  source.slice(start, end) +
  "\nthis.api = { isTextual, shortName, formatBytes, truncateBody, countMatches, safeStem, headerBlock, buildDocument, extensionOf, bodyNote };",
  sandbox
);
const api = sandbox.api;

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error("FAIL " + name + "\n  " + err.message); process.exitCode = 1; }
}

const baseOptions = {
  index: false, bodies: true, requestHeaders: false,
  responseHeaders: false, pageText: false, dom: false, bodyLimit: 0
};

function entry(over) {
  return Object.assign({
    url: "https://x.test/api/info",
    method: "GET",
    status: 200,
    mimeType: "application/json",
    size: 120,
    resourceType: "xhr",
    requestHeaders: [],
    responseHeaders: [],
    body: '{"ok":true}',
    bodyState: "ok"
  }, over);
}

function build(entries, options, snapshots) {
  return api.buildDocument({
    pageUrl: "https://x.test/page",
    capturedAt: "2026-09-23T00:00:00.000Z",
    entries,
    snapshots: snapshots || {},
    options: Object.assign({}, baseOptions, options)
  });
}

/* ---- textual detection ---- */

check("treats text mime types as text", () => {
  assert.ok(api.isTextual("application/json", "https://x.test/a"));
  assert.ok(api.isTextual("text/html; charset=utf-8", "https://x.test/a"));
  assert.ok(api.isTextual("application/vnd.apple.mpegurl", "https://x.test/a"));
  assert.ok(api.isTextual("image/svg+xml", "https://x.test/a"));
});

check("treats binary mime types as binary", () => {
  assert.ok(!api.isTextual("image/png", "https://x.test/a.png"));
  assert.ok(!api.isTextual("video/mp4", "https://x.test/a.mp4"));
  assert.ok(!api.isTextual("font/woff2", "https://x.test/a.woff2"));
});

check("falls back to the extension when mime is missing", () => {
  assert.ok(api.isTextual("", "https://x.test/subs.vtt"));
  assert.ok(api.isTextual("", "https://x.test/index.m3u8"));
  assert.ok(!api.isTextual("", "https://x.test/clip.mp4"));
  assert.ok(!api.isTextual("", "https://x.test/whatever"));
});

check("does not let the extension override an explicit mime", () => {
  // A .txt served as an image is still binary to us.
  assert.ok(!api.isTextual("image/png", "https://x.test/thing.txt"));
});

/* ---- small helpers ---- */

check("shortens URLs to name plus query", () => {
  assert.strictEqual(api.shortName("https://x.test/a/b/info.json?v=2"), "info.json?v=2");
  assert.strictEqual(api.shortName("https://x.test/a/My%20File.txt"), "My File.txt");
  assert.strictEqual(api.shortName("not a url"), "not a url");
});

check("formats sizes and treats zero as unknown", () => {
  assert.strictEqual(api.formatBytes(0), "—");
  assert.strictEqual(api.formatBytes(900), "900 B");
  assert.strictEqual(api.formatBytes(2048), "2.0 KB");
  assert.strictEqual(api.formatBytes(15 * 1024 * 1024), "15 MB");
});

check("truncates only past the cap", () => {
  // deepStrictEqual would fail on prototype identity across the vm realm.
  const uncapped = api.truncateBody("abcdef", 0);
  assert.strictEqual(uncapped.text, "abcdef");
  assert.strictEqual(uncapped.truncated, 0);

  const under = api.truncateBody("abcdef", 10);
  assert.strictEqual(under.text, "abcdef");
  assert.strictEqual(under.truncated, 0);

  const over = api.truncateBody("abcdef", 4);
  assert.strictEqual(over.text, "abcd");
  assert.strictEqual(over.truncated, 2);
});

check("counts overlapping-free matches, case insensitively", () => {
  assert.strictEqual(api.countMatches("Transcript transcript", "transcript"), 2);
  assert.strictEqual(api.countMatches("aaaa", "aa"), 2);
  assert.strictEqual(api.countMatches("nothing here", "xyz"), 0);
  assert.strictEqual(api.countMatches("", "a"), 0);
  assert.strictEqual(api.countMatches("abc", ""), 0);
});

check("derives a filename stem from the host", () => {
  assert.strictEqual(api.safeStem("https://tenant.hosted.panopto.com/x"), "tenant.hosted.panopto.com");
  assert.strictEqual(api.safeStem("garbage"), "page");
});

/* ---- header redaction ---- */

check("redacts credentials in headers", () => {
  const block = api.headerBlock([
    { name: "Accept", value: "*/*" },
    { name: "Cookie", value: "session=secret" },
    { name: "authorization", value: "Bearer abc" },
    { name: "Set-Cookie", value: "a=b" }
  ], "Request headers");
  const text = block.join("\n");
  assert.ok(text.includes("Accept: */*"));
  assert.ok(!text.includes("secret"));
  assert.ok(!text.includes("Bearer abc"));
  assert.ok(!text.includes("a=b"));
  assert.strictEqual(api.countMatches(text, "[redacted]"), 3);
});

check("omits an empty header block entirely", () => {
  assert.strictEqual(api.headerBlock([], "Request headers").length, 0);
  assert.strictEqual(api.headerBlock(undefined, "Request headers").length, 0);
  assert.strictEqual(api.headerBlock(null, "Request headers").length, 0);
});

/* ---- document assembly ---- */

check("writes a header with page, time and counts", () => {
  const doc = build([entry()]);
  assert.ok(doc.startsWith("Inspect Extractor\n"));
  assert.ok(doc.includes("Page:      https://x.test/page"));
  assert.ok(doc.includes("Captured:  2026-09-23T00:00:00.000Z"));
  assert.ok(doc.includes("1 included, 1 with a text body"));
});

check("counts only retained bodies in the header", () => {
  const doc = build([entry(), entry({ bodyState: "binary", body: null })]);
  assert.ok(doc.includes("2 included, 1 with a text body"));
});

check("includes the body when bodies are on", () => {
  const doc = build([entry()]);
  assert.ok(doc.includes('{"ok":true}'));
});

check("omits bodies when bodies are off", () => {
  const doc = build([entry()], { bodies: false });
  assert.ok(!doc.includes('{"ok":true}'));
  assert.ok(doc.includes("https://x.test/api/info"));
});

check("explains why a body is missing rather than leaving a gap", () => {
  const cases = {
    binary: "not text",
    empty: "was empty",
    unavailable: "not retained",
    pending: "still loading"
  };
  for (const [bodyState, phrase] of Object.entries(cases)) {
    const doc = build([entry({ bodyState, body: null })]);
    assert.ok(doc.includes(phrase), bodyState + " should mention " + phrase);
  }
});

check("marks a truncated body with the remainder", () => {
  const doc = build([entry({ body: "x".repeat(5000) })], { bodyLimit: 1000 });
  assert.ok(doc.includes("[truncated,"));
  assert.ok(!doc.includes("x".repeat(1001)));
});

check("writes the index only when asked", () => {
  const off = build([entry()]);
  assert.ok(!off.includes("\nIndex\n"));
  const on = build([entry()], { index: true });
  assert.ok(on.includes("\nIndex\n"));
  assert.ok(/001 {2}200 {2}GET/.test(on));
});

check("numbers requests consistently in index and detail", () => {
  const doc = build([entry({ url: "https://x.test/1" }), entry({ url: "https://x.test/2" })], { index: true });
  assert.ok(doc.includes("[001] GET 200  https://x.test/1"));
  assert.ok(doc.includes("[002] GET 200  https://x.test/2"));
});

check("adds page text and DOM sections when asked", () => {
  const snapshots = { text: "Lecture one", dom: "<html><body>hi</body></html>" };
  const doc = build([entry()], { pageText: true, dom: true }, snapshots);
  assert.ok(doc.includes("Rendered page text"));
  assert.ok(doc.includes("Lecture one"));
  assert.ok(doc.includes("DOM as inspected"));
  assert.ok(doc.includes("<body>hi</body>"));
});

check("skips snapshot sections when the snapshot came back empty", () => {
  const doc = build([entry()], { pageText: true, dom: true }, { text: "", dom: "" });
  assert.ok(!doc.includes("Rendered page text"));
  assert.ok(!doc.includes("DOM as inspected"));
});

check("includes header blocks only when requested", () => {
  const withHeaders = build([entry({
    requestHeaders: [{ name: "Accept", value: "text/html" }],
    responseHeaders: [{ name: "Content-Type", value: "application/json" }]
  })], { requestHeaders: true, responseHeaders: true });
  assert.ok(withHeaders.includes("Request headers"));
  assert.ok(withHeaders.includes("Response headers"));

  const without = build([entry({ requestHeaders: [{ name: "Accept", value: "text/html" }] })]);
  assert.ok(!without.includes("Request headers"));
});

check("survives an empty selection", () => {
  const doc = build([]);
  assert.ok(doc.includes("0 included, 0 with a text body"));
  assert.ok(doc.endsWith("\n"));
});

check("ends with exactly one trailing newline", () => {
  const doc = build([entry()]);
  assert.ok(doc.endsWith("\n"));
  assert.ok(!doc.endsWith("\n\n\n"));
});

console.log(passed + " checks passed");
