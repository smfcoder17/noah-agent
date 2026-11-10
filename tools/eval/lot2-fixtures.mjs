// Données stables pour comparer les deux interfaces sans clé de modèle ni écriture dans les comptes.
export const agent = { id: "lot2-banc", name: "Noah", role: "Assistant du banc", online: true, step: null, tasks: {}, state: "idle", color: "#6a50e0", pinned: false, droit: "proprietaire", model: null, mode: "auto" };
export const messages = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, role: i % 2 ? "agent" : "user", text: i % 2 ? `Résultat ${i + 1}. La préparation est terminée et le document est prêt à relire.\n\n- Première étape vérifiée\n- Deuxième étape vérifiée` : `Prépare le document ${i + 1} et vérifie son contenu.`, created_at: "2026-11-10 09:00:00", detail: null }));
export const files = Array.from({ length: 20 }, (_, i) => ({ path: `outputs/document-${i + 1}.txt`, size: 2048 + i, modified: 1794301200 }));
export async function fixtures(context, { latency = 0, bandwidth = 0 } = {}) {
  const hold = new Set();
  const handler = async (route) => {
    const u = new URL(route.request().url()), p = u.pathname;
    if (p === "/api/events") { hold.add(route); return; } // transport ouvert, aucune relève artificielle
    let body = {};
    if (p === "/api/status") body = { has_account: true, onboarded: true, model_configured: true, setup_code: false, secrets_lisibles: true };
    else if (p === "/api/me") body = { id: 1, username: "banc-lot2", role: "owner" };
    else if (p === "/api/me/interface") body = { tabs: ["chat", "activity", "tasks", "files", "computer"], masquer_sensibles: true, theme: "light", texte: "normal", ...(route.request().method() === "PUT" ? route.request().postDataJSON() : {}) };
    else if (p === "/api/agents") body = [agent];
    else if (/\/conversations$/.test(p)) body = [{ id: "lot2-conversation", agent_id: agent.id, title: "Discussion de mesure", main: true, state: "idle", archived: false, updated_at: "2026-11-10 09:00:00" }];
    else if (/\/messages$/.test(p)) body = messages;
    else if (/\/en-cours$/.test(p)) body = { occupe: false, activite: null, run_id: null, file: [], accord: null };
    else if (p === "/api/accords" || p === "/api/a-toi" || /\/activite$|\/log$/.test(p)) body = [];
    else if (p === "/api/usage") body = { month_cost: 0, daily: null, budget: null, agents: [], total_tokens: 0 };
    else if (p === "/api/model") body = { provider: "openrouter", model: "openai/gpt-test", has_key: true };
    else if (/\/files$/.test(p)) body = files;
    else if (/\/routines$/.test(p)) body = { routines: [] };
    else if (/\/watches$/.test(p)) body = { veilles: [] };
    else if (/\/competences$/.test(p)) body = { competences: [{ nom: "test", titre: "Format du document", texte: "Écrire trois phrases." }] };
    else if (/\/connections$/.test(p)) body = { google: { disponible: false }, applications: [], outils: [], globaux: [] };
    else if (/\/proactif$/.test(p)) body = { mode: "rien", minutes: 60, sources: [], compte: { passages: 0, signaux: 0, tours: 0, cout: 0 }, dernier_passage: null };
    else if (/\/screen-status$/.test(p)) body = { etat: "pret", awake: true, reachable: true, tabs: [] };
    else if (/\/screen-url$/.test(p)) body = { url: "/api/agents/lot2-banc/screen/banc" };
    else if (/\/screen\/banc$/.test(p)) return route.fulfill({ contentType: "text/html", body: '<!doctype html><html class="noVNC_connected"><body><input id="noVNC_setting_view_only" type="checkbox" checked><p>Écran de mesure</p></body></html>' });
    else if (/\/appel$/.test(p)) body = { appel: null };
    else if (/alertes-appareils/.test(p)) body = { alertes: [] };
    else if (/\/modes\/cerveau$/.test(p)) body = { niveau: "cerveau", actif: null, en_service: "openai/gpt-test", modes: ["fast", "balanced", "smart"].map((id) => ({ id, modele: { modele: "openai/gpt-test", fournisseur: "openrouter", nom: "GPT test" } })), gratuit: [], custom: [] };
    else if (p === "/api/fournisseurs") body = [{ id: "openrouter", label: "OpenRouter", connected: true, models: 1 }, { id: "custom", label: "Autre fournisseur", connected: false, own_url: true, base_url: "" }];
    else if (p === "/api/providers") body = [{ id: "openrouter", label: "OpenRouter", needs_key: true, default_model: "openai/gpt-test" }];
    else if (p === "/api/models") body = { models: [], groups: [], needs_key: false };
    else if (/\/voix|\/dictation|\/voice/.test(p)) body = { available: false, disponible: false };
    else if (/\/devices$/.test(p)) body = { appareils: [] };
    else if (/\/media$/.test(p)) body = { available: false, reason: "Clé du banc absente", kinds: {} };
    else if (/\/logos\//.test(p)) return route.fulfill({ status: 204, body: "" });
    const json = JSON.stringify(body);
    if (latency || bandwidth) await new Promise((resolve) => setTimeout(resolve, latency + (bandwidth ? Buffer.byteLength(json) / bandwidth * 1000 : 0)));
    await route.fulfill({ contentType: "application/json", body: json });
  };
  await context.route("**/api/**", handler);
  return async () => { for (const route of hold) await route.abort().catch(() => {}); await context.unroute("**/api/**", handler); };
}
