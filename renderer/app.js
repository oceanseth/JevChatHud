/* global hud, messageVisible, KINDS, KIND_CONFIDENCE_MIN */
const MAX_ROWS = 600;

const feed = document.getElementById("feed");
const profileSelect = document.getElementById("profile-select");
const relevancySlider = document.getElementById("relevancy");
const relevancyValue = document.getElementById("relevancy-value");
const factualSlider = document.getElementById("factual");
const factualValue = document.getElementById("factual-value");
const jevToggle = document.getElementById("jev-toggle");
const jevFace = document.getElementById("jev-face");
const jevVideo = document.getElementById("jev-video");
const micBtn = document.getElementById("mic-btn");
const micStatusEl = document.getElementById("mic-status");
const statusRow = document.getElementById("status-row");
const statsEl = document.getElementById("stats");
const judgeErrorEl = document.getElementById("judge-error");
const tagChipsEl = document.getElementById("tag-chips");
const emptyState = document.getElementById("empty-state");
const emptyTitle = document.getElementById("empty-title");
const emptyHint = document.getElementById("empty-hint");
const emptyAction = document.getElementById("empty-action");

let settings = null;
let editingProfile = null; // working copy inside the settings panel
const rows = new Map(); // message id -> row element
const sourceStates = new Map(); // sourceId -> {state, label}
const selectedKinds = new Set(); // active tag filters; empty = relevancy mode
const tagChips = new Map(); // kind -> {chip, count}

// ---------- feed ----------

function nearBottom() {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
}

function relClass(rel) {
  if (rel >= 70) return "high";
  if (rel >= 40) return "mid";
  return "low";
}

function applyFilter(row) {
  const visible = messageVisible(row._judgment, {
    filtering: jevFiltering,
    kinds: [...selectedKinds],
    relevancyMin: Number(relevancySlider.value),
    factualMin: Number(factualSlider.value),
  });
  row.classList.toggle("hidden-by-filter", !visible);
  if (visible) checkClamp(row);
}

// Long messages (spam walls) clamp to 3 lines; click the text or the chip to
// expand. Measured once per row, deferred until the row is actually visible.
function checkClamp(row) {
  if (row._clampChecked || !row._body || !row._body.clientHeight) return;
  row._clampChecked = true;
  if (row._body.scrollHeight > row._body.clientHeight + 2) row.classList.add("clampable");
}

function toggleExpanded(row) {
  if (!row.classList.contains("clampable")) return;
  const on = row.classList.toggle("expanded");
  row._expandChip.textContent = on ? "⌃ less" : "⌄ more";
}

function refilterAll() {
  for (const row of rows.values()) applyFilter(row);
}

let emoteByName = new Map();
let emoteGroups = [];

function fillMessageText(el, msg) {
  el.replaceChildren();
  // A translated message renders main's emote-preserving segments instead of
  // retokenizing; the marker's tooltip keeps the original text reachable.
  const tr = msg.translation;
  if (tr?.segments?.length) {
    const mark = document.createElement("span");
    mark.className = "trans-mark";
    mark.textContent = `⇄${tr.src}`;
    mark.title = `Translated ${tr.src} → ${tr.tgt}\nOriginal: ${msg.text}`;
    el.append(mark);
  }
  const segments = tr?.segments?.length ? tr.segments : tokenizeMessage(msg.text, msg.emotes, emoteByName);
  for (const seg of segments) {
    if (seg.type === "emote") {
      const img = document.createElement("img");
      img.className = "emote";
      img.src = seg.url;
      img.alt = seg.name;
      img.title = seg.name;
      img.referrerPolicy = "no-referrer";
      img.decoding = "async";
      img.addEventListener("error", () => img.replaceWith(document.createTextNode(seg.name)));
      el.append(img);
    } else {
      el.append(document.createTextNode(seg.text));
    }
  }
}

function applyEmoteCatalog(catalog) {
  emoteGroups = catalog?.groups || [];
  emoteByName = nameMapFromGroups(emoteGroups);
  for (const row of rows.values()) {
    if (!row._msg || !row._text) continue;
    fillMessageText(row._text, row._msg);
    row._clampChecked = false;
    row.classList.remove("clampable", "expanded");
    applyFilter(row);
  }
  const pop = document.getElementById("emote-pop");
  if (pop && !pop.classList.contains("hidden")) renderEmotePicker();
}

