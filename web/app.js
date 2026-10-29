const app = document.getElementById("app");
const $ = (id) => document.getElementById(id);
const state = { agents: [], agentId: null, conversationId: null, runId: null, busy: false, model: null };

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "same-origin",
  });
  if (!res.ok) {
    let message = `Erreur ${res.status}`;
    try { message = (await res.json()).detail || message; } catch {}
    if (Array.isArray(message)) message = "Vérifie les champs du formulaire.";
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return res;
}
const json = async (path, options) => (await api(path, options)).json();
const post = (path, body, method = "POST") => json(path, { method, body: JSON.stringify(body) });

function clone(id) {
  return document.getElementById(id).content.cloneNode(true);
}

function showError(form, err) {
  const p = form.querySelector(".error");
  p.textContent = err.message;
  p.hidden = false;
}

// --- Démarrage -------------------------------------------------------------------

async function boot() {
  const status = await json("/api/status");
  if (!status.has_account) return credentialsScreen("tpl-account", "form-account", "/api/setup/account");
  try {
    await json("/api/me");
  } catch (e) {
    if (e.status === 401) return credentialsScreen("tpl-login", "form-login", "/api/login");
    throw e;
  }
  if (!status.model_configured) {
    app.replaceChildren(Object.assign(document.createElement("div"), { className: "screen" }));
    return modelForm(app.firstChild, { first: true });
  }
  shell();
}

function credentialsScreen(tpl, formId, path) {
  app.replaceChildren(clone(tpl));
  const form = $(formId);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    form.querySelector("button").disabled = true;
    try {
      await post(path, { username: $("username").value.trim(), password: $("password").value });
      boot();
    } catch (err) {
      showError(form, err);
      form.querySelector("button").disabled = false;
    }
  });
}

// --- Formulaire du modèle ---------------------------------------------------------

const PROVIDER_HINTS = {
  openrouter: "Des centaines de modèles, une seule clé",
  anthropic: "Claude, directement",
  openai: "GPT, directement",
  gemini: "Gemini, directement",
  ollama: "Modèles locaux et cloud d'Ollama",
};

