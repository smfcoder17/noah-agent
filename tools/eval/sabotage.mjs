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
const FIL = PIP + "python /tests/agents/fil_fichiers_test.py";
const PLUGIN = "launcher/camofox-noah/index.js";

// NOAH_SABOTAGE=mot : seulement les sabotages dont le nom contient ce mot, pour rejouer un cas.
const PROVIDER = PIP + "python /tests/providers/provider_test.py";
const VIVANT = PIP + "python /tests/agents/chat_vivant_test.py";
const PUBLICATION = PIP + "python /tests/tools/publication_test.py";
const MODES = PIP + "python /tests/agents/modes_test.py";
const PROACTIF = PIP + "python /tests/agents/proactif_test.py";
const APPRENDRE = PIP + "python /tests/agents/apprendre_test.py";
const COORDINATION = PIP + "python /tests/coordination/coordination_test.py";
const COFFRE = PIP + "python /tests/tools/coffre_test.py";
const CONNEXION_PAGE = "mkdir -p /data && node /tests/navigateur/connexion_test.mjs";
const JUGE = PIP + "python /tests/tools/juge_test.py";
const CONNECTEURS = PIP + "python /tests/tools/connecteurs_test.py";
const RECU = PIP + "python /tests/agents/recu_test.py";
const MEDIAS = "node /repo/tests/chat/medias_test.mjs";
const SABOTAGES = [
  ["Apprendre : une réaction se lit comme un accord", "noah/apprentissage.py", "Une réaction n'est pas un accord : n'agis pas pour autant.", "Elle est d'accord, continue.", APPRENDRE],
  ["Apprendre : 👎 ne demande rien", "noah/apprentissage.py", 'if emoji == BAD and _is_owner(agent.id, user)', 'if False and _is_owner(agent.id, user)', APPRENDRE],
  ["Apprendre : relectures sans limite, et plusieurs fois pour la même correction", "noah/apprentissage.py", "if key in seen or len(times) >= REVIEWS_PER_HOUR:", "if False:", APPRENDRE],
  ["Apprendre : la relecture d'Hermes lit ce qui vient de dehors", "noah/agent_plugin/__init__.py", 'if isinstance(m, dict) and m.get("role") == "tool" and _is_untrusted(', 'if False and _is_untrusted(', APPRENDRE],
  ["Apprendre : un autre agent ou un invité fait apprendre", "noah/apprentissage.py", 'if not succeeded or author != "user" or agent.profile or not _is_owner(agent.id, user) or not _written_by_her(conv_id, message_id):', "if not succeeded:", APPRENDRE],
  ["Connecteur : un agent exclu le reçoit quand même", "noah/connecteurs.py", 'if agent_id in row["exclus"]:\n        return False\n', "", CONNECTEURS],
  ["Connecteur : l'exclusion laisse l'accès", "noah/connecteurs.py", 'if (agent_id in row["exclus"] and agent_id in previous) or agent_id in row["poses"]:', "if False:", CONNECTEURS],
  ["Connecteur : un partage admin l'hérite sans le dire", "noah/connecteurs.py", 'return agent_id == row["source"] or agent_id in row["partages_ok"] or not access.shared_admin(agent_id)', "return True", CONNECTEURS],
  ["Connecteur : alice vise l'agent d'un autre compte", "noah/connecteurs.py", "if ticked - own:", "if False:", CONNECTEURS],
  ["Connecteur : un invité admin décide pour le propriétaire", "noah/connecteurs.py", 'async def set_scope(agent_id: str, nom: str, body: Scope, user: int = Depends(auth.current_user)):\n    access.access(user, agent_id, "proprietaire")', 'async def set_scope(agent_id: str, nom: str, body: Scope, user: int = Depends(auth.current_user)):\n    access.access(user, agent_id, "admin")', CONNECTEURS],
  ["Connecteur : le droit de l'origine se copie", "noah/connecteurs.py", "VALUES (?, ?, ?, ?, ?, 'confirmer', ?, 'ok', ?)", "VALUES (?, ?, ?, ?, ?, 'agir', ?, 'ok', ?)", CONNECTEURS],
  ["Connecteur : un agent neuf ne reçoit rien", "noah/connecteurs.py", "await _install(row, agent_id)\n            except Exception as e:", "pass\n            except Exception as e:", CONNECTEURS],
  ["Compétences : on touche un skill appris seul", "launcher/agent_admin.py", 'if not (folder / "SKILL.md").is_file():  # ni un skill que l\'agent a appris seul, ni un chemin ailleurs', 'if name == "appris-seul":\n        return _competences_dir().parent / "devops" / name\n    if not (folder / "SKILL.md").is_file():', CONNECTEURS],
  ["Vidéo : un faux hôte passe pour YouTube", "frontend/src/lib/chatMedia.ts", 'if (host === "youtu.be" || YOUTUBE_HOSTS.has(host)) return fromYoutube(u, path);', 'if (host === "youtu.be" || host.includes("youtube")) return fromYoutube(u, path);', MEDIAS],
  ["Vidéo : un identifiant douteux entre dans l'adresse du cadre", "frontend/src/lib/chatMedia.ts", "if (!id || !YOUTUBE_ID.test(id)) return null;", "if (!id) return null;", MEDIAS],
  ["Vidéo : le serveur et l'interface ne s'accordent plus sur les hôtes", "frontend/src/lib/chatMedia.ts", '"www.tiktok.com", "www.instagram.com"];', '"www.tiktok.com", "www.instagram.com", "evil.example"];', MEDIAS],
  ["Image : MEDIA et aperçu du même fichier montrés deux fois", "frontend/src/lib/chatMedia.ts", "const later = new Set([...shownByWidgets(text), ...shownByWidgets(after)]);", "const later = new Set<string>();", MEDIAS],
  ["Image : une réponse coupée par un outil la montre dans chaque partie", "frontend/src/lib/chatMedia.ts", "for (const path of imagesMentioned(before)) if (!later.has(path)) shown.add(path);", "", MEDIAS],
  ["Reçu : n'importe quel outil prouve un envoi", "noah/recu.py", 'proven = next((c for c in calls if c["famille"] in wanted and c["etat"] == OK), None)', 'proven = next((c for c in calls if c["etat"] == OK), None)', RECU],
  ["Reçu : un outil en échec vaut preuve", "noah/recu.py", 'proven = next((c for c in calls if c["famille"] in wanted and c["etat"] == OK), None)', 'proven = next((c for c in calls if c["famille"] in wanted), None)', RECU],
  ["Reçu : un clic du navigateur devient une accusation", "noah/recu.py", '        elif vague:\n', '        elif False:\n', RECU],
  ["Reçu : une action cachée reste cachée", "noah/recu.py", 'if family in OUTWARD and call["etat"] == OK and family not in claimed', 'if False and family in OUTWARD and call["etat"] == OK and family not in claimed', RECU],
  ["Reçu : l'Activité dit « Fait » quand même", "noah/main.py", '("a_verifier" if recu.needs_attention(receipt) else "fait") if succeeded', '"fait" if succeeded', RECU],
  ["Reçu : un tour de lui-même perd sa réserve", "noah/proactif.py", 'coordination._actions_line([conv]) + recu.report_line(receipt))', 'coordination._actions_line([conv]))', RECU],
  ["Reçu : « RIEN » cache une action", "noah/proactif.py", 'if not (receipt or {}).get("non_dit"):\n            return', 'if True:\n            return', RECU],
  ["Juge : une panne laisse passer", "noah/juge.py", 'sure = lambda v: v is not None and v[2] >= SURE_ENOUGH  # noqa: E731', 'sure = lambda v: True  # FAUX : une panne passe pour une certitude', JUGE],
  ["Juge : la routine attend un accord que personne ne donnera", "noah/juge.py", 'elif verdict == "accord" and turn.alone:', "elif False:", JUGE],
  ["Juge : il lit la réponse de l'agent", "noah/juge.py", "WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT ?", "WHERE conversation_id = ? ORDER BY id DESC LIMIT ?", JUGE],
  ["Juge : le relevé d'une veille lui arrive", "noah/juge.py", 'return re.sub(r"<releve>.*</releve>", "[données de dehors retirées]", text, flags=re.S), data', "return text, data", JUGE],
  ["Juge : un autre agent lit une conversation", "noah/juge.py", '"SELECT id, origin FROM conversations WHERE id = ? AND agent_id = ?", (named.group(1), agent_id)', '"SELECT id, origin FROM conversations WHERE id = ?", (named.group(1),)', JUGE],
  ["Juge : « Me signaler » laisse agir", "noah/juge.py", 'verdict = AUTONOMY[row][column]', 'verdict = "passe" if row in (1, 2, 5) else AUTONOMY[row][column]  # FAUX : Me signaler n\'arrête plus', JUGE],
  ["Juge : sh -c et l'encodage ne sont plus dépliés", "noah/agent_plugin/__init__.py", "for text in variants(command) if command else ():\n        reason = _refused_command(text)", "for text in [command] if command else ():\n        reason = _refused_command(text)", JUGE],
  ["Tri : un motif fort demande l'avis du modèle", "noah/juge.py", 'flagged: bool | None = True if level == "fort" else None', "flagged: bool | None = None", JUGE],
  ["Connexion : la page a changé de site, on écrit quand même", "noah/coffre.py", 'elif page.get("origine") != item["origine"]:', "elif False:", COFFRE],
  ["Connexion : une personne invitée répond", "noah/coffre.py", '    if access.separated(user, agent_id):\n        raise HTTPException(403, "Une personne invitée', '    if False:\n        raise HTTPException(403, "Une personne invitée', COFFRE],
  ["Connexion : un autre que l'auteur répond", "noah/coffre.py", 'if not item or item["agent"] != agent_id or item["user"] != user:', 'if not item or item["agent"] != agent_id:', COFFRE],
  ["Connexion : deux réponses à la même demande", "noah/coffre.py", 'item["answered"] = True  # avant la première attente : un second envoi ne passe plus', "", COFFRE],
  ["Connexion : une demande n'expire jamais", "noah/coffre.py", 'elif now > item["expires"]:', "elif False:", COFFRE],
  ["Connexion : retenu en clair dans la base", "noah/coffre.py", 'sealed = db.seal(json.dumps({"identifiant": identifier, "mot_de_passe": password}))', 'sealed = json.dumps({"identifiant": identifier, "mot_de_passe": password})', COFFRE],
  ["Connexion : le mot de passe revient à l'agent", "noah/coffre.py", 'result = _outcome(filled, item["origine"], saved=bool(keep), handle=handle)', 'result = {**_outcome(filled, item["origine"], saved=bool(keep), handle=handle), "mot_de_passe": password}', COFFRE],
  ["Connexion : un identifiant retenu sert sur n'importe quel site", "noah/coffre.py", 'if page.get("origine") != row["origine"]:', "if False:", COFFRE],
  ["Connexion : Hermes n'a pas le consentement de la garde", "noah/hermes.py", 'plugins.setdefault("entries", {}).setdefault("noah-garde", {})["allow_tool_override"] = True', "pass", COFFRE],
  ["Connexion : la clé de l'agent remplit la page", PLUGIN, 'if (!serverKeyGiven(req)) return res.status(403).json({ error: "Forbidden" });', 'if (!agentKeyGiven(req)) return res.status(403).json({ error: "Forbidden" });', CONNEXION_PAGE],
  ["Connexion : le script qui écrit ne revérifie pas l'origine", PLUGIN, 'if (location.origin !== origine) return { refus: "origine" };', "", CONNEXION_PAGE],
  ["Connexion : le mot de passe reste dans le champ", PLUGIN, 'for (const frame of await stillThere()) await frame.evaluate(loginForm, { origine, action: "vider" }).catch(() => {});', "", CONNEXION_PAGE],
  ["Connexion : l'agent lit l'onglet pendant le remplissage", PLUGIN, "if (filling && TAB_READS.test(req.path)) {", "if (false) {", CONNEXION_PAGE],
  ["Connexion : un script de l'agent survit au remplissage", PLUGIN, "const reload = scripted.delete(tab.id);", "const reload = false;", CONNEXION_PAGE],
  ["Trace : la demande entre dans le contexte de l'agent", "noah/coordination.py", '_h["save"](_report_conversation(agent_id, user), TRACE, *_trace_row(fil, lead, _trace_text(asked), "en_cours"))', '_h["save"](_report_conversation(agent_id, user), TRACE, *_trace_row(fil, lead, _trace_text(asked), "en_cours")); machine.add_context(_report_conversation(agent_id, user), asked)', COORDINATION],
  ["Trace : un autre profil la lit dans une conversation partagée", "noah/main.py", 'if conv["user_id"] != user:  # conversation rendue visible', 'if False:  # conversation rendue visible', COORDINATION],
  ["Trace : l'issue n'est jamais écrite", "noah/coordination.py", '    close_trace(d["conversation_id"], "fini" if ok else "echec", last["text"] if last else "le travail s\'est arrêté sans réponse")\n    if not requester_exists:', '    if not requester_exists:', COORDINATION],
  ["Travaux en cours : un fil fini y reste", "noah/main.py", 'running = state in ("work", "approve") or (state == "choice" and r["id"] not in answered)', 'running = True', COORDINATION],
  ["Travaux en cours : un accord attendu passe pour fini", "noah/main.py", 'running = state in ("work", "approve") or (state == "choice" and r["id"] not in answered)', 'running = state == "work" or (state == "choice" and r["id"] not in answered)', COORDINATION],
  ["De lui-même : tout passe au tri, même sans rien de neuf", "noah/proactif.py", 'fresh += [{**it, "source": label, "_de": url} for it in items if it["cle"] not in have]', 'fresh += [{**it, "source": label, "_de": url} for it in items]', PROACTIF],
  ["De lui-même : coupé, il relève quand même", "noah/proactif.py", '    if mode(agent_id) == COUPE:\n        return {"etat": COUPE}\n    held = _held(agent_id)', '    held = _held(agent_id)', PROACTIF],
  ["De lui-même : il passe par-dessus une tâche de la personne", "noah/proactif.py", '    if relay.active.get(agent_id):\n        return "une tâche tourne"\n', '', PROACTIF],
  ["De lui-même : il tourne après le budget", "noah/proactif.py", '    refused = relay.spending_refusal(agent_id)\n    if refused:  # avant de relever', '    refused = None\n    if refused:  # avant de relever', PROACTIF],
  ["De lui-même : un invité le déclenche", "noah/proactif.py", 'async def pass_now(agent_id: str, user: int = Depends(auth.current_user)):\n    access.access(user, agent_id, "proprietaire")', 'async def pass_now(agent_id: str, user: int = Depends(auth.current_user)):\n    access.access(user, agent_id, "usage")', PROACTIF],
  ["De lui-même : « Me signaler » ne l'interdit pas dans la consigne", "noah/proactif.py", 'rule=RULES[current], resume=', 'rule=RULES[AGIR], resume=', PROACTIF],
  ["Objectifs : les objectifs partent chez un invité", "noah/proactif.py", 'if user is None or user != access.owner_of(agent_id):', 'if user is None:', PROACTIF],
  ["Objectifs : un autre compte en change un", "noah/proactif.py", '"SELECT * FROM goals WHERE id = ? AND user_id = ?", (goal_id, user)', '"SELECT * FROM goals WHERE id = ? AND ? = ?", (goal_id, user, user)', PROACTIF],
  ["Modes : un flux commencé bascule quand même", "noah/relay.py", 'failed = _failed_body(head)\n            if failed in modes.FAILOVER:', 'failed = 429\n            if failed in modes.FAILOVER:', MODES],
  ["Modes : un 429 ne passe pas au suivant", "noah/modes.py", 'FAILOVER = {402, 404, 408, 409, 425, 429, 500, 502, 503, 504, 524, 529}', 'FAILOVER = {402, 404, 408, 409, 425, 500, 502, 503, 504, 524, 529}', MODES],
  ["Modes : l'épuisé reste écarté pour toujours", "noah/modes.py", '(ready if _cooling.get((link.get("fournisseur", ""), link["modele"]), 0) <= now else tired).append(link)', '(ready if (link.get("fournisseur", ""), link["modele"]) not in _cooling else tired).append(link)', MODES],
  ["Modes : un invité change les modes", "noah/modes.py", 'async def change_modes(level: str, body: ModeChange, _: int = Depends(access.owner_only)):', 'async def change_modes(level: str, body: ModeChange, _: int = Depends(auth.current_user)):', MODES],
  ["Routine : un modèle hors des clés passe", "noah/modes.py", '    if not found:\n        raise HTTPException(400, f"Modèle inconnu avec tes clés : {model_id}")\n    return _link(found["id"], found["fournisseur"])', '    return _link(model_id, provider)', MODES],
  ["Routine : le relais suit un nom écrit par l'agent", "noah/relay.py", 'pinned = await modes.routine_links(agent_id, asked)', 'pinned = await modes.routine_links(agent_id, asked) or [{"modele": asked, "fournisseur": db.get_setting("provider")}]', MODES],
  ["Décision : la clé TypeSafe repart vers l'écran", "noah/decision.py", '"cles": {service: service in keys for service in TYPED_URLS},', '"cles": {service: keys.get(service) or False for service in TYPED_URLS},', MODES],
  ["Images : le plafond d'un post ne bloque rien", "noah/media.py", 'if not beyond_budget and _image_budget_left(agent_id) <= 0:', 'if False:', PIP + "python /tests/agents/reglages_test.py"],
  ["Chat : la réaction part sur la question posée pendant le travail", "noah/main.py", "_agent_reacts(answered, emoji)", "_agent_reacts(_last_user_message(conv_id), emoji)", VIVANT],
  ["Chat : l'écran ne reçoit pas le texte gardé", "noah/main.py", 'settled, left = _final_answer(reply, steps, kept, out.get("output") or "", True)', 'settled, left = "", []', VIVANT],
  ["Chat : un fichier livré se perd dans le récit", "noah/main.py", "|/opt/data/workspace/(?:outputs|apps|captures)/\\S+\\.\\w", "", VIVANT],
  ["Chat : deux choix pour la même question", "noah/main.py", 'block = "" if any(CHOICE_RE.search(k) for k in kept) else await', "block = await", VIVANT],
  ["Chat : un début retenu se perd à la coupure", "noah/main.py", "        if cut_short:\n            reply.append(cut_short)", "", VIVANT],
  ["Publication : le jeton passe dans l'adresse des journaux", "noah/publication.py", 'logging.getLogger(_logger).setLevel(logging.WARNING)', 'pass', PUBLICATION],
  ["À toi : une conversation privée se montre au propriétaire", "noah/main.py", '            access.conversation(user, conv_id)\n        except HTTPException:\n            continue', '            pass\n        except HTTPException:\n            continue', VIVANT],
  ["Publication : connexion X après retrait du droit", "noah/mcp.py", 'access.access(user, agent_id, "admin")  # le droit a pu être retiré pendant que la personne', 'pass  # le droit a pu être retiré pendant que la personne', PUBLICATION],
  ["Publication : un renouvellement écrase un autre compte", "noah/publication.py", 'if not row or not row["jeton"] or json.loads(db.unseal(row["jeton"])).get("jeton") != was:', 'if False:', PUBLICATION],
  ["Publication : une tentative en clôt une autre", "noah/publication.py", 'c.execute("UPDATE publications SET etat = ?, lien = ? WHERE id = ?", (etat, link, attempt))', 'c.execute("UPDATE publications SET etat = ?, lien = ? WHERE etat = \'en_cours\' OR id = ?", (etat, link, attempt))', PUBLICATION],
  ["Publication : le même contenu est refusé sur un autre compte", "noah/publication.py", 'h = hashlib.sha256(f"{platform}\\0{account}\\0{text}".encode())', 'h = hashlib.sha256(f"{platform}\\0{text}".encode())', PUBLICATION],
  ["Publication : une panne au moment de publier passe pour un refus", "noah/publication.py", 'raise Uncertain(f"Instagram a répondu par une panne ({r.status_code}) pendant la publication.")', 'pass', PUBLICATION],
  ["Publication : connexion X après l'échange sans le droit", "noah/mcp.py", 'access.access(user, agent_id, "admin")  # et pendant l\'échange avec X', 'pass  # et pendant l\'échange avec X', PUBLICATION],
  ["Garde : jetons des connexions lisibles", "noah/agent_plugin/__init__.py", 'if MCP_TOKENS in command or any(MCP_TOKENS in p for p in paths):', 'if False:', GUARD],
  ["Garde : jeton neuf sans relecture des outils", "noah/agent_plugin/__init__.py", 'with suppress_interactive_oauth():\n                reconcile_mcp_servers_with_config()', 'with suppress_interactive_oauth():\n                pass', GUARD],
  ["Réaction : emoji hors du sélecteur affiché dans le texte", "noah/events.py", 'if found and _is_emoji(found.group(1)) else', 'if found and found.group(1) in REACTIONS else', VIVANT],
  ["Accord : second clic en erreur", "noah/main.py", 'if e.response.status_code != 409:', 'if True:', MCP],
  ["Carte d'accord : réglage technique dans l'aperçu", "noah/mcp.py", '"_urls", "_mode"))', '"_urls"))', MCP],
  ["Activité : journal gardé sans limite de durée", "noah/main.py", 'AND j.at >= ? ORDER BY', 'AND j.at >= ? - 99999999 ORDER BY', VIVANT],
  ["Publication : X cite une image encore en traitement", "noah/publication.py", 'await _x_media_ready(c, media, _x_answer(await c.post(f"{X_API}/media/upload/{media}/finalize", headers=headers)), headers)', '_x_answer(await c.post(f"{X_API}/media/upload/{media}/finalize", headers=headers))', PUBLICATION],
  ["Publication : X publie sur un compte remplacé", "noah/publication.py", 'if stored.get("id") != creds.get("id"):\n                raise TokenRefused()\n            creds.update(stored)\n        if time.time() < creds.get("expire"', 'if False:\n                raise TokenRefused()\n            creds.update(stored)\n        if time.time() < creds.get("expire"', PUBLICATION],
  ["Images : deux générations ensemble dépassent le plafond", "noah/media.py", 'async with _image_locks.setdefault(agent_id, asyncio.Lock()):', 'if True:', PIP + "python /tests/agents/reglages_test.py"],
  ["Journal : l'activité montre une conversation privée", "noah/main.py", 'WHERE j.agent_id = ? AND (v.user_id = ? OR v.shared) AND j.at', 'WHERE j.agent_id = ? AND (? OR 1) AND j.at', VIVANT],
  ["Publication : Instagram se branche après le retrait du droit", "noah/mcp.py", 'access.access(user, agent_id, "admin")  # le droit a pu être retiré pendant la vérification', 'pass  # le droit a pu être retiré pendant la vérification', PUBLICATION],
  ["Publication : supprimer un agent efface le registre", "noah/db.py", 'publications (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, ', 'publications (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, ', PUBLICATION],
  ["Publication : le registre grossit sans fin", "noah/publication.py", 'c.execute("DELETE FROM publications WHERE at <= ?", (now - ALREADY_SECONDS,))', 'pass', PUBLICATION],
  ["Publication : un autre agent republie le même post", "noah/publication.py", '"SELECT * FROM publications WHERE plateforme = ?', '"SELECT * FROM publications WHERE agent_id = \'" + agent_id + "\' AND plateforme = ?', PUBLICATION],
  ["Publication : deux appels renouvellent le jeton Instagram", "noah/publication.py", 'if time.time() - creds.get("renouvele", 0) < IG_REFRESH_AFTER or now', 'if False and now', PUBLICATION],
  ["Accord : un second accord disparaît de À toi", "noah/main.py", 'if not accords.pending(conv_id=conv) and task_state.get(conv) == "approve":', 'if True and task_state.get(conv) == "approve":  # FAUX : un second accord en attente n\'empêche plus le badge de tomber', VIVANT],
  ["Accord : le titre se lit par sa place", "noah/mcp.py", 'title = _TITLE.search(shown)', 'title = re.search(r\'"\\w+"\\s*:\\s*"([^"]{2,60})"\', shown)', PUBLICATION],
  ["Accord : le badge reste après la réponse", "noah/main.py", '    if not accords.pending(conv_id=conv) and task_state.get(conv) == "approve":\n        task_state[conv] = "work"', '    task_state[conv] = "work"', VIVANT],
  ["Publication : le même post repart", "noah/publication.py", '        if row and not again:', '        if False:', PUBLICATION],
  ["Publication : un envoi perdu passe pour un refus", "noah/publication.py", 'raise Uncertain("La réponse d\'Instagram s\'est perdue pendant la publication.") from None', 'raise Refused("perdu") from None', PUBLICATION],
  ["Publication : deux appels ensemble passent", "noah/publication.py", 'if row and row["etat"] == "en_cours" and now - row["at"] < RUNNING_SECONDS:', 'if False:', PUBLICATION],
  ["Publication : l'image reste à une adresse publique", "noah/publication.py", '            _images.pop(url.rsplit("/", 1)[-1].removesuffix(".jpg"), None)', '            pass', PUBLICATION],
  ["Publication : l'image n'est pas joignable de dehors", "noah/publication.py", '@router.get("/api/post-image/{name}")', '@router.get("/api/public-image/{name}")', PUBLICATION],
  ["Publication : un JPEG n'est pas vérifié", "noah/publication.py", 'if not data.startswith(b"\\xff\\xd8\\xff"):', 'if False:', PUBLICATION],
  ["Publication : le jeton en clair dans la base", "noah/mcp.py", 'publication.tool_url(name), db.seal(json.dumps(creds)),', 'publication.tool_url(name), json.dumps(creds),', PUBLICATION],
  ["Publication : X sans PKCE S256", "noah/publication.py", '"code_challenge_method": "S256"', '"code_challenge_method": "plain"', PUBLICATION],
  ["Publication : le renouvellement de X se perd", "noah/publication.py", '        _save(agent_id, X, creds, was)', '        pass', PUBLICATION],
  ["Publication : Instagram sans renouvellement", "noah/publication.py", 'creds.update(jeton=fresh, renouvele=now)', 'pass', PUBLICATION],
  ["Publication : la carte dit envoyer au lieu de publier", "noah/mcp.py", '("publier", {"publish", "publier", "publie"}, "publier sur {}"),', '', PUBLICATION],
  ["Chat : le récit du travail reste dans la réponse", "noah/main.py", "                    reply.clear()\n                    if said:", "                    if said:", VIVANT],
  ["Chat : un widget écrit en chemin se perd", "noah/main.py", "(kept if _SHOWS_SOMETHING.search(said) else steps).append(said)", "steps.append(said)", VIVANT],
  ["Chat : une phrase de travail masque une erreur", "noah/main.py", 'return ("\\n\\n".join([*kept, answer]).strip() if answer or succeeded or kept else ""), left', 'return "\\n\\n".join([*kept, answer, *left]).strip(), left', VIVANT],
  ["Réaction : la marque s'affiche", "noah/main.py", '                    emoji, text = head.feed(out["text"])', '                    emoji, text = None, out["text"]', VIVANT],
  ["Réaction : n'importe quel texte passe", "noah/main.py", "if body.emoji is not None and body.emoji not in events.REACTIONS:", "if False:", VIVANT],
  ["Réaction : un message d'une autre conversation", "noah/main.py", 'WHERE id = ? AND conversation_id = ?", (message_id, conv_id))', 'WHERE id = ? AND ? = ?", (message_id, conv_id, conv_id))', VIVANT],
  ["Réaction : l'agent ne l'apprend pas", "noah/main.py", 'if body.emoji and row["role"] == "agent":', "if False:", VIVANT],
  ["Choix : une question déjà équipée en reçoit un autre", "noah/main.py", "if not said or CHOICE_RE.search(said) or not _WAITS_ANSWER", "if not said or not _WAITS_ANSWER", VIVANT],
  ["Choix : une panne du petit modèle casse la réponse", "noah/main.py", "    except Exception:  # une proposition perdue ne gêne personne : la saisie reste libre\n        return \"\"", "    except ValueError:\n        return \"\"", VIVANT],
  ["Mammouth : la clé n'est pas vérifiée", "noah/catalog.py", 'elif provider == "mammouth":', 'elif provider == "pas-mammouth":', PROVIDER],
  ["Mammouth : un modèle d'image devient cerveau", "noah/catalog.py", 'or _MAMMOUTH_NOT_CHAT.search(mid)', "", PROVIDER],
  ["Mammouth : tout passe pour un modèle OpenAI", "noah/catalog.py", 'next((lab for prefix, lab in _MAMMOUTH_LABS if mid.lower().startswith(prefix)), "mammouth")', 'm.get("owned_by")', PROVIDER],
  ["Mammouth : prix faux d'un facteur un million", "noah/catalog.py", 'float(price_in) * 1e6 if price_in', 'float(price_in) if price_in', PROVIDER],
  ["Fil : la tranche demandée est ignorée", "noah/main.py", "    if limit is not None:\n        query, args = f\"SELECT * FROM", "    if False:\n        query, args = f\"SELECT * FROM", FIL],
  ["Fil : remonter redonne le dernier message lu", "noah/main.py", 'where + " AND id < ?"', 'where + " AND id <= ?"', FIL],
  ["Fil : reprendre oublie les nouveaux messages", "noah/main.py", 'where + " AND id >= ?"', 'where + " AND id = ?"', FIL],
  ["Fil : une tranche sans plafond", "noah/main.py", "min(max(limit, 1), 500)", "max(limit, 1)", FIL],
  ["Fichiers : le simple usage suffit pour supprimer", "noah/main.py", '_usable(user, agent_id, "admin")\n    try:\n        return await hermes.delete_files', '_usable(user, agent_id)\n    try:\n        return await hermes.delete_files', FIL],
  ["Fichiers : la suppression suit un lien vers l'extérieur", "launcher/launcher.py", "chain.append((fd, part))\n            fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)", "chain.append((fd, part))\n            fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY, dir_fd=fd)", FIL],
  ["Fichiers : un chemin remonte hors du dossier", "launcher/launcher.py", 'or any(p in ("", ".", "..") for p in parts)', "", FIL],
  ["Fichiers : un dossier de premier niveau disparaît", "launcher/launcher.py", "reversed(chain[1:])", "reversed(chain)", FIL],
  ["Fichiers : une grosse suppression d'un seul coup", "launcher/launcher.py", "size + cost > DELETE_ARG_BYTES", "False", FIL],
  ["Routine : le fichier de la consigne est ignoré", "noah/hermes.py", 'if words[:1] != ["--fichier"]:', "if True:", ENVOI_OUTIL],
  ["Routine : n'importe quel fichier part en consigne", "noah/hermes.py", "if not real.startswith(root + os.sep):  # un texte lu en ligne", "if False:  # un texte lu en ligne", ENVOI_OUTIL],
  ["Accord : le texte technique sert de demande", "noah/mcp.py", 'return {"demande": f"Ton agent veut {wish}.", "apercu": preview}', 'return {"demande": summary, "apercu": preview}', MCP],
  ["Accord : l'aperçu montre les identifiants", "noah/mcp.py", 'hidden, key = key in _HIDDEN or key.endswith(("_id", "_ids", "_url", "_urls", "_mode")), ""', "hidden, key = False, key", MCP],
  ["Accord : une liste d'identifiants prend la place du contenu", "noah/mcp.py", 'inside = max(between.count("[") - between.count("]"), 0)', "inside = 0", MCP],
  ["Accord : une clé masquée cache la valeur suivante", "noah/mcp.py", 'key.endswith(("_id", "_ids", "_url", "_urls", "_mode")), ""', 'key.endswith(("_id", "_ids", "_url", "_urls", "_mode")), key', MCP],
  ["Accord : l'aperçu montre le technique", "noah/mcp.py", "and not _TECHNICAL.match(text) ", "", MCP],
  ["Accord : la description d'Hermes s'affiche", "noah/mcp.py", 'if command else "Ton agent te demande de valider une action."', "if command else summary", MCP],
  ["Accord : une suppression passe pour une lecture", "noah/mcp.py", "for action, verbs, sentence in _ACTIONS:", "for action, verbs, sentence in reversed(_ACTIONS):", MCP],
  ["Fuseau : un invité change l'heure du propriétaire", "noah/main.py", "await asyncio.to_thread(access.is_owner, user)", "await asyncio.to_thread(lambda u: True, user)", CONFIG_AGENT],
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
  ["Envoi : la prise en main n'arrête pas un envoi engagé", PLUGIN, 'notTakenOver();\n    await setFilesOn(input, files);', "await setFilesOn(input, files);", ENVOI],
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
  ["Envoi : la configuration de l'agent peut partir", "noah/hermes.py", 'if not real.startswith(root + os.sep):\n            return {"erreur": "Seuls', 'if False:\n            return {"erreur": "Seuls', ENVOI_OUTIL],
  ["Envoi : un lien sort de l'espace de travail", "noah/hermes.py", "real = os.path.realpath(local)", "real = os.path.abspath(local)", ENVOI_OUTIL],
  ["Envoi : le voisin de l'espace de travail accepté", "noah/hermes.py", 'if not real.startswith(root + os.sep):\n            return {"erreur": "Seuls', 'if not real.startswith(root):\n            return {"erreur": "Seuls', ENVOI_OUTIL],
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
  ["Dossier : lecture seule ignorée", "desktop/dossiers.js", "async function write(folder, relative, data, { remplacer = false, attendu = \"\", id = \"\", journal = null, ask = async () => false, recheck = () => null, trash = null } = {}) {\n  if (!folder.ecriture) throw new Refus(`Le dossier « ${folder.nom} » est en lecture seule.`);\n  if (data.length > MAX_FILE)", "async function write(folder, relative, data, { remplacer = false, attendu = \"\", id = \"\", journal = null, ask = async () => false, recheck = () => null, trash = null } = {}) {\n  if (data.length > MAX_FILE)", DOSSIERS],
  ["Dossier : un fichier existant écrasé", "desktop/dossiers.js", "fs.linkSync(temporary, candidate); // échoue d'un coup si le nom existe", "fs.copyFileSync(temporary, candidate);", DOSSIERS],
  ["Dossier : fichiers sensibles permis", "desktop/dossiers.js", 'if (isSensitive(parts) || isSensitive(path.relative(root, target).split(path.sep))) throw new Refus("Fichier sensible : refusé d\'office, quel que soit le droit.");', "", DOSSIERS],
  ["Dossier : permis pour toujours malgré un programme changé", "desktop/dossiers.js", "t.exe === print.exe && t.sha256 === print.sha256", "t.exe === print.exe", DOSSIERS],
  ["Dossier : un lanceur permis pour toujours", "desktop/dossiers.js", "return ALWAYS_PROGRAMS.test(bare) ? { program: bare, args } : null;", "return { program: bare, args };", DOSSIERS],
  ["Dossier : l'accès coupé levé par un changement de compte", "desktop/dossiers.js", "state = { ...EMPTY(), coupe: state.coupe };", "state = EMPTY();", DOSSIERS],
  ["Dossier : un nom trompeur accepté", "desktop/dossiers.js", 'if (DECEIVING.test(part)) throw new Refus("Ce nom contient des caractères invisibles ou de contrôle.");', "", DOSSIERS],
  ["Dossier : l'erreur du système part telle quelle", "desktop/dossiers.js", 'return { message: final[error.code] ?? "Le système de l\'ordinateur a refusé cette opération.", later: false };', "return { message: error.message, later: false };", DOSSIERS],
  ["Bureau : un autre serveur obtient une demande sans vérification", "desktop/actions.js", "if (attachedTo !== `${link.origin}|${link.token}` && !(await beat())) {", "if (false) {", DOSSIERS],
  ["Bureau : le nom de l'agent imite un message", "desktop/actions.js", 'const clean = (text, max = 40, exact = false) => {', 'const clean = (text, max = 40, exact = false) => text = String(text ?? "").split(/\\r\\n|\\r|\\n/).map((l) => l).join(" "); if (false) {', DOSSIERS],
  ["Appareil : une demande non reçue perdue", "noah/desktop.py", 'if last and fichiers and last["id"] != recu and (last["id"] in _waiting or _pending_row(last["id"])):', "if False:", APPAREILS],
  ["Appareil : un agent partagé en admin atteint l'ordinateur", "noah/desktop.py", "if access.guest_task(agent_id) or access.shared_admin(agent_id):", "if access.guest_task(agent_id):", APPAREILS],
  ["Appareil : un ordinateur disparu fait attendre 5 minutes", "noah/desktop.py", 'if seen.get("bat") and not _online(device):', "if False:", APPAREILS],
  ["Connexion : l'accord d'un autre compte accepté", "noah/connexion.py", 'if login.get("user") is not None and here is not None and here != login["user"]:', "if False:", CONNEXION],
  ["Connexion : sans session, sans confirmation", "noah/connexion.py", 'if login.get("user") is not None and here is None and not params.get("error"):', "if False:", CONNEXION],
  ["Bureau : l'accès coupé ne coupe rien", "desktop/actions.js", 'if (store?.isCut() && req.action !== "notifier") return CUT;', "", DOSSIERS],
  ["Bureau : un nom d'application piégé arrive au système", "desktop/actions.js", 'if (!APP_NAME.test(name)) return { erreur: "Donne seulement le nom de l\'application, sans chemin ni symbole." };', "", DOSSIERS],
  ["Bureau : un accord tardif agit quand même", "desktop/dossiers.js", 'const lastLook = recheck(); // l\'écriture a pris du temps\n    if (lastLook) return lastLook;', 'const lastLook = null;', DOSSIERS],
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
  ["Outil : garde qui accepte par défaut", "noah/agent_plugin/__init__.py", "    droit = rights.get(server, \"confirmer\")\n    if droit == \"agir\":", '    droit = rights.get(server, "agir")  # FAUX : un serveur inconnu agit\n    if droit == "agir":', MCP],
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
  ["Mémoire : tout entre sans jugement", "noah/agent_plugin/__init__.py", 'if tool_name == "memory":\n        refused = check_memory(args if isinstance(args, dict) else {})\n        return {"action": "block", "message": refused} if refused else None', 'if tool_name == "memory":\n        return None', DECISION],
  ["Outil : ajout sans contrôle d'accès", "noah/mcp.py", 'access.access(user, agent_id, "admin")\n    _scope(agent_id)\n    machine.forget_connections(agent_id)\n    token = _clean_token(body)', "_scope(agent_id)\n    token = _clean_token(body)", MCP],
];

