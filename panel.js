"use strict";

/* ------------------------------------------------------------------ *
 * Inspect Extractor
 *
 * Collects what DevTools captured for the inspected page and writes it
 * out as one plain text file: an index of every request, the text bodies
 * DevTools still holds, and optionally the page's rendered text and DOM.
 *
 * Nothing is re-requested from the network. Bodies come from
 * getContent(), snapshots come from eval() in the page. That is why the
 * only permission here is "downloads".
 * ------------------------------------------------------------------ */

/* ===== pure: start ===== */

const TEXTUAL_MIME = /^(text\/|application\/(json|xml|javascript|x-javascript|ecmascript|xhtml\+xml|ld\+json|manifest\+json|graphql|x-www-form-urlencoded|dash\+xml|vnd\.apple\.mpegurl|x-mpegurl)|image\/svg\+xml)/i;

const TEXTUAL_EXT = new Set([
  "txt", "json", "xml", "html", "htm", "css", "js", "mjs", "csv", "tsv",
  "vtt", "srt", "ttml", "dfxp", "m3u8", "mpd", "svg", "md", "yaml", "yml", "log"
]);

const RULE = 78;

function extensionOf(url) {
  let path;
  try { path = new URL(url).pathname; } catch { return ""; }
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

function isTextual(mimeType, url) {
  const mime = (mimeType || "").split(";")[0].trim();
  if (mime && TEXTUAL_MIME.test(mime)) return true;
  if (mime) return false;
  return TEXTUAL_EXT.has(extensionOf(url));
}

function shortName(url) {
  let u;
  try { u = new URL(url); } catch { return url; }
  const name = u.pathname.slice(u.pathname.lastIndexOf("/") + 1);
  const label = decodeURIComponent(name || u.pathname || u.host);
  return label + (u.search ? u.search : "");
}

function formatBytes(n) {
  if (!n || n < 0 || Number.isNaN(n)) return "—";
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + " " + units[i];
}

function truncateBody(text, limit) {
  if (!limit || text.length <= limit) return { text, truncated: 0 };
  return { text: text.slice(0, limit), truncated: text.length - limit };
}

function countMatches(haystack, needle) {
  if (!haystack || !needle) return 0;
  const hay = haystack.toLowerCase();
  const pin = needle.toLowerCase();
  let count = 0, at = 0;
  for (;;) {
    const found = hay.indexOf(pin, at);
    if (found === -1) return count;
    count++;
    at = found + pin.length;
  }
}

function safeStem(url) {
  let host = "page";
  try { host = new URL(url).hostname; } catch { /* keep default */ }
  return host.replace(/[^a-z0-9.-]+/gi, "-").replace(/^-+|-+$/g, "") || "page";
}

function headerBlock(headers, label) {
  if (!Array.isArray(headers) || !headers.length) return [];
  const out = [label];
  for (const h of headers) {
    if (!h || !h.name) continue;
    // Never write credentials into a file the user may share.
    const name = h.name.toLowerCase();
    const redact = name === "cookie" || name === "set-cookie" || name === "authorization";
    out.push("  " + h.name + ": " + (redact ? "[redacted]" : h.value));
  }
  return out;
}

function bodyNote(entry) {
  switch (entry.bodyState) {
    case "ok": return "";
    case "empty": return "  [body was empty]";
    case "binary": return "  [not text: " + (entry.mimeType || "unknown type") + "]";
    case "unavailable": return "  [body not retained by DevTools — reload with the panel open]";
    case "pending": return "  [body still loading]";
    default: return "  [body unavailable]";
  }
}

function buildDocument(ctx) {
  const opt = ctx.options || {};
  const entries = ctx.entries || [];
  const withBody = entries.filter((e) => e.bodyState === "ok").length;
  const out = [];

  out.push("Inspect Extractor");
  out.push("Page:      " + (ctx.pageUrl || "unknown"));
  out.push("Captured:  " + ctx.capturedAt);
  out.push("Requests:  " + entries.length + " included, " + withBody + " with a text body");
  out.push("");

  if (opt.index && entries.length) {
    out.push("=".repeat(RULE));
    out.push("Index");
    out.push("=".repeat(RULE));
    entries.forEach((e, i) => {
      const num = String(i + 1).padStart(3, "0");
      const status = String(e.status || "—").padEnd(4);
      const method = (e.method || "GET").padEnd(5);
      const size = formatBytes(e.size).padStart(8);
      out.push(num + "  " + status + " " + method + " " + size + "  " + e.url);
    });
    out.push("");
  }

  if (opt.pageText && ctx.snapshots && ctx.snapshots.text) {
    out.push("=".repeat(RULE));
    out.push("Rendered page text");
    out.push("=".repeat(RULE));
    out.push(ctx.snapshots.text);
    out.push("");
  }

  if (opt.dom && ctx.snapshots && ctx.snapshots.dom) {
    out.push("=".repeat(RULE));
    out.push("DOM as inspected");
    out.push("=".repeat(RULE));
    out.push(ctx.snapshots.dom);
    out.push("");
  }

  entries.forEach((e, i) => {
    out.push("=".repeat(RULE));
    out.push("[" + String(i + 1).padStart(3, "0") + "] " + (e.method || "GET") + " " + (e.status || "—") + "  " + e.url);
    const meta = [e.mimeType || "unknown type", formatBytes(e.size)];
    if (e.resourceType) meta.push(e.resourceType);
    out.push("      " + meta.join("   "));

    if (opt.requestHeaders) {
      const block = headerBlock(e.requestHeaders, "Request headers");
      if (block.length) { out.push(""); out.push(...block); }
    }
    if (opt.responseHeaders) {
      const block = headerBlock(e.responseHeaders, "Response headers");
      if (block.length) { out.push(""); out.push(...block); }
    }

    if (!opt.bodies) { out.push(""); return; }

    out.push("-".repeat(RULE));
    if (e.bodyState === "ok") {
      const { text, truncated } = truncateBody(e.body || "", opt.bodyLimit);
      out.push(text);
      if (truncated) out.push("  [truncated, " + formatBytes(truncated) + " more]");
    } else {
      out.push(bodyNote(e).trim());
    }
    out.push("");
  });

  return out.join("\n") + "\n";
}

/* ===== pure: end ===== */

const TYPES = [
  { id: "all", label: "All" },
  { id: "xhr", label: "Fetch/XHR" },
  { id: "document", label: "Doc" },
  { id: "script", label: "Script" },
  { id: "stylesheet", label: "Style" },
  { id: "other", label: "Other" }
];

const MAX_STORED_BODY = 4 * 1024 * 1024;

const state = {
  entries: new Map(),
  filter: "all",
  query: "",
  order: 0,
  pageUrl: "",
  options: {
    index: true,
    bodies: true,
    requestHeaders: false,
    responseHeaders: false,
    pageText: false,
    dom: false,
    bodyLimit: 262144
  }
};

const el = {};
for (const id of ["types", "query", "count", "load", "clear", "rows", "empty",
  "status", "estimate", "copy", "save", "limit",
  "opt-index", "opt-bodies", "opt-reqhead", "opt-reshead", "opt-text", "opt-dom",
  "sel-all", "sel-none", "sel-match", "sel-text"]) {
  el[id] = document.getElementById(id);
}

function setStatus(text, bad) {
  el.status.textContent = text || "";
  el.status.classList.toggle("bad", !!bad);
}

/* --------------------------- capture ----------------------------- */

function typeBucket(resourceType) {
  if (resourceType === "xhr" || resourceType === "fetch") return "xhr";
  if (resourceType === "document") return "document";
  if (resourceType === "script") return "script";
  if (resourceType === "stylesheet") return "stylesheet";
  return "other";
}

function makeEntry(harEntry, live) {
  const url = harEntry.request && harEntry.request.url;
  if (!url || !/^https?:/i.test(url)) return null;

  const response = harEntry.response || {};
  const content = response.content || {};
  const mimeType = (content.mimeType || "").split(";")[0].trim();
  const size = content.size > 0 ? content.size : (response.bodySize > 0 ? response.bodySize : 0);
  const resourceType = harEntry._resourceType || "";

  return {
    id: "e" + state.order,
    order: state.order++,
    url,
    method: (harEntry.request.method || "GET").toUpperCase(),
    status: response.status || 0,
    mimeType,
    size,
    resourceType,
    bucket: typeBucket(resourceType),
    requestHeaders: harEntry.request.headers || [],
    responseHeaders: response.headers || [],
    textual: isTextual(mimeType, url),
    body: null,
    bodyState: live ? "pending" : "unavailable",
    include: true
  };
}

function loadBody(entry, harEntry) {
  if (!entry.textual) {
    entry.bodyState = "binary";
    schedule();
    return;
  }
  if (typeof harEntry.getContent !== "function") {
    entry.bodyState = "unavailable";
    schedule();
    return;
  }

  let settled = false;
  const finish = (stateName, body) => {
    if (settled) return;
    settled = true;
    entry.bodyState = stateName;
    entry.body = body || null;
    schedule();
  };

  setTimeout(() => finish("unavailable", null), 5000);

  try {
    harEntry.getContent((content, encoding) => {
      if (content === null || content === undefined || content === "") return finish("empty", null);
      let text = content;
      if (encoding === "base64") {
        try {
          const binary = atob(content);
          const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
          text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        } catch {
          return finish("binary", null);
        }
      }
      if (text.length > MAX_STORED_BODY) text = text.slice(0, MAX_STORED_BODY);
      finish("ok", text);
    });
  } catch {
    finish("unavailable", null);
  }
}

chrome.devtools.network.onRequestFinished.addListener((harEntry) => {
  const entry = makeEntry(harEntry, true);
  if (!entry) return;
  state.entries.set(entry.id, entry);
  loadBody(entry, harEntry);
  schedule();
});

chrome.devtools.network.onNavigated.addListener((url) => {
  state.pageUrl = url;
});

function loadExisting() {
  chrome.devtools.network.getHAR((harLog) => {
    const seen = new Set([...state.entries.values()].map((e) => e.method + " " + e.url));
    let added = 0;
    let bodiless = 0;
    for (const harEntry of (harLog && harLog.entries) || []) {
      const entry = makeEntry(harEntry, false);
      if (!entry) continue;
      if (seen.has(entry.method + " " + entry.url)) continue;
      state.entries.set(entry.id, entry);
      added++;
      if (typeof harEntry.getContent === "function") loadBody(entry, harEntry);
      else bodiless++;
    }
    schedule();
    setStatus(added
      ? added + " added from the Network panel" + (bodiless ? ", " + bodiless + " without bodies" : "")
      : "Nothing new in the Network panel");
  });
}

function refreshPageUrl() {
  chrome.devtools.inspectedWindow.eval("location.href", (result) => {
    if (typeof result === "string") state.pageUrl = result;
  });
}

function snapshot(expression) {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(expression, (result, error) => {
      if (error || typeof result !== "string") return resolve("");
      resolve(result);
    });
  });
}