const money = (v) => (v == null ? "?" : v === 0 ? "0" : v < 0.1 ? v.toFixed(3) : v.toFixed(2)).replace(".", ",");
const ctx = (n) => (!n ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0).replace(".", ",")} M jetons` : `${Math.round(n / 1000)} k jetons`);

function modelCard(m, selectedId, onPick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "model";
  b.setAttribute("role", "radio");
  b.setAttribute("aria-checked", m.id === selectedId);
  b.dataset.id = m.id;
  b.innerHTML = "<b></b><code></code><span class=\"meta\"></span>";
  b.querySelector("b").textContent = m.name.replace(/^[^:]+:\s*/, "");
  b.querySelector("code").textContent = m.id;
  const meta = b.querySelector(".meta");
  const price = m.free ? "Gratuit" : m.price_in == null ? "Prix inconnu" : `${money(m.price_in)} $ · ${money(m.price_out)} $ / M`;
  for (const text of [price, ctx(m.context), m.size, m.vision ? "Images" : ""].filter(Boolean)) {
    const s = document.createElement("span");
    s.textContent = text;
    if (text === "Images") s.className = "tag";
    meta.append(s);
  }
  b.addEventListener("click", () => onPick(m));
  return b;
}

async function modelForm(container, { first = false, onDone } = {}) {
  container.replaceChildren(clone("tpl-model"));
  const [providers, current, usage] = await Promise.all([
    json("/api/providers"),
    first ? null : json("/api/model"),
    first ? null : json("/api/usage"),
  ]);
  const list = $("providers");
  const catalogBox = $("catalog");
  const search = $("model-search");
  let chosen = null;
  let picked = current ? { id: current.model, name: current.model } : null;
  let data = { groups: [], models: [] };

  if (usage) {
    $("budget").value = usage.budget ?? "";
    $("usage-line").hidden = false;
    $("usage-line").textContent = `Dépensé ce mois-ci : ${money(usage.month_cost)} $` +
      (usage.agents.length ? " — " + usage.agents.map((a) => `${a.name} ${money(a.cost)} $`).join(", ") : "");
  }

  const pick = (m) => {
    picked = m;
    $("picked-name").textContent = `${m.name} (${m.id})`;
    catalogBox.querySelectorAll(".model").forEach((b) => b.setAttribute("aria-checked", b.dataset.id === m.id));
  };
  if (picked) $("picked-name").textContent = picked.id;

  function render() {
    const q = search.value.trim().toLowerCase();
    catalogBox.replaceChildren();
    if (!data.models.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = data.needs_key ? "Colle ta clé API puis « Afficher les modèles »." : "Aucun modèle disponible.";
      return catalogBox.append(p);
    }
    const sections = q
      ? [{ title: "Résultats", hint: "", models: data.models.filter((m) => (m.id + " " + m.name).toLowerCase().includes(q)).slice(0, 60) }]
      : data.groups;
    for (const g of sections) {
      const section = document.createElement("section");
      section.className = "group";
      section.innerHTML = "<h2></h2><p class=\"muted\"></p><div class=\"models\" role=\"radiogroup\"></div>";
      section.querySelector("h2").textContent = g.title;
      section.querySelector("p").textContent = g.hint || (g.models.length ? "" : "Aucun résultat.");
      section.querySelector(".models").append(...g.models.map((m) => modelCard(m, picked?.id, pick)));
      catalogBox.append(section);
    }
    if (!q) {
      const more = document.createElement("p");
      more.className = "muted small";
      more.textContent = `${data.models.length} modèles disponibles : utilise la recherche pour les voir tous.`;
      catalogBox.append(more);
    }
  }

  async function load() {
    catalogBox.innerHTML = '<p class="muted">Chargement des modèles…</p>';
    form.querySelector(".error").hidden = true;
    try {
      data = await post("/api/models", { provider: chosen.id, api_key: $("api-key").value || null });
    } catch (err) {
      data = { groups: [], models: [] };
      catalogBox.replaceChildren();
      showError(form, err);
      return;
    }
    render();
  }

  function choose(p) {
    chosen = p;
    list.querySelectorAll(".provider").forEach((b) => b.setAttribute("aria-checked", b.dataset.id === p.id));
    $("key-field").hidden = !p.needs_key;
    const saved = current && current.provider === p.id && current.has_key;
    $("api-key").placeholder = saved ? "Clé enregistrée (laisser vide pour la garder)" : "Colle ta clé ici";
    if (!current || current.provider !== p.id) {
      picked = null;
      $("picked-name").textContent = "aucun";
    }
    search.value = "";
    load();
  }

  for (const p of providers) {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "provider" });
    b.innerHTML = "<span></span><small></small>";
    b.querySelector("span").textContent = p.label;
    b.querySelector("small").textContent = PROVIDER_HINTS[p.id] || "";
    b.setAttribute("role", "radio");
    b.dataset.id = p.id;
    b.addEventListener("click", () => choose(p));
    list.append(b);
  }
  const form = $("form-model");
  search.addEventListener("input", render);
  $("load-models").addEventListener("click", load);
  choose(providers.find((p) => p.id === current?.provider) || providers[0]);

  if (!first) {
    $("model-cancel").hidden = false;
    $("model-cancel").addEventListener("click", onDone);
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!picked) return showError(form, new Error("Choisis un modèle dans la liste."));
    const button = $("model-save");
    button.disabled = true;
    button.textContent = first ? "Création de ton premier agent…" : "Application aux agents…";
    try {
      const budget = $("budget").value;
      await post("/api/budget", { monthly: budget === "" ? null : Number(budget) });
      await post("/api/model", { provider: chosen.id, api_key: $("api-key").value || null, model: picked.id });
      first ? shell() : onDone();
    } catch (err) {
      showError(form, err);
      button.disabled = false;
      button.textContent = "Enregistrer";
    }
  });
}

// --- Application -----------------------------------------------------------------

async function shell() {
  app.replaceChildren(clone("tpl-shell"));
  const side = $("side");
  const scrim = $("scrim");
  const openSide = (open) => { side.classList.toggle("open", open); scrim.hidden = !open; };
  $("open-side").addEventListener("click", () => openSide(true));
  $("close-side").addEventListener("click", () => openSide(false));
  scrim.addEventListener("click", () => openSide(false));

  $("add-agent").addEventListener("click", () => agentModal());
  $("edit-agent").addEventListener("click", () => agentModal(currentAgent()));
  $("new-chat").addEventListener("click", () => { openConversation(null); openSide(false); });
  $("open-model").addEventListener("click", () => {
    const modal = $("modal");
    modal.hidden = false;
    modelForm(modal, { onDone: () => { modal.hidden = true; refreshModel(); refreshAgents(); } });
  });
  $("logout").addEventListener("click", async () => { await post("/api/logout", {}); boot(); });

  const input = $("input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || state.busy) return;
    input.value = "";
    input.style.height = "auto";
    send(text);
  });
  $("stop").addEventListener("click", () => {
    if (state.runId) post(`/api/agents/${state.agentId}/runs/${state.runId}/stop`, {}).catch(() => {});
  });

  // Panneau Détails / Fichiers / Ordinateur
  $("toggle-panel").addEventListener("click", () => ($("panel").hidden ? openPanel(state.panelTab || "computer") : closePanel()));
  $("close-panel").addEventListener("click", closePanel);
  document.querySelectorAll(".tabs [data-tab]").forEach((b) => b.addEventListener("click", () => openPanel(b.dataset.tab)));
  $("take-control").addEventListener("click", () => { state.viewOnly = !state.viewOnly; loadScreen(); });
  $("screen-reload").addEventListener("click", loadScreen);
  $("preview-close").addEventListener("click", () => { $("preview").hidden = true; $("preview-frame").src = "about:blank"; });

  // Pièces jointes
  $("file-input").addEventListener("change", (e) => { uploadFiles([...e.target.files]); e.target.value = ""; });
  const chat = document.querySelector(".chat");
  chat.addEventListener("dragover", (e) => e.preventDefault());
  chat.addEventListener("drop", (e) => { e.preventDefault(); uploadFiles([...e.dataTransfer.files]); });
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); uploadFiles(files); }
  });

  refreshModel();
  await refreshAgents();
  if (state.agents.length) selectAgent(state.agentId && state.agents.some((a) => a.id === state.agentId) ? state.agentId : state.agents[0].id);
  setInterval(refreshAgents, 4000);
}

async function refreshModel() {
  try {
    const [model, usage] = await Promise.all([json("/api/model"), json("/api/usage")]);
    state.model = model;
    $("model-name").textContent = model ? model.model : "aucun";
    $("spend").textContent = `Ce mois-ci : ${money(usage.month_cost)} $` + (usage.budget != null ? ` sur ${money(usage.budget)} $` : "");
  } catch {}
}

const currentAgent = () => state.agents.find((a) => a.id === state.agentId);

async function refreshAgents() {
  try { state.agents = await json("/api/agents"); } catch { return; }
  const ul = $("agents");
  if (!ul) return;
  ul.replaceChildren(...state.agents.map((a) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-current", a.id === state.agentId);
    b.innerHTML = '<span class="dot"></span><span class="title"></span>';
    b.querySelector(".dot").className = "dot " + (a.online ? "on" : a.step ? "busy" : "");
    b.querySelector(".title").textContent = a.name;
    b.addEventListener("click", () => { selectAgent(a.id); $("side").classList.remove("open"); $("scrim").hidden = true; });
    li.append(b);
    return li;
  }));
  renderAgentHead();
}

function renderAgentHead() {
  const a = currentAgent();
  $("agent-name-head").textContent = a ? a.name : "Aucun agent";
  $("agent-status").textContent = !a ? "" : a.step || (a.online ? "En ligne" : "Hors ligne");
  $("edit-agent").hidden = !a;
  $("send").disabled = !a || state.busy;
}

async function selectAgent(id) {
  state.agentId = id;
  state.attachments = [];
  renderAttachments();
  refreshAgents();
  await refreshConversations();
  openConversation(null);
  if (!$("panel").hidden) openPanel(state.panelTab);
}

// --- Panneau latéral -----------------------------------------------------------------

function openPanel(tab) {
  state.panelTab = tab;
  $("panel").hidden = false;
  document.querySelector(".shell").classList.add("with-panel");
  $("toggle-panel").setAttribute("aria-pressed", "true");
  document.querySelectorAll(".tabs [data-tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === tab));
  for (const t of ["details", "files", "computer"]) $(`tab-${t}`).hidden = t !== tab;
  if (tab === "details") renderDetails();
  if (tab === "files") renderFiles();
  if (tab === "computer") loadScreen();
  else $("screen").src = "about:blank"; // coupe le flux vidéo quand on ne le regarde pas
}

function closePanel() {
  $("panel").hidden = true;
  $("screen").src = "about:blank";
  document.querySelector(".shell").classList.remove("with-panel");
  $("toggle-panel").setAttribute("aria-pressed", "false");
}

async function renderDetails() {
  const box = $("tab-details");
  const a = currentAgent();
  box.replaceChildren();
  if (!a) return;
  const usage = await json("/api/usage").catch(() => null);
  const mine = usage?.agents.find((u) => u.agent_id === a.id);
  const cacheRate = mine && mine.prompt_tokens ? Math.round((100 * mine.cached_tokens) / mine.prompt_tokens) : 0;
  box.innerHTML = `
    <div class="kv"><span>Agent</span><p><strong></strong></p></div>
    <div class="kv"><span>État</span><p class="state"></p></div>
    <div class="kv"><span>Modèle</span><p class="model"></p></div>
    <div class="stats">
      <div class="stat"><span>Coût ce mois-ci</span><b class="cost"></b></div>
      <div class="stat"><span>Appels au modèle</span><b class="calls"></b></div>
      <div class="stat"><span>Jetons</span><b class="tokens"></b></div>
      <div class="stat"><span>Lus depuis le cache</span><b class="cache"></b></div>
    </div>
    <div class="kv"><span>Rôle</span><p class="role"></p></div>
    <button type="button" class="ghost" id="details-edit">Modifier le nom et le rôle</button>`;
  box.querySelector("strong").textContent = a.name;
  box.querySelector(".state").textContent = a.step || (a.online ? "En ligne" : "Hors ligne");
  box.querySelector(".model").textContent = state.model?.model || "—";
  box.querySelector(".cost").textContent = `${money(mine?.cost || 0)} $`;
  box.querySelector(".calls").textContent = mine?.calls || 0;
  box.querySelector(".tokens").textContent = (mine?.tokens || 0).toLocaleString("fr-CA");
  box.querySelector(".cache").textContent = `${cacheRate} %`;
  box.querySelector(".role").textContent = a.role || "Aucun rôle précis.";
  $("details-edit").addEventListener("click", () => agentModal(a));
}

const FILE_GROUPS = [
  ["outputs/", "Livrables"],
  ["apps/", "Applications"],
  ["captures/", "Captures"],
  ["uploads/", "Envoyés par toi"],
  ["", "Autres fichiers"],
];
const size = (n) => (n < 1024 ? `${n} o` : n < 1048576 ? `${Math.round(n / 1024)} Ko` : `${(n / 1048576).toFixed(1).replace(".", ",")} Mo`);

async function renderFiles() {
  const box = $("tab-files");
  const agentId = state.agentId;
  box.innerHTML = '<p class="muted">Chargement…</p>';
  let files;
  try { files = await json(`/api/agents/${agentId}/files`); } catch (err) { box.innerHTML = '<p class="error"></p>'; box.firstChild.textContent = err.message; return; }
  box.replaceChildren();
  if (!files.length) {
    box.innerHTML = '<p class="muted">Aucun fichier pour l\'instant. Ce que l\'agent crée et ce que tu lui envoies apparaîtra ici.</p>';
    return;
  }
  const used = new Set();
  for (const [prefix, title] of FILE_GROUPS) {
    const group = files.filter((f) => !used.has(f.path) && f.path.startsWith(prefix));
    // Une application = un dossier : on montre son index.html plutôt que chaque fichier.
    const items = prefix === "apps/" ? group.filter((f) => /^apps\/[^/]+\/index\.html$/.test(f.path)) : group;
    group.forEach((f) => used.add(f.path));
    if (!items.length) continue;
    const section = document.createElement("section");
    section.className = "files-group";
    section.innerHTML = "<h3></h3>";
    section.querySelector("h3").textContent = title;
    for (const f of items.slice(0, 100)) section.append(fileRow(agentId, f, prefix === "apps/"));
    box.append(section);
  }
}

function fileRow(agentId, f, isApp) {
  const raw = `/api/agents/${agentId}/files/raw/${f.path.split("/").map(encodeURIComponent).join("/")}`;
  const row = document.createElement("div");
  row.className = "file";
  const isImage = /\.(png|jpe?g|gif|webp)$/i.test(f.path);
  if (isImage) {
    const img = document.createElement("img");
    img.src = `/api/agents/${agentId}/media?path=${encodeURIComponent("/opt/data/workspace/" + f.path)}`;
    img.alt = "";
    img.loading = "lazy";
    row.append(img);
  }
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = isApp ? f.path.split("/")[1] : f.path.replace(/^(outputs|uploads|captures)\//, "");
  name.title = f.path;
  const sz = document.createElement("span");
  sz.className = "size";
  sz.textContent = size(f.size);
  row.append(name, sz);
  if (isApp || /\.(html?|pdf|txt|md|csv|json|svg)$/i.test(f.path) || isImage) {
    const open = Object.assign(document.createElement("button"), { type: "button", className: "ghost", textContent: isApp ? "Ouvrir l'app" : "Aperçu" });
    open.addEventListener("click", () => {
      $("preview-title").textContent = name.textContent;
      $("preview-frame").src = raw;
      $("preview-open").href = raw;
      $("preview").hidden = false;
    });
    row.append(open);
  }
  const dl = Object.assign(document.createElement("a"), { className: "ghost button", textContent: "↓", href: raw + "?download=1", title: "Télécharger" });
  dl.style.padding = "4px 8px";
  row.append(dl);
  return row;
}

async function loadScreen() {
  const a = currentAgent();
  const frame = $("screen");
  if (state.viewOnly === undefined) state.viewOnly = true;
  $("take-control").textContent = state.viewOnly ? "Prendre le contrôle" : "Rendre la main à l'agent";
  $("control-hint").textContent = state.viewOnly
    ? "Lecture seule : l'agent garde la main. Prends le contrôle pour te connecter à un site ou résoudre un CAPTCHA, puis dis-lui de continuer."
    : "Tu as la main : clique et tape directement dans l'écran. Quand tu as fini, rends la main et dis à l'agent de continuer.";
  document.querySelector(".screen").classList.toggle("control", !state.viewOnly);
  if (!a) return;
  try {
    const { url } = await json(`/api/agents/${a.id}/screen-url?view_only=${state.viewOnly ? 1 : 0}`);
    frame.hidden = false;
    $("screen-empty").hidden = true;
    frame.src = url;
    $("screen-open").href = url;
  } catch (err) {
    frame.hidden = true;
    $("screen-empty").hidden = false;
  }
}

// --- Pièces jointes ------------------------------------------------------------------

async function uploadFiles(files) {
  if (!state.agentId || !files.length) return;
  state.attachments = state.attachments || [];
  for (const file of files) {
    const item = { name: file.name, path: null, busy: true };
    state.attachments.push(item);
    renderAttachments();
    try {
      const res = await api(`/api/agents/${state.agentId}/upload?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        body: file,
        headers: { "Content-Type": "application/octet-stream" },
      });
      item.path = (await res.json()).path;
    } catch (err) {
      item.error = err.message;
    }
    item.busy = false;
    renderAttachments();
  }
}

