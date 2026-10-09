// Message-passing layer between the Translator (Electron main) and the
// translation engine host (an Electron utilityProcess). Pure and
// transport-agnostic: both sides speak through a tiny wire object
// ({ send(msg), onMessage(fn) }) so the protocol is testable in plain node.
//
// Protocol: requests are { id, op, ...args }; replies are
// { id, ok, result | error }. The host pushes { type: "progress", progress }
// while the model downloads.

/** Host side: serve an engine over `wire`, loading it on first use. */
function serveEngine(wire, loadEngine, cacheDir) {
  let enginePromise = null;
  const ensure = () => {
    if (!enginePromise) {
      enginePromise = loadEngine(cacheDir, (progress) => {
        wire.send({ type: "progress", progress });
      }).catch((e) => {
        enginePromise = null; // a failed load may be retried (e.g. network blip)
        throw e;
      });
    }
    return enginePromise;
  };
  wire.onMessage(async (msg) => {
    if (!msg || typeof msg !== "object" || !msg.id) return;
    try {
      let result = true;
      if (msg.op === "load") {
        await ensure();
      } else if (msg.op === "detect") {
        result = (await ensure()).detect(String(msg.text ?? ""));
      } else if (msg.op === "translate") {
        result = await (await ensure()).translate(String(msg.text ?? ""), msg.src, msg.tgt);
      } else {
        throw new Error(`unknown op: ${msg.op}`);
      }
      wire.send({ id: msg.id, ok: true, result });
    } catch (e) {
      wire.send({ id: msg.id, ok: false, error: e?.message || String(e) });
    }
  });
}

/** Client side: an engine-shaped proxy whose calls run in the host. */
function remoteEngine(wire, { onProgress } = {}) {
  let nextId = 1;
  let dead = null;
  const pending = new Map();
  wire.onMessage((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "progress") {
      onProgress?.(msg.progress);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || "translation engine error"));
  });
  function call(op, args) {
    if (dead) return Promise.reject(dead);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      wire.send({ id, op, ...args });
    });
  }
  return {
    load: () => call("load"),
    detect: (text) => call("detect", { text }),
    translate: (text, src, tgt) => call("translate", { text, src, tgt }),
    /** The transport died: fail everything in flight and everything after. */
    markDead(err) {
      dead = err || new Error("translation engine exited");
      for (const p of pending.values()) p.reject(dead);
      pending.clear();
    },
  };
}

module.exports = { serveEngine, remoteEngine };