/* --------------------------- rendering --------------------------- */

let frame = null;
function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = null; render(); });
}

function allEntries() {
  return [...state.entries.values()].sort((a, b) => a.order - b.order);
}

function matchCount(entry) {
  const q = state.query.trim();
  if (!q) return 0;
  return countMatches(entry.url, q) + countMatches(entry.body || "", q);
}

function visibleEntries() {
  const q = state.query.trim();
  return allEntries()
    .filter((e) => state.filter === "all" || e.bucket === state.filter)
    .filter((e) => !q || matchCount(e) > 0);
}

function selectedEntries() {
  return allEntries().filter((e) => e.include);
}

function renderTypes() {
  const counts = { all: 0, xhr: 0, document: 0, script: 0, stylesheet: 0, other: 0 };
  for (const e of state.entries.values()) { counts.all++; counts[e.bucket]++; }

  el.types.replaceChildren(...TYPES.map((t) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(state.filter === t.id));
    b.append(document.createTextNode(t.label));
    if (counts[t.id]) {
      const tally = document.createElement("span");
      tally.className = "tally";
      tally.textContent = counts[t.id];
      b.append(tally);
    }
    b.addEventListener("click", () => { state.filter = t.id; render(); });
    return b;
  }));
}

function cell(row, className, content) {
  const td = document.createElement("td");
  if (className) td.className = className;
  if (content !== undefined) td.append(content);
  row.append(td);
  return td;
}

