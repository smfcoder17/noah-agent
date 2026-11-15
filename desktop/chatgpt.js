// Forfait ChatGPT de la personne, par la voie officielle « Sign in with ChatGPT » (plan usage pour les applications
// open source et hébergées localement). La connexion se fait ici, dans son navigateur ; le jeton reste sur cet ordinateur,
// chiffré par le système (safeStorage), et ne part jamais au serveur. Le serveur envoie un tour de l'agent par le pont,
// cet ordinateur appelle https://api.openai.com/v1/responses, la réponse repart par le même pont.
//
// Provenance : adapté d'OmniRoute (https://github.com/cheaper-inference/OmniRoute, commit 418cf3439b88a6318210bb1c819d55f6aa8513ee),
//   - open-sse/config/chatgpt.ts : émetteur, ressource, adresse des jetons, portées ;
//   - src/lib/oauth/chatgptProtocol.ts : createChatGptAttempt (adresse d'autorisation), resolveChatGptClientId,
//     verifyChatGptIdentity (ici sans la bibliothèque jose : RS256 vérifié par node:crypto), exchangeChatGptCode ;
//   - open-sse/services/tokenRefresh/providers/chatgpt.ts : refreshChatGptToken (fenêtre d'une minute, earliest_refresh_at,
//     codes d'échec définitifs).
// Valeurs vérifiées dans la documentation d'OpenAI (https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md) :
// client « dynamic_agent_client » à la première inscription, identifiant oaiapp_… rendu au retour, retour sur 127.0.0.1.
// Rien des fournisseurs Codex, des cookies web ni des parties qui imitent un client officiel d'OmniRoute n'est repris.
//
// MIT License
//
// Copyright (c) 2026 diegosouzapw
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
const http = require("node:http");
const fs = require("node:fs");
const { createHash, createPublicKey, randomBytes, randomUUID, verify } = require("node:crypto");
const responses = require("./responses");

let ISSUER = "https://auth.openai.com";
let API = "https://api.openai.com/v1";
const RESOURCE = "https://api.openai.com/v1"; // la ressource demandée reste celle d'OpenAI, même quand les tests changent l'adresse
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = SCOPES.split(" ").at(-1);
const FIRST_CLIENT = "dynamic_agent_client";
const APP_NAME = "Noah Agent";
const UNRECOVERABLE = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated",
  "refresh_token_reused", "invalid_client"]);
const LIMIT_CODES = new Set(["subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable"]);
const EVENT = (name) => "response." + name;

let store = null; // { read(), write(obj|null) } : chiffré par le système
let saved = null;
let catalog = [];

/** issuer, api : changés par les tests seulement (faux serveur OpenAI). */
function configure({ issuer, api, storage } = {}) {
  if (issuer) ISSUER = issuer;
  if (api) API = api;
  if (storage) { store = storage; saved = null; }
}

/** Un stockage chiffré par le système (safeStorage d'Electron), dans un fichier à part de config.json. */
function sealedFile(file, safeStorage) {
  return {
    read: () => {
      try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(file))); } catch { return null; }
    },
    write: (data) => {
      if (!data) return fs.rmSync(file, { force: true });
      if (!safeStorage.isEncryptionAvailable()) throw new Error("encryption unavailable");
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(data)), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

const credentials = () => (saved ??= store?.read() || null);
const save = (data) => { saved = data; store?.write(data); };

