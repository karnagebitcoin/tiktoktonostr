import type { Event as NostrEvent } from "nostr-tools";

import type { SignerCallResponse, SignerInfo, TikTokDraft, TikTokExtractResponse } from "@/lib/types";

const REQUEST_TYPE = "TTN_SIGNER_REQUEST";
const RESPONSE_TYPE = "TTN_SIGNER_RESPONSE";
const READY_TYPE = "TTN_SIGNER_READY";
const SRC_IN = "ttn-extension";
const SRC_OUT = "ttn-page";
const BRIDGE_READY_TIMEOUT_MS = 8000;
const SIGNER_REQUEST_TIMEOUT_MS = 5000;
const SIGNER_LOOKUP_ATTEMPTS = 4;
const SIGNER_LOOKUP_DELAY_MS = 500;
const BRIDGE_ROUTE_POLL_MS = 1000;
const EXTRACT_LOOKUP_ATTEMPTS = 12;
const EXTRACT_LOOKUP_DELAY_MS = 250;
const SHARE_BUTTON_ID = "ttn-share-to-nostr-button";
const SHARE_BUTTON_SIZE = 52;
const SHARE_BUTTON_MARGIN = 16;

const bridgeToken = crypto.randomUUID();
const pendingRequests = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
>();

let bridgeReadyPromise: Promise<void> | null = null;
let lastKnownUrl = location.href;

function decodeJsonString(raw: string) {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw
      .replace(/\\u002F/g, "/")
      .replace(/\\u0026/g, "&")
      .replace(/\\"/g, '"');
  }
}

function extractJsonValue(keys: string[]) {
  const scripts = Array.from(document.querySelectorAll("script"));

  for (const script of scripts) {
    const source = script.textContent || "";
    if (!source) {
      continue;
    }

    for (const key of keys) {
      const pattern = new RegExp(`"${key}":"((?:\\\\.|[^"\\\\])*)"`);
      const match = pattern.exec(source);
      if (match?.[1]) {
        return decodeJsonString(match[1]);
      }
    }
  }

  return "";
}

function normalizeText(value: string | null | undefined) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function getCanonicalUrl(videoId?: string) {
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
  if (canonical && (!videoId || canonical.includes(`/video/${videoId}`))) {
    return canonical;
  }

  return location.href;
}

function getAuthorHandle() {
  const pathnameMatch = location.pathname.match(/^\/(@[^/]+)/);
  if (pathnameMatch?.[1]) {
    return pathnameMatch[1];
  }

  return normalizeText(
    document.querySelector('[data-e2e="video-author-uniqueid"]')?.textContent ||
      document.querySelector('[data-e2e="browse-username"]')?.textContent,
  );
}

function getCaption() {
  const selectors = [
    '[data-e2e="browse-video-desc"]',
    '[data-e2e="video-desc"]',
    'meta[property="og:description"]',
    'meta[name="description"]',
  ];

  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (!element) {
      continue;
    }

    if (element instanceof HTMLMetaElement) {
      const content = normalizeText(element.content);
      if (content) {
        return content;
      }
    } else {
      const content = normalizeText(element.textContent);
      if (content) {
        return content;
      }
    }
  }

  return "";
}

function getTitle() {
  const metaTitle =
    document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ||
    document.querySelector<HTMLMetaElement>('meta[name="twitter:title"]')?.content;

  if (metaTitle) {
    return normalizeText(metaTitle.replace(/\s*\|\s*TikTok.*$/i, ""));
  }

  return normalizeText(document.title.replace(/\s*\|\s*TikTok.*$/i, ""));
}

function getPosterUrl() {
  return (
    document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content ||
    document.querySelector<HTMLMetaElement>('meta[name="twitter:image"]')?.content ||
    extractJsonValue(["dynamicCover", "cover"])
  );
}

function getActiveVideoElement() {
  const candidates = Array.from(document.querySelectorAll("video"))
    .map((video) => {
      const rect = video.getBoundingClientRect();
      const hasSource = Boolean(video.currentSrc || video.src);
      const visibleArea = Math.max(0, rect.width) * Math.max(0, rect.height);
      const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;

      return {
        video,
        hasSource,
        visibleArea,
        inViewport,
      };
    })
    .filter((candidate) => candidate.hasSource && candidate.inViewport)
    .sort((left, right) => right.visibleArea - left.visibleArea);

  return candidates[0]?.video || null;
}