function addMessage(msg) {
  const stick = nearBottom();
  const row = document.createElement("div");
  row.className = "msg dim"; // dim until judged
  row._judgment = null;

  const srcChip = document.createElement("span");
  srcChip.className = `chip src-${msg.source.type}`;
  srcChip.textContent = msg.source.type;
  srcChip.title = msg.source.label;

  const time = document.createElement("span");
  time.className = "time";
  time.textContent = new Date(msg.ts || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const body = document.createElement("span");
  body.className = "body";
  const user = document.createElement("span");
  user.className = "user";
  user.textContent = msg.user.name;
  user.title = `profile ${msg.user.name}`;
  if (msg.user.color) user.style.color = msg.user.color;
  user.addEventListener("click", () => openUserProfile(msg.source.type, msg.user));
  row._userRef = { platform: msg.source.type, name: msg.user.name };
  const text = document.createElement("span");
  text.className = "text";
  fillMessageText(text, msg);
  text.addEventListener("click", () => toggleExpanded(row));
  body.append(user, text);
  row._msg = msg;
  row._text = text;

  const badges = document.createElement("span");
  badges.className = "badges";
  const relChip = document.createElement("span");
  relChip.className = "chip rel pending";
  relChip.textContent = "…";
  const expandChip = document.createElement("span");
  expandChip.className = "chip expand";
  expandChip.textContent = "⌄ more";
  expandChip.title = "message truncated — click to expand";
  expandChip.addEventListener("click", () => toggleExpanded(row));
  badges.append(relChip, expandChip);

  row.append(time, srcChip, body, badges);
  row._relChip = relChip;
  row._badges = badges;
  row._body = body;
  row._expandChip = expandChip;

  rows.set(msg.id, row);
  feed.append(row);
  applyFilter(row);
  refreshUserProfileIf(row._userRef);
  updateEmptyState();

  let evicted = false;
  while (feed.children.length > MAX_ROWS) {
    const victim = feed.firstElementChild;
    for (const [id, el] of rows) if (el === victim) rows.delete(id);
    victim.remove();
    evicted = true;
  }
  if (evicted) renderTagCounts();
  if (stick) feed.scrollTop = feed.scrollHeight;
}

// With only the relevancy slider in play the chip is a bare relevancy score.
// Once the factual slider is active the chip shows the BINDING dimension —
// the score with the least headroom above its slider, i.e. the number that
// explains why this row is in or out — letter-prefixed (r57 / f92) so the two
// dimensions can't be confused. The tooltip always carries both.
function renderScoreChip(row) {
  const j = row._judgment;
  if (!j) return;
  const factualMin = Number(factualSlider.value);
  let text = String(j.relevancy);
  let cls = relClass(j.relevancy);
  if (factualMin > 0) {
    const relMargin = j.relevancy - Number(relevancySlider.value);
    // A legacy judgment with no factuality fails any factual threshold.
    const factMargin = (j.factuality == null ? -101 : j.factuality) - factualMin;
    if (factMargin < relMargin) {
      text = j.factuality == null ? "f?" : `f${j.factuality}`;
      cls = j.factuality == null ? "pending" : relClass(j.factuality);
    } else {
      text = `r${j.relevancy}`;
    }
  }
  row._relChip.textContent = text;
  row._relChip.className = `chip rel ${cls}`;
  const rel = `relevancy ${j.relevancy}/100 (confidence ${j.relevanceConfidence.toFixed(2)})`;
  const fact =
    j.factuality == null
      ? "no factuality score — judged by an older build"
      : `factual ${j.factuality}/100 (confidence ${j.factualConfidence.toFixed(2)})`;
  row._relChip.title = `${rel} · ${fact}`;
}

function markJudged({ id, judgment }) {
  const row = rows.get(id);
  if (!row) return;
  const stick = nearBottom();
  if (!judgment) {
    // judge unavailable (no key / API error): leave unscored, visible in see-all
    row._relChip.textContent = "?";
    row._relChip.className = "chip rel pending";
    row._relChip.title = "not judged (see status bar)";
  } else {
    row.classList.remove("dim");
    row._judgment = judgment;
    renderScoreChip(row);

    const kindChip = document.createElement("span");
    kindChip.className = `chip kind-${judgment.kind}`;
    kindChip.textContent = judgment.kind.replace("_", " ");
    kindChip.title = `confidence ${judgment.kindConfidence.toFixed(2)}`;
    row._badges.append(kindChip);
    renderTagCounts();
  }
  applyFilter(row);
  refreshUserProfileIf(row._userRef);
  if (stick) feed.scrollTop = feed.scrollHeight;
}

// ---------- user profile popup ----------

const userOverlay = document.getElementById("user-overlay");
const userAvatar = document.getElementById("user-avatar");
const userCardName = document.getElementById("user-card-name");
const userCardPlatform = document.getElementById("user-card-platform");
const userObserved = document.getElementById("user-observed");
const userKinds = document.getElementById("user-kinds");
const userBig5 = document.getElementById("user-big5");

const BIG5_TRAITS = ["Openness", "Conscientiousness", "Extraversion", "Agreeableness", "Neuroticism"];
let openUser = null; // {platform, name} while the popup is showing

function relTime(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function statCell(label, value, detail) {
  const cell = document.createElement("div");
  cell.className = "stat";
  const v = document.createElement("div");
  v.className = "stat-value";
  v.textContent = value;
  const l = document.createElement("div");
  l.className = "stat-label";
  l.textContent = label;
  cell.append(v, l);
  if (detail) v.title = detail;
  return cell;
}

function traitRow(label, pct, { kindClass = "", count = null } = {}) {
  const row = document.createElement("div");
  row.className = `trait-row ${kindClass}`;
  const name = document.createElement("span");
  name.className = "trait-name";
  name.textContent = label;
  const bar = document.createElement("span");
  bar.className = "trait-bar";
  const fill = document.createElement("span");
  fill.className = "trait-fill";
  fill.style.width = pct == null ? "0" : `${pct}%`;
  bar.append(fill);
  const value = document.createElement("span");
  value.className = "trait-value";
  value.textContent = pct == null ? "—" : `${pct}%`;
  if (count) value.title = `${count} message${count === 1 ? "" : "s"}`;
  row.append(name, bar, value);
  return row;
}

function renderUserProfile(profile) {
  userCardName.textContent = profile.name;
  if (profile.color) userCardName.style.color = profile.color;
  else userCardName.style.removeProperty("color");
  userCardPlatform.className = `chip src-${profile.platform}`;
  userCardPlatform.textContent = profile.platform;
  userAvatar.textContent = (profile.name[0] || "?").toUpperCase();
  userAvatar.style.background = profile.color || "var(--accent)";

  userObserved.replaceChildren(
    statCell("first seen", relTime(profile.firstSeenTs), new Date(profile.firstSeenTs).toLocaleString()),
    statCell("messages", String(profile.messages)),
    statCell("judged", String(profile.judged)),
    statCell("avg relevancy", profile.avgRelevancy == null ? "—" : String(profile.avgRelevancy)),
    statCell("🏆 read on stream", String(profile.reads || 0), "times Jev judged this user's message most relevant and read it aloud")
  );
  const firstSeen = userObserved.firstElementChild.querySelector(".stat-label");
  firstSeen.textContent = `first seen · ${new Date(profile.firstSeenTs).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  })}`;

  userKinds.replaceChildren(
    ...KINDS.map((kind) =>
      traitRow(kind.replace("_", " "), profile.judged ? profile.kindPct[kind] || 0 : null, {
        kindClass: `kind-${kind}`,
        count: profile.kinds[kind] || 0,
      })
    )
  );

  userBig5.replaceChildren(...BIG5_TRAITS.map((t) => traitRow(t, null)));
}

async function openUserProfile(platform, user) {
  const profile = (await hud.getUserProfile(platform, user.name)) || {
    // The store lags the feed by nothing in practice, but never show a dead popup.
    platform,
    name: user.name,
    color: user.color,
    firstSeenTs: Date.now(),
    messages: 1,
    judged: 0,
    reads: 0,
    relevancySum: 0,
    kinds: {},
    kindPct: {},
    avgRelevancy: null,
  };
  openUser = { platform, name: user.name };
  renderUserProfile(profile);
  userOverlay.classList.remove("hidden");
}

function closeUserProfile() {
  openUser = null;
  userOverlay.classList.add("hidden");
}

// Keep an open popup live as its user keeps chatting / getting judged.
async function refreshUserProfileIf(ref) {
  if (!openUser || !ref) return;
  if (ref.platform !== openUser.platform || ref.name.toLowerCase() !== openUser.name.toLowerCase()) return;
  const profile = await hud.getUserProfile(openUser.platform, openUser.name);
  if (profile && openUser) renderUserProfile(profile);
}

document.getElementById("user-card-close").addEventListener("click", closeUserProfile);
userOverlay.addEventListener("click", (e) => {
  if (e.target === userOverlay) closeUserProfile();
});

// ---------- reading leaderboard (trophy button) ----------

const leaderboardOverlay = document.getElementById("leaderboard-overlay");
const leaderboardRows = document.getElementById("leaderboard-rows");
const leaderboardEmpty = document.getElementById("leaderboard-empty");
const leaderboardBg = document.getElementById("leaderboard-bg");
const leaderboardTabs = document.getElementById("leaderboard-tabs");
const leaderboardTitleText = document.getElementById("leaderboard-title-text");
const leaderboardSubtitle = document.getElementById("leaderboard-subtitle");
const leaderboardTrophy = document.getElementById("leaderboard-trophy");

// One tab per board: the main reads board plus every judgment kind. `id`
// matches the UserStats category; the art lives at assets/leaderboard/<id>.jpg.
const LB_TABS = [
  { id: "reads", emoji: "🏆", label: "Read", title: "Reading leaderboard", subtitle: "times Jev read a chatter's message on stream", empty: 'No readings yet. When "Jev speaks" is on, the most relevant message each interval gets read aloud — its author scores a trophy here.' },
  { id: "toxic", emoji: "☠️", label: "Toxic", title: "Most toxic", subtitle: "messages judged insults, harassment, spam, or bait", empty: "No toxic messages judged yet. A rare win for humanity." },
  { id: "question", emoji: "❓", label: "Questions", title: "Most questioning", subtitle: "direct questions aimed at the streamer", empty: "No questions judged yet." },
  { id: "stream_issue", emoji: "🛠️", label: "Issues", title: "Stream watchdogs", subtitle: "reports of stream problems: no audio, lag, frozen video", empty: "No stream issues reported yet. Suspiciously smooth." },
  { id: "feedback", emoji: "💡", label: "Feedback", title: "Most helpful", subtitle: "concrete feedback, suggestions, and useful info", empty: "No feedback judged yet." },
  { id: "personal", emoji: "💜", label: "Personal", title: "Most heartfelt", subtitle: "sharing something personal or emotionally significant", empty: "Nothing personal shared yet." },
  { id: "hype", emoji: "🔥", label: "Hype", title: "Hype squad", subtitle: "hype, praise, emotes, and generic reactions", empty: "No hype judged yet. Dead chat?" },
  { id: "chatter", emoji: "💬", label: "Chatter", title: "Chattiest", subtitle: "small talk and chatter aimed at other chatters", empty: "No chatter judged yet." },
];
let lbActiveTab = LB_TABS[0];

function buildLeaderboardTabs() {
  leaderboardTabs.replaceChildren(
    ...LB_TABS.map((tab) => {
      const btn = document.createElement("button");
      btn.className = "lb-tab";
      btn.dataset.tab = tab.id;
      btn.title = tab.title;
      const emoji = document.createElement("span");
      emoji.textContent = tab.emoji;
      const label = document.createElement("span");
      label.className = "lb-tab-label";
      label.textContent = tab.label;
      btn.append(emoji, label);
      btn.addEventListener("click", () => {
        if (lbActiveTab === tab) return;
        lbActiveTab = tab;
        renderLeaderboard();
      });
      return btn;
    })
  );
}
buildLeaderboardTabs();

async function renderLeaderboard() {
  const tab = lbActiveTab;
  leaderboardTrophy.textContent = tab.emoji;
  leaderboardTitleText.textContent = tab.title;
  leaderboardSubtitle.textContent = tab.subtitle;
  leaderboardBg.src = `assets/leaderboard/${tab.id}.jpg`;
  for (const btn of leaderboardTabs.children) {
    btn.classList.toggle("active", btn.dataset.tab === tab.id);
  }
  const entries = (await hud.getLeaderboard(tab.id)) || [];
  if (tab !== lbActiveTab) return; // user switched tabs while we fetched
  leaderboardEmpty.textContent = tab.empty;
  leaderboardEmpty.classList.toggle("hidden", entries.length > 0);
  leaderboardRows.replaceChildren(
    ...entries.map((u, i) => {
      const row = document.createElement("button");
      row.className = "lb-row";
      const msgs = `${u.messages} message${u.messages === 1 ? "" : "s"}`;
      const avg = u.avgRelevancy == null ? "" : ` · avg relevancy ${u.avgRelevancy}`;
      row.title = `${msgs}${avg} — click for profile`;
      const rank = document.createElement("span");
      rank.className = "lb-rank";
      rank.textContent = String(i + 1);
      const name = document.createElement("span");
      name.className = "lb-name";
      name.textContent = u.name;
      if (u.color) name.style.color = u.color;
      const chip = document.createElement("span");
      chip.className = `chip src-${u.platform}`;
      chip.textContent = u.platform;
      const count = document.createElement("span");
      count.className = "lb-count";
      count.textContent = `${u.count} ${tab.emoji}`;
      row.append(rank, name, chip, count);
      row.addEventListener("click", () => {
        closeLeaderboard();
        openUserProfile(u.platform, { name: u.name, color: u.color });
      });
      return row;
    })
  );
}

async function openLeaderboard() {
  await renderLeaderboard();
  leaderboardOverlay.classList.remove("hidden");
}

function closeLeaderboard() {
  leaderboardOverlay.classList.add("hidden");
}

document.getElementById("trophy-btn").addEventListener("click", openLeaderboard);
document.getElementById("leaderboard-close").addEventListener("click", closeLeaderboard);
leaderboardOverlay.addEventListener("click", (e) => {
  if (e.target === leaderboardOverlay) closeLeaderboard();
});

// ---------- tag filter bar ----------

function buildTagBar() {
  tagChipsEl.replaceChildren();
  tagChips.clear();
  for (const kind of KINDS) {
    const chip = document.createElement("button");
    chip.className = `tag-chip kind-${kind}`;
    chip.title = `only ${kind.replace("_", " ")} messages (Jev confidence >50%)`;
    const dot = document.createElement("span");
    dot.className = "dot";
    const label = document.createElement("span");
    label.textContent = kind.replace("_", " ");
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = "";
    chip.append(dot, label, count);
    chip.addEventListener("click", () => toggleKind(kind));
    tagChipsEl.append(chip);
    tagChips.set(kind, { chip, count });
  }
}

function renderTagCounts() {
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const row of rows.values()) {
    const j = row._judgment;
    if (j && j.kindConfidence > KIND_CONFIDENCE_MIN && j.kind in counts) counts[j.kind]++;
  }
  for (const [kind, { count }] of tagChips) {
    count.textContent = counts[kind] ? String(counts[kind]) : "";
  }
}

function syncFilterControls() {
  const tagsActive = selectedKinds.size > 0;
  for (const [kind, { chip }] of tagChips) {
    chip.classList.toggle("active", selectedKinds.has(kind));
  }
  // Communicate precedence: tags replace the sliders. (When Jev's eyes are
  // closed the whole filter stack is hidden, so no state to communicate.)
  const tip = tagsActive ? "tag filter active — clear tags to use the sliders" : "";
  for (const id of ["relevancy-label", "factual-label"]) {
    document.getElementById(id).classList.toggle("inactive", tagsActive);
  }
  relevancySlider.disabled = tagsActive;
  factualSlider.disabled = tagsActive;
  relevancySlider.title = tip;
  factualSlider.title = tip;
}

function setKinds(kinds) {
  selectedKinds.clear();
  for (const k of kinds) selectedKinds.add(k);
  hud.updateSettings({ kindFilter: [...selectedKinds] });
  syncFilterControls();
  refilterAll();
}

function toggleKind(kind) {
  const next = new Set(selectedKinds);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  setKinds(next);
}

document.getElementById("tags-all").addEventListener("click", () => setKinds(KINDS));
document.getElementById("tags-none").addEventListener("click", () => setKinds([]));

// ---------- status / stats ----------

function renderStatuses() {
  statusRow.replaceChildren();
  for (const { state, label, detail } of sourceStates.values()) {
    const el = document.createElement("span");
    el.className = "source-status";
    const dot = document.createElement("span");
    dot.className = `dot ${state}`;
    el.append(dot, document.createTextNode(label));
    if (detail) el.title = detail;
    statusRow.append(el);
  }
}

function renderStats(stats) {
  statsEl.textContent =
    `${stats.judged} judged · ${stats.requests} req · ` +
    `${(stats.inputTokens / 1000).toFixed(1)}k tok · $${stats.costUsd.toFixed(4)}`;
  judgeErrorEl.textContent = stats.lastError ? `⚠ ${stats.lastError}` : "";
  judgeErrorEl.title = stats.lastError || "";
}

// ---------- profiles (top bar) ----------

function renderProfileSelect() {
  profileSelect.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "no profile";
  profileSelect.append(none);
  for (const p of settings.profiles) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name || "(unnamed)";
    profileSelect.append(opt);
  }
  profileSelect.value = settings.activeProfileId || "";
}

function clearFeed() {
  rows.clear();
  feed.replaceChildren();
  sourceStates.clear();
  renderStatuses();
  renderTagCounts();
  updateEmptyState();
}

// ---------- appearance ----------

const FONT_STACKS = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  rounded: 'ui-rounded, "SF Pro Rounded", -apple-system, sans-serif',
  helvetica: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  avenir: '"Avenir Next", Avenir, "Segoe UI", sans-serif',
  georgia: 'Georgia, "Times New Roman", serif',
  menlo: 'Menlo, Consolas, ui-monospace, monospace',
};

const fontSelect = document.getElementById("appearance-font");
const densitySelect = document.getElementById("appearance-density");
const sizeSlider = document.getElementById("appearance-size");
const sizeValue = document.getElementById("appearance-size-value");
const timestampsCheck = document.getElementById("appearance-timestamps");

