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
  audioPerSecond: 0.0015, // AUDIO_PER_SEC alone (output:"audio" readings)
};

// Render tiers for video readings. The streamer pays, so the streamer picks:
// "high" is the slow best-quality renderer, "medium" trades some fidelity for
// much faster turnaround (better for live chat). Server-side both tiers bill
// the same flat per-second speech rate today; the per-tier field exists so
// the settings UI always quotes whatever the rate becomes.
const QUALITY_TIERS = [
  { id: "high", perSecond: PRICING.videoPerSecond },
  { id: "medium", perSecond: PRICING.videoPerSecond },
];

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

/** Whole minutes of talking a credit balance can still buy ("video" | "audio"). */
function talkingMinutes(balance, output = "video") {
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  const perSecond = output === "audio" ? PRICING.audioPerSecond : PRICING.videoPerSecond;
  return Math.floor(balance / (perSecond * 60));
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
   * The identity behind an OAuth-issued token: {name, picture}. Pasted raw
   * mky_ keys are not OAuth-sourced, so /oauth/userinfo rejects them — then
   * resolve null and the UI shows a generic connected state.
   */
  async userinfo(token) {
    try {
      const data = await this.request("GET", "/oauth/userinfo", { token });
      return { name: data.name || "", picture: data.picture || "" };
    } catch {
      return null;
    }
  }

  /**
   * Render the avatar speaking `text` verbatim. Resolves to
   * {url, line, creditsCharged} with a signed URL (~1h TTL — play it
   * promptly, don't store it). `output` "video" (default, talking head) or
   * "audio" (voice only — ~18x cheaper per second server-side).
   * `avatarImageUrl` pins the render to one of the avatar's stills (a
   * chatter's chosen stream-identity image); the server 400s if the still
   * no longer belongs to the avatar, so a stale pick retries unpinned
   * rather than losing the reading.
   */
  async speak(opts) {
    try {
      return await this.speakOnce(opts);
    } catch (err) {
      if (opts.avatarImageUrl && err instanceof MaskyError && err.status === 400) {
        return this.speakOnce({ ...opts, avatarImageUrl: null });
      }
      throw err;
    }
  }

  async speakOnce({ token, ownerUserId, avatarId, text, quality, output, avatarImageUrl }) {
    const line = speakableLine(text);
    const want = output === "audio" ? "audioUrl" : "videoUrl";
    const created = await this.request("POST", `/avatars/${encodeURIComponent(avatarId)}/speak`, {
      token,
      body: {
        text: line,
        textMode: "literal",
        output: output === "audio" ? "audio" : "video",
        avatarOwnerUserId: ownerUserId,
        ...(quality ? { quality } : {}),
        ...(avatarImageUrl ? { avatarImageUrl } : {}),
      },
    });
    // Sync completion (rare: Lambda self-invoke unavailable) returns the
    // finished generation inline; the normal 202 hands back an id to poll.
    let generation = created.generation || null;
    if (!generation || generation.status === "pending" || !generation[want]) {
      generation = await this.waitForResult(token, created.generationId || generation?.generationId, want);
    }
    return {
      url: generation[want],
      line,
      creditsCharged: generation.creditsCharged ?? null,
    };
  }

  /**
   * Poll the generation until the wanted media URL is rendered. The charge
   * lands when the render is requested, so giving up early throws away a
   * paid clip — the deadline is a last-resort backstop, generous enough
   * that even the slowest high-quality render of a max-length line lands.
   */
  async waitForResult(token, generationId, want = "videoUrl", { timeoutMs = 900000, everyMs = 3000 } = {}) {
    if (!generationId) throw new MaskyError("speak returned no generationId");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, everyMs));
      const data = await this.request("GET", `/avatars/speak/${generationId}`, { token });
      const gen = data.generation || data;
      if (gen.status === "error") {
        throw new MaskyError(gen.error || gen.videoError || "render failed");
      }
      if (gen[want]) return gen;
      // status pending → audio → video; keep waiting through intermediates
    }
    throw new MaskyError(`render timed out waiting for ${want === "audioUrl" ? "audio" : "video"}`);
  }

  /**
   * Resolve a chat username to that person's own speakable Masky avatar:
   * GET /avatars/lookup matches uid → Masky handle → Twitch username and
   * returns their self-avatar plus any publicly renderable ones. Picks the
   * best voice-ready avatar (self-avatar first — it *is* the person), or
   * null when the user isn't on Masky, has no voiced avatar, or the
   * endpoint isn't deployed yet (404).
   */
  async lookupUserAvatar(token, username) {
    const user = String(username || "").trim().toLowerCase();
    if (!user) return null;
    let data;
    try {
      data = await this.request("GET", `/avatars/lookup?user=${encodeURIComponent(user)}`, { token });
    } catch (err) {
      if (err.status === 404) return null; // endpoint not deployed yet
      throw err;
    }
    if (!data.found) return null;
    const voiced = (data.avatars || []).filter((a) => a.voiceId || a.humeVoiceId);
    if (!voiced.length) return null;
    // A stream identity is the user's explicit "render me as this on
    // streams" choice (set via masky.ai), so it outranks the self-avatar.
    const pick =
      voiced.find((a) => a.isStreamDefault) ||
      voiced.find((a) => a.isDefaultAvatar) ||
      voiced[0];
    return {
      ownerUserId: pick.avatarOwnerUserId,
      avatarId: pick.avatarId,
      name: pick.displayName || user,
      imageUrl: (pick.isStreamDefault && pick.streamImageUrl) || null,
    };
  }

  /**
   * The slug of the connected account's masky.ai page, for building
   * /{slug}/admin links. Mirrors the site's resolver order (handle →
   * twitchUsername → uid). Newer API responses carry a top-level `owner`
   * block even when the account has zero avatars; older ones only expose
   * owner fields on each avatar. Returns null when nothing resolves.
   */
  async ownerSlug(token) {
    const data = await this.request("GET", "/avatars", { token });
    const owner = data.owner || {};
    const first = (Array.isArray(data) ? data : data.avatars || [])[0] || {};
    return (
      owner.username ||
      owner.twitchUsername ||
      first.avatarOwnerTwitchUsername ||
      owner.userId ||
      first.avatarOwnerUserId ||
      null
    );
  }
}

module.exports = { MaskyClient, MaskyError, speakableLine, lineCost, talkingMinutes, PRICING, QUALITY_TIERS };
