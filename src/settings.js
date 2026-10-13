// Persistent app config: TypeSafe key, UI prefs, and ingestion profiles.
// One JSON file in Electron's userData dir; writes are atomic (tmp + rename).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULTS = {
  typesafeApiKey: "",
  model: "jev-latest",
  jevFiltering: true, // the Jev Judge toggle; false = raw firehose, filters hidden
  relevancyThreshold: 55, // 0-100; messages scoring below are hidden in curated view
  safetyThreshold: 0, // 0-100 over Jev's safety score (manipulation lens); 0 = no constraint
  // When the safety slider blocks a message, reply to it in chat (as the
  // logged-in Twitch account) naming the detected fallacy / manipulation.
  judgementReplies: false,
  kindFilter: [], // selected message kinds; non-empty replaces the slider filters
  mic: {
    enabled: false, // listen to the streamer's mic for judging context
    deviceId: "", // renderer mediaDevices deviceId; "" = system default
    label: "", // display label of the picked device (deviceIds are opaque)
  },
  // "Jev speaks": the OBS-shareable window where the avatar reads the most
  // relevant message on a cadence, rendered with the USER's Masky credits.
  speaker: {
    enabled: false,
    intervalMin: 1, // minutes between readings: 1 | 5 | 10
    maskyToken: "", // user's mky_ key (pasted or issued by Login with Masky)
    maskyAccountName: "", // display label of the connected identity
    maskyAccountPicture: "", // avatar image URL of the connected identity
    avatarOwnerUserId: "twitch:11867613", // Jev Judge's creator (default avatar)
    avatarId: "Ev1WizD5smJnxHWJXEHZ", // the Jev Judge avatar
    useOwnAvatar: false, // advanced: render one of the user's own avatars
    avatarImageUrl: "", // pinned still for the own avatar ("" = the avatar's primary image)
    audioOnly: false, // render voice only (cheaper) and never show the share window
    videoQuality: "high", // avatar video renders: "high" (best, slower) | "medium" (fast, good for live chat)
    speakLatest: false, // continuous mode: read the newest message as soon as the last reading ends
    readUserAvatars: false, // chatters who exist on Masky with a voiced avatar read their own messages
    chroma: false, // solid green idle background for OBS chroma key
    clickThrough: false, // share window never grabs the mouse; clicks fall through
    shareBounds: null, // last {x,y,width,height} of the share window
    // "Always on" (Manage identity): the stream-identity avatar stays on
    // screen in its own square and speaks what the mic hears, sentence by
    // sentence, rendered via Masky avatar-speak with the user's credits.
    alwaysOn: false,
    alwaysOnPersonality: false, // speak reinterprets lines via the avatar's personality
    alwaysOnAvatar: null, // resolved pick {avatarId, ownerUserId, name, imageUrl}
    avatarBounds: null, // last {x,y,width,height} of the always-on avatar square
  },
  appearance: {
    fontFamily: "system", // key into the renderer's font map
    fontSize: 13, // px, chat feed only
    density: "cozy", // cozy | compact row spacing
    timestamps: false, // show HH:MM per message
  },
  alwaysOnTop: false,
  windowBounds: null, // last {x,y,width,height} of the HUD window; null = first launch
  // Twitch account used to SEND chat from the composer. Separate from the
  // Masky token (that one pays for renders and stores stream identity).
  twitch: {
    accessToken: "",
    login: "",
    displayName: "",
    userId: "",
    profileImageUrl: "",
  },
  activeProfileId: null,
  profiles: [],
};

class Settings {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, "config.json");
    this.data = { ...DEFAULTS };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.data = { ...DEFAULTS, ...raw };
      this.data.appearance = { ...DEFAULTS.appearance, ...(raw.appearance || {}) };
      this.data.mic = { ...DEFAULTS.mic, ...(raw.mic || {}) };
      this.data.speaker = { ...DEFAULTS.speaker, ...(raw.speaker || {}) };
      this.data.twitch = { ...DEFAULTS.twitch, ...(raw.twitch || {}) };
      // v0.5 → v0.6: "see all" became the Jev Judge toggle (inverted).
      if (!("jevFiltering" in raw) && "seeAll" in raw) this.data.jevFiltering = !raw.seeAll;
      // v0.6 → v0.7: the factual slider became the safety slider. The two
      // measure different things (asserts-something-checkable vs
      // manipulation), so an old factual position does NOT carry over — the
      // safety slider starts at 0 (no constraint), which only ever shows
      // more, never silently hides messages under a repurposed threshold.
      delete this.data.seeAll;
      delete this.data.factsOnly;
      delete this.data.factualThreshold;
    } catch {
      // first run or unreadable file: start from defaults
    }
  }

  save() {
    const tmp = this.file + ".tmp";
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get() {
    return this.data;
  }

  update(patch) {
    for (const key of Object.keys(patch)) {
      if (key in DEFAULTS) this.data[key] = patch[key];
    }
    this.save();
    return this.data;
  }

  /**
   * Upsert a profile. A profile groups any number of chat sources under one
   * name plus the stream context Jev judges against:
   * { id, name, context, sources: [{ id, type, ...params }] }
   */
  saveProfile(profile) {
    if (!profile.id) profile.id = crypto.randomUUID();
    profile.sources = (profile.sources || []).map((s) => ({
      id: s.id || crypto.randomUUID(),
      ...s,
    }));
    const i = this.data.profiles.findIndex((p) => p.id === profile.id);
    if (i >= 0) this.data.profiles[i] = profile;
    else this.data.profiles.push(profile);
    this.save();
    return profile;
  }

  deleteProfile(id) {
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
    if (this.data.activeProfileId === id) this.data.activeProfileId = null;
    this.save();
  }

  profile(id) {
    return this.data.profiles.find((p) => p.id === id) || null;
  }
}

module.exports = { Settings, DEFAULTS };