function applyAppearance(a) {
  document.documentElement.style.setProperty("--chat-font", FONT_STACKS[a.fontFamily] || FONT_STACKS.system);
  document.documentElement.style.setProperty("--chat-size", `${a.fontSize}px`);
  document.body.classList.toggle("compact", a.density === "compact");
  document.body.classList.toggle("show-timestamps", !!a.timestamps);
}

function readAppearanceControls() {
  return {
    fontFamily: fontSelect.value,
    fontSize: Number(sizeSlider.value),
    density: densitySelect.value,
    timestamps: timestampsCheck.checked,
  };
}

// Appearance applies live and persists immediately — no save button round-trip.
async function onAppearanceChange() {
  const appearance = readAppearanceControls();
  sizeValue.textContent = appearance.fontSize;
  applyAppearance(appearance);
  settings = await hud.updateSettings({ appearance });
}

for (const el of [fontSelect, densitySelect, timestampsCheck]) {
  el.addEventListener("change", onAppearanceChange);
}
sizeSlider.addEventListener("input", () => {
  sizeValue.textContent = sizeSlider.value;
  applyAppearance(readAppearanceControls());
});
sizeSlider.addEventListener("change", onAppearanceChange);

// ---------- empty state ----------

function updateEmptyState() {
  if (rows.size > 0) {
    emptyState.classList.add("hidden");
    return;
  }
  emptyState.classList.remove("hidden");
  const profile = settings?.profiles.find((p) => p.id === settings.activeProfileId);
  if (!profile) {
    emptyTitle.textContent = "No profile selected";
    emptyHint.textContent = "A profile bundles your chat sources and the stream context Jev judges against.";
    emptyAction.textContent = "Create a profile";
    emptyAction.classList.remove("hidden");
  } else if (!(profile.sources || []).length) {
    emptyTitle.textContent = "No chat sources yet";
    emptyHint.textContent = "Attach your Twitch, YouTube, Discord, or Facebook chat to this profile.";
    emptyAction.textContent = "Add a source";
    emptyAction.classList.remove("hidden");
  } else {
    emptyTitle.textContent = "Waiting for chat…";
    emptyHint.textContent = "Messages from your connected sources will stream in here.";
    emptyAction.classList.add("hidden");
  }
}

emptyAction.addEventListener("click", () => openSettingsPanel({ focusSources: true }));

profileSelect.addEventListener("change", async () => {
  clearFeed();
  await hud.activateProfile(profileSelect.value || null);
  settings = await hud.getSettings();
  renderCompose();
});

// Moving either slider is pure display policy: re-threshold and re-render the
// binding-dimension chips, no re-judging. Chips need re-rendering because the
// binding dimension can flip as the margins change.
relevancySlider.addEventListener("input", () => {
  relevancyValue.textContent = relevancySlider.value;
  if (Number(factualSlider.value) > 0) for (const row of rows.values()) renderScoreChip(row);
  refilterAll();
});
relevancySlider.addEventListener("change", () => {
  hud.updateSettings({ relevancyThreshold: Number(relevancySlider.value) });
});
factualSlider.addEventListener("input", () => {
  factualValue.textContent = factualSlider.value;
  for (const row of rows.values()) renderScoreChip(row);
  refilterAll();
});
factualSlider.addEventListener("change", () => {
  hud.updateSettings({ factualThreshold: Number(factualSlider.value) });
});

// ---------- the Jev Judge toggle ----------

let jevFiltering = true;
let jevPlayToken = 0; // invalidates a playing voiceline if the coin is re-clicked

function playJevVoiceline(on) {
  const token = ++jevPlayToken;
  jevVideo.src = on ? "assets/jev-on.mp4" : "assets/jev-off.mp4";
  jevVideo.classList.remove("hidden");
  const done = () => {
    if (token !== jevPlayToken) return;
    jevPlayToken++; // one settle per playback
    jevVideo.pause();
    jevVideo.classList.add("hidden");
    jevVideo.removeAttribute("src");
    jevVideo.load();
  };
  jevVideo.onended = done;
  jevVideo.onerror = done;
  // Settle even if `ended` never fires (no/stuck audio output device freezes
  // the media clock): both voicelines are ~3-4s, cap at 6.
  setTimeout(done, 6000);
  jevVideo.play().catch(done);
}

function setJevFiltering(on, { animate = true, persist = true } = {}) {
  jevFiltering = on;
  document.body.classList.toggle("jev-off", !on);
  jevToggle.classList.toggle("off", !on);
  jevToggle.title = on
    ? "Jev is filtering your chat — click to let all messages through"
    : "Letting all messages through — click and Jev filters your chat";
  jevFace.src = on ? "assets/jev-judge-open.png" : "assets/jev-judge-closed.png";
  if (persist) hud.updateSettings({ jevFiltering: on });
  syncFilterControls();
  refilterAll();
  if (animate) playJevVoiceline(on);
}

jevToggle.addEventListener("click", () => setJevFiltering(!jevFiltering));

// ---------- slider peeks ----------
// Clicking "relevancy" slides open a strip showing exactly what rides into
// each judging batch: the active profile's stream context plus the rolling
// last-60s mic transcript (live while the mic is on). Clicking "factual"
// slides open a static explainer of the fact-vs-opinion score. They share the
// strip zone between the sliders and the tag bar, so opening one closes the
// other.

const contextPeek = document.getElementById("context-peek");
const factualPeek = document.getElementById("factual-peek");
const ctxStream = document.getElementById("ctx-stream");
const ctxSpeech = document.getElementById("ctx-speech");
let ctxTimer = null;

async function refreshContextPeek() {
  if (!settings) return;
  const profile = settings.profiles.find((p) => p.id === settings.activeProfileId);
  ctxStream.textContent =
    profile?.context?.trim() || "no stream context — add one to the profile in settings";
  try {
    const speech = await hud.sttRecent();
    ctxSpeech.classList.toggle("live", !!speech);
    ctxSpeech.textContent =
      speech ||
      (micListening ? "listening — nothing heard in the last minute" : "mic off — click 🎙 to add your voice as context");
  } catch {
    ctxSpeech.textContent = "";
  }
}

function setContextPeek(open) {
  contextPeek.classList.toggle("open", open);
  clearInterval(ctxTimer);
  ctxTimer = null;
  if (open) {
    factualPeek.classList.remove("open");
    refreshContextPeek();
    ctxTimer = setInterval(refreshContextPeek, 2000);
  }
}

function setFactualPeek(open) {
  factualPeek.classList.toggle("open", open);
  if (open) setContextPeek(false);
}

document.querySelector("#relevancy-label .metric-name").addEventListener("click", (e) => {
  e.preventDefault();
  setContextPeek(!contextPeek.classList.contains("open"));
});
document.getElementById("context-peek-close").addEventListener("click", () => setContextPeek(false));
document.querySelector("#factual-label .metric-name").addEventListener("click", (e) => {
  e.preventDefault();
  setFactualPeek(!factualPeek.classList.contains("open"));
});
document.getElementById("factual-peek-close").addEventListener("click", () => setFactualPeek(false));

// ---------- streamer mic → local STT context ----------
// Capture runs here (getUserMedia); 16kHz mono Float32 chunks ship to the main
// process where a local whisper.cpp binary transcribes them. The judge reads
// the rolling transcript as `streamer_speech`. Audio never leaves the machine.

const STT_CHUNK_SECONDS = 5;
const MIC_RMS_GATE = 0.004; // skip silent chunks: no voice energy, no whisper run

let micListening = false;
let micStream = null;
let micCtx = null;
let micNode = null;
let micChunks = [];
let micChunkLen = 0;

function setMicStatus(text, isError = false) {
  micStatusEl.textContent = text;
  micStatusEl.classList.toggle("error", isError);
}

function chunkRms(data) {
  let s = 0;
  for (let i = 0; i < data.length; i++) s += data[i] * data[i];
  return Math.sqrt(s / (data.length || 1));
}

function drainMicBuffer() {
  const all = new Float32Array(micChunkLen);
  let o = 0;
  for (const b of micChunks) {
    all.set(b, o);
    o += b.length;
  }
  micChunks = [];
  micChunkLen = 0;
  return all;
}

async function flushMicChunk() {
  const all = drainMicBuffer();
  if (chunkRms(all) < MIC_RMS_GATE) return;
  const res = await hud.sttChunk(all);
  if (res?.error) setMicStatus(`🎙 ${res.error}`, true);
  else if (micListening) setMicStatus("🎙 listening");
}

function stopMicCapture() {
  micNode?.disconnect();
  micCtx?.close();
  micStream?.getTracks().forEach((t) => t.stop());
  micNode = micCtx = micStream = null;
  micChunks = [];
  micChunkLen = 0;
}

async function startMicCapture(deviceId) {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
  });
  micCtx = new AudioContext({ sampleRate: 16000 });
  const src = micCtx.createMediaStreamSource(micStream);
  micNode = micCtx.createScriptProcessor(4096, 1, 1);
  micNode.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);
    micChunks.push(new Float32Array(data));
    micChunkLen += data.length;
    if (micChunkLen >= STT_CHUNK_SECONDS * micCtx.sampleRate) flushMicChunk();
  };
  src.connect(micNode);
  micNode.connect(micCtx.destination); // keeps the processor pulled; outputs silence
}

async function setMicListening(on, { persist = true, guide = true } = {}) {
  if (on === micListening) {
    // still reflect persisted intent in the UI on init
    micBtn.classList.toggle("active", micListening);
    return;
  }
  if (on) {
    try {
      const st = await hud.sttStatus();
      if (!st.ok) {
        // missing whisper: walk the user through the install instead of
        // dead-ending in an error string
        if (st.needsSetup && guide) openSettingsPanel({ focusMic: true });
        throw new Error(st.error);
      }
      const allowed = await hud.requestMicAccess();
      if (!allowed) throw new Error("microphone access denied (System Settings → Privacy)");
      await startMicCapture(settings.mic?.deviceId || "");
      micListening = true;
      setMicStatus("🎙 listening");
    } catch (err) {
      stopMicCapture();
      micListening = false;
      setMicStatus(`🎙 ${err.message || err}`, true);
    }
  } else {
    stopMicCapture();
    micListening = false;
    setMicStatus("");
  }
  micBtn.classList.toggle("active", micListening);
  settings.mic = { ...(settings.mic || {}), enabled: micListening };
  if (persist) settings = await hud.updateSettings({ mic: settings.mic });
}

micBtn.addEventListener("click", () => setMicListening(!micListening));

// Mic device picker + test, in the settings panel.
const micDeviceSelect = document.getElementById("mic-device");
const micTestBtn = document.getElementById("mic-test-btn");
const micLevelFill = document.getElementById("mic-level-fill");
const micTestResult = document.getElementById("mic-test-result");

async function populateMicDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  micDeviceSelect.replaceChildren();
  const def = document.createElement("option");
  def.value = "";
  def.textContent = "system default";
  micDeviceSelect.append(def);
  let i = 0;
  for (const d of devices) {
    if (d.kind !== "audioinput" || !d.deviceId) continue;
    i++;
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    // Labels are empty until mic permission has been granted once.
    opt.textContent = d.label || `microphone ${i}`;
    micDeviceSelect.append(opt);
  }
  micDeviceSelect.value = settings.mic?.deviceId || "";
  if (micDeviceSelect.selectedIndex === -1) micDeviceSelect.value = ""; // saved device unplugged
}

