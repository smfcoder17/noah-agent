"""#33 : vrais droits et vraies routes d'écran ; seuls les appels au navigateur et le mode privé sont simulés.

    MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD:/repo:ro" python:3.12-slim sh -c \
      "pip install -q -r /repo/server/requirements.txt && python /repo/tests/exposition/ecran_etats_test.py"
"""
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlsplit

REPO = Path(os.environ.get("NOAH_REPO", "/repo"))
os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, str(REPO / "server"))

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from noah import auth, db, handoff, hermes, main  # noqa: E402

db.init()
alice = auth.create_user("alice", "motdepasse-a")
eve = auth.create_user("eve", "motdepasse-e")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (alice,))


def session(user):
    return TestClient(main.app, headers={"Authorization": f"Bearer {auth.new_session(user, 'essai', 'web')}"})


client = session(alice)
state = {}


async def browser_call(agent_id, method, path, **kw):
    assert (agent_id, method) == ("a1", "GET"), (agent_id, method)
    assert path in {"/health", "/vnc/status"}, path
    reply = state[path]
    if isinstance(reply, Exception):
        raise reply
    return reply


# Les vrais _browser_diagnosis et screen_status sont traversés, jamais remplacés.
cases = [
    ("pret", {"browserRunning": True, "activeTabs": 2}, {"running": True}, True, True, 2),
    ("aucune_page", {"browserRunning": True, "activeTabs": 0}, {"running": True}, True, True, 0),
    ("veille", {"browserRunning": False, "activeTabs": 0}, {"running": False}, False, False, 0),
    ("veille", {"browserRunning": False, "activeTabs": 0}, {"running": True}, True, False, 0),
    ("injoignable", {"browserRunning": True, "activeTabs": 2}, {"running": False}, False, True, 2),
    ("injoignable", {"browserRunning": True, "activeTabs": 0}, {"running": False}, False, True, 0),
    ("injoignable", {"browserRunning": True}, {"running": True}, True, True, 0),
    ("injoignable", {"browserRunning": False, "http_status": 503, "recovering": True}, {"running": True}, True, False, 0),
    ("injoignable", {"browserRunning": True, "activeTabs": 2, "recovering": True}, {"running": True}, True, True, 2),
    ("injoignable", {"http_status": 401}, {"running": True}, True, False, 0),
    ("injoignable", {"browserRunning": True, "activeTabs": 0}, {"http_status": 502}, False, True, 0),
]
with patch.object(hermes, "browser_call", AsyncMock(side_effect=browser_call)) as calls, \
     patch.object(hermes, "_launcher", AsyncMock(return_value={"status": "running"})) as launcher:
    for expected, health, vnc, awake, running, tabs in cases:
        state.update({"/health": health, "/vnc/status": vnc})
        response = client.get("/api/agents/a1/screen-status")
        assert response.status_code == 200, response.text
        assert response.json() == {"etat": expected, "awake": awake, "reachable": True, "running": running, "tabs": tabs}, response.text
    print("1. quatre états, zéro onglet distinct de veille, écran coupé, diagnostic incomplet, récupération et refus HTTP")

    for route in ("/health", "/vnc/status"):
        for error in (httpx.ConnectError("coupure"), httpx.ReadTimeout("lent")):
            state.update({"/health": {"browserRunning": True, "activeTabs": 2}, "/vnc/status": {"running": True}, route: error})
            response = client.get("/api/agents/a1/screen-status")
            assert response.status_code == 200, response.text
            assert response.json() == {"etat": "injoignable", "awake": False, "reachable": False, "running": False, "tabs": 0}, response.text
    print("2. coupure et délai dépassé sur chacune des deux sondes : injoignable, jamais aucune_page")

    for container_status in ("exited", "created", "absent", "running", "restarting", "paused", "dead"):
        launcher.return_value = {"status": container_status}
        for route in ("/health", "/vnc/status"):
            state.update({"/health": {"browserRunning": True, "activeTabs": 2}, "/vnc/status": {"running": True},
                          route: httpx.ConnectError("conteneur inaccessible")})
            response = client.get("/api/agents/a1/screen-status")
            expected = "veille" if container_status in {"exited", "created", "absent"} else "injoignable"
            assert response.status_code == 200, response.text
            assert response.json() == {"etat": expected, "awake": False, "reachable": False, "running": False, "tabs": 0}, response.text
            launcher.assert_awaited_with("GET", "/agents/a1/browser", timeout=5)
    for error in (httpx.ConnectError("lanceur coupé"), httpx.ReadTimeout("lanceur lent")):
        launcher.side_effect = error
        assert client.get("/api/agents/a1/screen-status").json()["etat"] == "injoignable"
    launcher.side_effect = None
    launcher.return_value = {"status": "running"}
    print("2 bis. conteneur arrêté ou absent : veille ; conteneur actif ou état Docker inconnu : injoignable")

    launcher.reset_mock()
    state.update({"/health": {"browserRunning": True, "activeTabs": 1}, "/vnc/status": {"running": True}})
    assert client.get("/api/agents/a1/screen-status").json()["etat"] == "pret"
    launcher.assert_not_awaited()
    print("3. après la coupure, le diagnostic retrouve la page sans réveil ni redémarrage")

    for visitor in (TestClient(main.app), session(eve)):
        calls.reset_mock()
        launcher.reset_mock()
        for method, path in (("GET", "screen-status"), ("GET", "screen-url"), ("POST", "screen-url")):
            assert visitor.request(method, f"/api/agents/a1/{path}").status_code in {401, 403, 404}
        assert calls.await_count == 0, "un refus a atteint le navigateur"
        launcher.assert_not_awaited()
    print("4. session absente ou autre profil : aucun appel au navigateur, les trois routes restent protégées")

