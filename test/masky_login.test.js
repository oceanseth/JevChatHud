const { test } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { maskyLogin, CLIENT_ID } = require("../src/masky_login");

// Drives the real loopback server end to end: parse the auth URL the way the
// browser would, hit the callback, and verify the token exchange runs. This is
// the path that broke on Windows (server.address() read after close()).
function browser(onPage) {
  return (authUrl) => {
    const u = new URL(authUrl);
    const cb =
      u.searchParams.get("redirect_uri") +
      "?code=FAKECODE&state=" +
      encodeURIComponent(u.searchParams.get("state"));
    http.get(cb, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => onPage && onPage(res.statusCode, body));
    });
  };
}

test("browser login round-trip resolves with the exchanged token", async () => {
  let exchanged = null;
  let pageLoaded;
  const pagePromise = new Promise((r) => (pageLoaded = r));
  const result = await maskyLogin({
    openExternal: browser((status, body) => pageLoaded({ status, body })),
    fetchImpl: async (url, opts) => {
      exchanged = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "mky_test", scope: "generate", avatar: { name: "tester" } }),
      };
    },
    timeoutMs: 5000,
  });
  assert.equal(result.accessToken, "mky_test");
  assert.equal(result.avatar.name, "tester");
  assert.equal(exchanged.grant_type, "authorization_code");
  assert.equal(exchanged.client_id, CLIENT_ID);
  assert.equal(exchanged.code, "FAKECODE");
  // redirect_uri in the exchange must match the one the browser was sent to
  assert.match(exchanged.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.ok(exchanged.code_verifier.length > 40);
  // the browser saw the done page
  const page = await pagePromise;
  assert.equal(page.status, 200);
  assert.ok(page.body.includes("close this tab"));
});

test("denied login rejects instead of hanging", async () => {
  await assert.rejects(
    maskyLogin({
      openExternal: (authUrl) => {
        const u = new URL(authUrl);
        const cb =
          u.searchParams.get("redirect_uri") +
          "?error=access_denied&state=" +
          encodeURIComponent(u.searchParams.get("state"));
        http.get(cb, () => {});
      },
      fetchImpl: async () => {
        throw new Error("token exchange must not run on denial");
      },
      timeoutMs: 5000,
    }),
    /access_denied/
  );
});

test("state mismatch rejects without exchanging the code", async () => {
  await assert.rejects(
    maskyLogin({
      openExternal: (authUrl) => {
        const u = new URL(authUrl);
        const cb = u.searchParams.get("redirect_uri") + "?code=FAKECODE&state=WRONG";
        http.get(cb, () => {});
      },
      fetchImpl: async () => {
        throw new Error("token exchange must not run on state mismatch");
      },
      timeoutMs: 5000,
    }),
    /state mismatch/
  );
});

test("failed token exchange surfaces the server error", async () => {
  await assert.rejects(
    maskyLogin({
      openExternal: browser(),
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: "bad code" }) }),
      timeoutMs: 5000,
    }),
    /bad code/
  );
});
