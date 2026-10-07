const { test } = require("node:test");
const assert = require("node:assert");
const { Transcriber, wavFromFloat32, SAMPLE_RATE } = require("../src/stt");

test("wavFromFloat32 writes a valid 16kHz mono 16-bit WAV", () => {
  const pcm = new Float32Array(SAMPLE_RATE); // 1s
  pcm[0] = 1;
  pcm[1] = -1;
  const wav = wavFromFloat32(pcm);
  assert.equal(wav.length, 44 + SAMPLE_RATE * 2);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(24), SAMPLE_RATE);
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readInt16LE(44), 32767); // +1 clamps to int16 max
  assert.equal(wav.readInt16LE(46), -32767);
});

test("rolling transcript: recentSpeech windows and prunes", () => {
  const t = new Transcriber();
  t.record("first line");
  t.record("second line");
  assert.equal(t.recentSpeech(), "first line second line");
  // age the first line out of a tiny window
  t.lines[0].ts -= 10_000;
  assert.equal(t.recentSpeech(5_000), "second line");
  // record() prunes anything older than retention
  t.lines[0].ts -= 80_000;
  t.record("third line");
  assert.deepEqual(t.lines.map((l) => l.text), ["second line", "third line"]);
  // empty text records nothing
  t.record("");
  assert.equal(t.lines.length, 2);
});

test("transcribe without a model reports a setup error, not a throw", async () => {
  const t = new Transcriber({ whisperModel: "/nonexistent/model.bin" });
  t.model = null; // simulate nothing found on this machine
  const res = await t.transcribe(new Float32Array(16000));
  assert.match(res.error, /whisper model/);
});

test("config overrides win over autodetection", () => {
  const t = new Transcriber({ whisperBin: "/custom/bin", whisperModel: "/custom/model.bin" });
  assert.equal(t.bin, "/custom/bin");
  assert.equal(t.model, "/custom/model.bin");
});