function renderAttachments() {
  const box = $("attachments");
  if (!box) return;
  const list = state.attachments || [];
  box.hidden = !list.length;
  box.replaceChildren(...list.map((item, i) => {
    const chip = document.createElement("span");
    chip.className = "chip" + (item.busy ? " busy" : "");
    chip.textContent = item.error ? `${item.name} (échec)` : item.busy ? `${item.name}…` : item.name;
    const x = Object.assign(document.createElement("button"), { type: "button", textContent: "✕", title: "Retirer" });
    x.addEventListener("click", () => { state.attachments.splice(i, 1); renderAttachments(); });
    chip.append(x);
    return chip;
  }));
}

async function refreshConversations() {
  const ul = $("conversations");
  if (!state.agentId) return ul.replaceChildren();
  const convs = await json(`/api/agents/${state.agentId}/conversations`);
  ul.replaceChildren(...convs.map((c) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-current", c.id === state.conversationId);
    b.innerHTML = '<span class="title"></span>';
    b.querySelector(".title").textContent = c.title;
    b.addEventListener("click", () => { openConversation(c.id); $("side").classList.remove("open"); $("scrim").hidden = true; });
    li.append(b);
    return li;
  }));
}

async function openConversation(id) {
  state.conversationId = id;
  const box = $("messages");
  box.replaceChildren();
  if (!id) {
    const a = currentAgent();
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = "<strong></strong><span></span>";
    empty.querySelector("strong").textContent = a ? `Que doit faire ${a.name} ?` : "Crée ton premier agent";
    empty.querySelector("span").textContent = a
      ? (a.role ? a.role.slice(0, 160) : "Écris une demande ci-dessous.")
      : "Utilise « + Nouveau » dans la colonne de gauche.";
    box.append(empty);
  } else {
    for (const m of await json(`/api/conversations/${id}/messages`)) {
      const el = addMessage(m.role === "user" ? "msg user" : m.role === "error" ? "msg error" : "msg agent", m.text);
      if (m.role === "agent") renderAgentText(el, m.text, state.agentId);
    }
    $("messages").scrollTop = $("messages").scrollHeight;
  }
  refreshConversations();
}