micDeviceSelect.addEventListener("change", async () => {
  const label = micDeviceSelect.value ? micDeviceSelect.selectedOptions[0]?.textContent || "" : "";
  settings = await hud.updateSettings({
    mic: { ...(settings.mic || {}), deviceId: micDeviceSelect.value, label },
  });
  if (micListening) {
    // live-switch the capture to the new device
    await setMicListening(false, { persist: false });
    await setMicListening(true, { persist: false });
  }
});

// Record ~3s off the picked device with a live level meter, transcribe through
// the exact same pipeline, and show what whisper heard.
micTestBtn.addEventListener("click", async () => {
  if (micTestBtn.disabled) return;
  micTestBtn.disabled = true;
  micTestResult.textContent = "";
  let stream = null;
  let ctx = null;
  try {
    const st = await hud.sttStatus();
    if (!st.ok) throw new Error(st.error);
    const allowed = await hud.requestMicAccess();
    if (!allowed) throw new Error("microphone access denied (System Settings → Privacy)");
    const deviceId = micDeviceSelect.value;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
    await populateMicDevices(); // device labels resolve once permission is granted
    ctx = new AudioContext({ sampleRate: 16000 });
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const parts = [];
    proc.onaudioprocess = (e) => {
      const data = new Float32Array(e.inputBuffer.getChannelData(0));
      parts.push(data);
      micLevelFill.style.width = `${Math.min(100, chunkRms(data) * 900)}%`;
    };
    src.connect(proc);
    proc.connect(ctx.destination);
    micTestBtn.textContent = "listening…";
    await new Promise((r) => setTimeout(r, 3200));
    proc.disconnect();
    let len = 0;
    for (const p of parts) len += p.length;
    const all = new Float32Array(len);
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    micTestBtn.textContent = "transcribing…";
    const res = await hud.sttTest(all);
    micTestResult.textContent = res.error
      ? `✗ ${res.error}`
      : res.text
        ? `Jev heard: “${res.text}”`
        : "✗ heard nothing — try speaking during the test";
  } catch (err) {
    micTestResult.textContent = `✗ ${err.message || err}`;
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
    ctx?.close();
    micLevelFill.style.width = "0";
    micTestBtn.textContent = "test mic";
    micTestBtn.disabled = false;
  }
});

// ---------- guided whisper setup (settings → microphone) ----------
// The mic needs a local whisper.cpp binary + ggml model. This card shows what
// is missing and installs it in-app where the platform allows: prebuilt
// downloads on Windows/Linux, Homebrew on macOS, manual locate everywhere.
const sttSetupEl = document.getElementById("stt-setup");
const sttBinBadge = document.getElementById("stt-bin-badge");
const sttBinDetail = document.getElementById("stt-bin-detail");
const sttBinInstall = document.getElementById("stt-bin-install");
const sttBrewHelp = document.getElementById("stt-brew-help");
const sttModelBadge = document.getElementById("stt-model-badge");
const sttModelDetail = document.getElementById("stt-model-detail");
const sttModelSelect = document.getElementById("stt-model-select");
const sttModelInstall = document.getElementById("stt-model-install");
const sttProgress = document.getElementById("stt-progress");
const sttProgressFill = document.getElementById("stt-progress-fill");
const sttProgressText = document.getElementById("stt-progress-text");
const sttSetupError = document.getElementById("stt-setup-error");

function applySttStatus(st) {
  const setBadge = (el, ok) => {
    el.textContent = ok ? "✓" : "✗";
    el.classList.toggle("ok", ok);
    el.classList.toggle("missing", !ok);
  };
  // ‎ (LRM) keeps the leading "/" from jumping to the visual end under
  // the RTL front-ellipsis trick
  setBadge(sttBinBadge, st.bin.ok);
  sttBinDetail.textContent = st.bin.ok ? `‎${st.bin.path}‎` : "";
  sttBinDetail.classList.toggle("path", st.bin.ok);
  sttBinDetail.title = st.bin.path || "";
  sttBinInstall.classList.toggle("hidden", st.bin.ok);
  sttBrewHelp.classList.add("hidden");
  if (!st.bin.ok) {
    if (st.canDownloadBin) {
      sttBinInstall.textContent = "download (~10 MB)";
    } else if (st.brew.found) {
      sttBinInstall.textContent = "install via Homebrew";
    } else {
      sttBinInstall.classList.add("hidden");
      sttBrewHelp.classList.remove("hidden");
    }
  }
  setBadge(sttModelBadge, st.model.ok);
  sttModelDetail.textContent = st.model.ok ? `‎${st.model.path}‎` : "";
  sttModelDetail.classList.toggle("path", st.model.ok);
  sttModelDetail.title = st.model.path || "";
  sttModelSelect.classList.toggle("hidden", st.model.ok);
  sttModelInstall.classList.toggle("hidden", st.model.ok);
  if (!st.model.ok && !sttModelSelect.options.length) {
    for (const m of st.models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = `${m.id} · ${Math.round(m.bytes / 1048576)} MB — ${m.label.split("— ")[1] || ""}`;
      sttModelSelect.append(opt);
    }
  }
}

async function renderSttSetup() {
  sttSetupError.classList.add("hidden");
  try {
    applySttStatus(await hud.sttSetupStatus());
  } catch (err) {
    sttSetupError.textContent = `✗ ${err.message || err}`;
    sttSetupError.classList.remove("hidden");
  }
}

function sttSetupFailed(msg) {
  sttSetupError.textContent = `✗ ${msg}`;
  sttSetupError.classList.remove("hidden");
}

async function runSttInstall(btn, run) {
  const label = btn.textContent;
  btn.disabled = sttModelInstall.disabled = sttBinInstall.disabled = true;
  btn.textContent = "installing…";
  sttSetupError.classList.add("hidden");
  sttProgress.classList.remove("hidden");
  sttProgressFill.style.width = "0%";
  sttProgressText.textContent = "starting…";
  try {
    const st = await run();
    if (st.error) sttSetupFailed(st.error);
    else {
      applySttStatus(st);
      // the install may have dropped a stale whisperBin/whisperModel override
      // in the main process; refresh our copy so later mic updates (which
      // replace the mic object wholesale) don't write it back
      settings = await hud.getSettings();
      // a completed install may clear the mic's error status line
      if (st.bin.ok && st.model.ok && micStatusEl.classList.contains("error")) setMicStatus("");
    }
  } catch (err) {
    sttSetupFailed(err.message || err);
  } finally {
    sttProgress.classList.add("hidden");
    btn.textContent = label;
    btn.disabled = sttModelInstall.disabled = sttBinInstall.disabled = false;
  }
}

hud.onSttInstallProgress((p) => {
  if (p.kind === "brew") {
    sttProgressFill.style.width = "100%";
    sttProgressText.textContent = p.line.slice(0, 80);
    return;
  }
  const mb = (n) => (n / 1048576).toFixed(0);
  if (p.total) {
    sttProgressFill.style.width = `${Math.round((p.received / p.total) * 100)}%`;
    sttProgressText.textContent = `${mb(p.received)} / ${mb(p.total)} MB`;
  } else {
    sttProgressText.textContent = `${mb(p.received)} MB`;
  }
});

sttBinInstall.addEventListener("click", () =>
  runSttInstall(sttBinInstall, () => hud.sttInstallBin())
);
sttModelInstall.addEventListener("click", () =>
  runSttInstall(sttModelInstall, () => hud.sttInstallModel(sttModelSelect.value))
);
for (const [btn, which] of [
  [document.getElementById("stt-bin-locate"), "bin"],
  [document.getElementById("stt-model-locate"), "model"],
]) {
  btn.addEventListener("click", async () => {
    const st = await hud.sttLocate(which);
    if (st.error) sttSetupFailed(st.error);
    else applySttStatus(st);
    // locate writes mic.whisperBin/whisperModel in the main process; refresh
    // our copy so later mic updates don't clobber it (mic replaces wholesale)
    settings = await hud.getSettings();
  });
}
document.getElementById("stt-copy-brew").addEventListener("click", () => {
  navigator.clipboard.writeText("brew install whisper-cpp");
});

// Always-on-top lives in settings (used to be a header pin); main.js applies
// it to the window the moment it persists.
const alwaysOnTopCheck = document.getElementById("always-on-top");
alwaysOnTopCheck.addEventListener("change", async () => {
  settings = await hud.updateSettings({ alwaysOnTop: alwaysOnTopCheck.checked });
});

// ---------- settings panel ----------

const overlay = document.getElementById("overlay");
const panelBody = document.getElementById("panel-body");
const apiKeyInput = document.getElementById("api-key");
const modelInput = document.getElementById("model");
const editProfileSelect = document.getElementById("edit-profile-select");
const profileNameInput = document.getElementById("profile-name");
const profileContextInput = document.getElementById("profile-context");
const profileLanguageSelect = document.getElementById("profile-language");
const translatorSetup = document.getElementById("translator-setup");
const translatorNote = document.getElementById("translator-note");
const translatorInstallBtn = document.getElementById("translator-install-btn");
const translatorProgressLabel = document.getElementById("translator-progress-label");
const sourcesList = document.getElementById("sources-list");

// ---------- per-profile language + on-device translator setup ----------

async function initLanguageSelect() {
  let status;
  try {
    status = await hud.translateStatus();
  } catch {
    status = { langs: [] };
  }
  profileLanguageSelect.replaceChildren();
  const original = document.createElement("option");
  original.value = "";
  original.textContent = "Original (no translation)";
  profileLanguageSelect.append(original);
  for (const lang of status.langs || []) {
    const opt = document.createElement("option");
    opt.value = lang.code;
    opt.textContent = lang.label;
    profileLanguageSelect.append(opt);
  }
}

async function updateTranslatorSetup() {
  if (!profileLanguageSelect.value) {
    translatorSetup.classList.add("hidden");
    return;
  }
  let st;
  try {
    st = await hud.translateStatus();
  } catch {
    return;
  }
  if (st.state === "ready" || st.state === "installed") {
    translatorSetup.classList.add("hidden");
    return;
  }
  translatorSetup.classList.remove("hidden");
  translatorNote.textContent =
    st.state === "installing"
      ? "Downloading the on-device translator model…"
      : st.error
        ? `Translator install failed: ${st.error}`
        : `Translation runs on this computer — it needs a one-time model download (~${st.modelMB} MB).`;
  translatorInstallBtn.disabled = st.state === "installing";
  translatorInstallBtn.textContent = st.error ? "Retry download" : "Download translator model";
}

profileLanguageSelect.addEventListener("change", () => {
  if (editingProfile) {
    editingProfile.language = profileLanguageSelect.value;
    scheduleProfileSave();
  }
  updateTranslatorSetup();
});

translatorInstallBtn.addEventListener("click", async () => {
  translatorInstallBtn.disabled = true;
  translatorNote.textContent = "Downloading the on-device translator model…";
  const st = await hud.translateInstall();
  translatorProgressLabel.textContent = "";
  translatorInstallBtn.disabled = false;
  if (st.state === "ready") translatorSetup.classList.add("hidden");
  else updateTranslatorSetup();
});

hud.onTranslateProgress((p) => {
  if (!p?.total) return;
  const pct = Math.round((p.loaded / p.total) * 100);
  const file = String(p.file || "model").split("/").pop();
  translatorProgressLabel.textContent = `${file} ${pct}%`;
});

