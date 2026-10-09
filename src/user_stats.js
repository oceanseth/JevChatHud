// Per-user profiling store: every message and judgment observed feeds a
// per-user record keyed by platform + username, persisted across sessions in
// one JSON file (atomic tmp + rename, debounced). This is the substrate for
// the user profile popup today and for Big 5 / stylometry correlation later —
// which is why a small sample of raw messages is retained per user.
const fs = require("fs");
const path = require("path");

const SAVE_DEBOUNCE_MS = 3000;
const MAX_USERS = 20000; // evict least-recently-seen beyond this
const MAX_SAMPLES = 10; // recent raw messages kept per user (future stylometry)

function userKey(platform, name) {
  return `${platform}:${String(name || "").toLowerCase()}`;
}

class UserStats {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, "user-stats.json");
    this.users = {};
    this.timer = null;
    try {
      this.users = JSON.parse(fs.readFileSync(this.file, "utf8")).users || {};
    } catch {
      // first run or unreadable file: start empty
    }
  }

  recordMessage(msg) {
    const key = userKey(msg.source.type, msg.user.name);
    const ts = msg.ts || Date.now();
    let u = this.users[key];
    if (!u) {
      u = this.users[key] = {
        platform: msg.source.type,
        name: msg.user.name,
        firstSeenTs: ts,
        lastSeenTs: ts,
        messages: 0,
        judged: 0,
        reads: 0,
        relevancySum: 0,
        kinds: {},
        samples: [],
      };
      this.evictIfNeeded();
    }
    u.name = msg.user.name; // keep display casing current
    if (msg.user.color) u.color = msg.user.color;
    u.lastSeenTs = Math.max(u.lastSeenTs, ts);
    u.messages++;
    u.samples.push({ ts, text: String(msg.text).slice(0, 500) });
    if (u.samples.length > MAX_SAMPLES) u.samples.shift();
    this.scheduleSave();
  }

  recordJudgment(msg, judgment) {
    if (!judgment) return;
    const u = this.users[userKey(msg.source.type, msg.user.name)];
    if (!u) return;
    u.judged++;
    u.relevancySum += judgment.relevancy;
    u.kinds[judgment.kind] = (u.kinds[judgment.kind] || 0) + 1;
    this.scheduleSave();
  }

  /**
   * One of this user's messages won a reading window and was read aloud by
   * the avatar. Keyed the same way the speaker's pick carries it (platform =
   * msg.source.type, name = msg.user.name); the user always exists by now
   * because recordMessage ran when the message arrived.
   */
  recordRead(platform, name) {
    const u = this.users[userKey(platform, name)];
    if (!u) return;
    u.reads = (u.reads || 0) + 1;
    this.scheduleSave();
  }

  /**
   * Top chatters for the trophy popup. The default "reads" board ranks by
   * times the avatar read their message on stream; any judgment kind (toxic,
   * question, hype, …) ranks by that kind's count instead — the sentiment
   * leaderboards. Ties break toward the heavier chatter; zero-count users
   * are hidden.
   */
  leaderboard(limit = 20, category = "reads") {
    const count =
      category === "reads"
        ? (u) => u.reads || 0
        : (u) => (u.kinds && u.kinds[category]) || 0;
    return Object.values(this.users)
      .filter((u) => count(u) > 0)
      .sort((a, b) => count(b) - count(a) || b.messages - a.messages)
      .slice(0, limit)
      .map((u) => ({
        platform: u.platform,
        name: u.name,
        color: u.color || null,
        count: count(u),
        reads: u.reads || 0,
        messages: u.messages,
        avgRelevancy: u.judged ? Math.round(u.relevancySum / u.judged) : null,
      }));
  }

  /**
   * Profile for the popup: raw record plus derived averages. `kindPct[k]` is
   * the share of this user's judged messages classified as kind k — "how
   * toxic is this user on average" = kindPct.toxic.
   */
  get(platform, name) {
    const u = this.users[userKey(platform, name)];
    if (!u) return null;
    const kindPct = {};
    for (const [kind, count] of Object.entries(u.kinds)) {
      kindPct[kind] = Math.round((count / u.judged) * 100);
    }
    return {
      ...u,
      kindPct,
      reads: u.reads || 0, // records predating the reads counter
      avgRelevancy: u.judged ? Math.round(u.relevancySum / u.judged) : null,
    };
  }

  evictIfNeeded() {
    const keys = Object.keys(this.users);
    if (keys.length <= MAX_USERS) return;
    keys.sort((a, b) => this.users[a].lastSeenTs - this.users[b].lastSeenTs);
    for (const key of keys.slice(0, keys.length - MAX_USERS)) delete this.users[key];
  }

  scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, SAVE_DEBOUNCE_MS);
    // Don't let a pending save keep the app process alive on quit.
    this.timer.unref?.();
  }

  save() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = this.file + ".tmp";
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ users: this.users }));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { UserStats, userKey, MAX_SAMPLES, MAX_USERS };