// Repère les images dans un texte d'agent : « MEDIA:/chemin.png » ou un chemin absolu d'image.
const MEDIA_RE = /(?:MEDIA:\s*)?(\/(?:opt\/data|tmp)\/[^\s"'`)\]]+\.(?:png|jpe?g|gif|webp))/gi;

function renderAgentText(el, text, agentId) {
  el.replaceChildren();
  let last = 0;
  for (const m of text.matchAll(MEDIA_RE)) {
    el.append(text.slice(last, m.index).replace(/\n+$/, "\n"));
    const img = document.createElement("img");
    img.className = "media";
    img.alt = "Image de l'agent";
    img.loading = "lazy";
    img.src = `/api/agents/${agentId}/media?path=${encodeURIComponent(m[1])}`;
    img.addEventListener("click", () => window.open(img.src, "_blank"));
    // Si l'image n'existe plus, on remet le chemin en texte.
    img.addEventListener("error", () => img.replaceWith(document.createTextNode(m[1])));
    el.append(img);
    last = m.index + m[0].length;
  }
  el.append(text.slice(last).replace(/^\n+/, ""));
}

function addMessage(cls, text) {
  const box = $("messages");
  box.querySelector(".empty")?.remove();
  const el = document.createElement("div");
  el.className = cls;
  if (text != null) el.textContent = text;
  box.append(el);
  box.scrollTop = box.scrollHeight;
  return el;
}

async function send(text) {
  const agentId = state.agentId;
  if ((state.attachments || []).some((a) => a.busy)) {
    addMessage("msg error", "Attends la fin de l'envoi des fichiers, puis renvoie ton message.");
    $("input").value = text;
    return;
  }
  const attachments = (state.attachments || []).filter((a) => a.path).map((a) => a.path);
  state.attachments = [];
  renderAttachments();
  addMessage("msg user", attachments.length ? `${text}\n\n📎 ${attachments.map((p) => p.split("/").pop()).join(", ")}` : text);
  state.busy = true;
  $("send").hidden = true;
  $("stop").hidden = false;
  const activity = addMessage("activity", "Réflexion…");
  let reply = null;
  try {
    const res = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ agent_id: agentId, text, attachments, conversation_id: state.conversationId, details: $("details").checked }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (chunk.startsWith("data:")) reply = handle(JSON.parse(chunk.slice(5)), activity, reply, agentId);
      }
    }
  } catch (err) {
    addMessage("msg error", err.message);
  } finally {
    activity.remove();
    state.busy = false;
    state.runId = null;
    $("send").hidden = false;
    $("stop").hidden = true;
    renderAgentHead();
    refreshConversations();
    refreshModel();
    if (!$("panel").hidden && state.panelTab !== "computer") openPanel(state.panelTab);
  }
}

