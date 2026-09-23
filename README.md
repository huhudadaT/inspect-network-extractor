# Inspect Extractor

A DevTools panel that collects what the inspector captured for a page and writes it to a single `.txt` file.

Nothing is re-requested from the network. Bodies come from DevTools' own `getContent()`, page snapshots come from `eval()` in the inspected page. That is why the only permission in the manifest is `downloads`.

## Install

1. `chrome://extensions` → enable Developer mode
2. Load unpacked → select this folder
3. Open DevTools on any page. New tab: **Extract**

No build step. After editing, hit the reload arrow on the extension card, then close and reopen DevTools — panel scripts are cached for the DevTools session.

## Use

Reload the page with the panel open. Requests appear as they finish, and text bodies are pulled in automatically.

**Load existing** pulls whatever the Network panel already recorded. Useful when you opened the panel late, but Chrome does not hand out bodies for those entries — they show as `unavailable`. Reload with the panel open to get bodies.

### Include

Checkboxes control what lands in the file:

| Option | Adds |
| --- | --- |
| Index | A numbered one-line-per-request list at the top, matching the detail block numbering |
| Bodies | The response text of each selected request |
| Request / Response headers | Header blocks per request. `Cookie`, `Set-Cookie`, and `Authorization` are written as `[redacted]` |
| Page text | `document.body.innerText` as currently rendered |
| DOM | `document.documentElement.outerHTML` as currently inspected, post-JavaScript |

**Cap each body** keeps one enormous bundle from swallowing the file. Truncated bodies are marked with how much was cut.

### Selecting

Per-row checkboxes decide what goes in. The bulk buttons: **Select all**, **Select none**, **Select matches** (whatever the search box currently matches), **Select text only** (drops requests whose body was binary, empty, or unavailable).

### Searching

The search box matches request URLs *and* body text, showing a match count per row. This is the fastest way to find which request carries something you are hunting for — type a phrase you know is in the content, then hit **Select matches** and save just those.

`/` focuses the search box, `Esc` clears it.

Files land in `Downloads/inspect-extractor/` as `<host>-<timestamp>.txt`.

## Output shape

```
Inspect Extractor
Page:      https://example.test/lecture
Captured:  2026-09-23T14:22:05.123Z
Requests:  38 included, 24 with a text body

==============================================================================
Index
==============================================================================
001  200  GET     12.4 KB  https://example.test/api/info
002  200  GET      1.2 KB  https://example.test/api/captions
...

==============================================================================
[001] GET 200  https://example.test/api/info
      application/json   12.4 KB   xhr
------------------------------------------------------------------------------
{ ...body... }
```

Fixed-width rules and a stable field order, so `grep` and `less` behave predictably.

## Known limits

**Bodies are not guaranteed.** DevTools discards response bodies under memory pressure, and never retains them for requests that finished before a listener attached. A body that comes back empty is reported as such rather than silently omitted.

**Binary responses are listed, not dumped.** Images, video, and fonts appear in the index with their type and size; their bytes are skipped. Base64 payloads of text types are decoded as UTF-8.

**Bodies are capped in memory** at 4 MB each before the output cap is applied, so one huge response cannot exhaust the panel.

**Headers may still hold identifiers.** The three obvious credential headers are redacted, but bearer tokens in query strings and session IDs in custom headers are not. Skim the file before sharing it.

## Tests

```sh
node test/format.test.js
```

Slices the `pure: start` / `pure: end` region out of `panel.js` with `vm` and exercises it, so there is no duplicated copy to drift. 24 checks over mime detection, truncation, header redaction, and document assembly.
