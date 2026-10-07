// Masky (masky.ai) client for the Jev-speaks share window, built on the
// avatar-speak generation API: POST /avatars/{id}/speak renders any
// creator's avatar speaking a line, charged to the CALLER's credits —
// that's the mask-marketplace deal: the HUD user pays, the avatar's
// creator earns their share. Auth is the user's own token: an mky_ API
// key pasted in settings, or one issued by the Login-with-Masky OAuth
// flow (scope `generate`).
const BASE = "https://masky.ai/api";

// Server truth (utils/pricing.js + avatarSpeak.js on masky.ai): speech is
// estimated at 15 chars/second and talking-head video bills flat + per
// second. Used to turn a credit balance into "minutes of Jev talking".
const PRICING = {
  maxChars: 500, // MAX_INPUT_CHARS server-side
  charsPerSecond: 15,
  textFlat: 0.001,
  videoPerSecond: 0.0265, // TALKING_HEAD_PER_SEC + AUDIO_PER_SEC
};

class MaskyError extends Error {
  constructor(message, { status, code, availableCredits, requiredCredits } = {}) {
    super(message);
    this.name = "MaskyError";
    this.status = status;
    this.availableCredits = availableCredits;
    this.requiredCredits = requiredCredits;
    this.code =
      code ||
      (status === 402
        ? "insufficient_credits"
        : status === 401 || status === 403
          ? "bad_token"
          : "masky_error");
  }
}

/** One speak call renders one clip; clamp a chat line to the server max. */
function speakableLine(text) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (clean.length <= PRICING.maxChars) return clean;
  return clean.slice(0, PRICING.maxChars - 1).trimEnd() + "…";
}

/** Credits one reading of `line` costs (server's turnCost formula). */
function lineCost(line) {
  const seconds = Math.max(1, Math.round(line.length / PRICING.charsPerSecond));
  return PRICING.textFlat + PRICING.videoPerSecond * seconds;
}

/** Whole minutes of talking video a credit balance can still buy. */
function talkingMinutes(balance) {
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  return Math.floor(balance / (PRICING.videoPerSecond * 60));
}

class MaskyClient {
  constructor({ fetchImpl } = {}) {
    this.fetch = fetchImpl || fetch;
  }

  async request(method, path, { token, body } = {}) {
    const res = await this.fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new MaskyError(data.error || data.message || `masky ${res.status}`, {
        status: res.status,
        availableCredits: data.availableCredits,
        requiredCredits: data.requiredCredits,
      });
    }
    return data;
  }

  /**
   * The caller's credit balance on the avatar owner's page (their spendable
   * credits for this creator: creator-specific donations + global credits).
   * Requires masky.ai's GET /credits endpoint; returns null where the API
   * doesn't support it yet so callers degrade to estimate-free UI.
   */
  async balance(token, ownerUserId) {
    try {
      const data = await this.request(
        "GET",
        `/credits?owner=${encodeURIComponent(ownerUserId || "")}`,
        { token },
      );
      const n = Number(data.pageBalance ?? data.credits ?? data.balance);
      return Number.isFinite(n) ? n : null;
    } catch (err) {
      if (err.status === 404) return null; // endpoint not deployed yet
      throw err;
    }
  }

  /** Avatars the token's account owns (for the own-avatar picker). */
  async listAvatars(token) {
    const data = await this.request("GET", "/avatars", { token });
    const list = Array.isArray(data) ? data : data.avatars || [];
    return list.map((a) => ({
      avatarId: a.avatarId || a.id,
      ownerUserId: a.avatarOwnerUserId || a.ownerUserId,
      name: a.displayName || a.avatarName || a.avatarId,
    }));
  }

  /**
   * Render the avatar speaking `text` verbatim. Resolves to
   * {url, line, creditsCharged} with a signed video URL (~1h TTL — play it
   * promptly, don't store it).
   */
  async speak({ token, ownerUserId, avatarId, text, quality }) {
    const line = speakableLine(text);
    const created = await this.request("POST", `/avatars/${encodeURIComponent(avatarId)}/speak`, {
      token,
      body: {
        text: line,
        textMode: "literal",
        output: "video",
        avatarOwnerUserId: ownerUserId,
        ...(quality ? { quality } : {}),
      },
    });
    // Sync completion (rare: Lambda self-invoke unavailable) returns the
    // finished generation inline; the normal 202 hands back an id to poll.
    let generation = created.generation || null;
    if (!generation || generation.status === "pending" || !generation.videoUrl) {
      generation = await this.waitForVideo(token, created.generationId || generation?.generationId);
    }
    return {
      url: generation.videoUrl,
      line,
      creditsCharged: generation.creditsCharged ?? null,
    };
  }

  /** Poll the generation until its video is rendered (status → video). */
  async waitForVideo(token, generationId, { timeoutMs = 300000, everyMs = 3000 } = {}) {
    if (!generationId) throw new MaskyError("speak returned no generationId");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, everyMs));
      const data = await this.request("GET", `/avatars/speak/${generationId}`, { token });
      const gen = data.generation || data;
      if (gen.status === "error") {
        throw new MaskyError(gen.error || gen.videoError || "render failed");
      }
      if (gen.videoUrl) return gen;
      // status pending → audio → video; keep waiting through intermediates
    }
    throw new MaskyError("render timed out waiting for video");
  }
}

module.exports = { MaskyClient, MaskyError, speakableLine, lineCost, talkingMinutes, PRICING };