const SOURCE_FIELDS = {
  twitch: [{ key: "channel", label: "Channel name", placeholder: "sodapoppin" }],
  youtube: [
    { key: "apiKey", label: "YouTube Data API key", placeholder: "AIza..." },
    { key: "videoId", label: "Live video ID", placeholder: "dQw4w9WgXcQ" },
  ],
  discord: [
    { key: "botToken", label: "Bot token", placeholder: "MTA..." },
    { key: "channelIds", label: "Channel IDs (comma-separated)", placeholder: "123, 456" },
    { key: "label", label: "Display label", placeholder: "my server #general" },
  ],
  facebook: [
    { key: "accessToken", label: "Access token", placeholder: "EAAG..." },
    { key: "liveVideoId", label: "Live video ID", placeholder: "10158..." },
  ],
};

function renderSources() {
  sourcesList.replaceChildren();
  (editingProfile.sources || []).forEach((source, idx) => {
    const item = document.createElement("div");
    item.className = "source-item";
    const head = document.createElement("div");
    head.className = "row";
    const type = document.createElement("span");
    type.className = "type-label";
    type.textContent = source.type;
    const gap = document.createElement("span");
    gap.style.flex = "1";
    const remove = document.createElement("button");
    remove.className = "danger";
    remove.textContent = "remove";
    remove.addEventListener("click", () => {
      editingProfile.sources.splice(idx, 1);
      renderSources();
      scheduleProfileSave();
    });
    head.append(type, gap, remove);
    item.append(head);

    for (const field of SOURCE_FIELDS[source.type] || []) {
      const label = document.createElement("label");
      label.className = "field";
      label.textContent = field.label;
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = field.placeholder;
      input.value = Array.isArray(source[field.key]) ? source[field.key].join(", ") : source[field.key] || "";
      input.addEventListener("input", () => {
        source[field.key] =
          field.key === "channelIds"
            ? input.value.split(",").map((s) => s.trim()).filter(Boolean)
            : input.value.trim();
        scheduleProfileSave();
      });
      label.append(input);
      item.append(label);
    }
    sourcesList.append(item);
  });
}

function loadProfileIntoEditor(profile) {
  editingProfile = profile
    ? JSON.parse(JSON.stringify(profile))
    : { id: null, name: "", context: "", language: "", sources: [] };
  profileNameInput.value = editingProfile.name || "";
  profileContextInput.value = editingProfile.context || "";
  profileLanguageSelect.value = editingProfile.language || "";
  savedSourcesSig = JSON.stringify(editingProfile.sources || []);
  renderSources();
  updateTranslatorSetup();
}

function renderEditProfileSelect(selectedId) {
  editProfileSelect.replaceChildren();
  const fresh = document.createElement("option");
  fresh.value = "";
  fresh.textContent = "(new profile)";
  editProfileSelect.append(fresh);
  for (const p of settings.profiles) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name || "(unnamed)";
    editProfileSelect.append(opt);
  }
  editProfileSelect.value = selectedId || "";
}

editProfileSelect.addEventListener("change", async () => {
  await flushProfileSave();
  const p = settings.profiles.find((x) => x.id === editProfileSelect.value);
  loadProfileIntoEditor(p || null);
});

document.getElementById("new-profile-btn").addEventListener("click", async () => {
  await flushProfileSave();
  renderEditProfileSelect("");
  loadProfileIntoEditor(null);
});

document.getElementById("delete-profile-btn").addEventListener("click", async () => {
  if (!editingProfile?.id) return;
  settings = await hud.deleteProfile(editingProfile.id);
  renderEditProfileSelect("");
  loadProfileIntoEditor(null);
  renderProfileSelect();
});

for (const btn of document.querySelectorAll("#add-source-row .add-source")) {
  btn.addEventListener("click", () => {
    editingProfile.sources.push({ type: btn.dataset.type });
    renderSources();
    scheduleProfileSave();
    // Put the new source's first field in front of the user immediately.
    const items = sourcesList.querySelectorAll(".source-item");
    items[items.length - 1]?.querySelector("input")?.focus();
  });
}

function openSettingsPanel({ focusSources = false, focusMic = false, focusTwitch = false } = {}) {
  apiKeyInput.value = settings.typesafeApiKey || "";
  modelInput.value = settings.model || "jev-latest";
  const a = settings.appearance || {};
  fontSelect.value = a.fontFamily || "system";
  densitySelect.value = a.density || "cozy";
  sizeSlider.value = a.fontSize || 13;
  sizeValue.textContent = sizeSlider.value;
  timestampsCheck.checked = !!a.timestamps;
  alwaysOnTopCheck.checked = !!settings.alwaysOnTop;
  populateMicDevices();
  renderSttSetup();
  micTestResult.textContent = "";
  renderSpeakerUI();
  renderTwitch();
  const active = settings.profiles.find((p) => p.id === settings.activeProfileId);
  renderEditProfileSelect(active?.id || "");
  loadProfileIntoEditor(active || null);
  overlay.classList.remove("hidden");
  if (focusSources) {
    document.getElementById("sources-heading").scrollIntoView({ block: "start" });
  }
  if (focusMic) {
    document.getElementById("mic-heading").scrollIntoView({ block: "start" });
    sttSetupEl.classList.remove("flash");
    void sttSetupEl.offsetWidth; // restart the animation on repeat opens
    sttSetupEl.classList.add("flash");
  }
  if (focusTwitch) document.getElementById("twitch-heading").scrollIntoView({ block: "start" });
}

document.getElementById("settings-btn").addEventListener("click", () => openSettingsPanel());
document.getElementById("add-source-shortcut").addEventListener("click", () => openSettingsPanel({ focusSources: true }));

function closeSettingsPanel() {
  flushProfileSave();
  overlay.classList.add("hidden");
}

document.getElementById("panel-close").addEventListener("click", closeSettingsPanel);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const identityPopEl = document.getElementById("identity-pop");
  const emotePopEl = document.getElementById("emote-pop");
  if (emotePopEl && !emotePopEl.classList.contains("hidden")) closeEmotePicker();
  else if (identityPopEl && !identityPopEl.classList.contains("hidden")) identityPopEl.classList.add("hidden");
  else if (!leaderboardOverlay.classList.contains("hidden")) closeLeaderboard();
  else if (!userOverlay.classList.contains("hidden")) closeUserProfile();
  else if (!overlay.classList.contains("hidden")) closeSettingsPanel();
});

// ---------- settings autosave (there is no save button) ----------

apiKeyInput.addEventListener("change", async () => {
  settings = await hud.updateSettings({ typesafeApiKey: apiKeyInput.value.trim() });
});
modelInput.addEventListener("change", async () => {
  settings = await hud.updateSettings({ model: modelInput.value.trim() || "jev-latest" });
});

// Profile edits debounce into a save; the live profile's streams restart only
// when its SOURCES actually changed (a context/name edit must not reconnect
// Twitch mid-typing — the judge reads context fresh from settings anyway).
let profileSaveTimer = null;
let savedSourcesSig = "[]";

function scheduleProfileSave() {
  clearTimeout(profileSaveTimer);
  profileSaveTimer = setTimeout(saveProfileNow, 1000);
}

function flushProfileSave() {
  if (!profileSaveTimer) return Promise.resolve();
  return saveProfileNow();
}

async function saveProfileNow() {
  clearTimeout(profileSaveTimer);
  profileSaveTimer = null;
  editingProfile.name = profileNameInput.value.trim();
  editingProfile.context = profileContextInput.value;
  editingProfile.language = profileLanguageSelect.value;
  // Never materialize a profile out of an untouched "(new profile)" form.
  if (!editingProfile.id && !editingProfile.name && !editingProfile.sources.length) return;
  const sig = JSON.stringify(editingProfile.sources || []);
  const saved = await hud.saveProfile(editingProfile);
  editingProfile.id = saved.id;
  settings = await hud.getSettings();
  renderEditProfileSelect(saved.id);
  renderProfileSelect();
  updateEmptyState();
  if (settings.activeProfileId === saved.id && sig !== savedSourcesSig) {
    clearFeed();
    await hud.activateProfile(saved.id);
  }
  savedSourcesSig = sig;
}

profileNameInput.addEventListener("input", scheduleProfileSave);
profileContextInput.addEventListener("input", scheduleProfileSave);

// Scrollbar-less panel: the wheel scrolls natively; a click-drag on any
// non-interactive area scrolls too. A real drag never counts as a click.
(() => {
  const INTERACTIVE = "input, textarea, select, button, a";
  let drag = null;
  let dragged = false;
  panelBody.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest(INTERACTIVE)) return;
    drag = { y: e.clientY, top: panelBody.scrollTop };
    dragged = false;
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) > 4) dragged = true;
    if (dragged) {
      panelBody.scrollTop = drag.top - dy;
      panelBody.classList.add("drag-scrolling");
      e.preventDefault();
    }
  });
  window.addEventListener("mouseup", () => {
    drag = null;
    panelBody.classList.remove("drag-scrolling");
  });
  panelBody.addEventListener(
    "click",
    (e) => {
      if (!dragged) return;
      dragged = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
})();

// ---------- "Jev speaks" share window ----------

// Must match the defaults in src/settings.js: the Jev Judge avatar on its
// creator's account (rendering it spends the USER's credits; the creator
// earns their share through the mask marketplace).
const JEV_AVATAR = { ownerUserId: "twitch:11867613", avatarId: "Ev1WizD5smJnxHWJXEHZ" };

const speakerEnabledCheck = document.getElementById("speaker-enabled");
const speakerInterval = document.getElementById("speaker-interval");
const speakerSetup = document.getElementById("speaker-setup");
const maskyLoginBtn = document.getElementById("masky-login-btn");
const maskyStatus = document.getElementById("masky-status");
const maskyTokenInput = document.getElementById("masky-token");
const maskyConnectRow = document.getElementById("masky-connect-row");
const maskyTokenField = document.getElementById("masky-token-field");
const maskyConnectedRow = document.getElementById("masky-connected-row");
const maskyConnectedLabel = document.getElementById("masky-connected-label");
const maskyConnectedName = document.getElementById("masky-connected-name");
const maskyAvatarImg = document.getElementById("masky-avatar-img");
const maskyLogoutBtn = document.getElementById("masky-logout-btn");
const speakerBalance = document.getElementById("speaker-balance");
const speakerOwnAvatar = document.getElementById("speaker-own-avatar");
const ownAvatarRow = document.getElementById("own-avatar-row");
const speakerAvatarSelect = document.getElementById("speaker-avatar");
const speakerAvatarStill = document.getElementById("speaker-avatar-still");
const avatarStillsPanel = document.getElementById("avatar-stills");
const createAvatarBtn = document.getElementById("create-avatar-btn");
const speakerAudioOnly = document.getElementById("speaker-audio-only");
const qualityRow = document.getElementById("quality-row");
const speakerQuality = document.getElementById("speaker-quality");
const speakerSpeakLatest = document.getElementById("speaker-speak-latest");
const speakerUserAvatars = document.getElementById("speaker-user-avatars");
const readingAudio = document.getElementById("reading-audio");
const speakerChroma = document.getElementById("speaker-chroma");
const speakerPassthrough = document.getElementById("speaker-passthrough");
const speakerTestBtn = document.getElementById("speaker-test-btn");
const speakerArrangeBtn = document.getElementById("speaker-arrange-btn");
const speakerNote = document.getElementById("speaker-note");
let arrangingShare = false;
let lastCreditAlert = 0;

function speakerCfg() {
  return settings.speaker || {};
}

