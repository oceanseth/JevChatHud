// Guided install of the local whisper.cpp speech-to-text engine.
//
// whisper.cpp publishes prebuilt CLI binaries for Windows and Ubuntu on its
// GitHub releases (pinned tag below), so on those platforms the HUD can
// download the engine itself. There is no prebuilt macOS CLI — there the
// supported path is Homebrew, which this module can drive with streamed
// output when brew is present. Models (ggml) download from Hugging Face on
// every platform. Everything lands in app-owned directories; config.json's
// mic block (`whisperBin` / `whisperModel`) always wins over autodetection.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");

// Pinned whisper.cpp release that ships binary assets (the vX.Y.Z tags are
// source-only). Bump deliberately; archive layouts are verified per tag.
const WHISPER_TAG = "b5454";
const RELEASE_BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}`;
const MODEL_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

const MODELS = [
  { id: "base.en", label: "base.en — fast, recommended", bytes: 147964211 },
  { id: "small.en", label: "small.en — more accurate, slower", bytes: 487614201 },
];

const BREW_CANDIDATES = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];

function modelCacheDir() {
  return path.join(os.homedir(), ".cache", "jevchathud");
}

function modelPath(id) {
  return path.join(modelCacheDir(), `ggml-${id}.bin`);
}

/** The release asset for this platform/arch, or null when none exists (macOS). */
function binAsset(platform = process.platform, arch = process.arch) {
  if (platform === "win32") {
    const name =
      arch === "arm64" ? "whisper-bin-win-cpu-arm64.zip"
      : arch === "ia32" ? "whisper-bin-Win32.zip"
      : "whisper-bin-x64.zip";
    return { name, url: `${RELEASE_BASE}/${name}`, kind: "zip", exe: path.join("Release", "whisper-cli.exe") };
  }
  if (platform === "linux") {
    const base = arch === "arm64" ? "whisper-bin-ubuntu-arm64" : "whisper-bin-ubuntu-x64";
    return { name: `${base}.tar.gz`, url: `${RELEASE_BASE}/${base}.tar.gz`, kind: "tar", exe: path.join(base, "whisper-cli") };
  }
  return null; // macOS: Homebrew, no prebuilt CLI asset
}

/** Where a HUD-downloaded engine lives and the whisper-cli path inside it. */
function managedBinPath(userData, platform = process.platform, arch = process.arch) {
  const asset = binAsset(platform, arch);
  if (!asset) return null;
  return path.join(userData, "whisper-engine", asset.exe);
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(cmd, platform = process.platform) {
  const probe = spawnSync(platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  if (probe.status !== 0 || !probe.stdout) return null;
  const first = probe.stdout.split(/\r?\n/).find((l) => l.trim());
  return first ? first.trim() : null;
}

function findBrew() {
  for (const p of BREW_CANDIDATES) if (exists(p)) return p;
  return findOnPath("brew", "darwin");
}

const SYSTEM_BIN_CANDIDATES = [
  "/opt/homebrew/bin/whisper-cli",
  "/usr/local/bin/whisper-cli",
];
const SYSTEM_MODEL_CANDIDATES = (id) => [
  modelPath(id),
  path.join(os.homedir(), ".cache", "whisper", `ggml-${id}.bin`),
  path.join(os.homedir(), ".cache", "hyperframes", "whisper", "models", `ggml-${id}.bin`),
];

/**
 * Resolve the whisper binary + model for this machine. Config overrides win,
 * then the HUD-managed install, then system locations, then PATH.
 * Returns { whisperBin, whisperModel } with nulls for anything missing.
 */
function resolve({ userData, config = {} } = {}) {
  let bin = config.whisperBin || null;
  if (!bin) {
    const managed = userData ? managedBinPath(userData) : null;
    if (managed && exists(managed)) bin = managed;
  }
  if (!bin) bin = SYSTEM_BIN_CANDIDATES.find(exists) || null;
  if (!bin) bin = findOnPath("whisper-cli");

  let model = config.whisperModel || null;
  if (!model) {
    for (const id of ["small.en", "base.en"]) {
      const hit = SYSTEM_MODEL_CANDIDATES(id).find(exists);
      if (hit) {
        model = hit;
        break;
      }
    }
  }
  return { whisperBin: bin, whisperModel: model };
}

/** Full setup picture for the settings UI. */
function status({ userData, config = {} } = {}) {
  const { whisperBin, whisperModel } = resolve({ userData, config });
  const asset = binAsset();
  const brew = process.platform === "darwin" ? findBrew() : null;
  // A configured override wins in resolve() but may point at a deleted file;
  // the card should show that as missing, not as installed.
  const present = (p) => !!p && (!path.isAbsolute(p) || exists(p));
  return {
    platform: process.platform,
    bin: { ok: present(whisperBin), path: whisperBin },
    model: { ok: present(whisperModel), path: whisperModel },
    canDownloadBin: !!asset,
    binAssetName: asset?.name || null,
    brew: { found: !!brew, path: brew },
    brewCommand: "brew install whisper-cpp",
    models: MODELS,
  };
}

/** Stream a URL to a file with progress callbacks; atomic via .part + rename. */
async function downloadTo(url, dest, onProgress) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const part = `${dest}.part`;
  const out = fs.createWriteStream(part);
  let received = 0;
  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      onProgress?.({ received, total });
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    fs.renameSync(part, dest);
  } catch (err) {
    out.destroy();
    try { fs.unlinkSync(part); } catch {}
    throw err;
  }
  return dest;
}

/** Download a ggml model from Hugging Face. Resolves the model's path. */
async function downloadModel(id, { onProgress } = {}) {
  if (!MODELS.some((m) => m.id === id)) throw new Error(`unknown model ${id}`);
  const dest = modelPath(id);
  if (exists(dest)) return dest;
  await downloadTo(`${MODEL_BASE}/ggml-${id}.bin`, dest, onProgress);
  return dest;
}

function extractArchive(archive, destDir, kind) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const cmd =
    kind === "zip"
      ? // powershell ships on every supported Windows; avoids a zip dependency
        ["powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destDir}' -Force`]]
      : ["tar", ["xzf", archive, "-C", destDir]];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd[0], cmd[1], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(stderr.trim() || `extract exited ${code}`))
    );
  });
}