function bodyLabel(entry) {
  switch (entry.bodyState) {
    case "ok": return ["body-ok", formatBytes((entry.body || "").length)];
    case "empty": return ["body-skip", "empty"];
    case "binary": return ["body-skip", "not text"];
    case "pending": return ["body-skip", "loading"];
    default: return ["body-err", "unavailable"];
  }
}

function renderRow(entry, displayIndex) {
  const row = document.createElement("tr");
  if (!entry.include) row.classList.add("off");

  const pick = document.createElement("input");
  pick.type = "checkbox";
  pick.className = "pick";
  pick.checked = entry.include;
  pick.addEventListener("change", () => {
    entry.include = pick.checked;
    row.classList.toggle("off", !entry.include);
    updateFooter();
  });
  cell(row, "", pick);

  cell(row, "num", String(displayIndex).padStart(3, "0"));

  const stat = cell(row, "stat", String(entry.status || "—"));
  if (entry.status >= 400 || !entry.status) stat.classList.add("err");

  cell(row, "type", entry.bucket === "xhr" ? "fetch" : (entry.bucket === "stylesheet" ? "style" : entry.bucket));

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = shortName(entry.url);
  name.title = entry.url;
  const nameCell = cell(row, "", name);

  const hits = matchCount(entry);
  if (hits) {
    const sub = document.createElement("div");
    sub.className = "sub";
    const strong = document.createElement("span");
    strong.className = "hits";
    strong.textContent = hits;
    sub.append(strong, document.createTextNode(hits === 1 ? " match" : " matches"));
    nameCell.append(sub);
  }

  cell(row, "size", formatBytes(entry.size));

  const [cls, text] = bodyLabel(entry);
  cell(row, cls, text);

  return row;
}

