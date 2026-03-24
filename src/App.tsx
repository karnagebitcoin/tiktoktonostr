import { BlossomUploader } from "@nostrify/nostrify/uploaders";
import type { EventTemplate, Event as NostrEvent } from "nostr-tools";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCcw,
  Send,
  ShieldCheck,
  Video,
} from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { getActiveTab, getStorageValue, sendTabMessage, setStorageValues } from "@/lib/extension";
import type {
  BackendResolveResponse,
  NostrProfile,
  PopupSettings,
  PublishRelayResult,
  SignerInfo,
  TikTokDraft,
  TikTokExtractResponse,
} from "@/lib/types";

const DEFAULT_BACKEND_BASE_URL = "http://localhost:8787";
const DEFAULT_BLOSSOM_SERVER = "https://blossom.primal.net/";
const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://nos.lol",
];

const SETTINGS_KEY = "ttn-settings";
const POPUP_DRAFT_ATTEMPTS = 3;
const POPUP_DRAFT_DELAY_MS = 250;
const POPUP_SIGNER_ATTEMPTS = 6;
const POPUP_SIGNER_DELAY_MS = 750;

type PublishStage =
  | "idle"
  | "loading"
  | "ready"
  | "uploading"
  | "signing"
  | "publishing"
  | "done"
  | "error";

type PublishSummary = {
  eventId: string;
  relayResults: PublishRelayResult[];
  blossomUrl: string;
};

type ProfileResult = NostrProfile | null;

