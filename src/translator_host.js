// Entry point for the translation engine's Electron utilityProcess.
//
// Model load and inference happen here, off the main process, so a streamer's
// window never stutters while chat translates. The whole process runs at
// below-normal OS priority: when the game, encoder, or UI wants the CPU,
// translation yields and a message simply translates a beat later.
const os = require("os");
const { loadRealEngine } = require("./translator");
const { serveEngine } = require("./translator_rpc");

try {
  os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  // priority is an optimization, never a requirement
}

const cacheDir = process.argv[2];
const port = process.parentPort;
serveEngine(
  {
    send: (msg) => port.postMessage(msg),
    onMessage: (fn) => port.on("message", (e) => fn(e.data)),
  },
  loadRealEngine,
  cacheDir,
);