function handle(ev, activity, reply, agentId) {
  const box = $("messages");
  switch (ev.type) {
    case "start":
      state.conversationId = ev.conversation_id;
      state.runId = ev.run_id;
      break;
    case "message":
      if (!reply) reply = addMessage("msg agent", "");
      reply.textContent += ev.text;
      box.append(activity);
      box.scrollTop = box.scrollHeight;
      break;
    case "activity":
      activity.textContent = ev.label + "…";
      if (ev.detail) addMessage("detail", JSON.stringify(ev.detail, null, 2));
      break;
    case "activity_detail":
    case "raw":
      addMessage("detail", JSON.stringify(ev.detail || { [ev.kind]: ev.data }, null, 2));
      break;
    case "approval":
      approvalCard(ev, agentId);
      break;
    case "done":
      if (!reply && ev.output) reply = addMessage("msg agent", ev.output);
      if (reply) renderAgentText(reply, reply.textContent, agentId);
      if (ev.status !== "completed") addMessage("msg error", ev.error);
      break;
  }
  return reply;
}

function approvalCard(ev, agentId) {
  const card = addMessage("approval");
  card.innerHTML = '<b>À valider</b><p></p><div class="row"><button type="button">Autoriser</button><button type="button" class="ghost">Refuser</button></div>';
  card.querySelector("p").textContent = ev.summary;
  const runId = state.runId;
  const [yes, no] = card.querySelectorAll("button");
  const answer = async (approve) => {
    yes.disabled = no.disabled = true;
    try {
      await post(`/api/agents/${agentId}/runs/${runId}/approval`, { request_id: ev.request_id, generation: ev.generation, approve });
      card.querySelector(".row").textContent = approve ? "Autorisé" : "Refusé";
    } catch (err) {
      card.querySelector(".row").textContent = "La réponse n'a pas été prise en compte : " + err.message;
    }
  };
  yes.addEventListener("click", () => answer(true));
  no.addEventListener("click", () => answer(false));
}

