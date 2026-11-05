"""Veilles : surveiller une page ou un flux sans faire tourner l'agent.

Le serveur relève lui-même chaque source à son rythme (aucun modèle), garde ce qu'il a déjà vu, et ne montre
les nouveautés qu'à un petit modèle rapide qui juge si elles correspondent à ce que l'utilisateur cherche.
Seules les nouveautés pertinentes arrivent dans la conversation de l'agent (et en notification sur l'ordinateur).
Une routine, elle, fait travailler l'agent à chaque passage : pour « préviens-moi si… », la veille coûte
des centaines de fois moins.
"""
import asyncio
import hashlib
import html
import json
import re
import time
import uuid
import xml.etree.ElementTree as ET
from urllib.parse import urljoin

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import access, auth, db, desktop, media, relay

router = APIRouter()

SCHEMA = """
CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  criteria TEXT NOT NULL DEFAULT '',
  every_minutes INTEGER NOT NULL DEFAULT 60,
  active INTEGER NOT NULL DEFAULT 1,
  seen TEXT NOT NULL DEFAULT '[]',
  last_check REAL NOT NULL DEFAULT 0,
  last_alert REAL NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  checks INTEGER NOT NULL DEFAULT 0,
  alerts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
"""

SEEN_MAX = 3000
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0"


KEYS = "3"  # format des empreintes de blocs ; le changer fait réapprendre chaque page en silence


def init() -> None:
    with db.connect() as c:
        c.executescript(SCHEMA)
    if db.get_setting("veille_cles") != KEYS:
        # Anciennes empreintes : la page entière paraîtrait nouvelle (un tri payant, une fausse alerte). Le passage
        # suivant la réapprend sans prévenir, comme une veille neuve.
        with db.connect() as c:
            c.execute("UPDATE watches SET seen = '[]'")
        db.set_setting("veille_cles", KEYS)


# --- Relevé, sans modèle ----------------------------------------------------------------------

def _text(node) -> str:
    return re.sub(r"\s+", " ", "".join(node.itertext()) if node is not None else "").strip()


def _feed_items(body: str) -> list[dict] | None:
    """Articles d'un flux RSS ou Atom, ou None si ce n'est pas un flux."""
    head = body.lstrip()[:400].lower()
    if not ("<rss" in head or "<feed" in head or "<rdf" in head):
        return None
    try:
        root = ET.fromstring(body.encode())
    except ET.ParseError:
        return None
    items = []
    for el in root.iter():
        tag = el.tag.split("}")[-1]
        if tag not in ("item", "entry"):
            continue
        get = {c.tag.split("}")[-1]: c for c in el}
        link = get.get("link")
        href = (link.get("href") if link is not None and link.get("href") else _text(link)) if link is not None else ""
        title = _text(get.get("title"))
        summary = _text(get.get("description") or get.get("summary") or get.get("content"))[:400]
        key = _text(get.get("guid") or get.get("id")) or href or title
        items.append({"cle": key, "titre": title, "lien": href, "texte": re.sub(r"<[^>]+>", " ", html.unescape(summary))[:400]})
    return items


_ANCHOR = re.compile(r'(?is)<a\b[^>]*?href\s*=\s*["\']([^"\'#][^"\']*)["\'][^>]*>(.*?)</a>')


def _clean(fragment: str) -> str:
    return re.sub(r"[ \t \n]+", " ", html.unescape(re.sub(r"<[^>]+>", " ", fragment))).strip()


# Mentions qui changent à chaque passage sans rien apprendre, retirées avant l'empreinte d'un bloc (sinon une page
# immobile paierait un tri par le modèle à chaque passage) : « il y a 3 minutes », « 5 hours ago », et l'heure d'un
# horodatage de page (« Mis à jour à 14:32 », « Last updated 2:05 pm »). Une heure du contenu (« départ à 14h30 »)
# reste : son changement est une nouveauté.
_VOLATILE = re.compile(
    r"(?i)\b(?:il y a|depuis)\s+(?:\d+|une?|quelques)\s+(?:secondes?|minutes?|min|heures?|h|jours?)\b"
    r"|\b(?:\d+|an?|a few)\s+(?:seconds?|minutes?|mins?|hours?|hrs?|days?)\s+ago\b"
    r"|\b(?:à l'instant|just now)\b"
)
_STAMP = re.compile(
    r"(?i)\b((?:mis à jour|mise à jour|actualisée?|dernière modification|updated|last updated|as of|publiée?|posted)"
    r"\b[^.\n]{0,40}?)\b\d{1,2}[:h]\d{2}(?::\d{2})?(?:\s*(?:am|pm)\b)?"
)


