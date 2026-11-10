"""La base fait foi pour chaque accord, jamais l'état d'un écran ou d'une conversation."""
import json
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request

from . import access, auth, bus, db

router = APIRouter()
EXPIRATION = 300


def device_type(request: Request) -> str:
    token = auth.request_token(request, request.cookies.get(auth.COOKIE))
    key = auth.session_key(token)
    with db.connect() as c:
        row = c.execute("SELECT platform FROM sessions WHERE token = ?", (key,)).fetchone()
    platform = row["platform"] if row else ""
    if platform == "desktop":
        return "ordinateur"
    if platform in ("android", "ios", "mobile"):
        return "téléphone"
    ua = request.headers.get("user-agent", "").lower()
    # Le bureau local a historiquement une session web. Ceci nomme l'appareil, sans lui donner de droit local.
    if "electron/" in ua:
        return "ordinateur"
    return "téléphone" if any(s in ua for s in ("android", "iphone", "ipad")) else "web"


def shown(row) -> dict:
    return {**json.loads(row["summary_json"]), **{k: row[k] for k in
            ("id", "agent_id", "conv_id", "request_id", "generation", "run_id", "state", "created")}}


def create(user: int, agent_id: str, conv_id: str, run_id: str, summary: dict) -> dict:
    from . import mcp
    with db.connect() as c:
        c.execute("BEGIN IMMEDIATE")
        rid, generation = str(summary["request_id"]), int(summary.get("generation") or 1)
        added = c.execute("INSERT OR IGNORE INTO accords VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'attend', ?, NULL, NULL)",
                          (uuid.uuid4().hex, user, agent_id, conv_id, rid, generation, run_id,
                           json.dumps(summary, ensure_ascii=False), time.time())).rowcount
        row = c.execute("SELECT * FROM accords WHERE agent_id = ? AND run_id = ? AND request_id = ? AND generation = ?",
                        (agent_id, run_id, rid, generation)).fetchone()
        if added:
            bus.publish(c, user, "accord.demande", {"id": row["id"]})
        if row["state"] == "attend" and not json.loads(row["summary_json"]).get("bureau"):
            mcp.approval_seen(agent_id, rid, str(json.loads(row["summary_json"]).get("summary") or ""))
    return shown(row)


def pending(user: int | None = None, conv_id: str | None = None) -> list[dict]:
    sweep()
    with db.connect() as c:
        rows = c.execute("SELECT * FROM accords WHERE state = 'attend' AND (? IS NULL OR user_id = ?) "
                         "AND (? IS NULL OR conv_id = ?) ORDER BY created, rowid",
                         (user, user, conv_id, conv_id)).fetchall()
    return [shown(r) for r in rows]


def _close(c, row, state: str, par: str | None) -> bool:
    if not c.execute("UPDATE accords SET state = ?, answered_by = ?, answered_at = ? WHERE id = ? AND state = 'attend'",
                     (state, par, time.time(), row["id"])).rowcount:
        return False
    payload = {"id": row["id"], "par": par, "etat": state, "conv_id": row["conv_id"],
               "request_id": row["request_id"], "run_id": row["run_id"], "generation": row["generation"]}
    bus.publish(c, row["user_id"], "accord.clos", payload)
    if state in ("donne", "refuse"):
        label = "Accord donné" if state == "donne" else "Accord refusé"
        where = {"ordinateur": "sur l'ordinateur", "téléphone": "sur le téléphone", "web": "sur le web"}.get(par, "")
        c.execute("INSERT INTO messages (conversation_id, role, text, detail) VALUES (?, 'accord', ?, ?)",
                  (row["conv_id"], f"{label} {where}".strip(), json.dumps(payload, ensure_ascii=False)))
    return True


def close(ident: str, user: int, state: str, par: str | None, *, native: bool = False):
    sweep()
    with db.connect() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT * FROM accords WHERE id = ? AND user_id = ?", (ident, user)).fetchone()
        if not row:
            raise HTTPException(404, "Accord introuvable")
        if json.loads(row["summary_json"]).get("bureau") and not native:
            raise HTTPException(403, "À accepter sur ton ordinateur")
        if row["state"] == "expire":
            raise HTTPException(409, "Cet accord a expiré")
        if not _close(c, row, state, par):
            raise HTTPException(409, "Cet accord est déjà clos")
    return row


def sweep(live_runs=None, run_id: str | None = None) -> None:
    """Au démarrage : les anciens runs ne sont plus suivis. En continu : cinq minutes, même sans lecteur."""
    from . import mcp
    closed = []
    with db.connect() as c:
        c.execute("BEGIN IMMEDIATE")
        rows = c.execute("SELECT * FROM accords WHERE state = 'attend'").fetchall()
        for row in rows:
            state = "expire" if row["created"] <= time.time() - EXPIRATION else None
            if state is None and ((live_runs is not None and row["run_id"] not in live_runs) or run_id == row["run_id"]):
                state = "annule"
            if state and _close(c, row, state, None):
                closed.append(row)
        bus.prune(c)
    for row in closed:
        mcp.approval_answered(row["agent_id"], row["request_id"], False)


@router.get("/api/accords")
def list_accords(user: int = Depends(auth.current_user)):
    out = []
    for item in pending(user):
        try:
            access.conversation(user, item["conv_id"], ecrire=True)
        except HTTPException:
            continue
        with db.connect() as c:
            row = c.execute("SELECT v.title, v.main, a.name FROM conversations v JOIN agents a ON a.id = v.agent_id WHERE v.id = ?",
                            (item["conv_id"],)).fetchone()
        out.append({**item, "conversation_id": item["conv_id"], "agent": row["name"], "titre": row["title"],
                    "main": bool(row["main"]), "a_moi": True, "etat": "approve", "apercu": item.get("apercu") or []})
    return out
