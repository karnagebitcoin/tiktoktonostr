chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "ttn:open-popup") {
    return false;
  }

  void (async () => {
    try {
      await chrome.action.openPopup();
      sendResponse({ ok: true });
      return;
    } catch {
      await chrome.windows.create({
        url: chrome.runtime.getURL("index.html"),
        type: "popup",
        width: 420,
        height: 760,
      });
      sendResponse({ ok: true, fallback: true });
    }
  })();

  return true;
});