function renderSpeakerUI() {
  const cfg = speakerCfg();
  speakerEnabledCheck.checked = !!cfg.enabled;
  speakerInterval.value = String(cfg.intervalMin || 1);
  speakerSetup.classList.toggle("hidden", !cfg.enabled);
  renderMaskyAuth();
  speakerOwnAvatar.checked = !!cfg.useOwnAvatar;
  ownAvatarRow.classList.toggle("hidden", !cfg.useOwnAvatar);
  if (cfg.useOwnAvatar) populateOwnAvatars();
  speakerAudioOnly.checked = !!cfg.audioOnly;
  // Quality only applies to video renders; audio-only readings hide it.
  qualityRow.classList.toggle("hidden", !!cfg.audioOnly);
  speakerQuality.value = cfg.videoQuality === "medium" ? "medium" : "high";
  speakerSpeakLatest.checked = !!cfg.speakLatest;
  speakerUserAvatars.checked = !!cfg.readUserAvatars;
  speakerChroma.checked = !!cfg.chroma;
  speakerPassthrough.checked = !!cfg.clickThrough;
  speakerNote.textContent = "";
}

// Connected: avatar + "Masky Connected: <name>" + logout. Disconnected: the
// connect button and the paste-a-token field.
function renderMaskyAuth() {
  const cfg = speakerCfg();
  const connected = !!cfg.maskyToken;
  maskyConnectRow.classList.toggle("hidden", connected);
  maskyTokenField.classList.toggle("hidden", connected);
  maskyConnectedRow.classList.toggle("hidden", !connected);
  if (connected) {
    maskyConnectedLabel.textContent = "Masky Connected:";
    maskyConnectedName.textContent = cfg.maskyAccountName || "API token";
    if (cfg.maskyAccountPicture) {
      maskyAvatarImg.src = cfg.maskyAccountPicture;
      maskyAvatarImg.classList.remove("hidden");
    } else {
      maskyAvatarImg.removeAttribute("src");
      maskyAvatarImg.classList.add("hidden");
    }
  } else {
    maskyStatus.textContent = "not connected";
    maskyTokenInput.value = "";
    maskyTokenInput.placeholder = "mky_...";
  }
}

async function updateSpeaker(patch) {
  settings.speaker = await hud.speakerUpdate(patch);
  return settings.speaker;
}

async function populateOwnAvatars() {
  speakerAvatarSelect.replaceChildren();
  try {
    const avatars = await hud.speakerAvatars();
    avatars.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }));
    for (const a of avatars) {
      const opt = document.createElement("option");
      opt.value = a.avatarId;
      opt.textContent = a.name;
      opt.dataset.owner = a.ownerUserId;
      opt.dataset.image = a.imageUrl || "";
      speakerAvatarSelect.append(opt);
    }
    const cfg = speakerCfg();
    if (cfg.useOwnAvatar && cfg.avatarId) speakerAvatarSelect.value = cfg.avatarId;
    if (!avatars.length) speakerNote.textContent = "no avatars on this Masky account — create one on masky.ai first";
  } catch (err) {
    speakerNote.textContent = `could not list avatars: ${err.message || err}`;
  }
  renderOwnAvatarStill();
}

// The preview beside the select: the still that will be used when rendering —
// the pinned one when set, else the avatar's primary image. Clicking it opens
// the avatar's full image set to pin a different one.
function renderOwnAvatarStill() {
  const cfg = speakerCfg();
  const opt = speakerAvatarSelect.selectedOptions[0];
  const src = (cfg.avatarImageUrl || opt?.dataset.image || "").trim();
  if (src) speakerAvatarStill.src = src;
  else speakerAvatarStill.removeAttribute("src");
  speakerAvatarStill.classList.toggle("hidden", !src);
}

function hideAvatarStills() {
  avatarStillsPanel.classList.add("hidden");
  avatarStillsPanel.replaceChildren();
}

let ownStillsGen = 0;
async function toggleAvatarStills() {
  if (!avatarStillsPanel.classList.contains("hidden")) {
    hideAvatarStills();
    return;
  }
  const opt = speakerAvatarSelect.selectedOptions[0];
  if (!opt) return;
  const gen = ++ownStillsGen;
  avatarStillsPanel.classList.remove("hidden");
  avatarStillsPanel.replaceChildren();
  const pending = document.createElement("div");
  pending.className = "id-empty";
  pending.textContent = "Loading images…";
  avatarStillsPanel.append(pending);
  let images = [];
  try {
    const listed = await hud.identityImages(opt.value, "");
    images = listed?.images || [];
  } catch (err) {
    if (gen !== ownStillsGen) return;
    pending.textContent = `could not list images: ${err.message || err}`;
    return;
  }
  if (gen !== ownStillsGen) return;
  avatarStillsPanel.replaceChildren();
  if (!images.length) {
    const none = document.createElement("div");
    none.className = "id-empty";
    none.textContent = "This avatar has no images yet.";
    avatarStillsPanel.append(none);
    return;
  }
  const pinned = speakerCfg().avatarImageUrl || "";
  for (const img of images) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "id-still";
    if (pinned ? pinned === img.url : img.isPrimary) btn.classList.add("selected");
    const el = document.createElement("img");
    el.src = img.url;
    el.alt = "";
    btn.append(el);
    btn.addEventListener("click", async () => {
      await updateSpeaker({ avatarImageUrl: img.url });
      renderOwnAvatarStill();
      hideAvatarStills();
    });
    avatarStillsPanel.append(btn);
  }
}

speakerAvatarStill.addEventListener("click", () => {
  toggleAvatarStills().catch(() => {});
});

speakerEnabledCheck.addEventListener("change", async () => {
  const on = speakerEnabledCheck.checked;
  await updateSpeaker({ enabled: on, intervalMin: Number(speakerInterval.value) });
  speakerSetup.classList.toggle("hidden", !on);
  if (on && !speakerCfg().maskyToken) {
    speakerNote.textContent = "connect your Masky account (or paste a token) to start";
  }
});

speakerInterval.addEventListener("change", () => updateSpeaker({ intervalMin: Number(speakerInterval.value) }));
speakerAudioOnly.addEventListener("change", () => {
  qualityRow.classList.toggle("hidden", speakerAudioOnly.checked);
  updateSpeaker({ audioOnly: speakerAudioOnly.checked });
});
speakerQuality.addEventListener("change", () => updateSpeaker({ videoQuality: speakerQuality.value }));
speakerSpeakLatest.addEventListener("change", () => updateSpeaker({ speakLatest: speakerSpeakLatest.checked }));
speakerUserAvatars.addEventListener("change", () => updateSpeaker({ readUserAvatars: speakerUserAvatars.checked }));
speakerChroma.addEventListener("change", () => updateSpeaker({ chroma: speakerChroma.checked }));
speakerPassthrough.addEventListener("change", () => updateSpeaker({ clickThrough: speakerPassthrough.checked }));

maskyLoginBtn.addEventListener("click", async () => {
  maskyLoginBtn.disabled = true;
  maskyStatus.textContent = "waiting for browser login…";
  try {
    await hud.speakerLogin();
    settings = await hud.getSettings();
    renderMaskyAuth();
    speakerNote.textContent = "";
  } catch (err) {
    maskyStatus.textContent = "not connected";
    speakerNote.textContent = `login failed: ${err.message || err}`;
  } finally {
    maskyLoginBtn.disabled = false;
  }
});

maskyTokenInput.addEventListener("change", async () => {
  const token = maskyTokenInput.value.trim();
  if (!token) return;
  maskyStatus.textContent = "checking token…";
  try {
    await hud.speakerVerifyToken(token);
    settings = await hud.getSettings();
    renderMaskyAuth();
    speakerNote.textContent = "";
  } catch (err) {
    maskyStatus.textContent = "not connected";
    speakerNote.textContent = `token rejected: ${err.message || err}`;
  }
});

// Startup backfill: an older stored token resolved to its identity.
hud.onSpeakerIdentity(({ maskyAccountName, maskyAccountPicture }) => {
  Object.assign(speakerCfg(), { maskyAccountName, maskyAccountPicture });
  renderMaskyAuth();
});

maskyLogoutBtn.addEventListener("click", async () => {
  settings.speaker = await hud.speakerLogout();
  renderMaskyAuth();
  speakerNote.textContent = speakerCfg().enabled
    ? "connect your Masky account (or paste a token) to start"
    : "";
});

speakerOwnAvatar.addEventListener("change", async () => {
  const own = speakerOwnAvatar.checked;
  ownAvatarRow.classList.toggle("hidden", !own);
  hideAvatarStills();
  if (!own) {
    await updateSpeaker({
      useOwnAvatar: false,
      avatarOwnerUserId: JEV_AVATAR.ownerUserId,
      avatarId: JEV_AVATAR.avatarId,
      avatarImageUrl: "",
    });
    return;
  }
  const prevId = speakerCfg().avatarId;
  await populateOwnAvatars();
  const opt = speakerAvatarSelect.selectedOptions[0];
  if (opt) {
    // Re-checking restores the remembered avatar and its pinned still; if
    // that avatar is gone the select fell back to another one, whose stills
    // the old pin doesn't belong to.
    const pin = opt.value === prevId ? speakerCfg().avatarImageUrl || "" : "";
    await updateSpeaker({ useOwnAvatar: true, avatarOwnerUserId: opt.dataset.owner, avatarId: opt.value, avatarImageUrl: pin });
    renderOwnAvatarStill();
  }
});

speakerAvatarSelect.addEventListener("change", async () => {
  const opt = speakerAvatarSelect.selectedOptions[0];
  if (opt) {
    // A different avatar's stills don't apply — the pin resets to its primary.
    await updateSpeaker({ useOwnAvatar: true, avatarOwnerUserId: opt.dataset.owner, avatarId: opt.value, avatarImageUrl: "" });
  }
  hideAvatarStills();
  renderOwnAvatarStill();
});

// Deep-links into the connected account's masky.ai admin console; the #create
// hash there pops the "name your new avatar" dialog straight away.
createAvatarBtn.addEventListener("click", async () => {
  createAvatarBtn.disabled = true;
  speakerNote.textContent = "opening masky.ai in your browser…";
  try {
    await hud.speakerCreateAvatar();
  } finally {
    createAvatarBtn.disabled = false;
  }
});

// Plays the bundled sample clip (no Masky render, no credits): shows exactly
// where and how readings will appear.
speakerTestBtn.addEventListener("click", async () => {
  speakerTestBtn.disabled = true;
  try {
    await hud.speakerTest();
    speakerNote.textContent = speakerCfg().audioOnly
      ? "test reading is playing (audio only — no window)"
      : "test reading is playing in the share window";
  } catch (err) {
    speakerNote.textContent = `test failed: ${err.message || err}`;
  } finally {
    speakerTestBtn.disabled = false;
  }
});

function syncArrangeBtn() {
  speakerArrangeBtn.textContent = arrangingShare ? "done" : "set location";
  speakerArrangeBtn.classList.toggle("active", arrangingShare);
}

speakerArrangeBtn.addEventListener("click", async () => {
  arrangingShare = !arrangingShare;
  await hud.speakerArrange(arrangingShare);
  syncArrangeBtn();
});

// The ✕ on the share window itself also ends arrange mode.
hud.onSpeakerArranged((on) => {
  arrangingShare = !!on;
  syncArrangeBtn();
});