// L'interface se sabote sur une copie de son module pur, avec le CSP du serveur que le test compare.
function runFront([sabotage, path, old, replacement, cmd]) {
  const tmp = mkdtempSync(join(tmpdir(), "noah-sabotage-"));
  try {
    for (const part of [path, "server/noah/exposition.py", "tests/chat"]) cpSync(join(ROOT, part), join(tmp, part), { recursive: true });
    const target = join(tmp, path);
    const source = readFileSync(target, "utf8");
    if (old && source.split(old).length !== 2) return { sabotage, resultat: "cible introuvable" };
    if (old) writeFileSync(target, source.replace(old, () => replacement));
    const r = spawnSync("docker", ["run", "--rm", "-v", `${tmp}:/repo:ro`, "node:22-alpine", "sh", "-c", cmd], { timeout: 120000 });
    const seen = r.status && String(r.stderr).includes("AssertionError");
    return { sabotage, resultat: seen ? "vu" : r.status ? "panne" : "NON VU", fin: r.status ? String(r.stderr).slice(-500) : "" };
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 2 });
  }
}

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
    return { sabotage, resultat: seen ? "vu" : r.status ? "panne" : "NON VU", fin: r.status ? String(r.stderr).slice(-500) : "" };
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
    return { sabotage, resultat: seen ? "vu" : r.status ? "panne" : "NON VU", fin: r.status ? String(r.stderr).slice(-500) : "" };
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 2 });
  }
}

