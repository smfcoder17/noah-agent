"""Les fournisseurs « autres » : autant de services compatibles OpenAI qu'on veut, chacun avec son nom, son adresse et sa clé.

Identifiant : « autre:<mot> ». L'ancien emplacement unique, « custom », reste tel quel (ses réglages, ses clés, les agents et les
modes qui le citent ne bougent pas) : il se compte parmi les autres. Les clés sont dans les réglages scellés, comme celles des
autres fournisseurs (providers.py), jamais renvoyées.
"""
import json
import re
import unicodedata

from . import db

PREFIX = "autre:"
LEGACY = "custom"
LIST = "fournisseurs_autres"  # [{"id": "autre:lm-studio", "label": "LM Studio"}]
MAX = 30


def is_other(provider: str | None) -> bool:
    """Un service compatible OpenAI choisi par la personne : l'ancien « custom » ou un « autre:… »."""
    return bool(provider) and (provider == LEGACY or provider.startswith(PREFIX))


def entries() -> list[dict]:
    try:
        rows = json.loads(db.get_setting(LIST) or "[]")
    except ValueError:
        return []
    return [r for r in rows if isinstance(r, dict) and str(r.get("id", "")).startswith(PREFIX) and r.get("label")]


def info(provider: str) -> dict | None:
    """La fiche d'un fournisseur « autre » dans le même format que hermes.PROVIDERS, ou None s'il n'existe pas."""
    for row in entries():
        if row["id"] == provider:
            return {"label": row["label"], "env": None, "model": ""}
    return None


def label_of(provider: str, base_url: str | None = None) -> str:
    if provider == LEGACY:
        saved = db.get_setting(f"provider_label:{LEGACY}")
        if saved:
            return saved
        host = re.sub(r"^https?://", "", (base_url or "")).split("/")[0]
        return host or "Autre service compatible OpenAI"
    found = info(provider)
    return found["label"] if found else provider


def slug(label: str) -> str:
    plain = unicodedata.normalize("NFKD", label).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", plain).strip("-")[:20] or "service"


def add(label: str) -> str:
    """Crée la fiche et rend son identifiant. Deux fournisseurs de même nom restent distincts (-2, -3…)."""
    rows = entries()
    if len(rows) >= MAX:
        raise ValueError("Trop de fournisseurs.")
    taken = {r["id"] for r in rows}
    base = PREFIX + slug(label)
    pid, n = base, 1
    while pid in taken:
        n += 1
        pid = f"{base}-{n}"
    rows.append({"id": pid, "label": label.strip()[:60]})
    db.set_setting(LIST, json.dumps(rows, ensure_ascii=False))
    return pid


def rename(provider: str, label: str) -> None:
    if provider == LEGACY:
        db.set_setting(f"provider_label:{LEGACY}", label.strip()[:60])
        return
    rows = [{**r, "label": label.strip()[:60]} if r["id"] == provider else r for r in entries()]
    db.set_setting(LIST, json.dumps(rows, ensure_ascii=False))


def remove(provider: str) -> None:
    db.set_setting(LIST, json.dumps([r for r in entries() if r["id"] != provider], ensure_ascii=False))
    with db.connect() as c:
        for key in ("provider_key", "provider_base", "provider_connected", "provider_count"):
            c.execute("DELETE FROM settings WHERE key = ?", (f"{key}:{provider}",))
