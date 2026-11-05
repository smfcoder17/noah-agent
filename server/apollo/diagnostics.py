"""Les erreurs récentes du serveur, lisibles depuis l'application : sur un VPS, personne n'a les journaux sous la main.

Gardées en mémoire (un redémarrage les efface) et masquées avant d'être conservées : elles finissent copiées chez un agent.
"""
import re
import time
import traceback
from collections import deque

from . import db

_recent: deque[dict] = deque(maxlen=100)
_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9_-]{6,}"),
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"(?i)(x-api-key[\"']?\s*[:=]\s*[\"']?)[A-Za-z0-9._-]{8,}"),
)


def _stored_keys() -> list[str]:
    keys = []
    for name in ("api_key", "media_api_key", "voice_api_key"):
        try:
            if db.get_setting(name):
                keys.append(db.get_setting(name, secret=True))
        except Exception:  # base pas encore prête, clé illisible : les motifs restent
            continue
    return keys


def mask(text: str) -> str:
    text = str(text)
    for key in _stored_keys():
        text = text.replace(key, "***")
    for pattern in _PATTERNS:
        text = pattern.sub(lambda m: (m.group(1) if m.re.groups else "") + "***", text)
    return text


def record(where: str, text: str, agent: str | None = None) -> None:
    masked = mask(text)
    _recent.append({"quand": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()) + " UTC", "ou": where, "agent": agent, "texte": masked[-4000:]})
    print(f"[diagnostic] {where} {agent or ''} : {masked[-1500:]}", flush=True)


def failure(where: str, error: BaseException, agent: str | None = None) -> None:
    record(where, "".join(traceback.format_exception(error)), agent)


def recent() -> list[dict]:
    return list(reversed(_recent))
