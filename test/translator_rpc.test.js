const { test } = require("node:test");
const assert = require("node:assert");
const { serveEngine, remoteEngine } = require("../src/translator_rpc");

/** Two wires joined back to back, like a utilityProcess channel in memory. */
function wirePair() {
  const aHandlers = [];
  const bHandlers = [];
  const wireA = {
    send: (m) => queueMicrotask(() => bHandlers.forEach((f) => f(m))),
    onMessage: (f) => aHandlers.push(f),
  };
  const wireB = {
    send: (m) => queueMicrotask(() => aHandlers.forEach((f) => f(m))),
    onMessage: (f) => bHandlers.push(f),
  };
  return [wireA, wireB];
}

function fakeLoad({ fail = false } = {}) {
  const state = { loads: 0, progressSent: false };
  state.loadEngine = async (cacheDir, onProgress) => {
    state.loads++;
    state.cacheDir = cacheDir;
    onProgress({ file: "model.onnx", loaded: 1, total: 2 });
    state.progressSent = true;
    if (fail && state.loads === 1) throw new Error("download died");
    return {
      detect: (text) => ({ lang: text.startsWith("hola") ? "es" : "en", reliable: true }),
      translate: async (text, src, tgt) => `[${src}->${tgt}]${text}`,
    };
  };
  return state;
}

test("remote engine round-trips load, detect, and translate", async () => {
  const [client, host] = wirePair();
  const state = fakeLoad();
  serveEngine(host, state.loadEngine, "/tmp/cache");
  const progress = [];
  const remote = remoteEngine(client, { onProgress: (p) => progress.push(p) });
  await remote.load();
  assert.equal(state.cacheDir, "/tmp/cache");
  assert.deepEqual(progress, [{ file: "model.onnx", loaded: 1, total: 2 }]);
  assert.deepEqual(await remote.detect("hola amigos"), { lang: "es", reliable: true });
  assert.equal(await remote.translate("hola", "es", "en"), "[es->en]hola");
  assert.equal(state.loads, 1); // one engine serves every op
});

test("a failed load rejects, then a retry loads fresh", async () => {
  const [client, host] = wirePair();
  const state = fakeLoad({ fail: true });
  serveEngine(host, state.loadEngine, "/c");
  const remote = remoteEngine(client, {});
  await assert.rejects(remote.load(), /download died/);
  await remote.load(); // second attempt succeeds
  assert.equal(state.loads, 2);
  assert.equal(await remote.translate("hi", "en", "es"), "[en->es]hi");
});

test("unknown ops report an error instead of hanging", async () => {
  const [client, host] = wirePair();
  serveEngine(host, fakeLoad().loadEngine, "/c");
  const remote = remoteEngine(client, {});
  await assert.rejects(
    new Promise((resolve, reject) => {
      client.onMessage((m) => (m.id === 99 ? (m.ok ? resolve(m) : reject(new Error(m.error))) : null));
      client.send({ id: 99, op: "reticulate" });
    }),
    /unknown op/,
  );
  assert.equal(await remote.translate("ok", "en", "es"), "[en->es]ok"); // host still alive
});

test("markDead fails in-flight and future calls", async () => {
  const [client] = wirePair(); // no host: calls stay in flight
  const remote = remoteEngine(client, {});
  const inFlight = remote.translate("hola", "es", "en");
  remote.markDead(new Error("engine exited"));
  await assert.rejects(inFlight, /engine exited/);
  await assert.rejects(remote.detect("hola"), /engine exited/);
});
