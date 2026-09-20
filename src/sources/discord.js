// Discord chat source: gateway WebSocket with a bot token.
// The bot must be in the server with the Message Content intent enabled
// (Developer Portal -> Bot -> Privileged Gateway Intents).
// config: { botToken: "...", channelIds: ["123", ...], label: "my server" }
const WebSocket = require("ws");

const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
const INTENTS = (1 << 9) | (1 << 15); // GUILD_MESSAGES | MESSAGE_CONTENT

function start(config, { onMessage, onStatus }) {
  const label = `discord:${config.label || config.channelIds.join(",")}`;
  const wanted = new Set(config.channelIds.map(String));
  let ws = null;
  let heartbeat = null;
  let seq = null;
  let stopped = false;
  let retryMs = 1000;

  function connect() {
    if (stopped) return;
    onStatus({ state: "connecting", label });
    ws = new WebSocket(GATEWAY);

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.s != null) seq = msg.s;

      if (msg.op === 10) {
        // Hello: start heartbeating, then identify
        clearInterval(heartbeat);
        heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: seq }));
        }, msg.d.heartbeat_interval);
        ws.send(
          JSON.stringify({
            op: 2,
            d: {
              token: config.botToken,
              intents: INTENTS,
              properties: { os: process.platform, browser: "jevchathud", device: "jevchathud" },
            },
          })
        );
        return;
      }
      if (msg.op === 0 && msg.t === "READY") {
        retryMs = 1000;
        onStatus({ state: "connected", label });
        return;
      }
      if (msg.op === 0 && msg.t === "MESSAGE_CREATE") {
        const d = msg.d;
        if (!wanted.has(String(d.channel_id))) return;
        if (d.author?.bot) return;
        if (!d.content) return; // embeds/attachments only, or missing content intent
        onMessage({
          id: d.id,
          source: { type: "discord", label: config.label || d.channel_id },
          user: { name: d.member?.nick || d.author.global_name || d.author.username, color: null },
          text: d.content,
          ts: Date.parse(d.timestamp) || Date.now(),
        });
      }
    });

    const retry = () => {
      if (stopped) return;
      clearInterval(heartbeat);
      onStatus({ state: "reconnecting", label });
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    };
    ws.on("close", retry);
    ws.on("error", () => {}); // close always follows; retry happens there
  }

  connect();

  return () => {
    stopped = true;
    clearInterval(heartbeat);
    if (ws) ws.close();
    onStatus({ state: "stopped", label });
  };
}

module.exports = { start };
