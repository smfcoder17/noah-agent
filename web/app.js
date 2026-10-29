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

async function modelForm(container, { first = false, onDone } = {}) {
  container.replaceChildren(clone("tpl-model"));
  const [providers, current] = await Promise.all([json("/api/providers"), first ? null : json("/api/model")]);
  const list = $("providers");
  let chosen = null;

  function choose(p, keepModel) {
    chosen = p;
    list.querySelectorAll(".provider").forEach((b) => b.setAttribute("aria-checked", b.dataset.id === p.id));
    $("key-field").hidden = !p.needs_key;
    $("api-key").placeholder = current && current.provider === p.id && current.has_key ? "Clé enregistrée (laisser vide pour la garder)" : "";
    if (!keepModel) $("model").value = p.default_model;
  }
  for (const p of providers) {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "provider", textContent: p.label });
    b.setAttribute("role", "radio");
    b.dataset.id = p.id;
    b.addEventListener("click", () => choose(p));
    list.append(b);
  }
  if (current) {
    choose(providers.find((p) => p.id === current.provider) || providers[0], true);
    $("model").value = current.model;
  } else {
    choose(providers[0]);
  }

  if (!first) {
    $("model-cancel").hidden = false;
    $("model-cancel").addEventListener("click", onDone);
  }
  const form = $("form-model");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    button.textContent = first ? "Création de ton premier agent…" : "Application aux agents…";
    try {
      await post("/api/model", { provider: chosen.id, api_key: $("api-key").value || null, model: $("model").value.trim() });
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

  refreshModel();
  await refreshAgents();
  if (state.agents.length) selectAgent(state.agentId && state.agents.some((a) => a.id === state.agentId) ? state.agentId : state.agents[0].id);
  setInterval(refreshAgents, 4000);
}

async function refreshModel() {
  try {
    state.model = await json("/api/model");
    $("model-name").textContent = state.model ? state.model.model : "aucun";
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
  refreshAgents();
  await refreshConversations();
  openConversation(null);
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
      addMessage(m.role === "user" ? "msg user" : m.role === "error" ? "msg error" : "msg agent", m.text);
    }
  }
  refreshConversations();
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
  addMessage("msg user", text);
  state.busy = true;
  $("send").hidden = true;
  $("stop").hidden = false;
  const activity = addMessage("activity", "Réflexion…");
  let reply = null;
  try {
    const res = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ agent_id: agentId, text, conversation_id: state.conversationId, details: $("details").checked }),
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
