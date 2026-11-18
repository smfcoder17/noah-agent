"""Répétition de la migration 0.4.0 sur une COPIE d'une base (docs/epics/0.4.0/socle.md, 4.5). Le fichier donné n'est jamais ouvert en
écriture : il est copié dans un dossier temporaire, c'est la copie que `db.init()` puis `taches.migrer()` modifient.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tools:/tools" -v "$DOSSIER:/copie:ro" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tools/eval/migration_040.py /copie/noah.db"

Il imprime : `PRAGMA integrity_check` avant et après, les comptes avant et après de chaque table, les tâches par genre et par état,
`sans_fil`, la durée, les titres en double (un même fil, un même titre). Ce rapport contient des titres réels : il reste hors de git,
comme les captures de docs/epics/0.4.0/captures*/. Une copie de la production ne se prend pas à la main : sauvegarde par
`sh scripts/backup.sh` sur le VPS (instantané SQLite cohérent), puis `noah.db` dans `noah_noah-data.tar.gz`.

Clé de chiffrement (`NOAH_SECRET_KEY`). Une copie ouverte avec une AUTRE clé ne pose pas de problème, vérifié dans le code :
- `noah.db` construit son chiffreur à l'import (`_fernet`, db.py:113) mais `db.init()` ne déchiffre rien ;
- `_adopt` ne lit que des colonnes en clair (rôles, propriétaires) ;
- `_migrate_logins` appelle `unseal` seulement sur d'anciennes lignes `agent_logins` (d'avant la 0.3.0), et l'enveloppe d'un
  `except Exception` : avec une autre clé la ligne devient « illisible », n'est rapprochée d'aucune autre et passe au coffre telle
  quelle, secret scellé inchangé. Cela n'arrive que sur la copie ;
- `taches.migrer()` ne lit aucun secret (titres, résumés et états viennent de colonnes en clair).
Sans `NOAH_SECRET_KEY` ni `LAUNCHER_KEY` dans l'environnement, `config.py` écrirait des clés dans /secrets : le script en pose donc
d'office, factices, pour ne rien écrire hors du dossier temporaire. Le fuseau de la personne (l'heure ajoutée à un titre en double,
la date d'un titre de repli) vient d'un fichier d'état que la copie n'a pas : ces deux cas se lisent en UTC.
"""
import os
import shutil
import sqlite3
import sys
import tempfile
import time

if len(sys.argv) != 2 or not os.path.isfile(sys.argv[1]):
    sys.exit("usage : python migration_040.py <copie.db>")
SOURCE = os.path.abspath(sys.argv[1])
WORK = tempfile.mkdtemp(prefix="migration_040_")
os.environ["NOAH_DATA_DIR"] = WORK
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
os.environ.setdefault("NOAH_SECRETS_FILE", os.path.join(WORK, "secrets.json"))
sys.path.insert(0, os.environ.get("NOAH_APP", "/app"))

for suffix in ("", "-wal", "-shm"):  # le fichier et son journal : une base WAL copiée seule perdrait des transactions
    if os.path.exists(SOURCE + suffix):
        shutil.copy2(SOURCE + suffix, os.path.join(WORK, "noah.db" + suffix))

from noah import db, taches  # noqa: E402


def connect():
    c = sqlite3.connect(os.path.join(WORK, "noah.db"))
    c.row_factory = sqlite3.Row
    return c


def counts() -> dict[str, int]:
    with connect() as c:
        names = [r["name"] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        return {n: c.execute(f'SELECT COUNT(*) FROM "{n}"').fetchone()[0] for n in names}


def integrity() -> str:
    with connect() as c:
        return " ; ".join(r[0] for r in c.execute("PRAGMA integrity_check"))


NEW = ("taches", "questions", "regles", "routine_passages", "routine_vues")
print(f"Copie de travail : {WORK} (source intacte : {SOURCE})")
print(f"PRAGMA integrity_check (avant)  : {integrity()}")
before = counts()
t0 = time.time()
db.init()
t_init = time.time() - t0
t0 = time.time()
rapport = taches.migrer()
t_migrer = time.time() - t0
after = counts()
print(f"PRAGMA integrity_check (après)  : {integrity()}")

print("\nComptes avant / après, table par table :")
moved = []
for name in sorted(set(before) | set(after)):
    b, a = before.get(name), after.get(name)
    flag = ""
    if b is None:
        flag = "  (table nouvelle)"
    elif name == "settings" and 0 <= a - b <= 2:
        flag = "  (le compte rendu migr_040_taches, et migr_020 sur une base qui ne l'avait pas)"
    elif b != a and name not in NEW:
        flag = "  <-- A CHANGÉ"
        moved.append(name)
    print(f"  {name:<28} {'-' if b is None else b:>8} -> {a:>8}{flag}")
print("Tables existantes inchangées : " + ("OUI" if not moved else f"NON ({', '.join(moved)})"))

with connect() as c:
    print("\nTâches par genre et par état :")
    for r in c.execute("SELECT genre, etat, COUNT(*) AS n FROM taches GROUP BY genre, etat ORDER BY genre, etat"):
        print(f"  {r['genre']:<12} {r['etat']:<8} {r['n']:>6}")
    total = c.execute("SELECT COUNT(*) FROM taches").fetchone()[0]
    candidates = c.execute("SELECT COUNT(*) FROM conversations WHERE main = 0").fetchone()[0]
    print(f"  total {total} tâches pour {candidates} sous-conversations")
    doubles = c.execute("SELECT fil_id, titre, COUNT(*) AS n FROM taches GROUP BY fil_id, titre HAVING COUNT(*) > 1").fetchall()
    sans_fil = c.execute("SELECT v.id, v.agent_id, v.user_id FROM conversations v WHERE v.main = 0 AND NOT EXISTS "
                         "(SELECT 1 FROM taches t WHERE t.conversation_id = v.id)").fetchall()
    bad = c.execute("SELECT COUNT(*) FROM taches WHERE titre LIKE 'Demande de%' OR titre LIKE 'De lui-même%'").fetchone()[0]

print(f"\nsans_fil : {rapport['sans_fil']}" + ("  (sous-conversations d'un compte qui n'a pas de fil avec cet agent : question à Franck avant de publier)"
                                                if rapport["sans_fil"] else ""))
for r in sans_fil[:20]:
    print(f"  conversation {r['id']} (agent {r['agent_id']}, compte {r['user_id']})")
print(f"erreurs de ligne : {rapport['erreurs']}")
print(f"titres qui commencent par « Demande de » ou « De lui-même » : {bad}")
print(f"titres en double dans un même fil : {len(doubles)}")
for r in doubles[:20]:
    print(f"  {r['n']} x « {r['titre']} » (fil {r['fil_id']})")
print(f"\ndurée : db.init() {t_init:.2f} s, migrer() {t_migrer:.2f} s")
print(f"compte rendu écrit dans settings['migr_040_taches'] : {rapport}")

# Rejouer ne doit rien changer : la preuve que la migration est rejouable sur cette copie-là.
again = taches.migrer()
print(f"second passage : {again['creees']} tâche créée (attendu : 0)")
shutil.rmtree(WORK, ignore_errors=True)
sys.exit(0 if not moved and bad == 0 and again["creees"] == 0 and rapport["erreurs"] == 0 else 1)