function ensureShareButton() {
  const existing = document.getElementById(SHARE_BUTTON_ID) as HTMLButtonElement | null;
  const activeVideo = getActiveVideoElement();

  if (!location.pathname.includes("/video/") || !activeVideo) {
    existing?.remove();
    return;
  }

  const positionButton = (button: HTMLButtonElement) => {
    const rect = activeVideo.getBoundingClientRect();
    const top = Math.max(
      SHARE_BUTTON_MARGIN,
      Math.min(rect.bottom - SHARE_BUTTON_SIZE - SHARE_BUTTON_MARGIN, rect.top + SHARE_BUTTON_MARGIN),
    );
    const left = Math.max(
      SHARE_BUTTON_MARGIN,
      Math.min(rect.right - SHARE_BUTTON_SIZE - SHARE_BUTTON_MARGIN, rect.right - SHARE_BUTTON_SIZE - SHARE_BUTTON_MARGIN),
    );

    button.style.top = `${Math.round(top)}px`;
    button.style.left = `${Math.round(left)}px`;
  };

  if (existing) {
    positionButton(existing);
    return;
  }

  const button = document.createElement("button");
  button.id = SHARE_BUTTON_ID;
  button.type = "button";
  button.title = "Share to Nostr";
  button.setAttribute("aria-label", "Share to Nostr");
  button.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M21.2 2.8 3.9 10.2c-.9.4-.8 1.7.2 1.9l5.8 1.5 1.5 5.8c.2 1 .5 1.1 1.1.2l7.4-17.3c.5-1.1-.6-2.2-1.7-1.7Z" />
      <path d="M10.3 13.7 21 3" />
    </svg>
  `;
  button.style.position = "fixed";
  button.style.zIndex = "2147483647";
  button.style.display = "flex";
  button.style.alignItems = "center";
  button.style.justifyContent = "center";
  button.style.width = `${SHARE_BUTTON_SIZE}px`;
  button.style.height = `${SHARE_BUTTON_SIZE}px`;
  button.style.border = "1px solid rgba(255,255,255,0.7)";
  button.style.borderRadius = "9999px";
  button.style.background = "rgba(255,255,255,0.92)";
  button.style.boxShadow = "0 16px 32px rgba(17, 24, 39, 0.16)";
  button.style.backdropFilter = "blur(12px)";
  button.style.cursor = "pointer";
  button.style.padding = "0";
  button.style.transition = "transform 120ms ease, box-shadow 120ms ease";

  const svg = button.querySelector("svg");
  if (svg instanceof SVGElement) {
    svg.style.width = "24px";
    svg.style.height = "24px";
    svg.style.stroke = "#7c3aed";
    svg.style.fill = "none";
    svg.style.strokeWidth = "2";
    svg.style.strokeLinecap = "round";
    svg.style.strokeLinejoin = "round";
  }

  button.addEventListener("mouseenter", () => {
    button.style.transform = "translateY(-1px)";
    button.style.boxShadow = "0 20px 36px rgba(17, 24, 39, 0.22)";
  });

  button.addEventListener("mouseleave", () => {
    button.style.transform = "translateY(0)";
    button.style.boxShadow = "0 16px 32px rgba(17, 24, 39, 0.16)";
  });

  button.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "ttn:open-popup" });
  });

  positionButton(button);
  document.body.append(button);
}

function getVideoUrl() {
  const activeVideo = getActiveVideoElement();
  const directUrl = activeVideo?.currentSrc || activeVideo?.src;
  if (directUrl && /^https?:\/\//i.test(directUrl)) {
    return directUrl;
  }

  const metadataUrl =
    document.querySelector<HTMLMetaElement>('meta[property="og:video"]')?.content ||
    document.querySelector<HTMLMetaElement>('meta[property="og:video:url"]')?.content ||
    extractJsonValue(["downloadAddr", "playAddr", "playUrl"]);

  if (/^https?:\/\//i.test(metadataUrl)) {
    return metadataUrl;
  }

  return metadataUrl || directUrl || "";
}

function getVideoId() {
  const pathMatch = location.pathname.match(/\/video\/(\d+)/);
  if (pathMatch?.[1]) {
    return pathMatch[1];
  }

  return extractJsonValue(["itemId", "aweme_id"]);
}

function resetBridgeState() {
  bridgeReadyPromise = null;
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function ensureBridge(force = false) {
  if (force) {
    resetBridgeState();
  }

  if (bridgeReadyPromise) {
    return bridgeReadyPromise;
  }

  bridgeReadyPromise = new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      resetBridgeState();
      reject(new Error("Signer bridge did not initialize."));
    }, BRIDGE_READY_TIMEOUT_MS);

    const readyListener = (event: MessageEvent) => {
      if (event.source !== window || !event.data) {
        return;
      }

      if (event.data.source !== SRC_OUT || event.data.type !== READY_TYPE || event.data.bridgeToken !== bridgeToken) {
        return;
      }

      clearTimeout(timeoutId);
      window.removeEventListener("message", readyListener);
      resolve();
    };

    window.addEventListener("message", readyListener);

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-bridge.js");
    script.dataset.ttnToken = bridgeToken;
    script.async = false;
    script.addEventListener("error", () => {
      clearTimeout(timeoutId);
      window.removeEventListener("message", readyListener);
      resetBridgeState();
      reject(new Error("Signer bridge script failed to load."));
    });
    (document.head || document.documentElement).append(script);
    script.remove();
  });

  return bridgeReadyPromise;
}

function warmBridge(force = false) {
  void ensureBridge(force).catch(() => {
    // Bridge warm-up is best-effort. Actual signer requests still retry explicitly.
  });
}

window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data) {
    return;
  }

  const data = event.data;
  if (data.source !== SRC_OUT || data.type !== RESPONSE_TYPE || data.bridgeToken !== bridgeToken) {
    return;
  }

  const pending = pendingRequests.get(data.id);
  if (!pending) {
    return;
  }

  pendingRequests.delete(data.id);
  if (data.ok) {
    pending.resolve(data.result);
  } else {
    pending.reject(new Error(data.error || "Unknown signer error"));
  }
});

async function callSignerOnce(method: string, params: unknown[]) {
  await ensureBridge();

  return new Promise<unknown>((resolve, reject) => {
    const id = crypto.randomUUID();
    const timeoutId = window.setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Signer request timed out for ${method}.`));
    }, SIGNER_REQUEST_TIMEOUT_MS);

    pendingRequests.set(id, {
      resolve(value) {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      reject(reason) {
        window.clearTimeout(timeoutId);
        reject(reason);
      },
    });

    window.postMessage(
      {
        source: SRC_IN,
        type: REQUEST_TYPE,
        bridgeToken,
        id,
        method,
        params,
      },
      "*",
    );
  });
}