def _key(text: str) -> str:
    text = _STAMP.sub(r"\1", _VOLATILE.sub(" ", text))
    return hashlib.sha1(re.sub(r"\s+", " ", text).strip().lower().encode()).hexdigest()[:16]


def _page_items(body: str, base: str = "") -> list[dict]:
    """Blocs de texte d'une page web (paragraphes, titres, lignes de liste), assez longs pour avoir un sens. Chaque
    bloc garde le lien de son plus long texte cliquable : le titre d'un article plutôt que son domaine ou « 12 comments »."""
    body = re.sub(r"(?is)<(script|style|noscript|svg|head)\b.*?</\1>", " ", body)
    items = []
    for raw in re.split(r"(?i)<(?:br|/p|/div|/li|/h[1-6]|/tr|/article|/section)\b[^>]*>", body):
        b = _clean(raw)
        if len(b) < 40:
            continue
        anchors = [(len(_clean(t)), h) for h, t in _ANCHOR.findall(raw) if not h.lower().startswith(("javascript:", "mailto:"))]
        link = urljoin(base, html.unescape(max(anchors)[1])) if anchors else ""
        items.append({"cle": _key(b), "titre": "", "lien": link, "texte": b[:500]})
    return items


async def fetch(url: str) -> list[dict]:
    r = await relay.upstream_client().get(url, headers={"User-Agent": UA, "Accept-Language": "fr,en;q=0.8"},
                                          timeout=30, follow_redirects=True)
    r.raise_for_status()
    body = r.text[:3_000_000]
    return _feed_items(body) or _page_items(body, str(r.url))


# --- Tri par un petit modèle -------------------------------------------------------------------

TRIAGE = """Tu fais le tri d'une veille pour un utilisateur. Ce qu'il veut savoir : {criteria}
Voici les nouveautés apparues sur « {name} » ({url}) depuis le dernier passage.
Chaque nouveauté porte un numéro entre crochets.
Réponds uniquement par un objet JSON : {{"pertinent": true ou false, "resume": "...", "retenues": [numéros]}}.
- pertinent = true seulement si au moins une nouveauté correspond vraiment à ce qu'il veut savoir.
- resume : en français, deux à cinq phrases ou une courte liste, les faits utiles seulement (chiffres, dates, noms), sans les numéros entre crochets.
- retenues : les numéros des nouveautés dont parle le résumé (au plus 5)."""


async def triage(agent_id: str, w: dict, new: list[dict]) -> dict:
    refused = relay.profile_refusal(agent_id) or relay.day_refusal(agent_id)
    if refused:
        raise media.MediaError(refused)
    lines = []
    # Des numéros plutôt que des adresses : le modèle ne peut ni tronquer ni inventer un lien.
    for n, it in enumerate(new[:40], 1):
        lines.append(f"[{n}] " + " — ".join(x for x in (it["titre"], it["texte"][:300]) if x))
    if not w["criteria"].strip():
        # Sans critère, toute nouveauté compte : un résumé suffit.
        criteria = "toute nouveauté sur cette page"
    else:
        criteria = w["criteria"]
    model = await media.voice_model()
    body = {"model": model, "temperature": 0, "max_tokens": 500, "provider": {"sort": "latency"},
            "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": TRIAGE.format(criteria=criteria, name=w["name"], url=w["url"])},
                         {"role": "user", "content": "\n".join(lines)[:12000]}]}
    if "gpt-oss" in model:
        body["reasoning"] = {"effort": "low", "exclude": True}
    r = await relay.upstream_client().post(f"{media.BASE}/chat/completions", json=body, headers=media._headers(), timeout=60)
    if r.status_code != 200:
        raise media._fail(r)
    j = r.json()
    media._record(agent_id, model, (j.get("usage") or {}).get("cost"))
    content = j["choices"][0]["message"].get("content") or "{}"
    try:
        d = json.loads(content[content.find("{"): content.rfind("}") + 1])
    except ValueError:
        return {"pertinent": False, "resume": "", "liens": []}
    return {"pertinent": bool(d.get("pertinent")), "resume": re.sub(r"\s*[(\[]\d{1,2}(?:\s*[,et]+\s*\d{1,2})*[)\]]", "", str(d.get("resume", ""))).strip(),
            "liens": _picked(new[:40], d.get("retenues"))}


