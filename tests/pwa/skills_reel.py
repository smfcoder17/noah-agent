"""Sur le vrai agent : un skill créé comme l'agent le fait (outil d'Hermes, sans catégorie) apparaît, se modifie et se retire.

    python tests/pwa/skills_reel.py <conteneur>            # lecture seule
    python tests/pwa/skills_reel.py <conteneur> --ecrire    # crée, modifie, retire un skill de test
"""
import json
import subprocess
import sys
from pathlib import Path

NAME = next((a for a in sys.argv[1:] if not a.startswith("--")), "noah-agent-noah-4ed4")
WRITE = "--ecrire" in sys.argv
PY = "/opt/hermes/.venv/bin/python"
HERE = Path(__file__).parent


def run(script: str) -> str:
    raw = subprocess.run(["docker", "exec", NAME, "sh", "-c", f"cd /opt/data && {script}"],
                         capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = (raw.stdout or "").strip().splitlines()
    if raw.returncode or not out:
        raise SystemExit(f"échec : {(raw.stdout or '')[-500:]} {(raw.stderr or '')[-500:]}")
    return out[-1]


def admin(action: str, body: dict | None = None) -> dict:
    payload = json.dumps(body or {}, ensure_ascii=False).replace("'", "'\\''")
    return json.loads(run(f"{PY} /tmp/agent_admin_new.py {action} '{payload}'"))


def hermes_file(name: str, body: dict) -> dict:
    """L'agent écrit par son outil d'Hermes : le script part en fichier, son argument aussi (pas de quoting du shell)."""
    probe = HERE / "skill_create_probe.py"
    payload = HERE / "skill_create_probe.json"
    payload.write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
    subprocess.run(["docker", "cp", str(probe), f"{NAME}:/tmp/probe.py"], check=True, capture_output=True)
    subprocess.run(["docker", "cp", str(payload), f"{NAME}:/tmp/probe.json"], check=True, capture_output=True)
    payload.unlink()
    return json.loads(run(f"{PY} /tmp/probe.py /tmp/probe.json"))


def listed() -> dict:
    return {s["nom"]: s for s in admin("skills")["skills"]}


skills = admin("skills")["skills"]
print(f"{len(skills)} skills listés")
assert skills, "aucun skill : la liste ne voit rien"
for s in skills[:5]:
    assert s["titre"] and not s["titre"][:2].strip().rstrip(".").isdigit(), f"titre suspect : {s['titre']!r}"
    print(f"  {s['origine']:20} | {s['titre'][:50]:50} | {s['nom']}")

if WRITE:
    test = "zz-essai-noah"
    # Un essai précédent a pu être interrompu : son skill reste, on le retire d'abord.
    if test in listed():
        admin("skill_retirer", {"nom": test})
        assert test not in listed(), "nettoyage impossible"
    made = hermes_file(test, {
        "name": test,
        "content": "---\nname: zz-essai-noah\ndescription: \"Use when preparing replies.\"\n---\n\n# Essai Noah\n\nTrois phrases, tutoiement.\n",
    })
    assert made.get("success"), made
    found = listed()
    assert test in found, f"le skill créé par l'agent n'apparaît pas : {list(found)[:6]}"
    shown = found[test]
    print(f"  appris : {shown['origine']} · modifiable={shown['modifiable']} · titre={shown['titre']!r}")
    assert shown["origine"] == "appris par ton agent" and shown["modifiable"], shown
    assert "trois phrases" in shown["texte"].lower(), shown["texte"][:150]
    edited = admin("skill_ecrire", {"nom": test, "titre": "Essai Noah modifié", "texte": "Deux phrases, vouvoiement."})
    assert edited["titre"] == "Essai Noah modifié" and "Deux phrases" in edited["texte"], edited
    # L'agent continue de voir son skill après la modification : même dossier, même nom.
    assert test in listed(), "le skill modifié garde son nom"
    bundled = next(s for s in admin("skills")["skills"] if s["fourni"])
    try:
        admin("skill_ecrire", {"nom": bundled["nom"], "titre": "X", "texte": "Y"})
    except SystemExit as e:
        assert "vient avec Noah" in str(e), e
    else:
        raise AssertionError("un skill fourni ne doit pas être modifiable")
    admin("skill_retirer", {"nom": test})
    assert test not in listed(), "le skill de test reste"
    print("skills : créé par l'agent, vu, modifié, retiré ; un skill fourni refuse la modification")
print("skills : liste, titres et origines lisibles")
