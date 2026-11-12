"""Modèles d'agent livrés avec Noah : une persona, une apparence et des demandes d'exemple, posées une seule fois à la création.

presets.json est un fichier livré dans l'image, lu une fois au démarrage : rien ne l'écrit, ni une route ni un agent.
Un modèle ne donne aucun droit, aucun mode d'accord et aucune routine active : ses routines sont seulement proposées.
"""
import json
import re
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
        assert all(isinstance(x, str) and x for x in p["connexions"]), f"{pid} : connexions"
        assert set(p) == {"id", "nom", "accroche", "couleur", "shape", "detail", "role", "demandes", "routines", "connexions"}, f"{pid} : champs"
    return data


def _demandes(items) -> bool:
    return isinstance(items, list) and len(items) == DEMANDES and all(isinstance(x, str) and 0 < len(x) <= 70 for x in items)


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
    """À la création seulement : l'apparence et l'identifiant du modèle. La personne peut ensuite tout changer."""
    if not preset:
        return
    with db.connect() as c:
        c.execute("UPDATE agents SET color = ?, shape = ?, detail = ? WHERE id = ?", (preset["couleur"], preset["shape"], preset["detail"], agent_id))
    db.set_setting(f"preset_{agent_id}", preset["id"])


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
