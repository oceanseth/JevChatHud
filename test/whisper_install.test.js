const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const winstall = require("../src/whisper_install");

test("binAsset picks the right prebuilt per platform/arch", () => {
  assert.equal(winstall.binAsset("win32", "x64").name, "whisper-bin-x64.zip");
  assert.equal(winstall.binAsset("win32", "arm64").name, "whisper-bin-win-cpu-arm64.zip");
  assert.equal(winstall.binAsset("win32", "ia32").name, "whisper-bin-Win32.zip");
  assert.equal(winstall.binAsset("linux", "x64").name, "whisper-bin-ubuntu-x64.tar.gz");
  assert.equal(winstall.binAsset("linux", "arm64").name, "whisper-bin-ubuntu-arm64.tar.gz");
  assert.equal(winstall.binAsset("darwin", "arm64"), null); // Homebrew path
  // every asset URL is pinned to the verified release tag
  assert.match(winstall.binAsset("win32", "x64").url, new RegExp(`/${winstall.WHISPER_TAG}/`));
});

test("windows archives extract Release/whisper-cli.exe, linux tarballs whisper-cli", () => {
  assert.equal(winstall.binAsset("win32", "x64").exe, path.join("Release", "whisper-cli.exe"));
  assert.equal(
    winstall.binAsset("linux", "x64").exe,
    path.join("whisper-bin-ubuntu-x64", "whisper-cli")
  );
});

test("managedBinPath lives under the app's userData", () => {
  const p = winstall.managedBinPath("/ud", "win32", "x64");
  assert.equal(p, path.join("/ud", "whisper-engine", "Release", "whisper-cli.exe"));
  assert.equal(winstall.managedBinPath("/ud", "darwin", "arm64"), null);
});

test("resolve: config overrides beat autodetection", () => {
  const r = winstall.resolve({ config: { whisperBin: "/my/bin", whisperModel: "/my/model.bin" } });
  assert.equal(r.whisperBin, "/my/bin");
  assert.equal(r.whisperModel, "/my/model.bin");
});

test("resolve finds a downloaded model in ~/.cache/jevchathud", () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "jevhud-home-"));
  const saved = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome; // os.homedir() reads HOME on posix…
  process.env.USERPROFILE = fakeHome; // …and USERPROFILE on Windows
  try {
    const dir = path.join(fakeHome, ".cache", "jevchathud");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ggml-base.en.bin"), "x");
    const r = winstall.resolve({ config: { whisperBin: "/my/bin" } });
    assert.equal(r.whisperModel, path.join(dir, "ggml-base.en.bin"));
  } finally {
    process.env.HOME = saved;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("status reports what the settings card needs", () => {
  const st = winstall.status({ config: { whisperBin: __filename, whisperModel: __filename } });
  assert.equal(st.bin.ok, true);
  assert.equal(st.model.ok, true);
  // a configured override pointing at a deleted file shows as missing
  const gone = winstall.status({
    config: { whisperBin: "/nonexistent/bin", whisperModel: "/nonexistent/model.bin" },
  });
  assert.equal(gone.bin.ok, false);
  assert.equal(gone.model.ok, false);
  assert.equal(typeof st.canDownloadBin, "boolean");
  assert.equal(st.brewCommand, "brew install whisper-cpp");
  assert.ok(st.models.length >= 2);
  assert.ok(st.models.every((m) => m.id && m.label && m.bytes > 0));
});

test("downloadModel rejects unknown model ids", async () => {
  await assert.rejects(() => winstall.downloadModel("bogus.v9"), /unknown model/);
});

// Exercise the real streaming download path (progress + atomic .part rename)
// against a local HTTP server standing in for Hugging Face/GitHub.
test("downloads stream to disk with progress and no stray .part file", async () => {
  const body = Buffer.alloc(300_000, 7);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-length": body.length });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevhud-dl-"));
  const dest = path.join(dir, "out.bin");
  try {
    const url = `http://127.0.0.1:${server.address().port}/file.bin`;
    const seen = [];
    // downloadTo is internal; reach it through the test export for a real
    // integration run of fetch → stream → rename.
    await winstall.__downloadToForTest(url, dest, (p) => seen.push(p));
    assert.equal(fs.readFileSync(dest).length, body.length);
    assert.ok(!fs.existsSync(`${dest}.part`));
    assert.ok(seen.length > 0);
    assert.equal(seen.at(-1).received, body.length);
    assert.equal(seen.at(-1).total, body.length);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
