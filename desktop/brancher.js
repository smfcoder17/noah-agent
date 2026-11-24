// « Brancher » un abonnement (Claude Code, ChatGPT, Grok) d'un seul geste, depuis l'écran Réglages > Fournisseurs de l'app de bureau :
// détecter la CLI, proposer de l'installer si elle manque, connecter la personne, lui faire donner l'accord « cerveau », puis dire
// « prêt ». Chaque geste est celui des menus Abonnements (mêmes fonctions, même fenêtre d'accord, même avertissement) : l'écran n'en
// dépend plus, il enchaîne. Le dernier pas (brancher côté serveur) se fait depuis la page, dès que le battement a dit « prêt ».
//
// L'état rendu à la page ne porte que des mots (étape, code d'appareil et adresse de Grok, raison d'échec) : la page les traduit.
//   etape : detection | installation | connexion | accord | pret | erreur
//   detail : pour « installation », l'étape de l'installateur (accord, telechargement, installation, verification)
//   code, adresse : pour la connexion à Grok (code d'appareil chez xAI)
//   erreur : refus_installation | installation | connexion | refus_accord | inconnu
const WHICH = new Set(["claude", "chatgpt", "grok"]);
// Le droit « cerveau » de chaque abonnement dans le fichier de réglages de cet ordinateur.
const RIGHT = { claude: "abonnement_claude_cerveau", chatgpt: "abonnement_chatgpt", grok: "abonnement_grok" };

/**
 * deps : claude, grok, chatgpt (les modules), install(which, onStep) -> { ok | refuse | erreur }, consent(which) -> bool (la fenêtre
 * d'accord avec l'avertissement), openExternal(url), read(), write(patch), changed() (menu et battement), limits() (facultatif).
 */
function create(deps) {
  const states = {};
  const running = {};
  const set = (which, state) => { states[which] = state; return state; };

  const connected = (which) => (which === "chatgpt" ? deps.chatgpt.connected() : deps[which].status().connecte);

  async function steps(which) {
    const mod = deps[which];
    set(which, { etape: "detection" });
    if (which !== "chatgpt") await mod.detect().catch(() => {});
    if (which !== "chatgpt" && !mod.status().installe) {
      set(which, { etape: "installation", detail: "accord" });
      const r = await deps.install(which, (detail) => set(which, { etape: "installation", detail }));
      if (r.refuse) return set(which, { etape: "erreur", erreur: "refus_installation" });
      if (r.erreur) return set(which, { etape: "erreur", erreur: "installation", raison: r.erreur });
    }
    if (!connected(which)) {
      set(which, { etape: "connexion" });
      let r;
      if (which === "chatgpt") {
        r = await deps.chatgpt.login({ open: (url) => deps.openExternal(url), read: deps.read, write: deps.write }).then(() => ({ ok: true }), (e) => ({ erreur: String(e?.message || e).slice(0, 200) }));
        if (r.ok) await Promise.resolve(deps.limits?.()).catch(() => {});
      } else if (which === "grok") {
        r = await mod.login({ onInfo: ({ url, code }) => { deps.openExternal(url); set(which, { etape: "connexion", code, adresse: url }); } });
      } else {
        r = await mod.login();
      }
      deps.changed();
      if (r.erreur || !connected(which)) return set(which, { etape: "erreur", erreur: "connexion" });
    }
    if (deps.read()[RIGHT[which]] !== true) {
      set(which, { etape: "accord" });
      if (which !== "chatgpt" && !(await deps.consent(which))) { deps.changed(); return set(which, { etape: "erreur", erreur: "refus_accord" }); }
      deps.write({ [RIGHT[which]]: true });
    }
    deps.changed(); // le battement dit au serveur : cet ordinateur est prêt
    return set(which, { etape: "pret" });
  }

  /** Enchaîne les étapes ; rend l'état final. Un second appel pendant le premier attend le même résultat. */
  function plug(which) {
    if (!WHICH.has(which)) return Promise.resolve({ etape: "erreur", erreur: "inconnu" });
    running[which] ??= steps(which)
      .catch(() => set(which, { etape: "erreur", erreur: "inconnu" }))
      .finally(() => { delete running[which]; });
    return running[which];
  }

  /** L'état en cours (pour la page qui interroge toutes les secondes), ou null. */
  const state = (which) => (WHICH.has(which) ? states[which] ?? null : null);
  /** Où en est cet ordinateur : la CLI est-elle là, connectée, permise comme cerveau ? Sert à écrire un écran honnête. */
  function summary(which) {
    if (!WHICH.has(which)) return null;
    const installed = which === "chatgpt" ? true : deps[which].status().installe;
    return { installe: installed, connecte: installed && connected(which), cerveau: deps.read()[RIGHT[which]] === true, occupe: Boolean(running[which]) };
  }
  return { plug, state, summary };
}

module.exports = { create, WHICH };
