// Sensibilité des tests : on abîme le code exprès, un défaut à la fois, sur une copie. Un test qui reste vert ne protège rien.
//     node tools/eval/sabotage.mjs
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PIP = "pip install -q -r /app/requirements.txt && ";
const BUDGET = PIP + "python /tests/budget/budget_test.py";
const WATCH = PIP + "python /tests/watch/watch_test.py";
const GUARD = "python /tests/skills/guard_test.py";
const PAIRING = PIP + "python /tests/pairing/pairing_test.py";
const MCP = PIP + "python /tests/tools/mcp_test.py";
const PENDANT = PIP + "python /tests/voice/pendant_test.py";
const APERCU = PIP + "python /tests/agents/apercu_test.py";
const DECISION = PIP + "python /tests/agents/decision_test.py";
const APPAREILS = PIP + "timeout 120 python /tests/desktop/appareils_test.py";
const CONNEXION = PIP + "python /tests/agents/connexion_logos_test.py";
const DOSSIERS = "node /repo/tests/desktop/dossiers_test.mjs";
const ENVOI = "mkdir -p /data && node /tests/navigateur/envoi_test.mjs";
const ENVOI_OUTIL = "python /tests/navigateur/envoi_outil_test.py";
const CONFIG_AGENT = PIP + "python /tests/agents/config_agent_test.py";
const PLUGIN = "launcher/camofox-noah/index.js";

