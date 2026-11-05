"""G13 avec le vrai code d'Hermes, sans agent ni modèle : son client MCP, sa table d'outils, sa validation humaine, le plugin.

Le serveur de test répond comme le relais de Noah (JSON, sans session, GET refusé). Ce que cela prouve : Hermes accepte cette
forme de serveur et ce config.yaml, nomme les outils comme le plugin l'attend, applique les trois droits, passe par sa
validation (fermée sans personne), refuse en routine, et une panne reste un résultat d'outil. Ce que cela ne prouve pas :
un vrai tour de modèle, la gateway qui tourne, /v1/runs de bout en bout. Trop lourd pour la CI (image de 4 Go) : à la main.

    MSYS_NO_PATHCONV=1 docker run --rm --memory=1g --entrypoint /opt/hermes/.venv/bin/python \
      -v "$PWD/server/noah/agent_plugin:/plugin:ro" -v "$PWD/tests/tools:/check:ro" \
      nousresearch/hermes-agent@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d /check/mcp_hermes_check.py
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path

HOME = Path(tempfile.mkdtemp())
os.environ.update(HERMES_HOME=str(HOME), HOME=str(HOME))
RIGHTS = HOME / ".noah/mcp-droits.json"
RIGHTS.parent.mkdir()
os.environ["NOAH_MCP_DROITS"] = str(RIGHTS)
sys.path[:0] = ["/opt/hermes", "/check"]

from mcp_server import Server  # noqa: E402

srv = Server(session=False).start()
(HOME / "plugins/noah-garde").mkdir(parents=True)
for name in ("plugin.yaml", "__init__.py"):
    shutil.copy(f"/plugin/{name}", HOME / "plugins/noah-garde" / name)
# La configuration que Noah écrit pour un outil sans OAuth, avec un nom à tiret.
CONFIG = {
    "plugins": {"enabled": ["noah-garde"]},
    "approvals": {"cron_mode": "deny"},
    "mcp_servers": {"mes-fiches": {"url": f"http://127.0.0.1:{srv.port}/agent-api/mcp/mes-fiches",
                                   "headers": {"Authorization": "Bearer relais"}, "timeout": 130, "connect_timeout": 15,
                                   "sampling": {"enabled": False}}},
}
(HOME / "config.yaml").write_text(json.dumps(CONFIG))  # le JSON est du YAML valide


def rights(droit: str) -> None:
    RIGHTS.write_text(json.dumps({"mes-fiches": droit}))


from hermes_cli.plugins import _dispatch_pre_tool_call_hooks, discover_plugins, get_plugin_manager  # noqa: E402
from tools.mcp_tool_discovery import discover_mcp_tools  # noqa: E402
from tools.registry import registry  # noqa: E402

discover_plugins()
assert "noah-garde" in str(get_plugin_manager().list_plugins()), get_plugin_manager().list_plugins()
print("plugin chargé par Hermes")
names = discover_mcp_tools()
READ, WRITE = "mcp__mes_fiches__lire_fiche", "mcp__mes_fiches__creer_fiche"
assert READ in names and WRITE in names, names
assert registry.get_toolset_for_tool(WRITE) == "mcp-mes-fiches", registry.get_toolset_for_tool(WRITE)
print("outils découverts à travers une adresse de relais :", names)


def gate(tool: str, args: dict | None = None) -> str | None:
    return _dispatch_pre_tool_call_hooks(tool, args or {}, session_id="essai")[0]


def run(tool: str, args: dict | None = None) -> str:
    return registry.dispatch(tool, args or {})


rights("agir")
assert gate(WRITE) is None
out = run(WRITE, {"titre": "Devis"})
assert "fait : creer_fiche" in out and srv.calls[-1][0] == "creer_fiche" and srv.calls[-1][2] == "Bearer relais", out
print("agir : l'appel part, l'en-tête du relais arrive")

rights("lire")
assert gate(READ) is None, "readOnlyHint de lire_fiche non vu"
blocked = gate(WRITE)
assert blocked and "lecture seule" in blocked, blocked
print("lire : lire_fiche passe (readOnlyHint lu par Hermes), creer_fiche refusé")

rights("confirmer")
blocked = gate(WRITE, {"titre": "x"})
assert blocked and "BLOCKED" in blocked, blocked
print("confirmer sans personne pour répondre : refusé (fermé par défaut)")

# La validation par le pont de /v1/runs : Hermes appelle le notificateur, Noah répond « once » ou « deny ».
from tools import approval, approval_context  # noqa: E402

os.environ["HERMES_EXEC_ASK"] = "1"
key = "session-essai"
seen: list[dict] = []
reply = {"choice": "once"}


def notify(data: dict) -> None:
    seen.append(data)
    threading.Thread(target=lambda: (time.sleep(0.2), approval.resolve_gateway_approval(key, reply["choice"]))).start()


approval.register_gateway_notify(key, notify)
tokens = approval_context.set_current_session_key(key) if hasattr(approval_context, "set_current_session_key") else None
if tokens is None:
    os.environ["HERMES_SESSION_KEY"] = key
assert gate(WRITE, {"titre": "Devis"}) is None, "accord donné, et pourtant refusé"
assert seen, "le notificateur n'a pas été appelé"
assert str(seen[-1].get("description", "")).startswith("Outil « mes-fiches » : creer_fiche"), seen[-1]
print("confirmer, accord « une fois » : l'appel passe ; le résumé commence bien par « Outil « mes-fiches » : creer_fiche »")
assert gate(WRITE) is None and len(seen) == 2, "un accord « une fois » a resservi sans redemander"
reply["choice"] = "deny"
blocked = gate(WRITE)
assert blocked and len(seen) == 3, blocked
print("confirmer, chaque appel redemande ; refus :", blocked[:80])
approval.unregister_gateway_notify(key)

os.environ["HERMES_CRON_SESSION"] = "1"
blocked = gate(WRITE)
assert blocked and "routine" in blocked, blocked
del os.environ["HERMES_CRON_SESSION"]
print("routine : refus clair, en français")

from cron.scheduler import _resolve_cron_enabled_toolsets  # noqa: E402

toolsets = _resolve_cron_enabled_toolsets({}, CONFIG)
assert toolsets is None or any("mes-fiches" in t for t in toolsets), toolsets
print("routine sans liste d'outils : le serveur MCP reste dans ses outils :", "tous" if toolsets is None else [t for t in toolsets if "fiches" in t])

# Panne vue par Hermes en direct (cas OAuth) : un résultat d'outil, jamais une exception.
rights("agir")
srv.shutdown()
srv.server_close()
out = run(WRITE, {"titre": "x"})
assert "error" in out.lower(), out
print("panne : résultat d'outil, pas d'exception :", out[:160])
print("OK")