function buildContext(snapshots) {
  return {
    pageUrl: state.pageUrl,
    capturedAt: new Date().toISOString(),
    entries: selectedEntries(),
    snapshots: snapshots || {},
    options: state.options
  };
}

function updateFooter() {
  const chosen = selectedEntries();
  const bodies = chosen.filter((e) => e.bodyState === "ok");
  const raw = bodies.reduce((sum, e) => {
    const len = (e.body || "").length;
    return sum + (state.options.bodyLimit ? Math.min(len, state.options.bodyLimit) : len);
  }, 0);
  el.estimate.textContent = chosen.length + " selected, about " +
    formatBytes(raw + chosen.length * 220 + (state.options.index ? chosen.length * 90 : 0));
  el.save.disabled = chosen.length === 0;
  el.copy.disabled = chosen.length === 0;
}

function render() {
  renderTypes();
  const visible = visibleEntries();
  el.count.textContent = visible.length === state.entries.size
    ? String(state.entries.size)
    : visible.length + "/" + state.entries.size;
  el.empty.hidden = state.entries.size > 0;
  el.rows.replaceChildren(...visible.map((e, i) => renderRow(e, i + 1)));
  updateFooter();
}

/* ----------------------------- output ---------------------------- */

async function gatherSnapshots() {
  const snapshots = {};
  if (state.options.pageText) {
    snapshots.text = await snapshot("document.body ? document.body.innerText : ''");
  }
  if (state.options.dom) {
    snapshots.dom = await snapshot("document.documentElement.outerHTML");
  }
  return snapshots;
}

async function compose() {
  refreshPageUrl();
  const snapshots = await gatherSnapshots();
  return buildDocument(buildContext(snapshots));
}

async function saveTxt() {
  el.save.disabled = true;
  setStatus("Building file");
  try {
    const text = await compose();
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = "inspect-extractor/" + safeStem(state.pageUrl) + "-" + stamp + ".txt";
    const result = await new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "save", url: objectUrl, filename }, (r) => resolve(r || { ok: false, error: "no response" })));
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    setStatus(result.ok ? formatBytes(blob.size) + " written to " + filename : "Save failed: " + result.error, !result.ok);
  } catch (err) {
    setStatus("Could not build the file: " + (err.message || err), true);
  } finally {
    updateFooter();
  }
}

async function copyTxt() {
  setStatus("Building text");
  try {
    const text = await compose();
    await navigator.clipboard.writeText(text);
    setStatus(formatBytes(text.length) + " copied");
  } catch {
    setStatus("Clipboard blocked. Use Save .txt instead.", true);
  }
}

/* ----------------------------- wiring ---------------------------- */

function bindOption(element, key) {
  element.checked = state.options[key];
  element.addEventListener("change", () => {
    state.options[key] = element.checked;
    updateFooter();
  });
}

bindOption(el["opt-index"], "index");
bindOption(el["opt-bodies"], "bodies");
bindOption(el["opt-reqhead"], "requestHeaders");
bindOption(el["opt-reshead"], "responseHeaders");
bindOption(el["opt-text"], "pageText");
bindOption(el["opt-dom"], "dom");

el.limit.addEventListener("change", () => {
  state.options.bodyLimit = Number(el.limit.value) || 0;
  updateFooter();
});

el.query.addEventListener("input", () => { state.query = el.query.value; render(); });

el.load.addEventListener("click", loadExisting);

el.clear.addEventListener("click", () => {
  state.entries.clear();
  state.order = 0;
  setStatus("");
  render();
});

el["sel-all"].addEventListener("click", () => {
  for (const e of state.entries.values()) e.include = true;
  render();
});

el["sel-none"].addEventListener("click", () => {
  for (const e of state.entries.values()) e.include = false;
  render();
});

el["sel-match"].addEventListener("click", () => {
  if (!state.query.trim()) return setStatus("Type something to search for first", true);
  for (const e of state.entries.values()) e.include = matchCount(e) > 0;
  render();
  setStatus(selectedEntries().length + " matching requests selected");
});

el["sel-text"].addEventListener("click", () => {
  for (const e of state.entries.values()) e.include = e.bodyState === "ok";
  render();
  setStatus(selectedEntries().length + " requests with a text body selected");
});

el.save.addEventListener("click", saveTxt);
el.copy.addEventListener("click", copyTxt);

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== el.query) {
    e.preventDefault();
    el.query.focus();
  } else if (e.key === "Escape" && document.activeElement === el.query) {
    el.query.value = "";
    state.query = "";
    render();
  }
});

refreshPageUrl();
render();
