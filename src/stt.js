// Local speech-to-text for the streamer's microphone. Chunks of 16kHz mono
// Float32 PCM arrive from the renderer; each becomes a temp WAV transcribed by
// a local whisper.cpp binary (whisper-cli). A rolling transcript of the last
// ~75s is what the judge reads as `streamer_speech` context. Audio and
// transcript never leave the machine.
//
// Binary/model resolution lives in whisper_install (shared with the guided
// settings installer); config.json's mic block accepts `whisperBin` and
// `whisperModel` overrides, which always win.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const winstall = require("./whisper_install");

const SAMPLE_RATE = 16000;
const KEEP_MS = 75_000; // transcript retention; the judge reads the last 60s

const SETUP_HINT = "set it up in Settings → Microphone";

function wavFromFloat32(float32) {
  const pcm = Buffer.alloc(float32.length * 2);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

class Transcriber {
  constructor({ whisperBin, whisperModel, userData } = {}) {
    this.userData = userData || null;
    this.setPaths({ whisperBin, whisperModel });
    this.lines = []; // { ts, text }
    this.busy = Promise.resolve();
  }

  /** (Re)resolve binary + model, e.g. after the guided installer ran. */
  setPaths({ whisperBin, whisperModel } = {}) {
    const found = winstall.resolve({
      userData: this.userData,
      config: { whisperBin, whisperModel },
    });
    this.bin = found.whisperBin;
    this.model = found.whisperModel;
  }

  available() {
    // An absolute path that no longer exists (deleted install, stale config
    // override) needs setup just like nothing found at all.
    const present = (p) => !!p && (!path.isAbsolute(p) || fs.existsSync(p));
    if (!present(this.bin)) {
      return { ok: false, needsSetup: true, error: `whisper engine not installed — ${SETUP_HINT}` };
    }
    if (!present(this.model)) {
      return { ok: false, needsSetup: true, error: `no whisper speech model — ${SETUP_HINT}` };
    }
    return { ok: true };
  }

  /** Transcribe one Float32 PCM chunk; resolves { text } or { error }. */
  transcribe(float32) {
    // Serialize runs: chunks arrive every ~5s, but a slow machine must not
    // stack concurrent whisper processes.
    const run = this.busy
      .then(() => this._run(float32))
      .catch((err) => ({ error: String(err.message || err) }));
    this.busy = run.then(() => {});
    return run;
  }

  async _run(float32) {
    const avail = this.available();
    if (!avail.ok) return { error: avail.error };
    const tmp = path.join(os.tmpdir(), `jevhud-stt-${process.pid}-${Date.now()}.wav`);
    fs.writeFileSync(tmp, wavFromFloat32(float32));
    try {
      const out = await new Promise((resolve, reject) => {
        // The HUD-downloaded Linux build ships its shared libs next to the
        // binary; point the loader there. Windows resolves DLLs beside the
        // exe on its own.
        const env =
          process.platform === "linux"
            ? { ...process.env, LD_LIBRARY_PATH: [path.dirname(this.bin), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }
            : process.env;
        const child = spawn(this.bin, ["-m", this.model, "-f", tmp, "-nt", "-np"], {
          stdio: ["ignore", "pipe", "pipe"],
          env,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (e) =>
          reject(e.code === "ENOENT" ? new Error(`whisper engine missing — ${SETUP_HINT}`) : e)
        );
        child.on("close", (code) =>
          code === 0
            ? resolve(stdout)
            : reject(new Error(stderr.trim().split("\n").pop() || `whisper exited ${code}`))
        );
      });
      // Whisper annotates non-speech as [BLANK_AUDIO] / (coughs) etc. — drop them.
      const text = out
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/\([^)]*\)/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return { text };
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* already gone */
      }
    }
  }

  /** Fold a transcribed line into the rolling transcript. */
  record(text) {
    const now = Date.now();
    if (text) this.lines.push({ ts: now, text });
    this.lines = this.lines.filter((l) => now - l.ts < KEEP_MS);
  }

  /** The last `windowMs` of streamer speech as one string ("" if none). */
  recentSpeech(windowMs = 60_000) {
    const cutoff = Date.now() - windowMs;
    return this.lines
      .filter((l) => l.ts >= cutoff)
      .map((l) => l.text)
      .join(" ");
  }
}

module.exports = { Transcriber, wavFromFloat32, SAMPLE_RATE };