function defaultMessageForDraft(draft: TikTokDraft) {
  const parts = [draft.caption, draft.title]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  if (parts.length > 0) {
    return normalizeHashtagSpacing(parts[0]);
  }

  return normalizeHashtagSpacing(draft.authorHandle ? `${draft.authorHandle} on TikTok` : "TikTok video");
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeRelayList(input: string) {
  const seen = new Set<string>();

  return input
    .split(/[\n,\s]+/)
    .map((value) => value.trim())
    .filter((value) => /^wss?:\/\//i.test(value))
    .filter((value) => {
      if (seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    });
}

function normalizeHashtagSpacing(input: string) {
  return input.replace(/(^|[^\s#])#(?=[\p{L}\p{N}_])/gu, "$1 #").trim();
}

function buildNoteContent(message: string, blossomUrl?: string) {
  const sections = [normalizeHashtagSpacing(message)];

  sections.push(blossomUrl?.trim() || "[Blossom upload will be inserted here]");

  return sections.filter(Boolean).join("\n\n");
}

function getWriteRelays(relays: unknown) {
  if (!relays || typeof relays !== "object") {
    return [];
  }

  return Object.entries(relays as Record<string, { read?: boolean; write?: boolean } | null>)
    .filter(([, config]) => !config || config.write !== false)
    .map(([url]) => url)
    .filter((url) => /^wss?:\/\//i.test(url));
}

function getTagValue(tags: string[][], tagName: string) {
  return tags.find(([name]) => name === tagName)?.[1] || "";
}

function shortenPubkey(pubkey: string) {
  if (pubkey.length < 16) {
    return pubkey;
  }

  return `${pubkey.slice(0, 8)}…${pubkey.slice(-6)}`;
}

function getProfileInitials(profile: ProfileResult, signerInfo: SignerInfo | null) {
  const base = profile?.displayName || profile?.name || signerInfo?.providerName || "Nostr";
  return base
    .split(/\s+/)
    .map((part) => part[0] || "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function parseProfile(pubkey: string, event: { content?: string; created_at?: number }) {
  if (!event.content) {
    return null;
  }

  try {
    const content = JSON.parse(event.content) as {
      name?: string;
      display_name?: string;
      picture?: string;
      nip05?: string;
    };

    return {
      pubkey,
      name: typeof content.name === "string" ? content.name : "",
      displayName: typeof content.display_name === "string" ? content.display_name : "",
      picture: typeof content.picture === "string" ? content.picture : "",
      nip05: typeof content.nip05 === "string" ? content.nip05 : "",
      createdAt: Number.isFinite(event.created_at) ? Number(event.created_at) : 0,
    } satisfies NostrProfile;
  } catch {
    return null;
  }
}

async function fetchProfileFromRelay(relay: string, pubkey: string): Promise<ProfileResult> {
  return new Promise((resolve) => {
    const subId = crypto.randomUUID();
    const socket = new WebSocket(relay);
    let settled = false;

    const settle = (profile: ProfileResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(["CLOSE", subId]));
        }
        socket.close();
      } catch {
        // Ignore close failures during profile lookup.
      }
      resolve(profile);
    };

    const timeoutId = window.setTimeout(() => settle(null), 5000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(["REQ", subId, { kinds: [0], authors: [pubkey], limit: 1 }]));
    });

    socket.addEventListener("message", (message) => {
      try {
        const payload = JSON.parse(message.data as string);
        if (!Array.isArray(payload) || payload[1] !== subId) {
          return;
        }

        if (payload[0] === "EVENT") {
          settle(parseProfile(pubkey, payload[2]));
          return;
        }

        if (payload[0] === "EOSE") {
          settle(null);
        }
      } catch {
        settle(null);
      }
    });

    socket.addEventListener("error", () => settle(null));
  });
}

async function fetchNostrProfile(pubkey: string, relays: string[]) {
  const results = await Promise.all(relays.map((relay) => fetchProfileFromRelay(relay, pubkey)));
  return results
    .filter((profile): profile is NostrProfile => Boolean(profile))
    .sort((left, right) => right.createdAt - left.createdAt)[0] || null;
}

function buildEventTags(draft: TikTokDraft, uploadTags: string[][]) {
  const tags: string[][] = [["t", "tiktok"]];

  if (draft.authorHandle) {
    tags.push(["t", draft.authorHandle.replace(/^@/, "")]);
  }

  const uploadTagNames = new Set(["url", "x", "ox", "m", "size", "dim", "blurhash", "thumb"]);
  for (const tag of uploadTags) {
    if (uploadTagNames.has(tag[0]) && tag[1]) {
      tags.push(tag);
    }
  }

  const deduped = new Map<string, string[]>();
  for (const tag of tags) {
    deduped.set(`${tag[0]}:${tag[1]}`, tag);
  }

  return [...deduped.values()];
}

function getUserFacingError(error: unknown, context: "init" | "publish" = "publish") {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  if (message.includes("tiktok video tab") || message.includes("could not detect")) {
    return "Open a TikTok video page and try again.";
  }

  if (message.includes("no tiktok draft")) {
    return "Open a TikTok video page before publishing.";
  }

  if (message.includes("signer")) {
    return "Could not connect to the signer.";
  }

  if (message.includes("download") || message.includes("video")) {
    return "Failed to download the video.";
  }

  if (message.includes("server") || message.includes("worker") || message.includes("resolve") || message.includes("health")) {
    return "There seems to be an issue with the server.";
  }

  if (message.includes("upload") || message.includes("blossom")) {
    return "Failed to upload the video.";
  }

  if (message.includes("relay") || message.includes("publish")) {
    return "Failed to publish to relays.";
  }

  return context === "init" ? "Could not load this TikTok page." : "Something went wrong. Please try again.";
}

async function resolveDraftFromBackend(draft: TikTokDraft, backendBaseUrl: string) {
  const endpoint = new URL("/api/tiktok/resolve", backendBaseUrl);
  endpoint.searchParams.set("url", draft.pageUrl);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      cache: "no-store",
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    throw new Error("There seems to be an issue with the server.");
  }

  if (!response.ok) {
    throw new Error("There seems to be an issue with the server.");
  }

  const payload = (await response.json()) as BackendResolveResponse;
  if (!payload.ok || !payload.stream_url) {
    throw new Error("There seems to be an issue with the server.");
  }

  return {
    ...draft,
    title: payload.title || draft.title,
    caption: payload.caption || draft.caption,
    authorHandle: payload.author_handle || draft.authorHandle,
    posterUrl: payload.poster_url || draft.posterUrl,
    pageUrl: payload.webpage_url || draft.pageUrl,
    videoId: payload.video_id || draft.videoId,
    videoUrl: payload.stream_url,
  };
}

async function fetchVideoFile(draft: TikTokDraft) {
  if (!/^https?:\/\//i.test(draft.videoUrl)) {
    throw new Error("Worker did not provide a valid downloadable media URL.");
  }

  let response: Response;
  try {
    response = await fetch(draft.videoUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    throw new Error("Failed to download the video.");
  }

  if (!response.ok) {
    throw new Error("Failed to download the video.");
  }

  const blob = await response.blob();
  const mimeType = response.headers.get("content-type")?.split(";")[0] || blob.type || "video/mp4";
  const extension = mimeType.includes("webm") ? "webm" : "mp4";
  const filename = `${draft.videoId || "tiktok-video"}.${extension}`;

  return new File([blob], filename, {
    type: mimeType,
    lastModified: Date.now(),
  });
}

async function publishToRelay(relay: string, event: NostrEvent): Promise<PublishRelayResult> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(relay);

    const settle = (result: PublishRelayResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      try {
        socket.close();
      } catch {
        // Ignore close failures during publish cleanup.
      }
      resolve(result);
    };

    const timeoutId = window.setTimeout(() => {
      settle({
        relay,
        ok: false,
        message: "Relay timed out before acknowledging the event.",
      });
    }, 12000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(["EVENT", event]));
    });

    socket.addEventListener("message", (message) => {
      try {
        const payload = JSON.parse(message.data as string);
        if (!Array.isArray(payload) || payload[0] !== "OK" || payload[1] !== event.id) {
          return;
        }

        settle({
          relay,
          ok: Boolean(payload[2]),
          message: typeof payload[3] === "string" ? payload[3] : "",
        });
      } catch {
        settle({
          relay,
          ok: false,
          message: "Relay returned an unreadable response.",
        });
      }
    });

    socket.addEventListener("error", () => {
      settle({
        relay,
        ok: false,
        message: "Relay connection failed.",
      });
    });
  });
}

