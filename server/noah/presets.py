"""Modèles d'agent livrés avec Noah : une persona, une apparence et des demandes d'exemple, posées une seule fois à la création.

presets.json est un fichier livré dans l'image, lu une fois au démarrage : rien ne l'écrit, ni une route ni un agent.
Un modèle ne donne aucun droit, aucun mode d'accord et aucune routine active. Ses routines sont posées en pause, dans Noah
(table routines_suggerees) et pas dans le cron d'Hermes : rien ne tourne, aucun modèle n'est appelé. Un geste de la personne
(machine.py, « Activer ») crée la vraie routine, une seule fois. À la création, l'agent écrit aussi un premier message, tiré
du modèle sans appel au modèle : ce qu'il sait faire seul et ses routines à activer.
"""
import json
import re
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from . import access, auth, db

ROLE_MAX = 4000  # la limite d'AgentBody.role dans main.py
SHAPES = ("", "gomme", "bulle", "cube", "goutte", "pastille")  # celles d'AgentLook
DETAILS = ("", "lunettes", "antenne", "sourcils", "joues")
DEMANDES = 4


def check(data: dict) -> dict:
    """Refuse au démarrage un fichier mal formé, plutôt qu'à la première création d'agent."""
    assert isinstance(data.get("version"), int) and data["version"] >= 1, "version"
    assert _demandes(data["defaut"]["demandes"]), "demandes par défaut"
    seen = set()
    for p in data["presets"]:
        pid = p["id"]
        assert re.fullmatch(r"[a-z][a-z0-9-]{1,30}", pid) and pid not in seen, f"id : {pid}"
        seen.add(pid)
        assert 1 <= len(p["nom"]) <= 40, f"{pid} : nom"
        assert 1 <= len(p["accroche"]) <= 90 and "\n" not in p["accroche"], f"{pid} : accroche"
        assert 500 <= len(p["role"]) <= 1200 <= ROLE_MAX, f"{pid} : rôle de {len(p['role'])} caractères"
        assert re.fullmatch(r"#[0-9a-fA-F]{6}", p["couleur"]), f"{pid} : couleur"
        assert p["shape"] in SHAPES and p["detail"] in DETAILS, f"{pid} : apparence"
        assert _demandes(p["demandes"]), f"{pid} : demandes"
        for r in p["routines"]:
            # Proposées seulement : aucun champ ne peut les rendre actives ni leur donner des outils.
            assert set(r) == {"nom", "quand", "consigne"} and all(isinstance(v, str) and v for v in r.values()), f"{pid} : routine"
            assert horaire(r["quand"]), f"{pid} : moment de « {r['nom']} » non compris"
        assert all(isinstance(x, str) and x for x in p["connexions"]), f"{pid} : connexions"
        assert set(p) == {"id", "nom", "accroche", "couleur", "shape", "detail", "role", "demandes", "routines", "connexions"}, f"{pid} : champs"
    return data


def _demandes(items) -> bool:
    return isinstance(items, list) and len(items) == DEMANDES and all(isinstance(x, str) and 0 < len(x) <= 70 for x in items)


JOURS = {"dimanche": 0, "lundi": 1, "mardi": 2, "mercredi": 3, "jeudi": 4, "vendredi": 5, "samedi": 6}
_MOMENT = re.compile(r"(chaque jour|chaque (?P<jour>" + "|".join(JOURS) + r")|le (?P<date>\d{1,2})(?:er)? de chaque mois)"
                     r" à (?P<h>\d{1,2}) h(?: (?P<m>\d{2}))?")


def horaire(quand: str) -> str | None:
    """Le moment écrit en clair dans presets.json (« chaque lundi à 9 h ») en horaire cron, celui que le cron d'Hermes lit.
    Ce qui suit une virgule est une précision pour la personne (« en pause tant que tu ne l'actives pas »)."""
    text = quand.split(",")[0].strip().lower()
    if text == "toutes les heures":
        return "0 * * * *"
    m = _MOMENT.fullmatch(text)
    if not m or int(m["h"]) > 23 or int(m["m"] or 0) > 59 or (m["date"] and not 1 <= int(m["date"]) <= 28):
        return None
    day = m["date"] or "*"
    week = str(JOURS[m["jour"]]) if m["jour"] else "*"
    return f"{int(m['m'] or 0)} {int(m['h'])} {day} * {week}"


DATA = check(json.loads((Path(__file__).parent / "presets.json").read_text(encoding="utf-8")))
BY_ID = {p["id"]: p for p in DATA["presets"]}


def find(preset_id: str) -> dict | None:
    """Le modèle demandé à la création ; vide : partir de zéro. Un identifiant inconnu est refusé."""
    if not preset_id:
        return None
    if preset_id not in BY_ID:
        raise HTTPException(400, "Ce modèle d'agent n'existe pas. Choisis-en un autre, ou pars de zéro.")
    return BY_ID[preset_id]


