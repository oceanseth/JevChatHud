// Local speech-to-text for the streamer's microphone. Chunks of 16kHz mono
// Float32 PCM arrive from the renderer; each becomes a temp WAV transcribed by
// a local whisper.cpp binary (whisper-cli). A rolling transcript of the last
// ~75s is what the judge reads as `streamer_speech` context. Audio and
// transcript never leave the machine.
//
// Binary/model resolve from common install locations; config.json's mic block
// accepts `whisperBin` and `whisperModel` overrides (no UI — power users).
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SAMPLE_RATE = 16000;
const KEEP_MS = 75_000; // transcript retention; the judge reads the last 60s

const BIN_CANDIDATES = [
  "/opt/homebrew/bin/whisper-cli",
  "/usr/local/bin/whisper-cli",
];
const MODEL_CANDIDATES = [
  path.join(os.homedir(), ".cache", "jevchathud", "ggml-small.en.bin"),
  path.join(os.homedir(), ".cache", "whisper", "ggml-small.en.bin"),
  path.join(os.homedir(), ".cache", "hyperframes", "whisper", "models", "ggml-small.en.bin"),
  path.join(os.homedir(), ".cache", "hyperframes", "whisper", "models", "ggml-base.en.bin"),
];

function firstExisting(paths) {
  for (const p of paths) {
    try {
      fs.accessSync(p);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

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
  constructor({ whisperBin, whisperModel } = {}) {
    this.bin = whisperBin || firstExisting(BIN_CANDIDATES) || "whisper-cli";
    this.model = whisperModel || firstExisting(MODEL_CANDIDATES);
    this.lines = []; // { ts, text }
    this.busy = Promise.resolve();
  }

  available() {
    if (!this.model) {
      return {
        ok: false,
        error: "no whisper model found — brew install whisper-cpp and put ggml-small.en.bin in ~/.cache/whisper/",
      };
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
        const child = spawn(this.bin, ["-m", this.model, "-f", tmp, "-nt", "-np"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (e) =>
          reject(e.code === "ENOENT" ? new Error("whisper-cli not found — brew install whisper-cpp") : e)
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
