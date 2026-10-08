const { test } = require("node:test");
const assert = require("node:assert");
const {
  CLIENT_ID,
  activeTwitchChannel,
  publicTwitch,
  startDeviceFlow,
  pollDeviceToken,
  channelCategory,
  sendChatMessage,
} = require("../src/twitch_auth");

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("activeTwitchChannel reads the active profile's twitch source", () => {
  const settings = {
    activeProfileId: "p1",
    profiles: [
      { id: "p1", sources: [{ type: "youtube", channel: "nope" }, { type: "twitch", channel: "#SoDaPoppin" }] },
      { id: "p2", sources: [{ type: "twitch", channel: "other" }] },
    ],
  };
  assert.equal(activeTwitchChannel(settings), "sodapoppin");
  assert.equal(activeTwitchChannel({ activeProfileId: "missing", profiles: [] }), "");
});

test("publicTwitch never includes the access token", () => {
  const pub = publicTwitch({
    accessToken: "secret",
    login: "oceanseth",
    displayName: "OceanSeth",
    userId: "42",
    profileImageUrl: "https://img",
  });
  assert.equal(pub.connected, true);
  assert.equal(pub.displayName, "OceanSeth");
  assert.equal("accessToken" in pub, false);
  assert.equal(publicTwitch({}).connected, false);
});

test("startDeviceFlow posts the Masky client id and user:write:chat", async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, body: opts.body };
    return jsonResponse({
      device_code: "dev",
      user_code: "ABCD1234",
      verification_uri: "https://www.twitch.tv/activate?device-code=ABCD1234",
      expires_in: 1800,
      interval: 5,
    });
  };
  const flow = await startDeviceFlow({ fetchImpl });
  assert.equal(flow.userCode, "ABCD1234");
  assert.match(seen.url, /oauth2\/device$/);
  assert.match(seen.body, new RegExp(`client_id=${CLIENT_ID}`));
  assert.match(seen.body, /user%3Awrite%3Achat|user:write:chat/);
});

test("pollDeviceToken waits out authorization_pending and slow_down", async () => {
  const messages = ["authorization_pending", "slow_down", null];
  const fetchImpl = async () => {
    const message = messages.shift();
    if (!message) return jsonResponse({ access_token: "tok", scope: "user:write:chat" });
    return jsonResponse({ status: 400, message }, 400);
  };
  let slept = 0;
  const tok = await pollDeviceToken("dev", {
    fetchImpl,
    sleepImpl: async (ms) => {
      slept += ms;
    },
    intervalSec: 1,
    expiresInSec: 30,
  });
  assert.equal(tok.accessToken, "tok");
  // 1s, then another 1s, then 1s+5s after slow_down
  assert.equal(slept, 1000 + 1000 + 6000);
});

test("channelCategory prefers the live game over the channel's saved category", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/users?")) return jsonResponse({ data: [{ id: "9", login: "jev" }] });
    if (url.includes("/streams?")) return jsonResponse({ data: [{ game_name: "Path of Exile" }] });
    if (url.includes("/channels?")) return jsonResponse({ data: [{ game_name: "Just Chatting" }] });
    throw new Error(url);
  };
  const live = await channelCategory("tok", "jev", { fetchImpl });
  assert.deepEqual(live, { broadcasterId: "9", gameName: "Path of Exile" });
});

test("channelCategory falls back to the channel category when the stream is offline", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/users?")) return jsonResponse({ data: [{ id: "9" }] });
    if (url.includes("/streams?")) return jsonResponse({ data: [] });
    if (url.includes("/channels?")) return jsonResponse({ data: [{ game_name: "Just Chatting" }] });
    throw new Error(url);
  };
  const off = await channelCategory("tok", "jev", { fetchImpl });
  assert.equal(off.gameName, "Just Chatting");
});

test("sendChatMessage posts Helix chat/messages and surfaces a drop reason", async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return jsonResponse({
      data: [{ message_id: "", is_sent: false, drop_reason: { code: "msg_rejected", message: "Followers-only mode is on" } }],
    });
  };
  await assert.rejects(
    () => sendChatMessage({
      token: "tok",
      broadcasterId: "b",
      senderId: "s",
      message: "  hello  ",
      fetchImpl,
    }),
    /Followers-only/,
  );
  assert.match(seen.url, /\/chat\/messages$/);
  assert.equal(seen.opts.headers["client-id"], CLIENT_ID);
  assert.equal(seen.opts.headers.authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(seen.opts.body), {
    broadcaster_id: "b",
    sender_id: "s",
    message: "hello",
  });
});

test("sendChatMessage returns the message id when Twitch accepts it", async () => {
  const fetchImpl = async () => jsonResponse({ data: [{ message_id: "m1", is_sent: true }] });
  const res = await sendChatMessage({
    token: "tok",
    broadcasterId: "b",
    senderId: "s",
    message: "hi",
    fetchImpl,
  });
  assert.equal(res.messageId, "m1");
});
