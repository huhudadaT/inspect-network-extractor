// The DevTools panel cannot call chrome.downloads, so it hands blob URLs here.
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (!msg || msg.type !== "save") return false;
  chrome.downloads.download(
    { url: msg.url, filename: msg.filename, saveAs: !!msg.saveAs },
    (id) => {
      const err = chrome.runtime.lastError;
      respond(err ? { ok: false, error: err.message } : { ok: true, id });
    }
  );
  return true;
});