// NOAH_SABOTAGE=mot : seulement les sabotages dont le nom contient ce mot, pour rejouer un cas.
const SABOTAGES = [
  ["Routine : la consigne de l'entrée standard est perdue", "noah/hermes.py", 'sys.stdin.read().strip() if a[3:] == ["-"] else " ".join(a[3:])', '" ".join(a[3:])', ENVOI_OUTIL],
  ["Routine : le texte de la consigne compte comme des commandes", "noah/agent_plugin/__init__.py", "    command = _without_routine_text(command)\n", "", GUARD],
  ["Routine : une commande passe cachée après le texte", "noah/agent_plugin/__init__.py", " or any(line.strip() for line in lines[lines.index(found.group(1)) + 1:])", "", GUARD],
  ["Fuseau : un invité change l'heure du propriétaire", "noah/main.py", "await asyncio.to_thread(access.owner_app, token)", "await asyncio.to_thread(auth.still_valid, token)", CONFIG_AGENT],
  ["Agent : à l'heure du serveur", "noah/hermes.py", 'tz = client_zone() or (await browser_identity()).get("timezone")', 'tz = (await browser_identity()).get("timezone")', CONFIG_AGENT],
  ["Agent : Hermes coupe le réveil à 30 s", "noah/hermes.py", 'plugins["hook_callback_timeout"] = 600', 'plugins["hook_callback_timeout"] = 30', CONFIG_AGENT],
  ["Agent : le réveil dépasse le délai d'Hermes", "noah/agent_plugin/__init__.py", "capture_output=True, timeout=HOOK_SECONDS - 30)", "capture_output=True, timeout=900)", CONFIG_AGENT],
  ["Outil : un nom à tiret n'est jamais vu en lecture", "noah/agent_plugin/__init__.py", "if sanitize_mcp_name_component(name) == tool]", "if name == tool]", GUARD],
  ["Outil : un nom ambigu passe pour une lecture", "noah/agent_plugin/__init__.py", "return bool(same) and all(hint is True for hint in same)", "return any(hint is True for hint in same)", GUARD],
  ["Envoi : n'importe qui dépose un fichier", PLUGIN, 'if (!agentKeyGiven(req)) return res.status(403).json({ error: "Forbidden" });', "", ENVOI],
  ["Envoi : le nom sort du dossier", PLUGIN, "const nom = safeName(req.query.nom);", "const nom = String(req.query.nom);", ENVOI],
  ["Envoi : aucun plafond", PLUGIN, "if (size > limit) done(tooBig());", "if (false) done(tooBig());", ENVOI],
  ["Envoi : deux envois simultanés dépassent le plafond", PLUGIN, "if (used + others + limit > MAX_TOTAL) throw tooBig();", "if (used + limit > MAX_TOTAL) throw tooBig();", ENVOI],
  ["Envoi : un champ déjà là après un bouton sans effet", PLUGIN, "if (!seen || (onlyNew && seen.before)) continue;", "if (!seen) continue;", ENVOI],
  ["Envoi : une fenêtre cachée passe avant la page", PLUGIN, 'return { place: !dialog ? "page" : open ? "fenetre" : "cachee", before: Boolean(el.__noahAvantClic) };', 'return { place: !dialog ? "page" : "fenetre", before: Boolean(el.__noahAvantClic) };', ENVOI],
  ["Envoi : un cadre caché compte", PLUGIN, "if (frame.parentFrame?.() && !(await frame.frameElement().then((el) => el.isVisible()).catch(() => false))) continue;", "", ENVOI],
  ["Envoi : la prise en main n'arrête pas un envoi engagé", PLUGIN, 'notTakenOver();\n    await input.setInputFiles', "await input.setInputFiles", ENVOI],
  ["Envoi : téléchargement hors de https", "noah/hermes.py", 'not words[0].lower().startswith("https://")', "False", ENVOI_OUTIL],
  ["Envoi : redirection hors de https suivie", "noah/hermes.py", 'if not newurl.lower().startswith("https://"):', "if False:", ENVOI_OUTIL],
  ["Envoi : un téléchargement écrase un fichier", "noah/hermes.py", "os.link(temporary, final)  # échoue si le nom existe : rien n'est écrasé", "os.replace(temporary, final)", ENVOI_OUTIL],
  ["Envoi : un nom de fichier sort du dossier", "noah/hermes.py", 'if not re.fullmatch(r"[^\\W_][\\w .()-]{0,119}", name):', "if False:", ENVOI_OUTIL],
  ["Envoi : un téléchargement coupé accepté", "noah/hermes.py", "if expected and expected.isdigit() and int(expected) != size:", "if False:", ENVOI_OUTIL],
  ["Envoi : la fenêtre que le bouton ouvre refusée", PLUGIN, "el.__noahAvantClic = !closed;", "el.__noahAvantClic = true;", ENVOI],
  ["Envoi : tout va bien alors que la main a changé", PLUGIN, 'if (Date.now() < privateUntil) throw fail(423, "L\'utilisateur a pris la main pendant l\'envoi', 'if (false) throw fail(423, "L\'utilisateur a pris la main pendant l\'envoi', ENVOI],
  ["Garde : un script téléchargé par noah.py lancé sans lecture", "noah/agent_plugin/__init__.py", 'unread.add(_path(f"{WORKSPACE}/uploads/{words[i + 4]}"))', "pass", GUARD],
  ["Garde : le téléchargement caché derrière une option", "noah/agent_plugin/__init__.py", 'if os.path.basename(w) == "noah.py" and words[i + 1:i + 3]', 'if i == 1 and os.path.basename(w) == "noah.py" and words[i + 1:i + 3]', GUARD],
  ["Envoi : un onglet de connexion pris pour celui de l'agent", PLUGIN, "for (const group of own ? [own] : session?.tabGroups?.values() || []) {", "for (const group of session?.tabGroups?.values() || []) {", ENVOI],
  ["Envoi : un profil invité joint un fichier", "noah/hermes.py", 'home, base, key, user = browser_access()\n    if "/profiles/" in home:', 'home, base, key, user = browser_access()\n    if False:', ENVOI_OUTIL],
  ["Garde : un invité envoie un fichier du disque commun", "noah/agent_plugin/__init__.py", 'if len(words) >= 4 and words[2] == "navigateur" and words[3] not in GUEST_BROWSER:', "if False:", GUARD],
  ["Envoi : un transfert coupé reste sur le disque", PLUGIN, 'fs.rmSync(dir, { recursive: true, force: true });\n    if (!res.headersSent)', "if (!res.headersSent)", ENVOI],
  ["Envoi : les vieux fichiers restent", PLUGIN, "Date.now() - fs.statSync(dir).mtimeMs > KEEP_MS", "false", ENVOI],
  ["Envoi : le premier champ pris au hasard", PLUGIN, "if (candidates.length === 1) return candidates[0];", "if (candidates.length) return candidates[0];", ENVOI],
  ["Envoi : le champ de profil avant la fenêtre ouverte", PLUGIN, "const candidates = inOpenDialogs.length ? inOpenDialogs : onPage;", "const candidates = onPage.length ? onPage : inOpenDialogs;", ENVOI],
  ["Envoi : l'agent joint pendant la prise en main", PLUGIN, 'function notTakenOver() {\n  if (Date.now() < privateUntil)', "function notTakenOver() {\n  if (false)", ENVOI],
  ["Envoi : la configuration de l'agent peut partir", "noah/hermes.py", "if not real.startswith(root + os.sep):", "if False:", ENVOI_OUTIL],
  ["Envoi : un lien sort de l'espace de travail", "noah/hermes.py", "real = os.path.realpath(local)", "real = os.path.abspath(local)", ENVOI_OUTIL],
  ["Envoi : le voisin de l'espace de travail accepté", "noah/hermes.py", "if not real.startswith(root + os.sep):", "if not real.startswith(root):", ENVOI_OUTIL],
  ["Envoi : l'identité d'un invité ignorée", "noah/hermes.py", 'user = found.group(1) if found else user', "pass", ENVOI_OUTIL],
  ["Envoi : un autre user_id de la configuration pris pour l'identité", "noah/hermes.py", String.raw`r"camofox:[ \t]*\n(?:[ \t]+.*\n)*?[ \t]+user_id:\s*[\"']?([\w-]+)"`, String.raw`r"user_id:\s*[\"']?([\w-]+)"`, ENVOI_OUTIL],
  ["Outil : une écriture passe pour une lecture", "noah/mcp.py", 'if tool in known and _is_read_only(known[tool]):  # lire ne change rien', 'if tool in known:  # lire ne change rien', MCP],
  ["Appareil : la réponse d'un autre appareil acceptée", "noah/desktop.py", "elif future is None or owner != user or target != device:", "elif future is None:", APPAREILS],
  ["Appareil : un fichier en attente servi à un autre", "noah/desktop.py", 'if not row or row["user_id"] != user or row["appareil"] != _device(request, noah_session) or not path.is_file():', "if not row or not path.is_file():", APPAREILS],
  ["Appareil : le chemin d'un dossier gardé par le serveur", "noah/desktop.py", 'shown = [{"id": str(d.get("id", ""))[:40], "nom": str(d.get("nom", ""))[:120], "ecriture": bool(d.get("ecriture")), "absent": bool(d.get("absent"))} for d in body.dossiers]', "shown = body.dossiers", APPAREILS],
  ["Appareil : file d'attente sans plafond", "noah/desktop.py", "if size > MAX_FILE or (user is not None and _pending_bytes(user) + _receiving[user] > MAX_PENDING):", "if False:", APPAREILS],
  ["Appareil : un fichier en attente n'expire jamais", "noah/desktop.py", 'if row["expire"] <= now:', "if False:", APPAREILS],
  ["Connexions : un état périmé remis en mémoire", "noah/machine.py", "if _connections_version.get(agent_id, 0) == version:", "if True:", APPAREILS],
  ["Connexions : un changement n'oublie pas le cache", "noah/machine.py", "    _connections.pop(agent_id, None)\n", "", APPAREILS],
  ["Dossier : un lien sort du dossier", "desktop/dossiers.js", 'if (!inside(root, existing)) throw new Refus("Ce chemin mène hors du dossier.");', "", DOSSIERS],
  ["Dossier : lecture seule ignorée", "desktop/dossiers.js", 'if (!folder.ecriture) throw new Refus(', 'if (false) throw new Refus(', DOSSIERS],
  ["Dossier : un fichier existant écrasé", "desktop/dossiers.js", "fs.linkSync(temporary, candidate); // échoue d'un coup si le nom existe", "fs.copyFileSync(temporary, candidate);", DOSSIERS],
  ["Dossier : fichiers sensibles permis", "desktop/dossiers.js", 'if (isSensitive(parts) || isSensitive(path.relative(root, target).split(path.sep))) throw new Refus("Fichier sensible : refusé d\'office, quel que soit le droit.");', "", DOSSIERS],
  ["Dossier : permis pour toujours malgré un programme changé", "desktop/dossiers.js", "t.exe === print.exe && t.sha256 === print.sha256", "t.exe === print.exe", DOSSIERS],
  ["Dossier : un lanceur permis pour toujours", "desktop/dossiers.js", "return ALWAYS_PROGRAMS.test(bare) ? { program: bare, args } : null;", "return { program: bare, args };", DOSSIERS],
  ["Dossier : l'accès coupé levé par un changement de compte", "desktop/dossiers.js", "state = { ...EMPTY(), coupe: state.coupe };", "state = EMPTY();", DOSSIERS],
  ["Dossier : un fichier qui agit écrit sans accord", "desktop/dossiers.js", "if (needsConsent(target, pieces(relative)) && !(await", "if (false && !(await", DOSSIERS],
  ["Dossier : un nom trompeur accepté", "desktop/dossiers.js", 'if (DECEIVING.test(part)) throw new Refus("Ce nom contient des caractères invisibles ou de contrôle.");', "", DOSSIERS],
  ["Dossier : l'erreur du système part telle quelle", "desktop/dossiers.js", 'return { message: final[error.code] ?? "Le système de l\'ordinateur a refusé cette opération.", later: false };', "return { message: error.message, later: false };", DOSSIERS],
  ["Bureau : un autre serveur obtient une demande sans vérification", "desktop/actions.js", "if (attachedTo !== `${link.origin}|${link.token}` && !(await beat())) {", "if (false) {", DOSSIERS],
  ["Bureau : le nom de l'agent imite un message", "desktop/actions.js", 'const who = clean(req.agent) || "Noah";', 'const who = req.agent || "Noah";', DOSSIERS],
  ["Appareil : une demande non reçue perdue", "noah/desktop.py", 'if last and fichiers and last["id"] != recu and (last["id"] in _waiting or _pending_row(last["id"])):', "if False:", APPAREILS],
  ["Appareil : un agent partagé en admin atteint l'ordinateur", "noah/desktop.py", "if access.guest_task(agent_id) or access.shared_admin(agent_id):", "if access.guest_task(agent_id):", APPAREILS],
  ["Appareil : un ordinateur disparu fait attendre 5 minutes", "noah/desktop.py", 'if seen.get("bat") and not _online(device):', "if False:", APPAREILS],
  ["Connexion : l'accord d'un autre compte accepté", "noah/connexion.py", 'if login.get("user") is not None and here is not None and here != login["user"]:', "if False:", CONNEXION],
  ["Connexion : sans session, sans confirmation", "noah/connexion.py", 'if login.get("user") is not None and here is None and not params.get("error"):', "if False:", CONNEXION],
  ["Bureau : l'accès coupé ne coupe rien", "desktop/actions.js", 'if (store?.isCut() && req.action !== "notifier") return CUT;', "", DOSSIERS],
  ["Bureau : un nom d'application piégé arrive au système", "desktop/actions.js", 'if (!APP_NAME.test(name)) return { erreur: "Donne seulement le nom de l\'application, sans chemin ni symbole." };', "", DOSSIERS],
  ["Bureau : un accord tardif agit quand même", "desktop/actions.js", "const blocked = await stop();\n      if (blocked) return blocked;\n      clipboard.writeText(text);", "clipboard.writeText(text);", DOSSIERS],
  ["Bureau : ouvrir suit une liste trop large", "desktop/actions.js", 'if (!isDir && !OPENABLE.test(finale)) return { erreur: "Noah n\'ouvre pas ce type de fichier directement : utilise « commande », qui demande un accord." };', "", DOSSIERS],
  ["Plafond de dépense ignoré", "noah/relay.py", "if cap is None or day_cost(agent_id) < cap:", "if True:", BUDGET],
  ["Heures non retirées des pages surveillées", "noah/watch.py", String.raw`text = _STAMP.sub(r"\1", _VOLATILE.sub(" ", text))`, "pass", WATCH],
  ["Téléchargement puis exécution autorisés", "noah/agent_plugin/__init__.py", 'DOWNLOADER = r"(?:curl|wget|iwr|invoke-webrequest|fetch)"', 'DOWNLOADER = r"(?:zzzz)"', GUARD],
  ["Session d'appairage qui n'expire plus", "noah/auth.py", "UNCLAIMED = timedelta(minutes=10)", "UNCLAIMED = timedelta(days=3650)", PAIRING],
  ["Outil : adresse jugée sans la résolution DNS", "noah/mcp.py", '_judge(ipaddress.ip_address(a), "https" if for_source else scheme)', "pass", MCP],
  ["Veille : redirection suivie sans contrôle", "noah/watch.py", "target = await mcp.resolve(url, for_source=True)", 'target = mcp.Target(*(lambda p: (p.scheme, p.hostname, p.port or {"https": 443, "http": 80}[p.scheme], p.path or "/", p.hostname))(mcp.urlsplit(url)))', WATCH],
  ["Veille : réponse lue sans plafond", "noah/watch.py", "if len(body) >= limit:", "if False:", WATCH],
  ["Aperçu : session révoquée, le lien sert encore", "noah/main.py", "not auth.session_alive(session) or ", "", APERCU],
  ["Outil : jeton en clair en base", "noah/mcp.py", "db.seal(token) if token else None", "token", MCP],
  ["Outil : « confirmer » laisse passer sans accord", "noah/mcp.py", 'if _take_grant(row["agent_id"], name, _shown(tool, args if args is not None else {})):', "if True:", MCP],
  ["Outil : un accord sert plusieurs fois", "noah/mcp.py", "left.remove(match)", "pass", MCP],
  ["Outil : garde qui accepte par défaut", "noah/agent_plugin/__init__.py", 'droit = rights.get(server, "confirmer")', 'droit = rights.get(server, "agir")', MCP],
  ["Outil : une panne casse le tour de l'agent", "noah/mcp.py", 'return _tool_error(msg_id, _outage_text(name, erreur.rstrip(".")))', 'raise HTTPException(502, "panne")', MCP],
  ["Pendant le travail : même envoi compté deux fois", "noah/pendant.py", "INSERT OR IGNORE INTO pending_requests", "INSERT OR REPLACE INTO pending_requests", PENDANT],
  ["Pendant le travail : la file part par-dessus le travail", "noah/pendant.py", 'elif _h["busy"](agent_id, conv) or _h["paused"]():', "elif False:", PENDANT],
  ["Pendant le travail : accès retiré, la demande part quand même", "noah/pendant.py", 'if not _h["allowed"](row["user_id"], agent_id):', "if False:", PENDANT],
  ["Pendant le travail : une demande perdue au redémarrage", "noah/pendant.py", 'c.execute("UPDATE pending_requests SET status = ? WHERE status IN (?, ?)", (WAITING, TRI, RUNNING))', "pass", PENDANT],
  ["Pendant le travail : une demande retirée peut encore partir", "noah/main.py", 'if not pendant.move(request_id, (pendant.WAITING, pendant.ANSWERED), pendant.SENDING):', 'if not pendant.move(request_id, (pendant.WAITING, pendant.ANSWERED, pendant.CANCELLED, pendant.DONE), pendant.SENDING):', PENDANT],
  ["Pendant le travail : réponse perdue, la précision repart", "noah/main.py", "return STEER_UNSURE", "return STEER_REFUSED", PENDANT],
  ["Pendant le travail : droit retiré pendant le tri", "noah/main.py", 'if not access.allowed(user, agent.id, "usage"):  # le tri prend du temps', 'if False:  # le tri prend du temps', PENDANT],
  ["Activité : une clé affichée dans la ligne de travail", "noah/events.py", "label = mask(label)[:LABEL_MAX] if label else label", "pass", PENDANT],
  ["Aperçu : une page voit tout le dossier commun", "noah/main.py", "own_folder = bool(folder) and folder not in PREVIEW_SHARED_FOLDERS", "own_folder = bool(folder)", APERCU],
  ["Garde : un déplacement de patch ignoré", "noah/agent_plugin/__init__.py", "targets += [move.group(1).strip(), move.group(2).strip()]", "pass", GUARD],
  ["Routine : le cerveau part même si la condition n'est pas remplie", "noah/watch.py", 'if not (alert and alert["pertinent"] and alert["resume"]):', "if not alert:", DECISION],
  ["Décision : l'essai ne regarde pas la réponse", "noah/decision.py", 'elif a.data.get("pertinent") is not True or _numbers(a.data.get("retenues")) != {2}:', "elif False:", DECISION],
  ["Mémoire : tout entre sans jugement", "noah/agent_plugin/__init__.py", 'if tool_name == "memory":', "if False:", DECISION],
  ["Outil : ajout sans contrôle d'accès", "noah/mcp.py", 'access.access(user, agent_id, "admin")\n    _scope(agent_id)\n    machine.forget_connections(agent_id)\n    token = _clean_token(body)', "_scope(agent_id)\n    token = _clean_token(body)", MCP],
];