async function requestDraft(tabId: number): Promise<TikTokDraft> {
  let lastError = "Could not detect a TikTok video in the active tab.";

  for (let attempt = 0; attempt < POPUP_DRAFT_ATTEMPTS; attempt += 1) {
    const response = await sendTabMessage<TikTokExtractResponse>(tabId, {
      type: "ttn:extract",
    });

    if (response.ok && response.draft) {
      return response.draft;
    } else if (response.error) {
      lastError = response.error;
    }

    if (attempt < POPUP_DRAFT_ATTEMPTS - 1) {
      await delay(POPUP_DRAFT_DELAY_MS);
    }
  }

  throw new Error(lastError);
}

async function requestSignerInfo(tabId: number): Promise<SignerInfo> {
  let lastSuccessfulResponse: TikTokExtractResponse | null = null;
  let lastError = "Could not connect to the signer.";

  for (let attempt = 0; attempt < POPUP_SIGNER_ATTEMPTS; attempt += 1) {
    const response = await sendTabMessage<TikTokExtractResponse>(tabId, {
      type: "ttn:signer-info",
    });

    if (response.ok && response.signer) {
      lastSuccessfulResponse = response;
      if (response.signer.available) {
        return response.signer;
      }
    } else if (response.error) {
      lastError = response.error;
    }

    if (attempt < POPUP_SIGNER_ATTEMPTS - 1) {
      await delay(POPUP_SIGNER_DELAY_MS);
    }
  }

  if (lastSuccessfulResponse?.signer) {
    return lastSuccessfulResponse.signer;
  }

  throw new Error(lastError);
}

async function requestSignerPublicKey(tabId: number) {
  let lastError = "Signer public key request failed.";

  for (let attempt = 0; attempt < POPUP_SIGNER_ATTEMPTS; attempt += 1) {
    const response = await sendTabMessage<{ ok: boolean; pubkey?: string; error?: string }>(tabId, {
      type: "ttn:signer-call",
      method: "getPublicKey",
      params: [],
    });

    if (response.ok && response.pubkey) {
      return response.pubkey;
    }

    if (response.error) {
      lastError = response.error;
    }

    if (attempt < POPUP_SIGNER_ATTEMPTS - 1) {
      await delay(POPUP_SIGNER_DELAY_MS);
    }
  }

  throw new Error(lastError);
}

