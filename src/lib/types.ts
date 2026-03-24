import type { Event as NostrEvent } from "nostr-tools";

export type PopupSettings = {
  blossomServer?: string;
  relayInput?: string;
  backendBaseUrl?: string;
};

export type TikTokDraft = {
  videoId: string;
  pageUrl: string;
  title: string;
  caption: string;
  authorHandle: string;
  posterUrl: string;
  videoUrl: string;
};

export type SignerInfo = {
  available: boolean;
  providerName: string;
  source: string;
  relays?: unknown;
  pubkey?: string;
};

export type TikTokExtractResponse = {
  ok: boolean;
  draft?: TikTokDraft;
  signer?: SignerInfo;
  error?: string;
};

export type PublishRelayResult = {
  relay: string;
  ok: boolean;
  message: string;
};

export type NostrProfile = {
  pubkey: string;
  name: string;
  displayName: string;
  picture: string;
  nip05: string;
  createdAt: number;
};

export type SignerCallResponse =
  | { ok: true; event?: NostrEvent; pubkey?: string; relays?: unknown }
  | { ok: false; error: string };

export type BackendResolveResponse = {
  ok: boolean;
  title?: string;
  caption?: string;
  author_handle?: string;
  poster_url?: string;
  stream_url?: string;
  webpage_url?: string;
  video_id?: string;
  error?: string;
};
