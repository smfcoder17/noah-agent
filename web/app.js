const app = document.getElementById("app");
const state = { conversationId: null, runId: null, busy: false };

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

function mount(id) {
  app.replaceChildren(document.getElementById(id).content.cloneNode(true));
}

function showError(form, err) {
  const p = form.querySelector(".error");
  p.textContent = err.message;
  p.hidden = false;
}

async function boot() {
  const status = await (await api("/api/status")).json();
  if (!status.has_account) return accountScreen();
  try {
    await api("/api/conversations");
  } catch (e) {
    if (e.status === 401) return loginScreen();
    throw e;
  }
  if (!status.model_configured) return modelScreen();
  chatScreen(status.agent_online);
}

function credentialsForm(tpl, formId, path) {
  mount(tpl);
  const form = document.getElementById(formId);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    form.querySelector("button").disabled = true;
    try {
      await api(path, {
        method: "POST",
        body: JSON.stringify({
          username: document.getElementById("username").value.trim(),
          password: document.getElementById("password").value,
        }),
      });
      boot();
    } catch (err) {
      showError(form, err);
      form.querySelector("button").disabled = false;
    }
  });
}

const accountScreen = () => credentialsForm("tpl-account", "form-account", "/api/setup/account");
const loginScreen = () => credentialsForm("tpl-login", "form-login", "/api/login");

async function modelScreen() {
  mount("tpl-model");
  const providers = await (await api("/api/providers")).json();
  const list = document.getElementById("providers");
  const keyField = document.getElementById("key-field");
  const model = document.getElementById("model");
  let chosen = null;

  function choose(p) {
    chosen = p;
    list.querySelectorAll(".provider").forEach((b) => b.setAttribute("aria-checked", b.dataset.id === p.id));
    keyField.hidden = !p.needs_key;
    model.value = p.default_model;
  }
  for (const p of providers) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "provider";
    b.setAttribute("role", "radio");
    b.dataset.id = p.id;
    b.textContent = p.label;
    b.addEventListener("click", () => choose(p));
    list.append(b);
  }
  choose(providers[0]);

  const form = document.getElementById("form-model");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    button.textContent = "Démarrage de l'agent…";
    try {
      await api("/api/setup/model", {
        method: "POST",
        body: JSON.stringify({
          provider: chosen.id,
          api_key: document.getElementById("api-key").value || null,
          model: model.value || null,
        }),
      });
      chatScreen(false);
    } catch (err) {
      showError(form, err);
      button.disabled = false;
      button.textContent = "Enregistrer et démarrer l'agent";
    }
  });
}

function chatScreen(online) {
  mount("tpl-chat");
  const messages = document.getElementById("messages");
  const input = document.getElementById("input");
  const statusEl = document.getElementById("agent-status");

  async function refreshStatus() {
    try {
      const s = await (await api("/api/status")).json();
      statusEl.textContent = s.agent_online ? "Agent en ligne" : "Agent en démarrage";
      statusEl.className = "status " + (s.agent_online ? "on" : "off");
    } catch {}
  }
  statusEl.textContent = online ? "Agent en ligne" : "Agent en démarrage";
  statusEl.className = "status " + (online ? "on" : "off");
  setInterval(refreshStatus, 5000);

  document.getElementById("change-model").addEventListener("click", () => modelScreen());

  document.getElementById("new-chat").addEventListener("click", () => {
    state.conversationId = null;
    messages.replaceChildren();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.getElementById("composer").requestSubmit();
    }
  });

  document.getElementById("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || state.busy) return;
    input.value = "";
    document.getElementById("empty")?.remove();
    add("div", "msg user", text);
    await send(text);
  });

  function add(tag, cls, text) {
    const el = document.createElement(tag);
    el.className = cls;
    if (text != null) el.textContent = text;
    messages.append(el);
    messages.scrollTop = messages.scrollHeight;
    return el;
  }

  async function send(text) {
    state.busy = true;
    document.getElementById("send").disabled = true;
    const activity = add("div", "activity", "Réflexion…");
    let reply = null;
    try {
      const res = await api("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          text,
          conversation_id: state.conversationId,
          details: document.getElementById("details").checked,
        }),
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
          if (!chunk.startsWith("data:")) continue;
          const ev = JSON.parse(chunk.slice(5));
          reply = handle(ev, activity, reply);
        }
      }
    } catch (err) {
      add("div", "msg agent failed", err.message);
    } finally {
      activity.remove();
      state.busy = false;
      document.getElementById("send").disabled = false;
    }
  }

  function handle(ev, activity, reply) {
    switch (ev.type) {
      case "start":
        state.conversationId = ev.conversation_id;
        state.runId = ev.run_id;
        break;
      case "message":
        if (!reply) reply = add("div", "msg agent", "");
        reply.textContent += ev.text;
        messages.append(activity);
        messages.scrollTop = messages.scrollHeight;
        break;
      case "activity":
        activity.textContent = ev.label + "…";
        if (ev.detail) add("div", "detail", JSON.stringify(ev.detail, null, 2));
        break;
      case "activity_detail":
      case "raw":
        add("div", "detail", JSON.stringify(ev.detail || { [ev.kind]: ev.data }, null, 2));
        break;
      case "approval":
        approvalCard(ev);
        break;
      case "done":
        if (!reply && ev.output) reply = add("div", "msg agent", ev.output);
        if (ev.status !== "completed") add("div", "msg agent failed", ev.error);
        break;
    }
    return reply;
  }

  function approvalCard(ev) {
    const card = add("div", "approval");
    card.innerHTML = '<b>À valider</b><p></p><div class="row"><button type="button">Autoriser</button><button type="button" class="ghost">Refuser</button></div>';
    card.querySelector("p").textContent = ev.summary;
    const [yes, no] = card.querySelectorAll("button");
    const answer = async (approve) => {
      yes.disabled = no.disabled = true;
      await api(`/api/runs/${state.runId}/approval`, {
        method: "POST",
        body: JSON.stringify({ request_id: ev.request_id, generation: ev.generation, approve }),
      });
      card.querySelector(".row").textContent = approve ? "Autorisé" : "Refusé";
    };
    yes.addEventListener("click", () => answer(true));
    no.addEventListener("click", () => answer(false));
  }
}

boot().catch((e) => {
  app.innerHTML = '<p class="error center"></p>';
  app.firstChild.textContent = "Impossible de joindre le serveur Apollo : " + e.message;
});