def apply(agent_id: str, preset: dict | None) -> None:
    """À la création seulement : l'apparence, l'identifiant du modèle et ses routines en pause. La personne peut ensuite tout changer."""
    if not preset:
        return
    with db.connect() as c:
        c.execute("UPDATE agents SET color = ?, shape = ?, detail = ? WHERE id = ?", (preset["couleur"], preset["shape"], preset["detail"], agent_id))
        if not c.execute("SELECT 1 FROM routines_suggerees WHERE agent_id = ?", (agent_id,)).fetchone():
            c.executemany("INSERT INTO routines_suggerees (agent_id, nom, quand, horaire, consigne, cree) VALUES (?, ?, ?, ?, ?, ?)",
                          [(agent_id, r["nom"], r["quand"], horaire(r["quand"]), r["consigne"], time.time()) for r in preset["routines"]])
    db.set_setting(f"preset_{agent_id}", preset["id"])


def welcome(agent_id: str, name: str, preset: dict | None, conversation, save_message) -> None:
    """Le premier message de l'agent, écrit une seule fois, sans appel au modèle : tiré du modèle. `conversation()` rend
    sa conversation principale (créée au besoin) ; une conversation qui a déjà un message n'en reçoit pas d'autre."""
    if not preset:
        return
    conv = conversation()
    with db.connect() as c:
        if c.execute("SELECT 1 FROM messages WHERE conversation_id = ?", (conv,)).fetchone():
            return
    save_message(conv, "agent", first_message(name, preset))


def first_message(name: str, preset: dict) -> str:
    accroche = preset["accroche"][0].lower() + preset["accroche"][1:]
    lines = [f"Bonjour, je suis {name}. Modèle « {preset['nom']} » : {accroche}", ""]
    if preset["routines"]:
        lines.append("Ce que je peux faire seul, à heure fixe, sans que tu me le redemandes :")
        lines += [f"- **{r['nom']}** ({r['quand'].split(',')[0]}) : {r['consigne']}" for r in preset["routines"]]
        lines += ["", "Ces routines sont en pause : rien ne part tant que tu ne les actives pas. "
                  "Pour en activer une, touche « Activer » dans Détails, onglet Routines.", ""]
    else:
        lines += ["Je travaille quand tu me le demandes. Si une tâche revient souvent, je te proposerai d'en faire une routine.", ""]
    lines.append("Pour commencer, tu peux me demander :")
    lines += [f"- {d}" for d in preset["demandes"]]
    return "\n".join(lines)


def suggested(agent_id: str) -> list[dict]:
    """Les routines du modèle encore en pause, pour l'écran et pour l'agent."""
    with db.connect() as c:
        rows = c.execute("SELECT id, nom, quand, horaire, consigne FROM routines_suggerees WHERE agent_id = ? ORDER BY id", (agent_id,)).fetchall()
    return [{**dict(r), "quand": r["quand"].split(",")[0].strip(), "en_pause": True} for r in rows]


def take(agent_id: str, suggestion_id: int) -> dict:
    """Retire la suggestion avant de créer la routine : deux gestes rapides n'en créent pas deux."""
    with db.connect() as c:
        row = c.execute("SELECT * FROM routines_suggerees WHERE id = ? AND agent_id = ?", (suggestion_id, agent_id)).fetchone()
        if not row:
            raise HTTPException(404, "Cette routine n'est plus à activer.")
        c.execute("DELETE FROM routines_suggerees WHERE id = ?", (suggestion_id,))
    return dict(row)


def give_back(row: dict) -> None:
    """La création a échoué (agent arrêté) : la suggestion revient, pour réessayer."""
    with db.connect() as c:
        c.execute("INSERT OR IGNORE INTO routines_suggerees (id, agent_id, nom, quand, horaire, consigne, cree) VALUES (?, ?, ?, ?, ?, ?, ?)",
                  (row["id"], row["agent_id"], row["nom"], row["quand"], row["horaire"], row["consigne"], row["cree"]))


def of(agent_id: str) -> str | None:
    """Le modèle dont vient cet agent, tant qu'il existe encore dans le fichier."""
    pid = db.get_setting(f"preset_{agent_id}")
    return pid if pid in BY_ID else None


router = APIRouter()


@router.get("/api/presets")
def list_presets(user: int = Depends(auth.current_user)):
    """Les modèles d'agent, les demandes générales, et le modèle de chaque agent que ce compte voit (pour l'écran vide)."""
    with db.connect() as c:
        rows = c.execute("SELECT key, value FROM settings WHERE key LIKE 'preset\\_%' ESCAPE '\\'").fetchall()
    agents = {r["key"][7:]: r["value"] for r in rows if r["value"] in BY_ID}
    return {
        "version": DATA["version"],
        "presets": DATA["presets"],
        "defaut": DATA["defaut"],
        "agents": {a: p for a, p in agents.items() if access.right(user, a)},
    }
