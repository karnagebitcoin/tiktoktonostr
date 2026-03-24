(() => {
  const REQUEST_TYPE = "TTN_SIGNER_REQUEST";
  const RESPONSE_TYPE = "TTN_SIGNER_RESPONSE";
  const READY_TYPE = "TTN_SIGNER_READY";
  const SRC_IN = "ttn-extension";
  const SRC_OUT = "ttn-page";
  const bridgeToken = document.currentScript?.dataset?.ttnToken || null;
  const BRIDGE_STATE_KEY = "__ttnSignerBridgeState";
  const allowedMethods = new Set(["getSignerInfo", "getPublicKey", "signEvent", "getRelays"]);
  const bridgeState = ((window as typeof window & {
    [BRIDGE_STATE_KEY]?: { installed: boolean; token: string | null };
  })[BRIDGE_STATE_KEY] ??= { installed: false, token: null });

  bridgeState.token = bridgeToken;

  function getProviderName(candidate: unknown, fallback: string) {
    if (!candidate || typeof candidate !== "object") {
      return fallback;
    }

    const signer = candidate as {
      name?: string;
      signerName?: string;
      provider?: string;
      client?: string;
      constructor?: { name?: string };
    };

    return (
      [signer.name, signer.signerName, signer.provider, signer.client, signer.constructor?.name]
        .find((value) => typeof value === "string" && value.trim() && value !== "Object") || fallback
    );
  }

  function getSignerCandidate() {
    const win = window as typeof window & {
      signer?: { nip07?: unknown; name?: string; provider?: string };
      nostr?: unknown;
    };

    const candidates = [
      {
        source: "window.signer.nip07",
        signer: win.signer?.nip07,
        providerName: getProviderName(win.signer?.nip07 || win.signer, "window.signer.nip07"),
      },
      {
        source: "window.signer",
        signer: win.signer,
        providerName: getProviderName(win.signer, "window.signer"),
      },
      {
        source: "window.nostr",
        signer: win.nostr,
        providerName: getProviderName(win.nostr, "window.nostr"),
      },
    ];

    return candidates.find((candidate) => {
      if (!candidate.signer || typeof candidate.signer !== "object") {
        return false;
      }

      const signer = candidate.signer as Record<string, unknown>;
      return typeof signer.getPublicKey === "function" && typeof signer.signEvent === "function";
    });
  }

  function post(payload: Record<string, unknown>, token = bridgeState.token) {
    window.postMessage(
      {
        source: SRC_OUT,
        bridgeToken: token,
        ...payload,
      },
      "*",
    );
  }

  if (bridgeState.installed) {
    post({ type: READY_TYPE });
    return;
  }

  bridgeState.installed = true;

  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data) {
      return;
    }

    const data = event.data;
    if (data.source !== SRC_IN || data.type !== REQUEST_TYPE || data.bridgeToken !== bridgeState.token) {
      return;
    }

    const { id, method, params } = data;

    try {
      if (!allowedMethods.has(method)) {
        throw new Error(`Blocked signer method: ${String(method)}`);
      }

      const candidate = getSignerCandidate();
      if (!candidate) {
        if (method === "getSignerInfo") {
          post({
            type: RESPONSE_TYPE,
            id,
            ok: true,
            result: {
              available: false,
              providerName: "No signer",
              source: "none",
            },
          });
          return;
        }

        throw new Error("No compatible NIP-07 signer was found in this page.");
      }

      const signer = candidate.signer as {
        getPublicKey: () => Promise<string>;
        signEvent: (event: unknown) => Promise<unknown>;
        getRelays?: () => Promise<unknown>;
      };

      let result: unknown;
      if (method === "getSignerInfo") {
        result = {
          available: true,
          providerName: candidate.providerName,
          source: candidate.source,
        };
      } else if (method === "getPublicKey") {
        result = await signer.getPublicKey();
      } else if (method === "getRelays") {
        if (typeof signer.getRelays !== "function") {
          throw new Error("Signer does not expose getRelays.");
        }
        result = await signer.getRelays();
      } else {
        result = await signer.signEvent(Array.isArray(params) ? params[0] : params);
      }

      post({
        type: RESPONSE_TYPE,
        id,
        ok: true,
        result,
      }, data.bridgeToken);
    } catch (error) {
      post({
        type: RESPONSE_TYPE,
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }, data.bridgeToken);
    }
  });

  post({ type: READY_TYPE });
})();