def _picked(items: list[dict], numbers) -> list[str]:
    links = []
    for n in numbers if isinstance(numbers, list) else []:
        try:
            link = items[int(n) - 1]["lien"] if int(n) >= 1 else ""
        except (ValueError, TypeError, IndexError):
            continue
        if link and link not in links:
            links.append(link)
    return links[:5]


# --- Passage ---------------------------------------------------------------------------------

def _row(wid: str) -> dict | None:
    with db.connect() as c:
        r = c.execute("SELECT * FROM watches WHERE id = ?", (wid,)).fetchone()
    return dict(r) if r else None


async def check(wid: str, save_message, main_conversation) -> dict:
    """Un passage : relevé, nouveautés, tri, livraison. Rend ce qui s'est passé."""
    w = _row(wid)
    if not w:
        return {"erreur": "Veille introuvable"}
    now = time.time()
    try:
        items = await fetch(w["url"])
    except (httpx.HTTPError, ValueError) as e:
        with db.connect() as c:
            c.execute("UPDATE watches SET last_check = ?, last_error = ?, checks = checks + 1 WHERE id = ?",
                      (now, f"Source injoignable : {str(e)[:200]}", wid))
        return {"erreur": "Source injoignable"}
    seen = json.loads(w["seen"])
    known = set(seen)
    new = [it for it in items if it["cle"] not in known]
    first = not seen
    # Toute la page actuelle reste connue, quelle que soit sa taille (au-delà de SEEN_MAX blocs, l'éviction en
    # faisait reparaître un à chaque passage) ; les anciens blocs disparus de la page gardent SEEN_MAX places.
    current = [it["cle"] for it in items]
    on_page = set(current)
    seen = [k for k in seen if k not in on_page][-SEEN_MAX:] + current
    result = {"nouveautes": 0 if first else len(new), "alerte": False}
    alert = None
    if new and not first:  # premier passage : on apprend la page, sans prévenir
        try:
            alert = await triage(w["agent_id"], w, new)
        except (httpx.HTTPError, media.MediaError) as e:
            with db.connect() as c:
                c.execute("UPDATE watches SET last_check = ?, last_error = ?, checks = checks + 1 WHERE id = ?",
                          (now, f"Tri impossible : {str(e)[:200]}", wid))
            return {"erreur": "Tri impossible, nouvel essai au prochain passage"}  # « seen » inchangé : rien de perdu
    with db.connect() as c:
        c.execute("UPDATE watches SET seen = ?, last_check = ?, last_error = '', checks = checks + 1 WHERE id = ?",
                  (json.dumps(seen), now, wid))
    if alert and alert["pertinent"] and alert["resume"]:
        links = "\n".join(f"- {u}" for u in alert["liens"])
        text = f"**Veille « {w['name']} »**\n\n{alert['resume']}" + (f"\n\n{links}" if links else "")
        conv = main_conversation(w["agent_id"])
        if conv:
            save_message(conv, "agent", text)
            pending = json.loads(db.get_setting(f"contexte_{conv}") or "[]")
            db.set_setting(f"contexte_{conv}", json.dumps((pending + [text])[-5:]))
        desktop.notify(f"Veille « {w['name']} »", alert["resume"][:240], agent_id=w["agent_id"])
        with db.connect() as c:
            c.execute("UPDATE watches SET last_alert = ?, alerts = alerts + 1 WHERE id = ?", (now, wid))
        result["alerte"] = True
    return result


async def run_watches(save_message, main_conversation) -> None:
    """Chaque minute : les veilles dont c'est l'heure passent, l'une après l'autre."""
    init()
    while True:
        await asyncio.sleep(60)
        now = time.time()
        with db.connect() as c:
            due = [r["id"] for r in c.execute(
                "SELECT id FROM watches WHERE active = 1 AND last_check + every_minutes * 60 <= ?", (now,))]
        for wid in due:
            try:
                await check(wid, save_message, main_conversation)
            except Exception as e:  # une veille cassée ne doit pas arrêter les autres
                print(f"[veille] {wid} : {e}", flush=True)


