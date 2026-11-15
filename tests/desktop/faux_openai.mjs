// Faux serveur OpenAI pour les tests : connexion « Sign in with ChatGPT » (autorisation, jetons, clés publiques) et API Responses
// en flux, avec les contraintes de la voie du forfait (store:false, stream:true, pas de temperature, outils par additional_tools).
import http from "node:http";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

export async function fakeOpenAI() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "cle-1", alg: "RS256", use: "sig" };
  const state = { requests: [], tokens: new Map(), challenges: new Map(), refreshes: 0, expiresIn: 3600, seen: [] };
  let origin = "";
  const idToken = (clientId, nonce) => {
    const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "cle-1", typ: "JWT" })).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const body = Buffer.from(JSON.stringify({ iss: origin, aud: clientId, sub: "user-42", email: "franck@exemple.fr", nonce, iat: now, exp: now + 3600 })).toString("base64url");
    return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
  };
  const issue = (clientId, nonce) => {
    const access = `acces-${randomBytes(8).toString("hex")}`;
    state.tokens.set(access, true);
    return { access_token: access, refresh_token: `renouv-${randomBytes(8).toString("hex")}`, id_token: idToken(clientId, nonce), token_type: "Bearer",
      expires_in: state.expiresIn, scope: "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke" };
  };
  const read = (req) => new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });
  const sse = (res, events) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const body = await read(req);
    state.requests.push({ method: req.method, path: url.pathname });
    if (url.pathname === "/.well-known/jwks.json") return res.end(JSON.stringify({ keys: [jwk] }));
    if (url.pathname === "/api/accounts/oauth/token") {
      const form = new URLSearchParams(body);
      if (form.get("resource") !== "https://api.openai.com/v1") return res.writeHead(400).end("{}");
      if (form.get("grant_type") === "authorization_code") {
        const pending = state.challenges.get(form.get("code"));
        const ok = pending && createHash("sha256").update(form.get("code_verifier")).digest("base64url") === pending.challenge
          && form.get("client_id") === "oaiapp_essai" && form.get("redirect_uri") === pending.redirect;
        if (!ok) return res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
        state.challenges.delete(form.get("code"));
        return res.end(JSON.stringify(issue("oaiapp_essai", pending.nonce)));
      }
      if (form.get("grant_type") === "refresh_token") {
        state.refreshes += 1;
        const t = issue("oaiapp_essai", "");
        delete t.id_token;
        return res.end(JSON.stringify(t));
      }
      return res.writeHead(400).end("{}");
    }
    const bearer = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (url.pathname.startsWith("/v1/") && !state.tokens.has(bearer)) return res.writeHead(401).end(JSON.stringify({ error: { message: "bad token" } }));
    if (url.pathname === "/v1/models") {
      return res.end(JSON.stringify({ models: [{ slug: "gpt-essai", display_name: "GPT Essai", visibility: "list" }, { slug: "cache", visibility: "hide" }] }));
    }
    if (url.pathname === "/v1/responses") {
      const payload = JSON.parse(body);
      state.seen.push(payload);
      const bad = payload.store !== false || payload.stream !== true || "temperature" in payload || "max_tokens" in payload
        || (payload.input || []).some((i) => i.role === "system");
      if (bad) return res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "rejected by preview", code: "invalid_request" } }));
      const text = JSON.stringify(payload.input);
      if (text.includes("LIMITE")) {
        return sse(res, [{ type: "response.created", response: { id: "r1" } },
          { type: "response.failed", response: { id: "r1", error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } }]);
      }
      const last = payload.input.at(-1);
      const tools = payload.input.find((i) => i.type === "additional_tools")?.tools || [];
      const output = last.type === "message" && tools.length
        ? [{ type: "function_call", call_id: "appel-1", name: tools[0].name, arguments: "{\"chemin\":\"notes.txt\"}", namespace: "functions" }]
        : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `réponse du forfait (${payload.model})` }] }];
      return sse(res, [{ type: "response.created", response: { id: "r2" } }, { type: "response.output_text.delta", delta: "réponse" },
        { type: "response.completed", response: { id: "r2", status: "completed", output, usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 } } }]);
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  /** Fait le navigateur de la personne : vérifie l'adresse d'autorisation, puis revient sur le retour de l'app. */
  const browser = async (authorizeUrl, { deny = false } = {}) => {
    const u = new URL(authorizeUrl);
    const p = u.searchParams;
    const problems = [];
    if (u.origin + u.pathname !== `${origin}/api/accounts/authorize`) problems.push("adresse");
    if (p.get("client_id") !== "dynamic_agent_client" && p.get("client_id") !== "oaiapp_essai") problems.push("client_id");
    if (!/^urn:uuid:[0-9a-f-]{36}$/.test(p.get("ext_agent_host_id") || "")) problems.push("ext_agent_host_id");
    if (!(p.get("scope") || "").split(" ").includes("chatgpt.tokens.use.direct")) problems.push("scope");
    if (p.get("resource") !== "https://api.openai.com/v1" || p.get("code_challenge_method") !== "S256" || p.get("response_type") !== "code") problems.push("params");
    if (!/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(p.get("redirect_uri") || "")) problems.push("redirect_uri");
    state.lastAuthorize = Object.fromEntries(p);
    if (problems.length) throw new Error("autorisation : " + problems.join(", "));
    const back = new URL(p.get("redirect_uri"));
    if (deny) back.search = new URLSearchParams({ error: "access_denied", state: p.get("state") }).toString();
    else {
      const code = `code-${randomBytes(6).toString("hex")}`;
      state.challenges.set(code, { challenge: p.get("code_challenge"), nonce: p.get("nonce"), redirect: p.get("redirect_uri") });
      back.search = new URLSearchParams({ code, state: p.get("state"), client_id: "oaiapp_essai", scope: p.get("scope") }).toString();
    }
    // Une page tierce qui tente sa chance avec un faux état : refusée, la connexion attend toujours le vrai retour.
    const wrong = new URL(back);
    wrong.searchParams.set("state", "faux");
    state.wrongState = (await fetch(wrong)).status;
    await fetch(back);
  };
  return { origin, state, browser, close: () => new Promise((r) => server.close(r)) };
}