with patch.object(handoff, "take_control", AsyncMock(return_value=True)) as control, \
     patch.object(hermes, "browser_secrets", return_value=("cle", "mot-ecran")) as secrets:
    link = client.get("/api/agents/a1/screen-url?view_only=1").json()["url"]
    parts = urlsplit(link)
    assert "mot-ecran" not in parts.path + parts.query
    assert parse_qs(parts.fragment)["view_only"] == ["1"]
    assert parse_qs(parts.fragment)["password"] == ["mot-ecran"]
    control.assert_awaited_with("a1", False)
    secrets.reset_mock()
    for view_only, expected in ((0, True), (1, False)):
        response = client.post(f"/api/agents/a1/screen-url?view_only={view_only}", json={})
        assert response.status_code == 200 and response.json() == {"ok": True}, response.text
        control.assert_awaited_with("a1", expected)
    secrets.assert_not_called()
    control.return_value = False
    assert client.post("/api/agents/a1/screen-url?view_only=0", json={}).status_code == 503
    print("5. lien en lecture seule, secret dans le fragment ; changement de contrôle sans relire le lien, refus si G7.7 non confirmé")

started = False


async def ensure_browser(agent_id):
    global started
    assert agent_id == "a1"
    started = True


async def wake_call(agent_id, method, path, **kw):
    assert agent_id == "a1"
    if not started:
        raise httpx.ConnectError("conteneur arrêté")
    if (method, path) == ("POST", "/start"):
        return {"http_status": 200}
    if (method, path) == ("GET", "/tabs"):
        return {"tabs": [{"tabId": "page"}], "http_status": 200}
    assert method == "GET" and path in {"/health", "/vnc/status"}, (method, path)
    return {"browserRunning": True, "activeTabs": 1, "running": True, "http_status": 200}


with patch.object(hermes, "browser_call", AsyncMock(side_effect=wake_call)), \
     patch.object(hermes, "ensure_browser", AsyncMock(side_effect=ensure_browser)) as ensure, \
     patch.object(hermes, "restart_browser", AsyncMock()) as restart:
    response = client.post("/api/agents/a1/browser/wake", json={})
    assert response.status_code == 200 and response.json()["ecran_actif"] is True, response.text
    ensure.assert_awaited_once_with("a1")
    restart.assert_not_awaited()
    assert client.get("/api/agents/a1/screen-status").json()["etat"] == "pret"
    print("6. vraie route de réveil depuis un conteneur arrêté : relance à la demande, puis écran prêt")

print("écran : tout est vert")