function run(item) {
  if (item[1].startsWith("desktop/")) return runDesktop(item);
  if (item[1].startsWith("frontend/")) return runFront(item);
  if (item[1].startsWith("launcher/") && !item[1].endsWith(".py")) return runPlugin(item);
  const [sabotage, path, old, replacement, cmd] = item;
  const tmp = mkdtempSync(join(tmpdir(), "noah-sabotage-"));
  try {
    const server = join(tmp, "server");
    cpSync(join(ROOT, "server"), server, { recursive: true, filter: (p) => !p.includes("__pycache__") });
    // Le code du lanceur se sabote dans sa propre copie, le reste dans celle du serveur.
    const launcherCopy = join(tmp, "launcher");
    if (path.startsWith("launcher/")) cpSync(join(ROOT, "launcher"), launcherCopy, { recursive: true, filter: (p) => !p.includes("__pycache__") && !p.includes("node_modules") });
    const target = path.startsWith("launcher/") ? join(tmp, path) : join(server, path);
    const source = readFileSync(target, "utf8");
    if (old && source.split(old).length !== 2) return { sabotage, resultat: "cible introuvable" };
    if (old) writeFileSync(target, source.replace(old, () => replacement));
    const r = spawnSync("docker", ["run", "--rm", "-e", "PYTHONDONTWRITEBYTECODE=1", "-v", `${server}:/app`, "-v", `${join(ROOT, "tests")}:/tests`, "-v", `${path.startsWith("launcher/") ? launcherCopy : join(ROOT, "launcher")}:/l:ro`,
      "-v", `${join(ROOT, "frontend/src/App.tsx")}:/front/App.tsx:ro`, "-v", `${join(ROOT, "mobile/www/app.js")}:/mobile/app.js:ro`,
      "python:3.12-slim", "sh", "-c", cmd], { timeout: 600000 });
    // Seule une assertion compte : une panne d'installation ou de Docker ne prouve rien.
    const seen = r.status && String(r.stderr).includes("AssertionError");
    return { sabotage, resultat: seen ? "vu" : r.status ? "panne" : "NON VU", fin: r.status ? String(r.stderr).slice(-500) : "" };
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 2 });
  }
}

// Témoin : la même chaîne sans défaut doit rester verte, sinon un « vu » ne prouve rien.
const CHOISIS = SABOTAGES.filter((s) => !process.env.NOAH_SABOTAGE || new RegExp(process.env.NOAH_SABOTAGE, "i").test(s[0]));
const TEMOINS = [...new Set(CHOISIS.map((s) => s[4]))].map((cmd) => run(["témoin", cmd === DOSSIERS ? "desktop/dossiers.js" : cmd === MEDIAS ? "frontend/src/lib/chatMedia.ts" : cmd === ENVOI || cmd === CONNEXION_PAGE ? PLUGIN : "noah/auth.py", "", "", cmd]));
if (TEMOINS.some((t) => t.resultat !== "NON VU")) {
  console.error("Un témoin échoue sans sabotage : les résultats ne valent rien.", TEMOINS.filter((t) => t.resultat !== "NON VU"));
  process.exit(2);
}
const results = CHOISIS.map(run);
console.log(JSON.stringify(results, null, 1));
const seen = results.filter((r) => r.resultat === "vu").length;
console.log(`Défauts vus : ${seen} sur ${results.length}`);
process.exit(seen === results.length ? 0 : 1);