export default function App() {
  const [stage, setStage] = useState<PublishStage>("loading");
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [draft, setDraft] = useState<TikTokDraft | null>(null);
  const [signerInfo, setSignerInfo] = useState<SignerInfo | null>(null);
  const [signerProfile, setSignerProfile] = useState<ProfileResult>(null);
  const [blossomServer, setBlossomServer] = useState(DEFAULT_BLOSSOM_SERVER);
  const [relayInput, setRelayInput] = useState(DEFAULT_RELAYS.join("\n"));
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [uploadUrl, setUploadUrl] = useState("");
  const [publishSummary, setPublishSummary] = useState<PublishSummary | null>(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState("");
  const objectUrlRef = useRef<string | null>(null);
  const initializeRunRef = useRef(0);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
    };
  }, []);

  async function initialize() {
    const runId = initializeRunRef.current + 1;
    initializeRunRef.current = runId;

    setStage("loading");
    setError("");
    setPublishSummary(null);
    setUploadUrl("");
    setSignerProfile(null);
    setSignerInfo(null);
    setDraft(null);
    setVideoPreviewUrl("");

    const settings = (await getStorageValue<PopupSettings>(SETTINGS_KEY)) || {};
    setBlossomServer(settings.blossomServer || DEFAULT_BLOSSOM_SERVER);
    setRelayInput(settings.relayInput || DEFAULT_RELAYS.join("\n"));

    try {
      const activeTab = await getActiveTab();
      if (!activeTab?.id || !activeTab.url) {
        throw new Error("Open a TikTok video tab before using this extension.");
      }

      if (initializeRunRef.current !== runId) {
        return;
      }

      setActiveTabId(activeTab.id);

      const nextDraft = await requestDraft(activeTab.id);
      if (initializeRunRef.current !== runId) {
        return;
      }

      setDraft(nextDraft);
      setMessage(defaultMessageForDraft(nextDraft));
      setVideoPreviewUrl(nextDraft.videoUrl);
      setSignerInfo({
        available: false,
        providerName: "Checking signer…",
        source: "pending",
      });
      setStage("ready");

      void (async () => {
        try {
          const nextSignerInfo = await requestSignerInfo(activeTab.id);
          if (initializeRunRef.current !== runId) {
            return;
          }

          setSignerInfo(nextSignerInfo);

          if (!settings.relayInput) {
            const signerRelays = getWriteRelays(nextSignerInfo.relays);
            if (signerRelays.length > 0) {
              setRelayInput(signerRelays.join("\n"));
            }
          }

          if (!nextSignerInfo.available) {
            return;
          }

          const signerPubkey = await requestSignerPublicKey(activeTab.id);
          if (initializeRunRef.current !== runId) {
            return;
          }

          const signerWithPubkey = {
            ...nextSignerInfo,
            pubkey: signerPubkey,
          } satisfies SignerInfo;

          setSignerInfo(signerWithPubkey);

          const profile = await fetchNostrProfile(
            signerPubkey,
            getWriteRelays(nextSignerInfo.relays).length > 0 ? getWriteRelays(nextSignerInfo.relays) : DEFAULT_RELAYS,
          );

          if (initializeRunRef.current !== runId) {
            return;
          }

          if (profile) {
            setSignerProfile(profile);
          }
        } catch {
          if (initializeRunRef.current !== runId) {
            return;
          }

          setSignerInfo({
            available: false,
            providerName: "Signer unavailable",
            source: "none",
          });
        }
      })();
    } catch (initError) {
      if (initializeRunRef.current !== runId) {
        return;
      }

      setStage("error");
      setError(getUserFacingError(initError, "init"));
    }
  }

  useEffect(() => {
    void initialize();
  }, []);

  const finalPreview = useMemo(() => {
    return buildNoteContent(message, uploadUrl);
  }, [message, uploadUrl]);

  async function handlePublish() {
    if (!draft || !activeTabId) {
      setError("No TikTok draft is ready yet.");
      return;
    }

    const relays = normalizeRelayList(relayInput);
    if (relays.length === 0) {
      setError("Add at least one relay before publishing.");
      return;
    }

    if (!blossomServer.trim()) {
      setError("A Blossom server URL is required.");
      return;
    }

    setError("");
    setPublishSummary(null);

    const backendBaseUrl = (await getStorageValue<PopupSettings>(SETTINGS_KEY))?.backendBaseUrl || DEFAULT_BACKEND_BASE_URL;

    try {
      await setStorageValues({
        [SETTINGS_KEY]: {
          blossomServer: blossomServer.trim(),
          relayInput,
          backendBaseUrl,
        } satisfies PopupSettings,
      });

      const signer = {
        getPublicKey: async () => {
          const response = await sendTabMessage<{ ok: boolean; pubkey?: string; error?: string }>(activeTabId, {
            type: "ttn:signer-call",
            method: "getPublicKey",
            params: [],
          });

          if (!response.ok || !response.pubkey) {
            throw new Error(response.error || "Signer public key request failed.");
          }

          return response.pubkey;
        },
        signEvent: async (eventTemplate: EventTemplate) => {
          const response = await sendTabMessage<{ ok: boolean; event?: NostrEvent; error?: string }>(activeTabId, {
            type: "ttn:signer-call",
            method: "signEvent",
            params: [eventTemplate],
          });

          if (!response.ok || !response.event) {
            throw new Error(response.error || "Signer rejected the event.");
          }

          return response.event;
        },
      };

      setStage("uploading");
      try {
        await fetch(new URL("/healthz", backendBaseUrl), {
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        throw new Error("There seems to be an issue with the server.");
      }

      const resolvedDraft = await resolveDraftFromBackend(draft, backendBaseUrl);
      setDraft(resolvedDraft);

      const file = await fetchVideoFile(resolvedDraft);
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
      objectUrlRef.current = URL.createObjectURL(file);
      setVideoPreviewUrl(objectUrlRef.current);

      const uploader = new BlossomUploader({
        servers: [blossomServer.trim()],
        signer,
      });

      const uploadTags = (await uploader.upload(file)) as string[][];
      const blossomUrl = getTagValue(uploadTags, "url");
      if (!blossomUrl) {
        throw new Error("Blossom upload finished without returning a URL.");
      }

      setUploadUrl(blossomUrl);

      setStage("signing");
      const unsignedEvent: EventTemplate = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        content: buildNoteContent(message, blossomUrl),
        tags: buildEventTags(resolvedDraft, uploadTags),
      };

      const signedEvent = await signer.signEvent(unsignedEvent);

      setStage("publishing");
      const relayResults = await Promise.all(relays.map((relay) => publishToRelay(relay, signedEvent)));
      const accepted = relayResults.filter((result) => result.ok);

      if (accepted.length === 0) {
        throw new Error("The note was signed, but no relay accepted it.");
      }

      setPublishSummary({
        eventId: signedEvent.id,
        relayResults,
        blossomUrl,
      });
      setStage("done");
    } catch (publishError) {
      setStage("ready");
      setError(getUserFacingError(publishError, "publish"));
      console.error("[ttn] publish failed", publishError);
    }
  }

  const isBusy = stage === "loading" || stage === "uploading" || stage === "signing" || stage === "publishing";
  const primaryLabel =
    stage === "uploading"
      ? "Uploading to Blossom"
      : stage === "signing"
        ? "Waiting for signer"
        : stage === "publishing"
          ? "Publishing to relays"
          : "Upload and publish";

  return (
    <main className="min-h-[640px] w-[420px] bg-background text-foreground">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(255,91,122,0.25),_transparent_32%),radial-gradient(circle_at_bottom_right,_rgba(35,244,244,0.18),_transparent_30%)]" />
        <div className="relative flex flex-col gap-4 p-4">
          <Card className="border-white/10 bg-white/75 shadow-2xl shadow-black/10 backdrop-blur dark:bg-slate-950/70">
            <CardHeader className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Video className="h-5 w-5 text-[hsl(var(--brand-hot))]" />
                    TikTok to Nostr
                  </CardTitle>
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  className="border-white/20 bg-white/60 dark:bg-slate-900/70"
                  onClick={() => void initialize()}
                  disabled={isBusy}
                >
                  <RefreshCcw className="h-4 w-4" />
                </Button>
              </div>

              <div className="w-full">
                <div className="flex w-full min-w-0 items-center gap-3 rounded-2xl border border-white/10 bg-black/5 px-4 py-3 dark:bg-white/5">
                  <Avatar className="h-10 w-10 border border-white/10">
                    <AvatarImage src={signerProfile?.picture || undefined} alt={signerProfile?.displayName || signerProfile?.name || "Signer profile"} />
                    <AvatarFallback>{getProfileInitials(signerProfile, signerInfo)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                      {signerProfile?.displayName || signerProfile?.name || (signerInfo?.available ? "Posting with signer" : "Signer not detected")}
                      <span className="ml-2 text-sm font-medium text-muted-foreground">
                        {signerProfile?.name
                          ? `@${signerProfile.name}`
                          : signerInfo?.pubkey
                            ? shortenPubkey(signerInfo.pubkey)
                            : signerInfo?.providerName || "NIP-07 required"}
                      </span>
                    </p>
                  </div>
                  {signerInfo?.available ? <ShieldCheck className="h-4 w-4 shrink-0 text-[hsl(var(--brand-cool))]" /> : null}
                </div>
              </div>
            </CardHeader>

            <CardContent className="space-y-4">
              {stage === "loading" ? (
                <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/5 px-4 py-5 text-sm dark:bg-white/5">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Reading the active TikTok tab and signer state.
                </div>
              ) : null}

              {draft ? (
                <>
                  <section className="space-y-2">
                    <Label htmlFor="note-body">Note</Label>
                    <Textarea
                      id="note-body"
                      className="min-h-[132px] resize-none border-slate-300 bg-white/85 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-950/80"
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                    />
                  </section>

                  <Button
                    className="h-12 w-full rounded-2xl bg-[linear-gradient(135deg,rgba(255,91,122,0.95),rgba(35,244,244,0.9))] font-semibold text-white shadow-lg shadow-[rgba(255,91,122,0.3)] transition hover:opacity-95"
                    onClick={() => void handlePublish()}
                    disabled={isBusy || !signerInfo?.available}
                  >
                    {isBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                    {primaryLabel}
                  </Button>

                  {publishSummary ? (
                    <details className="rounded-2xl border border-emerald-200 bg-emerald-100/90 px-3 py-2 text-slate-950">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold">
                        <span className="flex items-center gap-2">
                          <CheckCircle2 className="h-4 w-4" />
                          Published
                        </span>
                        <Badge variant="secondary">{publishSummary.relayResults.filter((result) => result.ok).length} relays</Badge>
                      </summary>
                      <div className="mt-3 space-y-3 text-xs">
                        <div className="space-y-1">
                          <p className="break-all">Event: {publishSummary.eventId}</p>
                          <p className="break-all">Blossom: {publishSummary.blossomUrl}</p>
                        </div>
                        <div className="space-y-1">
                          {publishSummary.relayResults.map((result) => (
                            <div
                              key={result.relay}
                              className="flex items-start justify-between gap-3 rounded-xl bg-black/5 px-3 py-2"
                            >
                              <span className="break-all">{result.relay}</span>
                              <Badge variant={result.ok ? "secondary" : "outline"}>{result.ok ? "OK" : "Failed"}</Badge>
                            </div>
                          ))}
                        </div>
                      </div>
                    </details>
                  ) : null}

                  <Separator />

                  <section className="space-y-3">
                    <div className="overflow-hidden rounded-3xl border border-white/10 bg-black/5 dark:bg-white/5">
                      {videoPreviewUrl ? (
                        <video
                          className="h-[280px] w-full bg-black object-cover"
                          controls
                          muted
                          playsInline
                          poster={draft.posterUrl || undefined}
                          preload="metadata"
                          src={videoPreviewUrl}
                        />
                      ) : draft.posterUrl ? (
                        <img
                          alt={draft.title || "TikTok preview"}
                          className="h-[280px] w-full object-cover"
                          src={draft.posterUrl}
                        />
                      ) : null}
                    </div>

                    <div className="space-y-1">
                      <p className="text-sm font-semibold leading-snug">{draft.title || "Untitled TikTok"}</p>
                    </div>
                  </section>

                  <details className="group rounded-2xl border border-white/10 bg-black/5 px-3 py-2 dark:bg-white/5">
                    <summary className="cursor-pointer list-none text-sm font-semibold text-foreground">
                      Blossom server
                    </summary>
                    <div className="mt-3 space-y-2">
                      <Input
                        id="blossom-server"
                        className="border-white/15 bg-white/65 dark:bg-slate-950/80"
                        value={blossomServer}
                        onChange={(event) => setBlossomServer(event.target.value)}
                      />
                    </div>
                  </details>

                  <details className="group rounded-2xl border border-white/10 bg-black/5 px-3 py-2 dark:bg-white/5">
                    <summary className="cursor-pointer list-none text-sm font-semibold text-foreground">
                      Relay list
                    </summary>
                    <div className="mt-3 space-y-2">
                      <Textarea
                        id="relay-list"
                        className="min-h-[92px] resize-none border-white/15 bg-white/65 text-xs dark:bg-slate-950/80"
                        value={relayInput}
                        onChange={(event) => setRelayInput(event.target.value)}
                      />
                    </div>
                  </details>

                  <section className="space-y-2 rounded-2xl border border-white/10 bg-black/5 p-3 dark:bg-white/5">
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="text-sm font-semibold">Final note preview</h2>
                      <Badge variant="outline">{uploadUrl ? "Ready to publish" : "Upload pending"}</Badge>
                    </div>
                    <pre className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
                      {finalPreview}
                    </pre>
                  </section>
                </>
              ) : null}

              {error ? (
                <section className="rounded-2xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-200">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <p>{error}</p>
                  </div>
                </section>
              ) : null}

              {!draft && stage !== "loading" ? (
                <section className="rounded-2xl border border-white/10 bg-black/5 p-4 text-sm text-muted-foreground dark:bg-white/5">
                  Open a TikTok video page, then reopen the popup. The content script only activates on TikTok watch pages.
                </section>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
