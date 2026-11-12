"""Vérifie que brollss est proposé, puis l'installe comme le ferait la carte de connexion."""
import json
import subprocess
import sys

NAME = sys.argv[1] if len(sys.argv) > 1 else "noah-agent-noah-4ed4"
PY = "/opt/hermes/.venv/bin/python"


def admin(action, body=None):
    payload = json.dumps(body or {}, ensure_ascii=False).replace("'", "'\\''")
    raw = subprocess.run(["docker", "exec", NAME, "sh", "-c", f"cd /opt/data && {PY} /tmp/agent_admin_new.py {action} '{payload}'"],
                         capture_output=True, text=True, encoding="utf-8", errors="replace")
    line = (raw.stdout or "").strip().splitlines()
    if not line:
        raise SystemExit(f"échec {action}: {(raw.stderr or '')[-400:]}")
    return json.loads(line[-1])


apps = admin("applications")["applications"]
extra = next((a for a in apps if a["nom"] == "brollss"), None)
print("brollss :", extra)
assert extra, "brollss n'est pas proposé"
assert extra["url"] == "https://brollss.com/mcp" and extra["oauth"] and not extra["installe"], extra
print(f"{len(apps)} applications proposées au total")

if "--connecter" in sys.argv:
    out = admin("application_connecter", {"nom": "brollss", "retour": ""})
    print("connexion :", {k: (str(v)[:90]) for k, v in out.items()})
    assert out.get("adresse", "").startswith("https://"), out
    cfg = admin("applications")["applications"]
    b = next(a for a in cfg if a["nom"] == "brollss")
    assert b["installe"], b
    print("après connexion :", b["nom"], "installé =", b["installe"], "· adresse d'autorisation rendue")
print("brollss : proposé dans Connexions, adresse MCP et OAuth corrects")