// --- Fenêtre de création / réglages d'un agent -------------------------------------

function agentModal(agent) {
  const modal = $("modal");
  modal.replaceChildren(clone("tpl-agent"));
  modal.hidden = false;
  const close = () => { modal.hidden = true; modal.replaceChildren(); };
  const form = $("form-agent");
  if (agent) {
    $("agent-title").textContent = `Réglages de ${agent.name}`;
    $("agent-name").value = agent.name;
    $("agent-role").value = agent.role;
    $("agent-save").textContent = "Enregistrer";
    $("agent-delete").hidden = false;
  }
  $("agent-cancel").addEventListener("click", close);
  $("agent-delete").addEventListener("click", async () => {
    const b = $("agent-delete");
    if (b.dataset.confirm !== "1") {
      b.dataset.confirm = "1";
      b.textContent = "Confirmer la suppression";
      return;
    }
    b.disabled = true;
    await json(`/api/agents/${agent.id}`, { method: "DELETE" });
    close();
    state.agentId = null;
    await refreshAgents();
    if (state.agents.length) selectAgent(state.agents[0].id);
    else { refreshConversations(); openConversation(null); }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    $("agent-save").disabled = true;
    const body = { name: $("agent-name").value.trim(), role: $("agent-role").value.trim() };
    try {
      if (agent) {
        await post(`/api/agents/${agent.id}`, body, "PATCH");
        close();
        refreshAgents();
      } else {
        const { id } = await post("/api/agents", body);
        close();
        await refreshAgents();
        selectAgent(id);
      }
    } catch (err) {
      showError(form, err);
      $("agent-save").disabled = false;
    }
  });
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

boot().catch((e) => {
  app.innerHTML = '<p class="error center"></p>';
  app.firstChild.textContent = "Impossible de joindre le serveur Apollo : " + e.message;
});