async function callSigner(method: string, params: unknown[]) {
  try {
    return await callSignerOnce(method, params);
  } catch (error) {
    resetBridgeState();
    await ensureBridge(true);
    return callSignerOnce(method, params);
  }
}

warmBridge();
ensureShareButton();

window.setInterval(() => {
  if (location.href === lastKnownUrl) {
    ensureShareButton();
    return;
  }

  lastKnownUrl = location.href;
  warmBridge(true);
  ensureShareButton();
}, BRIDGE_ROUTE_POLL_MS);

window.addEventListener("focus", () => {
  warmBridge();
  ensureShareButton();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    warmBridge();
    ensureShareButton();
  }
});

async function getSignerInfo(): Promise<SignerInfo> {
  for (let attempt = 0; attempt < SIGNER_LOOKUP_ATTEMPTS; attempt += 1) {
    try {
      const info = (await callSigner("getSignerInfo", [])) as SignerInfo;
      if (!info.available) {
        if (attempt < SIGNER_LOOKUP_ATTEMPTS - 1) {
          await delay(SIGNER_LOOKUP_DELAY_MS);
          continue;
        }

        return info;
      }

      let relays: unknown;
      try {
        relays = await callSigner("getRelays", []);
      } catch {
        relays = undefined;
      }

      return {
        ...info,
        relays,
      };
    } catch {
      if (attempt < SIGNER_LOOKUP_ATTEMPTS - 1) {
        await delay(SIGNER_LOOKUP_DELAY_MS);
        continue;
      }
    }
  }

  return {
    available: false,
    providerName: "No signer",
    source: "none",
  };
}

function extractDraftSnapshot(): TikTokDraft {
  const videoUrl = getVideoUrl();
  const videoId = getVideoId();
  const pageUrl = getCanonicalUrl(videoId);

  if (!videoUrl || !videoId || !pageUrl.includes("/video/")) {
    throw new Error("This page does not expose a TikTok video URL yet.");
  }

  return {
    videoId,
    pageUrl,
    title: getTitle(),
    caption: getCaption(),
    authorHandle: getAuthorHandle(),
    posterUrl: getPosterUrl(),
    videoUrl,
  };
}

async function extractDraft(): Promise<TikTokDraft> {
  const routeVideoId = location.pathname.match(/\/video\/(\d+)/)?.[1] || "";
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < EXTRACT_LOOKUP_ATTEMPTS; attempt += 1) {
    try {
      const draft = extractDraftSnapshot();
      if (routeVideoId && draft.videoId !== routeVideoId) {
        throw new Error("The visible TikTok video has not updated yet.");
      }

      return draft;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < EXTRACT_LOOKUP_ATTEMPTS - 1) {
        await delay(EXTRACT_LOOKUP_DELAY_MS);
      }
    }
  }

  throw lastError || new Error("This page does not expose a TikTok video URL yet.");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    if (message?.type === "ttn:extract") {
      try {
        const draft = await extractDraft();
        sendResponse({
          ok: true,
          draft,
        } satisfies TikTokExtractResponse);
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies TikTokExtractResponse);
      }
      return;
    }

    if (message?.type === "ttn:signer-info") {
      try {
        const signer = await getSignerInfo();
        sendResponse({
          ok: true,
          signer,
        } satisfies TikTokExtractResponse);
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies TikTokExtractResponse);
      }
      return;
    }

    if (message?.type === "ttn:signer-call") {
      try {
        const result = await callSigner(message.method, Array.isArray(message.params) ? message.params : []);

        if (message.method === "getPublicKey") {
          sendResponse({ ok: true, pubkey: String(result) } satisfies SignerCallResponse);
          return;
        }

        if (message.method === "getRelays") {
          sendResponse({ ok: true, relays: result } satisfies SignerCallResponse);
          return;
        }

        sendResponse({ ok: true, event: result as NostrEvent } satisfies SignerCallResponse);
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies SignerCallResponse);
      }
      return;
    }

    sendResponse({ ok: false, error: "Unsupported message type." });
  })();

  return true;
});