const speakerStat = document.getElementById("speaker-stat");
hud.onSpeakerState((state) => {
  if (state.balance != null) {
    const mins = state.talkingMinutes;
    speakerBalance.textContent =
      `Masky balance: ${state.balance.toFixed(2)} credits` +
      (mins != null ? ` ≈ ${mins} minute${mins === 1 ? "" : "s"} of Jev talking` : "");
  } else if (speakerCfg().maskyToken) {
    speakerBalance.textContent = "balance unknown (Masky balance endpoint not available yet)";
  } else {
    speakerBalance.textContent = "";
  }
  speakerStat.textContent = state.enabled
    ? state.speaking
      ? "🎭 rendering…"
      : state.talkingMinutes != null
        ? `🎭 ~${state.talkingMinutes}min left`
        : "🎭 on"
    : "";
});

hud.onSpeakerError((err) => {
  if (err.code === "insufficient_credits") {
    speakerNote.textContent = "out of Masky credits — Jev can't speak until you top up on masky.ai";
    speakerStat.textContent = "🎭 out of credits";
    // One alert per 10 minutes, not one per failed reading.
    if (Date.now() - lastCreditAlert > 600000) {
      lastCreditAlert = Date.now();
      alert(
        "Jev has run out of Masky credits.\n\n" +
          "The share window will stay silent until you add credits to your Masky account (masky.ai).",
      );
    }
  } else {
    speakerNote.textContent = `Jev speaks error: ${err.message || err.code}`;
  }
});

hud.onSpeakerPlayed(({ username, relevancy, audio }) => {
  speakerNote.textContent = `now reading ${username}${audio ? " (audio only)" : ""} (relevancy ${relevancy})`;
  // A reading just credited someone — keep an open leaderboard live.
  if (!leaderboardOverlay.classList.contains("hidden")) renderLeaderboard();
});

// Audio-only readings: no popup window — the clip's sound plays through the
// HUD itself, and main is told when it ends so continuous mode can chain.
// Like the share window, a render that finishes while a clip is still
// playing queues behind it instead of cutting it off — paid renders always
// get heard.
let audioActive = false;
const audioQueue = [];
function playAudioNow({ url }) {
  audioActive = true;
  readingAudio.src = url;
  const p = readingAudio.play();
  if (p && p.catch) p.catch(() => readingAudioDone());
}
function readingAudioDone() {
  if (!audioActive) return;
  const next = audioQueue.shift();
  if (next) {
    playAudioNow(next);
    return;
  }
  audioActive = false;
  readingAudio.removeAttribute("src");
  readingAudio.load();
  hud.speakerAudioDone();
}
readingAudio.addEventListener("ended", readingAudioDone);
readingAudio.addEventListener("error", () => readingAudioDone());
hud.onSpeakerPlayAudio((payload) => {
  if (audioActive) {
    audioQueue.push(payload);
    return;
  }
  playAudioNow(payload);
});

// ---------- events from main ----------

hud.onMessage(addMessage);
hud.onJudged(markJudged);
hud.onTranslation((tr) => {
  const row = rows.get(tr.id);
  if (!row || !row._msg || !row._text) return;
  row._msg.translation = tr;
  fillMessageText(row._text, row._msg);
  row._clampChecked = false;
  row.classList.remove("clampable", "expanded");
  applyFilter(row);
});
hud.onSourceStatus((status) => {
  // Stopped sources drop off the status row rather than lingering as stale chips.
  if (status.state === "stopped") sourceStates.delete(status.sourceId || status.label);
  else sourceStates.set(status.sourceId || status.label, status);
  renderStatuses();
});
hud.onJudgeStats(renderStats);
hud.onProfileActivated((id) => {
  if (settings) {
    settings.activeProfileId = id;
    profileSelect.value = id || "";
    updateEmptyState();
    renderCompose();
  }
});
hud.onOpenSettings(() => openSettingsPanel());

// ---------- Twitch chat composer + stream identity ----------

const chatForm = document.getElementById("chat-compose");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const chatError = document.getElementById("chat-error");
const identityBtn = document.getElementById("identity-btn");
const identityPop = document.getElementById("identity-pop");
const identityClose = document.getElementById("identity-close");
const idOwn = document.getElementById("id-own");
const idCommunity = document.getElementById("id-community");
const idGame = document.getElementById("id-game");
const idImages = document.getElementById("id-images");
const idClear = document.getElementById("id-clear");
const idStatus = document.getElementById("id-status");
const twitchLoginBtn = document.getElementById("twitch-login-btn");
const twitchLogoutBtn = document.getElementById("twitch-logout-btn");
const twitchConnectRow = document.getElementById("twitch-connect-row");
const twitchConnectedRow = document.getElementById("twitch-connected-row");
const twitchStatusEl = document.getElementById("twitch-status");
const twitchPending = document.getElementById("twitch-pending");
const twitchConnectedName = document.getElementById("twitch-connected-name");
const twitchAvatarImg = document.getElementById("twitch-avatar-img");

let twitchAccount = { connected: false };
let identityState = null;
// An avatar the user just clicked, before (or instead of) the saved identity.
let identityPick = null;
let stillsGen = 0;

function profileTwitchChannel() {
  const profile = (settings?.profiles || []).find((p) => p.id === settings.activeProfileId);
  const src = (profile?.sources || []).find((s) => s.type === "twitch" && s.channel);
  return src ? String(src.channel).replace(/^#/, "").trim() : "";
}

function showChatError(text) {
  chatError.textContent = text || "";
  chatError.classList.remove("ok");
  chatError.classList.toggle("hidden", !text);
}

let chatStatusTimer = null;
function showChatStatus(text) {
  chatError.textContent = text;
  chatError.classList.add("ok");
  chatError.classList.remove("hidden");
  clearTimeout(chatStatusTimer);
  chatStatusTimer = setTimeout(() => {
    if (chatError.classList.contains("ok")) showChatError("");
  }, 5000);
}

function renderCompose() {
  const channel = profileTwitchChannel();
  chatInput.disabled = !channel;
  chatSend.disabled = !channel;
  chatInput.placeholder = channel ? "Send a message" : "Add a Twitch channel to this profile";
}

function renderTwitch() {
  const tw = twitchAccount || {};
  twitchConnectRow.classList.toggle("hidden", !!tw.connected);
  twitchConnectedRow.classList.toggle("hidden", !tw.connected);
  if (tw.connected) {
    twitchConnectedName.textContent = tw.displayName || tw.login || "Twitch";
    if (tw.profileImageUrl) {
      twitchAvatarImg.src = tw.profileImageUrl;
      twitchAvatarImg.classList.remove("hidden");
    } else {
      twitchAvatarImg.removeAttribute("src");
      twitchAvatarImg.classList.add("hidden");
    }
  } else {
    twitchStatusEl.textContent = "not connected";
  }
}

twitchLoginBtn.addEventListener("click", async () => {
  twitchLoginBtn.disabled = true;
  twitchPending.classList.remove("hidden");
  twitchPending.textContent = "Opening Twitch…";
  try {
    const flow = await hud.twitchLogin();
    twitchPending.textContent = `Enter ${flow.userCode} on the Twitch page that just opened.`;
  } catch (err) {
    twitchLoginBtn.disabled = false;
    twitchPending.textContent = err.message || String(err);
  }
});

twitchLogoutBtn.addEventListener("click", async () => {
  twitchAccount = await hud.twitchLogout();
  twitchPending.classList.add("hidden");
  twitchLoginBtn.disabled = false;
  renderTwitch();
  renderCompose();
});

// Ground truth per send: the message either echoed back on the channel's
// public (anonymous) reader — provably visible to everyone — or Twitch
// accepted it and then quietly hid it, which no error anywhere reports.
hud.onTwitchDelivery((d) => {
  if (d.state === "delivered") {
    showChatStatus(`Seen in #${d.channel}'s public chat ✓`);
  } else {
    showChatError(
      `Twitch accepted the message but it never appeared in #${d.channel}'s public chat. ` +
        `Either Twitch is quietly holding this account's messages back in that channel ` +
        `(new-looking account, or the channel requires verified email/phone or following), ` +
        `or the HUD's chat reader is disconnected.`,
    );
  }
});

hud.onTwitchStatus((view) => {
  twitchAccount = view || { connected: false };
  twitchLoginBtn.disabled = false;
  if (twitchAccount.connected) twitchPending.classList.add("hidden");
  else if (twitchAccount.error) {
    twitchPending.classList.remove("hidden");
    twitchPending.textContent = twitchAccount.error;
  }
  renderTwitch();
  renderCompose();
});

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  if (!profileTwitchChannel()) return;
  if (!twitchAccount?.connected) {
    showChatError("Log in with Twitch in Settings to send chat.");
    openSettingsPanel({ focusTwitch: true });
    return;
  }
  showChatError("");
  chatSend.disabled = true;
  try {
    await hud.twitchSend(text);
    chatInput.value = "";
  } catch (err) {
    showChatError(err.message || String(err));
  } finally {
    chatSend.disabled = !profileTwitchChannel();
    chatInput.focus();
  }
});

function communityMessage(community) {
  if (!community) return "";
  switch (community.reason) {
    case "no-channel":
      return "Add a Twitch source to see avatars for its game.";
    case "no-twitch":
      return "Log in with Twitch to load this channel's category.";
    case "no-category":
      return "This channel has no game category set.";
    case "category-failed":
      return "Couldn't read the channel's category.";
    default:
      if (!community.avatars?.length && community.gameName) return `None enabled for ${community.gameName} yet.`;
      return "";
  }
}

function avatarButton(avatar) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "id-avatar";
  btn.dataset.id = avatar.avatarId;
  const voiced = !!avatar.voiceId;
  if (!voiced) {
    btn.classList.add("no-voice");
    btn.disabled = true;
    btn.title = "no voice yet";
  }
  if (identityState?.streamIdentity?.avatarId === avatar.avatarId) btn.classList.add("selected");
  const img = document.createElement("img");
  img.alt = "";
  if (avatar.imageUrl) img.src = avatar.imageUrl;
  const label = document.createElement("span");
  label.textContent = avatar.name || avatar.avatarId;
  btn.append(img, label);
  if (voiced) btn.addEventListener("click", () => chooseAvatar(avatar));
  return btn;
}

function fillAvatarGrid(el, avatars, emptyText, community) {
  el.replaceChildren();
  if (!avatars.length) {
    if (!emptyText) return;
    const note = document.createElement("div");
    note.className = "id-empty";
    note.textContent = emptyText;
    el.append(note);
    return;
  }
  const sorted = [...avatars].sort((a, b) =>
    String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }),
  );
  for (const avatar of sorted) el.append(avatarButton(community ? { ...avatar, community: true } : avatar));
}

function paintIdentitySelection() {
  const id = identityState?.streamIdentity?.avatarId || "";
  const imageUrl = identityState?.streamIdentity?.imageUrl || "";
  for (const btn of identityPop.querySelectorAll(".id-avatar")) {
    btn.classList.toggle("selected", btn.dataset.id === id);
  }
  for (const btn of idImages.querySelectorAll(".id-still")) {
    btn.classList.toggle("selected", !!imageUrl && btn.dataset.url === imageUrl);
  }
}

function canonicalPick(avatar) {
  const own = (identityState?.avatars || []).find((a) => a.avatarId === avatar.avatarId);
  if (own) return own;
  return avatar.community ? avatar : { ...avatar, community: true };
}