/** Identifiant stable de cet ordinateur auprès d'OpenAI, gardé avant la première connexion (ext_agent_host_id). */
function hostId(read, write) {
  const known = read().chatgpt_hote;
  if (typeof known === "string" && /^urn:uuid:[0-9a-f-]{36}$/.test(known)) return known;
  const id = `urn:uuid:${randomUUID()}`;
  write({ chatgpt_hote: id });
  return id;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** Signature RS256 d'un jeton d'identité, vérifiée avec les clés publiées par l'émetteur fixé ici, jamais lues du jeton. */
async function verifyIdentity(idToken, clientId, nonce) {
  const [head, body, sig] = String(idToken).split(".");
  const header = JSON.parse(Buffer.from(head, "base64url"));
  if (header.alg !== "RS256") throw new Error("id token: unexpected algorithm");
  const jwks = await (await fetch(`${ISSUER}/.well-known/jwks.json`, { signal: AbortSignal.timeout(15000) })).json();
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid) || (jwks.keys || [])[0];
  if (!jwk || !verify("RSA-SHA256", Buffer.from(`${head}.${body}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(sig, "base64url"))) {
    throw new Error("id token: bad signature");
  }
  const claims = JSON.parse(Buffer.from(body, "base64url"));
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER || !audience.includes(clientId) || !(claims.exp * 1000 > Date.now()) || claims.nonce !== nonce || !claims.sub) {
    throw new Error("id token: claims rejected");
  }
  return claims.sub;
}

/** Échange un code ou un jeton de renouvellement à l'adresse des jetons. Le corps d'une erreur n'est jamais montré : il peut porter un secret. */
async function tokenRequest(fields) {
  const r = await fetch(`${ISSUER}/api/accounts/oauth/token`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ ...fields, resource: RESOURCE }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const code = typeof data?.error === "string" ? data.error : data?.error?.code;
    throw Object.assign(new Error(`token endpoint HTTP ${r.status}`), { code, definitive: UNRECOVERABLE.has(code) });
  }
  const tokens = await r.json();
  if (!tokens.access_token || !tokens.refresh_token || !(tokens.expires_in > 0)) throw new Error("token endpoint: incomplete answer");
  return tokens;
}

/** Connexion : la personne se connecte chez OpenAI dans son navigateur, le retour arrive sur 127.0.0.1. */
async function login({ open, read, write, port = 1455 }) {
  const host = hostId(read, write);
  const previous = credentials();
  const state = b64url(randomBytes(32)), nonce = b64url(randomBytes(32)), verifier = b64url(randomBytes(32));
  const server = http.createServer();
  const listening = (p) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(p, "127.0.0.1", () => resolve(server.address().port));
  });
  const actual = await listening(port).catch(() => listening(0));
  const redirectUri = `http://127.0.0.1:${actual}/auth/callback`;
  const url = new URL(`${ISSUER}/api/accounts/authorize`);
  url.search = new URLSearchParams({
    client_id: previous?.client_id || FIRST_CLIENT,
    ...(previous ? { id_token_hint: previous.id_token } : { agent_name_hint: APP_NAME }),
    ext_agent_host_id: host, response_type: "code", redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE,
    state, nonce, code_challenge_method: "S256", code_challenge: b64url(createHash("sha256").update(verifier).digest()),
  }).toString();
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sign-in timed out")), 10 * 60000);
    server.on("request", (req, res) => {
      const got = new URL(req.url, redirectUri);
      if (got.pathname !== "/auth/callback") { res.writeHead(404).end(); return; }
      if (got.searchParams.get("state") !== state) { res.writeHead(400).end(); return; } // un autre onglet, ou une page qui tente sa chance
      clearTimeout(timer);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<!doctype html><title>Noah Agent</title><p>OK. You can close this tab.</p>");
      resolve(got.searchParams);
    });
  });
  try {
    await open(url.toString());
    const params = await answer;
    if (params.get("error")) throw new Error(`sign-in refused (${params.get("error").slice(0, 40)})`);
    const returned = params.get("client_id") || "";
    if (previous?.client_id && returned && returned !== previous.client_id) throw new Error("different registration returned");
    const clientId = previous?.client_id || returned;
    if (!/^oaiapp_[A-Za-z0-9_-]+$/.test(clientId)) throw new Error("no issued client id");
    const tokens = await tokenRequest({ grant_type: "authorization_code", client_id: clientId, code: params.get("code") || "", code_verifier: verifier, redirect_uri: redirectUri });
    const scopes = String(tokens.scope || "").split(/\s+/).filter(Boolean);
    if (!scopes.includes(PLAN_SCOPE)) throw new Error("plan usage not granted");
    const subject = await verifyIdentity(tokens.id_token, clientId, nonce);
    save({ client_id: clientId, ext_agent_host_id: host, subject, id_token: tokens.id_token, access_token: tokens.access_token,
      refresh_token: tokens.refresh_token, expires_at: Date.now() + tokens.expires_in * 1000, earliest_refresh_at: tokens.earliest_refresh_at ?? null, scopes });
    await refreshCatalog().catch(() => {});
    return { ok: true };
  } finally {
    server.close();
  }
}

function logout() {
  save(null);
  catalog = [];
}

/** Un jeton valide : renouvelé dans sa dernière minute, jamais avant l'heure permise par l'émetteur. */
async function accessToken() {
  const c = credentials();
  if (!c) return null;
  const earliest = typeof c.earliest_refresh_at === "number" ? c.earliest_refresh_at * 1000 : Date.parse(c.earliest_refresh_at || "") || 0;
  if (c.expires_at > Date.now() + 60000 || earliest > Date.now()) return c.expires_at > Date.now() ? c.access_token : null;
  try {
    const tokens = await tokenRequest({ grant_type: "refresh_token", client_id: c.client_id, refresh_token: c.refresh_token });
    const scopes = tokens.scope !== undefined ? String(tokens.scope).split(/\s+/).filter(Boolean) : c.scopes;
    save({ ...c, access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + tokens.expires_in * 1000,
      earliest_refresh_at: tokens.earliest_refresh_at ?? null, scopes, ...(tokens.id_token ? { id_token: tokens.id_token } : {}) });
    return scopes.includes(PLAN_SCOPE) ? tokens.access_token : null;
  } catch (e) {
    if (e.definitive) logout();
    return null;
  }
}

/** Les modèles de ce compte, tels qu'OpenAI les liste pour lui. */
async function refreshCatalog() {
  const token = await accessToken();
  if (!token) return (catalog = []);
  const r = await fetch(`${API}/models`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return catalog;
  const data = await r.json();
  const list = Array.isArray(data.models) ? data.models : Array.isArray(data.data) ? data.data : [];
  catalog = list.filter((m) => !m.visibility || m.visibility === "list").map((m) => ({ slug: String(m.slug || m.id || ""), nom: String(m.display_name || m.slug || m.id || "") }))
    .filter((m) => /^[\w.:-]{1,80}$/.test(m.slug));
  return catalog;
}

const models = () => catalog;
const connected = () => Boolean(credentials());

/** Lit un flux SSE de l'API Responses jusqu'à response.completed. Rend { response } ou { erreur, code }. */
async function readStream(r) {
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let pending = "", done = null;
  const handle = (block) => {
    const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") return;
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (event.type === EVENT("completed")) done = { response: event.response };
    else if (event.type === EVENT("incomplete")) done = { response: { ...event.response, status: "incomplete" } };
    else if (event.type === EVENT("failed") || event.type === "error") {
      const err = event.response?.error || event.error || {};
      done = { erreur: String(err.message || "response failed").slice(0, 300), code: String(err.code || "").slice(0, 80) };
    }
  };
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let i;
    while ((i = pending.indexOf("\n\n")) >= 0) {
      handle(pending.slice(0, i));
      pending = pending.slice(i + 2);
      if (done) { reader.cancel().catch(() => {}); return done; }
    }
  }
  if (pending.trim()) handle(pending);
  return done || { erreur: "stream interrupted", code: "interrompu" };
}

/** Un tour de l'agent (Chat Completions) par le forfait : rend { ok, reponse } ou { erreur, statut, code }. */
async function call(body, chosen, signal) {
  const token = await accessToken();
  if (!token) return { erreur: "ChatGPT disconnected", statut: 503, code: "deconnecte" };
  const model = chosen && catalog.some((m) => m.slug === chosen) ? chosen : chosen || catalog[0]?.slug;
  if (!model) return { erreur: "no ChatGPT model available", statut: 503, code: "sans_modele" };
  let payload;
  try {
    payload = responses.toResponses(body, model);
  } catch (e) {
    return { erreur: e.message, statut: 400, code: "non_pris_en_charge" };
  }
  let r;
  try {
    r = await fetch(`${API}/responses`, {
      method: "POST", signal: signal || AbortSignal.timeout(280000), redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { erreur: "OpenAI unreachable", statut: 502, code: "injoignable" };
  }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const code = String(data?.error?.code || "").slice(0, 80);
    return { erreur: String(data?.error?.message || `HTTP ${r.status}`).slice(0, 300), statut: LIMIT_CODES.has(code) ? 429 : r.status, code };
  }
  const out = await readStream(r);
  if (out.erreur) return { erreur: out.erreur, statut: LIMIT_CODES.has(out.code) ? 429 : 502, code: out.code };
  return { ok: true, reponse: responses.toChat(out.response, model), modele: model };
}

module.exports = { configure, sealedFile, login, logout, accessToken, refreshCatalog, models, connected, call, verifyIdentity };
