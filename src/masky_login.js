// "Login with Masky" for a desktop app: PKCE authorization-code flow with a
// loopback redirect. Opens the user's browser on masky.ai's consent page and
// catches the code on a one-shot 127.0.0.1 server; no client secret ships in
// the app. The access token that comes back is a long-lived scoped mky_ key
// (revocable from the user's Masky account), which we store in settings and
// use for all speak/balance calls.
const http = require("http");
const crypto = require("crypto");

// OAuth client registered on masky.ai for JevChatHud (public identifier;
// PKCE means there is no secret to protect).
const CLIENT_ID = "mkc_89755a33ac202f776f479b88";
const AUTHORIZE_URL = "https://masky.ai/oauth-authorize.html";
const TOKEN_URL = "https://masky.ai/api/oauth/token";
const SCOPES = "profile avatars:read generate";

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const DONE_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>JevChatHud</title>
<style>body{background:#0e0e12;color:#e8e8ee;font:15px -apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}b{color:#7c5cff}</style>
</head><body><div><p><b>Masky account connected.</b></p><p>You can close this tab and return to JevChatHud.</p></div></body></html>`;

/**
 * Run the full login round-trip. `openExternal` is injected (Electron's
 * shell.openExternal) so tests can fake the browser leg.
 * Resolves {accessToken, scope, avatar} or rejects on denial/timeout.
 */
function maskyLogin({ openExternal, fetchImpl = fetch, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    let settled = false;
    // Captured at listen time: server.address() returns null once close() has
    // been called, so the callback handler must not read it after closing.
    let redirectUri = "";

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(DONE_PAGE);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      try {
        if (url.searchParams.get("state") !== state) throw new Error("state mismatch");
        const code = url.searchParams.get("code");
        if (!code) throw new Error(url.searchParams.get("error") || "login was denied");
        const tokenRes = await fetchImpl(TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            redirect_uri: redirectUri,
            code,
            code_verifier: verifier,
          }),
        });
        const data = await tokenRes.json().catch(() => ({}));
        if (!tokenRes.ok || !data.access_token) {
          throw new Error(data.error || `token exchange failed (${tokenRes.status})`);
        }
        resolve({ accessToken: data.access_token, scope: data.scope, avatar: data.avatar });
      } catch (err) {
        reject(err);
      }
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      reject(new Error("login timed out"));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    server.listen(0, "127.0.0.1", () => {
      redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      const authUrl =
        `${AUTHORIZE_URL}?client_id=${CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=${encodeURIComponent(SCOPES)}` +
        `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;
      openExternal(authUrl);
    });
  });
}

module.exports = { maskyLogin, CLIENT_ID };
