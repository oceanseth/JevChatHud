// MaskyClient wire behavior: output-aware speak polling and the owner-slug
// resolution behind the "create avatar" deep link.
const { test } = require("node:test");
const assert = require("node:assert");
const { MaskyClient } = require("../src/masky");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("speak with output:audio sends output audio and resolves the audioUrl", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (opts.method === "POST") {
      assert.equal(JSON.parse(opts.body).output, "audio");
      return jsonResponse({ generationId: "g1", generation: { status: "pending" } });
    }
    // first poll still rendering, second poll done (status audio is terminal)
    return calls.length < 3
      ? jsonResponse({ generation: { status: "pending" } })
      : jsonResponse({ generation: { status: "audio", audioUrl: "https://signed/a.mp3", creditsCharged: 0.004 } });
  };
  const client = new MaskyClient({ fetchImpl });
  const orig = client.waitForResult.bind(client);
  client.waitForResult = (token, id, want) => orig(token, id, want, { timeoutMs: 2000, everyMs: 1 });
  const res = await client.speak({ token: "mky_t", ownerUserId: "o", avatarId: "a", text: "hi", output: "audio" });
  assert.equal(res.url, "https://signed/a.mp3");
  assert.equal(res.creditsCharged, 0.004);
});

test("speak defaults to video output and still waits for the videoUrl", async () => {
  let posts = 0;
  const fetchImpl = async (url, opts) => {
    if (opts.method === "POST") {
      posts++;
      assert.equal(JSON.parse(opts.body).output, "video");
      // intermediate 'audio' status with an audioUrl must NOT satisfy a video render
      return jsonResponse({ generationId: "g2", generation: { status: "audio", audioUrl: "https://signed/a.mp3" } });
    }
    return jsonResponse({ generation: { status: "video", audioUrl: "https://signed/a.mp3", videoUrl: "https://signed/v.mp4" } });
  };
  const client = new MaskyClient({ fetchImpl });
  const orig = client.waitForResult.bind(client);
  client.waitForResult = (token, id, want) => orig(token, id, want, { timeoutMs: 2000, everyMs: 1 });
  const res = await client.speak({ token: "mky_t", ownerUserId: "o", avatarId: "a", text: "hi" });
  assert.equal(posts, 1);
  assert.equal(res.url, "https://signed/v.mp4");
});

test("ownerSlug prefers handle, then twitch, then uid — falling back to avatar rows", async () => {
  const client = (body) =>
    new MaskyClient({ fetchImpl: async () => jsonResponse(body) });
  assert.equal(
    await client({ owner: { username: "seth", twitchUsername: "oceanseth", userId: "u1" }, avatars: [] }).ownerSlug("t"),
    "seth",
  );
  assert.equal(
    await client({ owner: { twitchUsername: "oceanseth", userId: "u1" }, avatars: [] }).ownerSlug("t"),
    "oceanseth",
  );
  // pre-owner-field API responses: derive from the first avatar row
  assert.equal(
    await client({ avatars: [{ avatarOwnerTwitchUsername: "oceanseth", avatarOwnerUserId: "u1" }] }).ownerSlug("t"),
    "oceanseth",
  );
  assert.equal(await client({ avatars: [{ avatarOwnerUserId: "u1" }] }).ownerSlug("t"), "u1");
  // nothing resolvable -> null (caller falls back to masky.ai)
  assert.equal(await client({ avatars: [] }).ownerSlug("t"), null);
});

test("lookupUserAvatar prefers the voiced self-avatar and lowercases the query", async () => {
  let requested;
  const fetchImpl = async (url) => {
    requested = url;
    return jsonResponse({
      found: true,
      owner: { userId: "twitch:42", twitchUsername: "chatfan" },
      avatars: [
        { avatarId: "noVoice", avatarOwnerUserId: "twitch:42", isDefaultAvatar: false, voiceId: null },
        { avatarId: "pub", avatarOwnerUserId: "twitch:42", isDefaultAvatar: false, voiceId: "v1", displayName: "Alt" },
        { avatarId: "self", avatarOwnerUserId: "twitch:42", isDefaultAvatar: true, voiceId: "v2", displayName: "ChatFan" },
      ],
    });
  };
  const client = new MaskyClient({ fetchImpl });
  const res = await client.lookupUserAvatar("mky_t", "ChatFan");
  assert.ok(requested.endsWith("/avatars/lookup?user=chatfan"));
  assert.deepEqual(res, { ownerUserId: "twitch:42", avatarId: "self", name: "ChatFan" });
});

test("lookupUserAvatar: not found, voiceless, 404, and blank all resolve null", async () => {
  const mk = (body, status) => new MaskyClient({ fetchImpl: async () => jsonResponse(body, status) });
  assert.equal(await mk({ found: false }).lookupUserAvatar("t", "ghost"), null);
  assert.equal(
    await mk({ found: true, owner: {}, avatars: [{ avatarId: "a", voiceId: null }] }).lookupUserAvatar("t", "mute"),
    null,
  );
  // endpoint not deployed yet -> feature silently off, not an error
  assert.equal(await mk({ error: "Route not found" }, 404).lookupUserAvatar("t", "x"), null);
  assert.equal(await mk({}).lookupUserAvatar("t", "   "), null);
});

test("lookupUserAvatar falls back to a voiced public avatar when the self-avatar is mute", async () => {
  const client = new MaskyClient({
    fetchImpl: async () =>
      jsonResponse({
        found: true,
        owner: {},
        avatars: [
          { avatarId: "self", avatarOwnerUserId: "u", isDefaultAvatar: true, voiceId: null },
          { avatarId: "pub", avatarOwnerUserId: "u", isDefaultAvatar: false, voiceId: "v", displayName: "Alt" },
        ],
      }),
  });
  const res = await client.lookupUserAvatar("t", "someone");
  assert.equal(res.avatarId, "pub");
});
