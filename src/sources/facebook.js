// Facebook Live comment source: Graph API polling. EXPERIMENTAL — written to
// the documented API but not yet exercised against a real live video.
// config: { accessToken: "...", liveVideoId: "..." }
// The token needs pages_read_engagement (page live) or user live video access.

const GRAPH = "https://graph.facebook.com/v19.0";

function start(config, { onMessage, onStatus }) {
  const label = `facebook:${config.liveVideoId}`;
  let stopped = false;
  let timer = null;
  let since = Math.floor(Date.now() / 1000);
  const seen = new Set();

  async function poll() {
    if (stopped) return;
    try {
      const url =
        `${GRAPH}/${encodeURIComponent(config.liveVideoId)}/comments` +
        `?live_filter=no_filter&order=chronological&since=${since}` +
        `&fields=id,from{name},message,created_time` +
        `&access_token=${encodeURIComponent(config.accessToken)}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`facebook api ${res.status}: ${body.slice(0, 200)}`);
      }
      onStatus({ state: "connected", label });
      const data = await res.json();
      for (const c of data.data || []) {
        if (seen.has(c.id) || !c.message) continue;
        seen.add(c.id);
        if (seen.size > 5000) seen.delete(seen.values().next().value);
        const ts = Date.parse(c.created_time) || Date.now();
        since = Math.max(since, Math.floor(ts / 1000) - 1);
        onMessage({
          id: c.id,
          source: { type: "facebook", label: config.liveVideoId },
          user: { name: c.from?.name || "viewer", color: null },
          text: c.message,
          ts,
        });
      }
      timer = setTimeout(poll, 3000);
    } catch (err) {
      onStatus({ state: "error", label, detail: String(err.message || err) });
      timer = setTimeout(poll, 15000);
    }
  }

  onStatus({ state: "connecting", label });
  poll();

  return () => {
    stopped = true;
    clearTimeout(timer);
    onStatus({ state: "stopped", label });
  };
}

module.exports = { start };
