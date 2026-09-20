// Twitch chat source: anonymous IRC over WebSocket. Read-only, no OAuth.
// Uses the wss endpoint (port 443) — the raw 6697 edge can present certs
// that fail hostname verification, and 443 traverses firewalls.
// config: { channel: "sodapoppin" }
const WebSocket = require("ws");
const crypto = require("crypto");

const GATEWAY = "wss://irc-ws.chat.twitch.tv:443";

function parseTags(raw) {
  const tags = {};
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) tags[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return tags;
}

function start(config, { onMessage, onStatus }) {
  const channel = config.channel.replace(/^#/, "").toLowerCase();
  const label = `twitch:#${channel}`;
  let ws = null;
  let stopped = false;
  let retryMs = 1000;
  let retryTimer = null;

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    onStatus({ state: "reconnecting", label });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, 30000);
  }

  function connect() {
    if (stopped) return;
    onStatus({ state: "connecting", label });
    ws = new WebSocket(GATEWAY);

    ws.on("open", () => {
      const nick = "justinfan" + Math.floor(100000 + Math.random() * 900000);
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      ws.send(`NICK ${nick}`);
    });

    ws.on("message", (data) => {
      for (const line of data.toString().split("\r\n")) {
        if (line) handleLine(line);
      }
    });

    ws.on("close", scheduleRetry);
    ws.on("error", () => {}); // close always follows; retry happens there
  }

  function handleLine(line) {
    if (line.startsWith("PING")) {
      ws.send("PONG :tmi.twitch.tv");
      return;
    }
    let tags = {};
    let rest = line;
    if (rest.startsWith("@")) {
      const sp = rest.indexOf(" ");
      tags = parseTags(rest.slice(1, sp));
      rest = rest.slice(sp + 1);
    }
    // :nick!user@host COMMAND #chan :text
    const m = rest.match(/^:(\S+) (\S+)(?: (.*))?$/);
    if (!m) return;
    const [, prefix, command, paramsRaw] = m;

    if (command === "001") {
      ws.send(`JOIN #${channel}`);
      return;
    }
    if (command === "JOIN") {
      retryMs = 1000;
      onStatus({ state: "connected", label });
      return;
    }
    if (command === "PRIVMSG") {
      const colon = paramsRaw.indexOf(" :");
      if (colon < 0) return;
      const text = paramsRaw.slice(colon + 2);
      const user = tags["display-name"] || prefix.split("!")[0];
      onMessage({
        id: tags.id || crypto.randomUUID(),
        source: { type: "twitch", label: `#${channel}` },
        user: { name: user, color: tags.color || null },
        text,
        ts: Number(tags["tmi-sent-ts"]) || Date.now(),
      });
    }
  }

  connect();

  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    if (ws) ws.close();
    onStatus({ state: "stopped", label });
  };
}

module.exports = { start, parseTags };