function runDesktop([sabotage, path, old, replacement, cmd]) {
  const tmp = mkdtempSync(join(tmpdir(), "noah-sabotage-"));
  try {
    for (const part of ["desktop", "tests/desktop"]) {
      cpSync(join(ROOT, part), join(tmp, part), { recursive: true, filter: (p) => !p.includes("node_modules") && !p.includes("dist") });
    }
    const target = join(tmp, path);
    const source = readFileSync(target, "utf8");
    if (old && source.split(old).length !== 2) return { sabotage, resultat: "cible introuvable" };
    if (old) writeFileSync(target, source.replace(old, () => replacement));
    const r = spawnSync("docker", ["run", "--rm", "-v", `${tmp}:/repo`, "node:22-alpine", "sh", "-c", cmd], { timeout: 120000 });
    const seen = r.status === 1 && String(r.stdout).includes("ÉCHEC");
    return { sabotage, resultat: seen ? "vu" : r.status ? "panne" : "NON VU" };
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 2 });
  }
}

function runPlugin([sabotage, path, old, replacement, cmd]) {
  const tmp = mkdtempSync(join(tmpdir(), "noah-sabotage-"));
  try {
    for (const part of ["launcher/camofox-noah", "tests/navigateur", "tests/handoff"]) cpSync(join(ROOT, part), join(tmp, part), { recursive: true });
    const target = join(tmp, path);
    const source = readFileSync(target, "utf8");
    if (old && source.split(old).length !== 2) return { sabotage, resultat: "cible introuvable" };
    if (old) writeFileSync(target, source.replace(old, () => replacement));
    const r = spawnSync("docker", ["run", "--rm", "-v", `${join(tmp, "launcher/camofox-noah")}:/p:ro`, "-v", `${join(tmp, "tests")}:/tests:ro`, "node:22-alpine", "sh", "-c", cmd], { timeout: 180000 });
    const seen = r.status && String(r.stderr).includes("AssertionError");
    return { sabotage, resultat: seen ? "vu" : r.status ? "panne" : "NON VU" };
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 2 });
  }
}