function focusedAvatar(data) {
  if (identityPick) return identityPick;
  const id = data?.streamIdentity?.avatarId;
  if (!id) return null;
  const own = (data.avatars || []).find((a) => a.avatarId === id);
  if (own) return own;
  const comm = (data.community?.avatars || []).find((a) => a.avatarId === id);
  if (comm) return { ...comm, community: true };
  const si = data.streamIdentity || {};
  const ownOwner = (data.avatars || [])[0]?.ownerUserId || "";
  return {
    avatarId: id,
    name: si.displayName || id,
    imageUrl: si.imageUrl || "",
    voiceId: si.voiceId || "set",
    ownerUserId: si.avatarOwnerUserId || "",
    community: !!si.avatarOwnerUserId && si.avatarOwnerUserId !== ownOwner,
  };
}

function renderIdentity() {
  const data = identityState;
  const focus = data?.connected ? focusedAvatar(data) : null;
  idClear.classList.toggle("hidden", !focus);
  if (!data?.connected) {
    stillsGen++;
    idImages.classList.add("hidden");
    idImages.replaceChildren();
    idOwn.replaceChildren();
    const note = document.createElement("div");
    note.className = "id-empty";
    note.textContent = "Connect Masky to choose the avatar that renders your messages on any JevChatHud stream.";
    const connect = document.createElement("button");
    connect.type = "button";
    connect.className = "primary";
    connect.textContent = "Connect Masky account";
    connect.addEventListener("click", async () => {
      connect.disabled = true;
      idStatus.textContent = "Waiting for browser login…";
      try {
        await hud.speakerLogin();
        settings = await hud.getSettings();
        renderMaskyAuth();
        await openIdentity();
      } catch (err) {
        idStatus.textContent = err.message || String(err);
        connect.disabled = false;
      }
    });
    idOwn.append(note, connect);
    idGame.textContent = "";
    fillAvatarGrid(idCommunity, [], "Connect Masky first.");
    idStatus.textContent = "";
    return;
  }
  fillAvatarGrid(idOwn, focus ? [focus] : (data.avatars || []), focus ? "" : "No avatars on this Masky account yet.");
  const community = data.community || {};
  idGame.textContent = community.gameName ? `(${community.gameName})` : "";
  const communityAvatars = (community.avatars || []).filter((a) => a.avatarId !== focus?.avatarId);
  fillAvatarGrid(idCommunity, communityAvatars, communityMessage(community), true);
  const current = data.streamIdentity;
  if (!identityPick) {
    idStatus.textContent = current?.avatarId
      ? `Using ${current.displayName || focus?.name || "this avatar"} on JevChatHud streams.`
      : "No identity set. Streams fall back to your Masky default.";
  }
  // A click handler loads stills itself. A saved identity loads them here,
  // and only shows the row when the avatar has more than one.
  if (identityPick) return;
  if (focus) void refreshStills(focus, { autosave: false });
  else {
    stillsGen++;
    idImages.classList.add("hidden");
    idImages.replaceChildren();
  }
}

async function openIdentity() {
  identityPick = null;
  stillsGen++;
  identityPop.classList.remove("hidden");
  idStatus.textContent = "Loading…";
  idOwn.replaceChildren();
  idCommunity.replaceChildren();
  idImages.classList.add("hidden");
  idClear.classList.add("hidden");
  try {
    identityState = await hud.identityLoad();
    renderIdentity();
  } catch (err) {
    idStatus.textContent = err.message || String(err);
  }
}

async function loadStills(avatar) {
  const community = !!(avatar.ownerUserId && avatar.community);
  try {
    const listed = await hud.identityImages(avatar.avatarId, community ? avatar.ownerUserId : "");
    if (listed?.images?.length) return listed.images;
  } catch (err) {
    if (!community || !avatar.imageUrl) throw err;
  }
  return avatar.imageUrl ? [{ url: avatar.imageUrl, isPrimary: true }] : [];
}

function paintStills(avatar, images) {
  const current = identityState?.streamIdentity;
  const already = current?.avatarId === avatar.avatarId;
  idImages.classList.remove("hidden");
  idImages.replaceChildren();
  for (const img of images) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "id-still";
    btn.dataset.url = img.url;
    if (already && (current.imageUrl ? current.imageUrl === img.url : img.isPrimary)) btn.classList.add("selected");
    const el = document.createElement("img");
    el.src = img.url;
    el.alt = "";
    btn.append(el);
    btn.addEventListener("click", () => saveIdentity(avatar, img.url));
    idImages.append(btn);
  }
}

async function refreshStills(avatar, { autosave }) {
  const gen = ++stillsGen;
  if (autosave) {
    idImages.classList.remove("hidden");
    idImages.replaceChildren();
    const pending = document.createElement("div");
    pending.className = "id-empty";
    pending.textContent = "Loading stills…";
    idImages.append(pending);
  }
  try {
    const images = await loadStills(avatar);
    if (gen !== stillsGen) return;
    if (images.length > 1) {
      paintStills(avatar, images);
      return;
    }
    idImages.classList.add("hidden");
    idImages.replaceChildren();
    if (!images.length) {
      if (autosave) idStatus.textContent = "This avatar has no images yet.";
      return;
    }
    if (!autosave) return;
    const current = identityState?.streamIdentity;
    const same = current?.avatarId === avatar.avatarId && (!current.imageUrl || current.imageUrl === images[0].url);
    if (!same) await saveIdentity(avatar, images[0].url);
    else identityPick = null;
  } catch (err) {
    if (gen !== stillsGen) return;
    idImages.classList.add("hidden");
    idStatus.textContent = err.message || String(err);
  }
}

async function chooseAvatar(avatar) {
  identityPick = canonicalPick(avatar);
  idStatus.textContent = "";
  renderIdentity();
  await refreshStills(identityPick, { autosave: true });
}

async function saveIdentity(avatar, imageUrl) {
  idStatus.textContent = "Saving…";
  const body = { avatarId: avatar.avatarId, imageUrl };
  if (avatar.community) {
    body.avatarOwnerUserId = avatar.ownerUserId || "";
    body.category = identityState?.community?.gameName || "";
  }
  try {
    const saved = await hud.identitySave(body);
    identityState = { ...identityState, streamIdentity: saved.streamIdentity };
    identityPick = null;
    paintIdentitySelection();
    const name = saved.streamIdentity?.displayName || avatar.name || "this avatar";
    idStatus.textContent = `Using ${name} on JevChatHud streams.`;
  } catch (err) {
    idStatus.textContent = err.message || String(err);
  }
}

identityBtn.addEventListener("click", () => {
  closeEmotePicker();
  if (identityPop.classList.contains("hidden")) openIdentity();
  else identityPop.classList.add("hidden");
});
identityClose.addEventListener("click", () => identityPop.classList.add("hidden"));
idClear.addEventListener("click", async () => {
  if (!identityState?.connected) return;
  const savedId = identityState?.streamIdentity?.avatarId || "";
  if (identityPick && identityPick.avatarId !== savedId) {
    identityPick = null;
    renderIdentity();
    return;
  }
  idStatus.textContent = "Clearing…";
  try {
    const saved = await hud.identitySave({ avatarId: null });
    identityPick = null;
    identityState = { ...identityState, streamIdentity: saved.streamIdentity };
    renderIdentity();
    idStatus.textContent = "Cleared. Streams fall back to your Masky default.";
  } catch (err) {
    idStatus.textContent = err.message || String(err);
  }
});
document.addEventListener("mousedown", (e) => {
  if (!identityPop.classList.contains("hidden")) {
    if (!identityPop.contains(e.target) && !identityBtn.contains(e.target)) {
      identityPop.classList.add("hidden");
    }
  }
  if (!emotePop.classList.contains("hidden")) {
    if (!emotePop.contains(e.target) && !emoteBtn.contains(e.target)) closeEmotePicker();
  }
});

const emoteBtn = document.getElementById("emote-btn");
const emotePop = document.getElementById("emote-pop");
const emoteSearch = document.getElementById("emote-search");
const emoteGroupsEl = document.getElementById("emote-groups");
const emoteClose = document.getElementById("emote-close");

function closeEmotePicker() {
  emotePop.classList.add("hidden");
  emoteBtn.classList.remove("active");
}

function openEmotePicker() {
  identityPop.classList.add("hidden");
  emotePop.classList.remove("hidden");
  emoteBtn.classList.add("active");
  renderEmotePicker();
  emoteSearch.focus();
}

function renderEmotePicker() {
  const q = emoteSearch.value.trim().toLowerCase();
  emoteGroupsEl.replaceChildren();
  let shown = 0;
  for (const group of emoteGroups) {
    const emotes = (group.emotes || []).filter((e) => !q || String(e.name).toLowerCase().includes(q));
    if (!emotes.length) continue;
    const wrap = document.createElement("div");
    wrap.className = "emote-group";
    const label = document.createElement("div");
    label.className = "emote-group-label";
    label.textContent = group.label;
    const grid = document.createElement("div");
    grid.className = "emote-grid";
    for (const em of emotes) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "emote-pick";
      btn.title = em.name;
      const img = document.createElement("img");
      img.src = em.url;
      img.alt = em.name;
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      btn.append(img);
      btn.addEventListener("click", () => pickEmote(em.name));
      grid.append(btn);
      shown += 1;
    }
    wrap.append(label, grid);
    emoteGroupsEl.append(wrap);
  }
  if (!shown) {
    const empty = document.createElement("div");
    empty.className = "emote-empty";
    empty.textContent = emoteGroups.length ? "No emotes match." : "Loading emotes…";
    emoteGroupsEl.append(empty);
  }
}

function pickEmote(name) {
  const start = chatInput.selectionStart ?? chatInput.value.length;
  const end = chatInput.selectionEnd ?? start;
  const next = insertEmoteName(chatInput.value, name, start, end);
  chatInput.value = next.value;
  chatInput.focus();
  chatInput.setSelectionRange(next.caret, next.caret);
}

emoteBtn.addEventListener("click", () => {
  if (emotePop.classList.contains("hidden")) openEmotePicker();
  else closeEmotePicker();
});
emoteClose.addEventListener("click", closeEmotePicker);
emoteSearch.addEventListener("input", renderEmotePicker);
hud.onEmotes(applyEmoteCatalog);

// ---------- init ----------

(async () => {
  settings = await hud.getSettings();
  relevancySlider.value = settings.relevancyThreshold;
  relevancyValue.textContent = settings.relevancyThreshold;
  factualSlider.value = settings.factualThreshold || 0;
  factualValue.textContent = factualSlider.value;
  setJevFiltering(settings.jevFiltering !== false, { animate: false, persist: false });
  buildTagBar();
  for (const k of settings.kindFilter || []) if (KINDS.includes(k)) selectedKinds.add(k);
  syncFilterControls();
  applyAppearance(settings.appearance || {});
  renderProfileSelect();
  updateEmptyState();
  await initLanguageSelect();
  try {
    twitchAccount = await hud.twitchStatus();
  } catch {
    twitchAccount = { connected: false };
  }
  renderCompose();
  try {
    applyEmoteCatalog(await hud.emotesGet());
  } catch {
    applyEmoteCatalog({ groups: [] });
  }
  // Resume listening if the mic was on when the app last closed.
  if (settings.mic?.enabled) {
    micListening = false;
    // don't pop the settings panel open on launch if whisper went missing
    await setMicListening(true, { persist: false, guide: false });
  }
  hud.speakerState(); // pushes the current Jev-speaks state to the statusbar
})();
