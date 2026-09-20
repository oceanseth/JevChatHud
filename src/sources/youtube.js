// YouTube live chat source: Data API v3 polling.
// config: { apiKey: "...", videoId: "dQw4..." } — videoId of the live broadcast.
// Quota note: liveChatMessages.list costs ~5 units/call; the API tells us how
// often to poll via pollingIntervalMillis.

function start(config, { onMessage, onStatus }) {
  const label = `youtube:${config.videoId}`;
  let stopped = false;
  let timer = null;
  let pageToken = null;
  let liveChatId = null;

  async function api(url) {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`youtube api ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  async function resolveChatId() {
    const data = await api(
      `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${encodeURIComponent(
        config.videoId
      )}&key=${encodeURIComponent(config.apiKey)}`
    );
    const details = data.items?.[0]?.liveStreamingDetails;
    if (!details?.activeLiveChatId) {
      throw new Error("video is not live or has no active chat");
    }
    return details.activeLiveChatId;
  }

  async function poll() {
    if (stopped) return;
    try {
      if (!liveChatId) {
        onStatus({ state: "connecting", label });
        liveChatId = await resolveChatId();
        onStatus({ state: "connected", label });
      }
      let url =
        `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${encodeURIComponent(liveChatId)}` +
        `&part=snippet,authorDetails&maxResults=200&key=${encodeURIComponent(config.apiKey)}`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
      const data = await api(url);

      // First page returns history; skip emitting it so the HUD starts "now".
      const firstPage = !pageToken;
      pageToken = data.nextPageToken;
      if (!firstPage) {
        for (const item of data.items || []) {
          if (item.snippet?.type !== "textMessageEvent") continue;
          onMessage({
            id: item.id,
            source: { type: "youtube", label: config.videoId },
            user: { name: item.authorDetails?.displayName || "unknown", color: null },
            text: item.snippet.displayMessage || "",
            ts: Date.parse(item.snippet.publishedAt) || Date.now(),
          });
        }
      }
      timer = setTimeout(poll, Math.max(data.pollingIntervalMillis || 3000, 1500));
    } catch (err) {
      onStatus({ state: "error", label, detail: String(err.message || err) });
      liveChatId = null; // re-resolve on next attempt (stream may have restarted)
      pageToken = null;
      timer = setTimeout(poll, 15000);
    }
  }

  poll();

  return () => {
    stopped = true;
    clearTimeout(timer);
    onStatus({ state: "stopped", label });
  };
}

module.exports = { start };