function run(item) {
  if (item[1].startsWith("desktop/")) return runDesktop(item);
  if (item[1].startsWith("launcher/")) return runPlugin(item);
  const [sabotage, path, old, replacement, cmd] = item;
  const tmp = mkdtempSync(join(tmpdir(), "noah-sabotage-"));
  try {
    const server = join(tmp, "server");
    cpSync(join(ROOT, "server"), server, { recursive: true, filter: (p) => !p.includes("__pycache__") });
    const target = join(server, path);
    const source = readFileSync(target, "utf8");
    if (old && source.split(old).length !== 2) return { sabotage, resultat: "cible introuvable" };
    if (old) writeFileSync(target, source.replace(old, () => replacement));
    const r = spawnSync("docker", ["run", "--rm", "-e", "PYTHONDONTWRITEBYTECODE=1", "-v", `${server}:/app`, "-v", `${join(ROOT, "tests")}:/tests`, "-v", `${join(ROOT, "launcher")}:/l:ro`,
      "-v", `${join(ROOT, "frontend/src/App.tsx")}:/front/App.tsx:ro`, "-v", `${join(ROOT, "mobile/www/app.js")}:/mobile/app.js:ro`,
      "python:3.12-slim", "sh", "-c", cmd], { timeout: 600000 });
    // Seule une assertion compte : une panne d'installation ou de Docker ne prouve rien.
    const seen = r.status && String(r.stderr).includes("AssertionError");
    return { sabotage, resultat: seen ? "vu" : r.status ? "panne" : "NON VU" };
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 2 });
  }
}

// Témoin : la même chaîne sans défaut doit rester verte, sinon un « vu » ne prouve rien.
const CHOISIS = SABOTAGES.filter((s) => !process.env.NOAH_SABOTAGE || new RegExp(process.env.NOAH_SABOTAGE, "i").test(s[0]));
const TEMOINS = [...new Set(CHOISIS.map((s) => s[4]))].map((cmd) => run(["témoin", cmd === DOSSIERS ? "desktop/dossiers.js" : cmd === ENVOI ? PLUGIN : "noah/auth.py", "", "", cmd]));
if (TEMOINS.some((t) => t.resultat !== "NON VU")) {
  console.error("Un témoin échoue sans sabotage : les résultats ne valent rien.");
  process.exit(2);
}
const results = CHOISIS.map(run);
console.log(JSON.stringify(results, null, 1));
const seen = results.filter((r) => r.resultat === "vu").length;
console.log(`Défauts vus : ${seen} sur ${results.length}`);
process.exit(seen === results.length ? 0 : 1);
