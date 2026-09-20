// Persistent app config: TypeSafe key, UI prefs, and ingestion profiles.
// One JSON file in Electron's userData dir; writes are atomic (tmp + rename).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULTS = {
  typesafeApiKey: "",
  model: "jev-latest",
  relevancyThreshold: 55, // 0-100; messages scoring below are hidden in curated view
  kindFilter: [], // selected message kinds; non-empty replaces the relevancy filter
  seeAll: false,
  appearance: {
    fontFamily: "system", // key into the renderer's font map
    fontSize: 13, // px, chat feed only
    density: "cozy", // cozy | compact row spacing
    timestamps: false, // show HH:MM per message
  },
  alwaysOnTop: false,
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
