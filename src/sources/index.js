// Source manager: starts/stops every ingestion source of the active profile.
// Switching profiles tears down all running streams before opening new ones.
const twitch = require("./twitch");
const discord = require("./discord");
const youtube = require("./youtube");
const facebook = require("./facebook");

const ADAPTERS = { twitch, discord, youtube, facebook };

class SourceManager {
  constructor({ onMessage, onStatus }) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.stops = []; // stop() fns of running sources
    this.activeProfileId = null;
  }

  /** Stop every running source, then start the given profile's sources. */
  activate(profile) {
    this.stopAll();
    if (!profile) return;
    this.activeProfileId = profile.id;
    for (const source of profile.sources || []) {
      const adapter = ADAPTERS[source.type];
      if (!adapter) {
        this.onStatus({ state: "error", label: source.type, detail: "unknown source type" });
        continue;
      }
      try {
        const stop = adapter.start(source, {
          onMessage: (msg) => this.onMessage({ ...msg, profileId: profile.id, sourceId: source.id }),
          onStatus: (status) => this.onStatus({ ...status, sourceId: source.id }),
        });
        this.stops.push(stop);
      } catch (err) {
        this.onStatus({ state: "error", label: source.type, sourceId: source.id, detail: String(err.message || err) });
      }
    }
  }

  stopAll() {
    for (const stop of this.stops) {
      try {
        stop();
      } catch {
        // a source failing to stop must not block the rest
      }
    }
    this.stops = [];
    this.activeProfileId = null;
  }
}

module.exports = { SourceManager, ADAPTERS };
