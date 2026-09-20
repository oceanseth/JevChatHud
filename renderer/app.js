/* global hud, messageVisible, KINDS, KIND_CONFIDENCE_MIN */
const MAX_ROWS = 600;

const feed = document.getElementById("feed");
const profileSelect = document.getElementById("profile-select");
const relevancySlider = document.getElementById("relevancy");
const relevancyValue = document.getElementById("relevancy-value");
const seeAllCheck = document.getElementById("see-all");
const statusRow = document.getElementById("status-row");
const statsEl = document.getElementById("stats");
const judgeErrorEl = document.getElementById("judge-error");
const pinBtn = document.getElementById("pin-btn");
const tagbar = document.getElementById("tagbar");
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
    seeAll: seeAllCheck.checked,
    kinds: [...selectedKinds],
    threshold: Number(relevancySlider.value),
  });
  row.classList.toggle("hidden-by-filter", !visible);
}

function refilterAll() {
  for (const row of rows.values()) applyFilter(row);
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
  text.textContent = msg.text;
  body.append(user, text);

  const badges = document.createElement("span");
  badges.className = "badges";
  const relChip = document.createElement("span");
  relChip.className = "chip rel pending";
  relChip.textContent = "…";
  badges.append(relChip);

  row.append(time, srcChip, body, badges);
  row._relChip = relChip;
  row._badges = badges;

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
    row._relChip.textContent = judgment.relevancy;
    row._relChip.className = `chip rel ${relClass(judgment.relevancy)}`;
    row._relChip.title = `relevancy ${judgment.relevancy}/100 (confidence ${judgment.relevanceConfidence.toFixed(2)})`;

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
    statCell("avg relevancy", profile.avgRelevancy == null ? "—" : String(profile.avgRelevancy))
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
  // Communicate precedence: tags replace the slider; "see all" bypasses both.
  document.getElementById("relevancy-label").classList.toggle("inactive", tagsActive || seeAllCheck.checked);
  relevancySlider.disabled = tagsActive;
  relevancySlider.title = tagsActive ? "tag filter active — clear tags to use the relevancy slider" : "";
  tagbar.classList.toggle("inactive", seeAllCheck.checked);
}

function setKinds(kinds) {
  selectedKinds.clear();
  for (const k of kinds) selectedKinds.add(k);
  // Picking a tag means "curate for me" — drop out of the raw firehose view.
  if (selectedKinds.size && seeAllCheck.checked) {
    seeAllCheck.checked = false;
    hud.updateSettings({ seeAll: false });
  }
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
});

relevancySlider.addEventListener("input", () => {
  relevancyValue.textContent = relevancySlider.value;
  refilterAll();
});
relevancySlider.addEventListener("change", () => {
  hud.updateSettings({ relevancyThreshold: Number(relevancySlider.value) });
});

seeAllCheck.addEventListener("change", () => {
  hud.updateSettings({ seeAll: seeAllCheck.checked });
  syncFilterControls();
  refilterAll();
});

pinBtn.addEventListener("click", async () => {
  settings = await hud.updateSettings({ alwaysOnTop: !settings.alwaysOnTop });
  pinBtn.classList.toggle("active", settings.alwaysOnTop);
});

// ---------- settings panel ----------

const overlay = document.getElementById("overlay");
const apiKeyInput = document.getElementById("api-key");
const modelInput = document.getElementById("model");
const editProfileSelect = document.getElementById("edit-profile-select");
const profileNameInput = document.getElementById("profile-name");
const profileContextInput = document.getElementById("profile-context");
const sourcesList = document.getElementById("sources-list");

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
    : { id: null, name: "", context: "", sources: [] };
  profileNameInput.value = editingProfile.name || "";
  profileContextInput.value = editingProfile.context || "";
  renderSources();
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

editProfileSelect.addEventListener("change", () => {
  const p = settings.profiles.find((x) => x.id === editProfileSelect.value);
  loadProfileIntoEditor(p || null);
});

document.getElementById("new-profile-btn").addEventListener("click", () => {
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
    // Put the new source's first field in front of the user immediately.
    const items = sourcesList.querySelectorAll(".source-item");
    items[items.length - 1]?.querySelector("input")?.focus();
  });
}

function openSettingsPanel({ focusSources = false } = {}) {
  apiKeyInput.value = settings.typesafeApiKey || "";
  modelInput.value = settings.model || "jev-latest";
  const a = settings.appearance || {};
  fontSelect.value = a.fontFamily || "system";
  densitySelect.value = a.density || "cozy";
  sizeSlider.value = a.fontSize || 13;
  sizeValue.textContent = sizeSlider.value;
  timestampsCheck.checked = !!a.timestamps;
  const active = settings.profiles.find((p) => p.id === settings.activeProfileId);
  renderEditProfileSelect(active?.id || "");
  loadProfileIntoEditor(active || null);
  overlay.classList.remove("hidden");
  if (focusSources) {
    document.getElementById("sources-heading").scrollIntoView({ block: "start" });
  }
}

document.getElementById("settings-btn").addEventListener("click", () => openSettingsPanel());
document.getElementById("add-source-shortcut").addEventListener("click", () => openSettingsPanel({ focusSources: true }));

document.getElementById("close-panel-btn").addEventListener("click", () => {
  overlay.classList.add("hidden");
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!userOverlay.classList.contains("hidden")) closeUserProfile();
  else if (!overlay.classList.contains("hidden")) overlay.classList.add("hidden");
});

document.getElementById("save-panel-btn").addEventListener("click", async () => {
  settings = await hud.updateSettings({
    typesafeApiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim() || "jev-latest",
  });
  editingProfile.name = profileNameInput.value.trim();
  editingProfile.context = profileContextInput.value;
  if (editingProfile.name || editingProfile.sources.length) {
    const saved = await hud.saveProfile(editingProfile);
    editingProfile.id = saved.id;
    settings = await hud.getSettings();
    renderEditProfileSelect(saved.id);
    // If we edited the live profile, restart its streams with the new config.
    if (settings.activeProfileId === saved.id) {
      clearFeed();
      await hud.activateProfile(saved.id);
    }
  }
  renderProfileSelect();
  updateEmptyState();
  overlay.classList.add("hidden");
});

// ---------- events from main ----------

hud.onMessage(addMessage);
hud.onJudged(markJudged);
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
  }
});
hud.onOpenSettings(() => openSettingsPanel());

// ---------- init ----------

(async () => {
  settings = await hud.getSettings();
  relevancySlider.value = settings.relevancyThreshold;
  relevancyValue.textContent = settings.relevancyThreshold;
  seeAllCheck.checked = settings.seeAll;
  pinBtn.classList.toggle("active", settings.alwaysOnTop);
  buildTagBar();
  for (const k of settings.kindFilter || []) if (KINDS.includes(k)) selectedKinds.add(k);
  syncFilterControls();
  applyAppearance(settings.appearance || {});
  renderProfileSelect();
  updateEmptyState();
})();