/**
 * Download + extract the prebuilt whisper-cli for this platform (Windows and
 * Linux only). Resolves the installed binary's path.
 */
async function downloadBinary({ userData, onProgress } = {}) {
  const asset = binAsset();
  if (!asset) throw new Error("no prebuilt whisper for this platform — install via Homebrew");
  const destDir = path.join(userData, "whisper-engine");
  const archive = path.join(os.tmpdir(), `jevhud-${asset.name}`);
  await downloadTo(asset.url, archive, onProgress);
  try {
    await extractArchive(archive, destDir, asset.kind);
  } finally {
    try { fs.unlinkSync(archive); } catch {}
  }
  const bin = path.join(destDir, asset.exe);
  if (!exists(bin)) throw new Error(`extracted archive is missing ${asset.exe}`);
  if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
  return bin;
}

/** Run `brew install whisper-cpp`, streaming output lines. Resolves bin path. */
async function brewInstall({ onLog } = {}) {
  const brew = findBrew();
  if (!brew) throw new Error("Homebrew not found — install it from https://brew.sh first");
  await new Promise((resolvePromise, reject) => {
    const child = spawn(brew, ["install", "whisper-cpp"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1" },
    });
    let lastLines = [];
    const feed = (d) => {
      for (const line of String(d).split("\n")) {
        const t = line.trim();
        if (!t) continue;
        lastLines = [...lastLines.slice(-4), t];
        onLog?.(t);
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(lastLines.join(" · ") || `brew exited ${code}`))
    );
  });
  const bin = SYSTEM_BIN_CANDIDATES.find(exists) || findOnPath("whisper-cli");
  if (!bin) throw new Error("brew finished but whisper-cli was not found");
  return bin;
}

module.exports = {
  WHISPER_TAG,
  MODELS,
  binAsset,
  managedBinPath,
  modelPath,
  resolve,
  status,
  downloadModel,
  downloadBinary,
  brewInstall,
  findBrew,
  __downloadToForTest: downloadTo,
};