# --- API (interface et agent) ------------------------------------------------------------------

class NewWatch(BaseModel):
    nom: str = Field(min_length=1, max_length=80)
    url: str = Field(pattern=r"^https?://", max_length=2000)
    critere: str = Field(default="", max_length=1000)
    minutes: int = Field(default=60, ge=15, le=7 * 24 * 60)


def _public(w: dict) -> dict:
    return {"id": w["id"], "nom": w["name"], "url": w["url"], "critere": w["criteria"], "minutes": w["every_minutes"],
            "active": bool(w["active"]), "dernier_passage": w["last_check"] or None, "derniere_alerte": w["last_alert"] or None,
            "erreur": w["last_error"] or None, "passages": w["checks"], "alertes": w["alerts"]}


def _list(agent_id: str) -> list[dict]:
    with db.connect() as c:
        return [_public(dict(r)) for r in c.execute("SELECT * FROM watches WHERE agent_id = ? ORDER BY created_at", (agent_id,))]


def _create(agent_id: str, body: NewWatch) -> dict:
    with db.connect() as c:
        if c.execute("SELECT COUNT(*) FROM watches WHERE agent_id = ?", (agent_id,)).fetchone()[0] >= 50:
            raise HTTPException(400, "50 veilles au plus par agent")
        wid = uuid.uuid4().hex[:12]
        c.execute("INSERT INTO watches (id, agent_id, name, url, criteria, every_minutes) VALUES (?, ?, ?, ?, ?, ?)",
                  (wid, agent_id, body.nom.strip(), body.url.strip(), body.critere.strip(), body.minutes))
    return _public(_row(wid))


def _owned(agent_id: str, wid: str) -> dict:
    w = _row(wid)
    if not w or w["agent_id"] != agent_id:
        raise HTTPException(404, "Veille introuvable")
    return w


_hooks: dict = {}


def setup(save_message, main_conversation) -> None:
    _hooks.update(save=save_message, main=main_conversation)


async def _act(agent_id: str, wid: str, action: str) -> dict:
    _owned(agent_id, wid)
    if action in ("pause", "reprendre"):
        with db.connect() as c:
            c.execute("UPDATE watches SET active = ? WHERE id = ?", (1 if action == "reprendre" else 0, wid))
        return {"ok": True}
    if action == "supprimer":
        with db.connect() as c:
            c.execute("DELETE FROM watches WHERE id = ?", (wid,))
        return {"ok": True}
    if action == "verifier":
        return await check(wid, _hooks["save"], _hooks["main"])
    raise HTTPException(400, "Action inconnue")


@router.get("/api/agents/{agent_id}/watches")
def list_watches(agent_id: str, user: int = Depends(auth.current_user)):
    access.access(user, agent_id, "admin")
    return {"veilles": _list(agent_id)}


@router.post("/api/agents/{agent_id}/watches")
async def create_watch(agent_id: str, body: NewWatch, user: int = Depends(auth.current_user)):
    access.access(user, agent_id, "admin")
    w = _create(agent_id, body)
    await check(w["id"], _hooks["save"], _hooks["main"])  # premier relevé tout de suite : la source est vérifiée
    return _public(_row(w["id"]))


@router.post("/api/agents/{agent_id}/watches/{wid}/{action}")
async def watch_action(agent_id: str, wid: str, action: str, user: int = Depends(auth.current_user)):
    access.access(user, agent_id, "admin")
    return await _act(agent_id, wid, action)


@router.get("/agent-api/veilles")
def agent_list(request: Request):
    return {"veilles": _list(relay._agent_from(request))}


@router.post("/agent-api/veilles")
async def agent_create(body: NewWatch, request: Request):
    agent_id = relay._agent_from(request)
    w = _create(agent_id, body)
    first = await check(w["id"], _hooks["save"], _hooks["main"])
    return {**_public(_row(w["id"])), "premier_releve": first}


class WatchAction(BaseModel):
    id: str
    action: str = Field(pattern="^(pause|reprendre|supprimer|verifier)$")


@router.post("/agent-api/veilles/action")
async def agent_action(body: WatchAction, request: Request):
    return await _act(relay._agent_from(request), body.id, body.action)
