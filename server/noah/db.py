import base64
import hashlib
import sqlite3
from contextlib import contextmanager

from cryptography.fernet import Fernet

from .config import DATA_DIR, SECRET_KEY

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pw_hash BLOB NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS window_sessions (
  token TEXT PRIMARY KEY,
  parent TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  cost REAL NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pending_requests (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  who TEXT NOT NULL,
  emoji TEXT NOT NULL,
  PRIMARY KEY (message_id, who)
);
"""

_fernet = Fernet(base64.urlsafe_b64encode(hashlib.sha256(SECRET_KEY.encode()).digest()))


def init() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.executescript(SCHEMA)
        columns = {r["name"] for r in db.execute("PRAGMA table_info(usage)")}
        if "cached_tokens" not in columns:
            db.execute("ALTER TABLE usage ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0")
        # Tâche (conversation) qui a provoqué l'appel ; vide pour le travail de fond (tâches planifiées, surveillance).
        _add_columns(db, "usage", {"conversation_id": "TEXT"})
        _add_columns(db, "messages", {"detail": "TEXT"})  # d'une erreur : ce qui permet de la diagnostiquer
        db.execute("CREATE INDEX IF NOT EXISTS usage_conversation ON usage(conversation_id)")
        _add_columns(db, "agents", {"color": "TEXT NOT NULL DEFAULT ''", "pinned": "INTEGER NOT NULL DEFAULT 0"})
        # Visage choisi : forme et détail distinctif (vides = le visage d'origine). Valeurs validées par la route.
        _add_columns(db, "agents", {"shape": "TEXT NOT NULL DEFAULT ''", "detail": "TEXT NOT NULL DEFAULT ''"})
        # Chaque session est un appareil (navigateur, app de bureau, téléphone), listé et révocable dans Réglages.
        _add_columns(db, "sessions", {"device": "TEXT NOT NULL DEFAULT ''", "platform": "TEXT NOT NULL DEFAULT 'web'",
                                      "created_at": "TEXT", "last_seen": "TEXT", "last_ip": "TEXT", "version": "TEXT"})
        # Quand le mot de passe de cette session a été vérifié pour la dernière fois (voir auth.proven_recently).
        _add_columns(db, "sessions", {"mdp_a": "REAL"})
        # Double vérification : `secret` scellé, `secours` les empreintes des codes de secours, `dernier_pas` le dernier code
        # consommé, `essais` les dates des codes faux récents (double_verification.py).
        db.execute("CREATE TABLE IF NOT EXISTS double_verification (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, "
                   "secret TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, dernier_pas INTEGER NOT NULL DEFAULT 0, "
                   "secours TEXT NOT NULL DEFAULT '[]', essais TEXT NOT NULL DEFAULT '[]')")
        # main = la conversation unique avec l'agent ; les autres sont des fils (ouverts par l'agent ou anciens).
        _add_columns(db, "conversations", {
            "main": "INTEGER NOT NULL DEFAULT 0",
            "archived": "INTEGER NOT NULL DEFAULT 0",
            "origin": "TEXT NOT NULL DEFAULT 'user'",
        })
        # Requêtes de chaque appel au modèle (budget du mois) et de chaque ouverture de conversation.
        db.execute("CREATE INDEX IF NOT EXISTS usage_created ON usage(created_at)")
        db.execute("CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id)")
        db.execute("CREATE INDEX IF NOT EXISTS conversations_agent ON conversations(agent_id)")
        # Abonnements Web Push : un par appareil, rattaché à sa session (déconnecter l'appareil coupe ses notifications).
        # Fichiers qu'un agent destine à un ordinateur éteint : le contenu dans DATA_DIR/attente, le temps de sa reconnexion.
        db.execute("CREATE TABLE IF NOT EXISTS desktop_attente (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, appareil TEXT NOT NULL, "
                   "agent TEXT NOT NULL, dossier TEXT NOT NULL, chemin TEXT NOT NULL, sha256 TEXT NOT NULL, taille INTEGER NOT NULL, "
                   "remplacer INTEGER NOT NULL DEFAULT 0, cree TEXT NOT NULL, expire TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, session TEXT NOT NULL, "
                   "p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT)")
        # Envois repris plus tard (service de push indisponible, Retry-After) : survivent à un redémarrage.
        db.execute("CREATE TABLE IF NOT EXISTS push_queue (id INTEGER PRIMARY KEY, endpoint TEXT NOT NULL, "
                   "session TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, payload BLOB NOT NULL, "
                   "urgent INTEGER NOT NULL DEFAULT 0, not_before REAL NOT NULL, tries INTEGER NOT NULL DEFAULT 0, "
                   "created REAL NOT NULL)")
        # Ce que chaque compte veut recevoir : `rappels` (demande, important, jamais), `coupes` les types éteints (notifications.py).
        db.execute("CREATE TABLE IF NOT EXISTS notification_prefs (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, "
                   "rappels TEXT NOT NULL DEFAULT 'demande', coupes TEXT NOT NULL DEFAULT '[]')")
        # Demandes entre agents : `chaine` liste les agents dont celle-ci descend (boucles et profondeur).
        db.execute("CREATE TABLE IF NOT EXISTS delegations (id TEXT PRIMARY KEY, de TEXT NOT NULL, vers TEXT NOT NULL, "
                   "conversation_id TEXT NOT NULL, profondeur INTEGER NOT NULL, chaine TEXT NOT NULL, "
                   "rappeler INTEGER NOT NULL DEFAULT 0, etat TEXT NOT NULL, consigne TEXT NOT NULL, created_at REAL NOT NULL)")
        _add_columns(db, "delegations", {"livre": "INTEGER NOT NULL DEFAULT 1"})  # 1 : les anciennes sont déjà arrivées
        db.execute("CREATE INDEX IF NOT EXISTS delegations_de ON delegations(de, created_at)")
        db.execute("CREATE INDEX IF NOT EXISTS delegations_vers ON delegations(vers, etat)")
        # Rappels vocaux : sonne, puis repondu, refuse ou manque.
        db.execute("CREATE TABLE IF NOT EXISTS voice_calls (id TEXT PRIMARY KEY, "
                   "agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, user_id INTEGER NOT NULL, "
                   "conversation_id TEXT NOT NULL, texte TEXT NOT NULL, etat TEXT NOT NULL, created_at REAL NOT NULL, ended_at REAL)")
        db.execute("CREATE INDEX IF NOT EXISTS voice_calls_user ON voice_calls(user_id, etat)")
        # Profils (G12) : un rôle et un plafond mensuel par compte, un propriétaire par agent, payeur de chaque dépense.
        # `usage.owner_id` survit à l'agent : supprimer un agent ne remet pas le compteur du mois à zéro.
        _add_columns(db, "users", {"role": "TEXT NOT NULL DEFAULT 'member'", "budget_monthly": "REAL"})
        _add_columns(db, "agents", {"owner_id": "INTEGER REFERENCES users(id)"})
        _add_columns(db, "usage", {"owner_id": "INTEGER"})
        # shared : l'auteur rend cette conversation lisible par ceux qui ont accès à l'agent.
        _add_columns(db, "conversations", {"shared": "INTEGER NOT NULL DEFAULT 0"})
        db.execute("CREATE TABLE IF NOT EXISTS agent_shares (agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, "
                   "user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
                   "droit TEXT NOT NULL CHECK (droit IN ('lecture', 'usage', 'admin')), "
                   "created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (agent_id, user_id))")
        db.execute("CREATE INDEX IF NOT EXISTS agent_shares_user ON agent_shares(user_id)")
        db.execute("CREATE INDEX IF NOT EXISTS usage_owner ON usage(owner_id, created_at)")
        # Mot de passe temporaire (premier compte choisi au déploiement, réinitialisation) : à changer avant toute autre chose.
        _add_columns(db, "users", {"a_changer": "INTEGER NOT NULL DEFAULT 0"})
        # Courriel de confirmation (courriel.py) : l'adresse d'un compte, les codes en empreinte, les envois de la dernière heure.
        db.execute("CREATE TABLE IF NOT EXISTS courriel_adresses (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, "
                   "adresse TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 0, en_attente TEXT NOT NULL DEFAULT '')")
        db.execute("CREATE TABLE IF NOT EXISTS courriel_codes (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
                   "action TEXT NOT NULL, session TEXT NOT NULL, empreinte TEXT NOT NULL, expire REAL NOT NULL, "
                   "essais INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, action))")
        db.execute("CREATE TABLE IF NOT EXISTS courriel_envois (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
                   "genre TEXT NOT NULL, quand REAL NOT NULL)")
        # Nouvel appareil (appareils.py) : les navigateurs reconnus, et les sessions signalées sur lesquelles personne n'a tranché.
        db.execute("CREATE TABLE IF NOT EXISTS appareils_connus (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
                   "empreinte TEXT NOT NULL, reseau TEXT NOT NULL, vu REAL NOT NULL, PRIMARY KEY (user_id, empreinte, reseau))")
        db.execute("CREATE TABLE IF NOT EXISTS alertes_appareils (id TEXT PRIMARY KEY, "
                   "user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
                   "session TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE, empreinte TEXT NOT NULL DEFAULT '', "
                   "nom TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'web', ip TEXT NOT NULL DEFAULT '', reseau TEXT NOT NULL DEFAULT '', "
                   "reseau_connu INTEGER NOT NULL DEFAULT 0, cree TEXT NOT NULL, tranche INTEGER NOT NULL DEFAULT 0)")
        # Outils branchés par l'utilisateur (G13) : `jeton` chiffré par seal(), `outils` la dernière liste connue du serveur.
        db.execute("CREATE TABLE IF NOT EXISTS mcp_tools (agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, "
                   "nom TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', "
                   "auth TEXT NOT NULL CHECK (auth IN ('aucune', 'jeton', 'oauth', 'catalogue')), jeton TEXT, "
                   "droit TEXT NOT NULL DEFAULT 'confirmer' CHECK (droit IN ('lire', 'agir', 'confirmer')), "
                   "outils TEXT NOT NULL DEFAULT '[]', etat TEXT NOT NULL DEFAULT '', erreur TEXT NOT NULL DEFAULT '', vu_a REAL, "
                   "created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (agent_id, nom))")
        # Une connexion « pour tous mes agents » (connecteurs.py) : à qui elle est, d'où elle vient, qui en est exclu. Jamais de jeton ici.
        db.execute("CREATE TABLE IF NOT EXISTS connecteurs_globaux (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
                   "nom TEXT NOT NULL, genre TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, exclus TEXT NOT NULL DEFAULT '[]', "
                   "partages_ok TEXT NOT NULL DEFAULT '[]', poses TEXT NOT NULL DEFAULT '[]', created_at REAL NOT NULL, "
                   "PRIMARY KEY (user_id, nom))")
        # Les connexions à des sites que la personne a choisi de retenir (coffre.py) : `secret` scellé par seal(), hors de portée de l'agent.
        db.execute("CREATE TABLE IF NOT EXISTS agent_logins (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, "
                   "origine TEXT NOT NULL, secret TEXT NOT NULL, created_at REAL NOT NULL, used_at REAL)")
        # Ce qui est parti par l'API d'une plateforme : un même post ne repart pas deux fois (publication.py).
        # Sans lien vers l'agent : le post reste en ligne après sa suppression, et un autre agent peut tenir le même compte.
        db.execute("CREATE TABLE IF NOT EXISTS publications (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, "
                   "plateforme TEXT NOT NULL, empreinte TEXT NOT NULL, etat TEXT NOT NULL, lien TEXT NOT NULL DEFAULT '', at REAL NOT NULL)")
        # Ce qu'ont coûté les images générées sur l'heure écoulée : le plafond d'un post survit à un redémarrage (media.py).
        db.execute("CREATE TABLE IF NOT EXISTS image_spend (agent_id TEXT NOT NULL, cost REAL NOT NULL, at REAL NOT NULL)")
        # Ce que l'agent a fait, lisible par la personne : ses tâches et les accords donnés (onglet Activité).
        db.execute("CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, "
                   "conversation_id TEXT NOT NULL, kind TEXT NOT NULL, titre TEXT NOT NULL, resultat TEXT NOT NULL DEFAULT '', etat TEXT NOT NULL, at REAL NOT NULL)")
        db.execute("CREATE INDEX IF NOT EXISTS journal_agent ON journal(agent_id, at)")
        # Objectifs d'un compte (proactif.py) : pour un de ses agents, ou pour tous (agent_id vide).
        db.execute("CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
                   "agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE, texte TEXT NOT NULL, "
                   "etat TEXT NOT NULL DEFAULT 'actif' CHECK (etat IN ('actif', 'fait')), cree REAL NOT NULL, fait_a REAL)")
        db.execute("CREATE INDEX IF NOT EXISTS goals_user ON goals(user_id, etat)")
        # Ce que chaque agent regarde de lui-même : `mode` vide = le défaut, `seen` les empreintes déjà vues par source (proactif.py).
        db.execute("CREATE TABLE IF NOT EXISTS proactive (agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE, mode TEXT, "
                   "minutes INTEGER NOT NULL DEFAULT 30, seen TEXT NOT NULL DEFAULT '{}', last_pass REAL NOT NULL DEFAULT 0, "
                   "last_error TEXT NOT NULL DEFAULT '', passes INTEGER NOT NULL DEFAULT 0, signals INTEGER NOT NULL DEFAULT 0, "
                   "decision_cost REAL NOT NULL DEFAULT 0, brain_cost REAL NOT NULL DEFAULT 0, "
                   "proposal_day TEXT NOT NULL DEFAULT '', proposals TEXT NOT NULL DEFAULT '[]')")
        # Chaque tour lancé de lui-même : son fil et le mode qui valait alors, lisible par ce qui juge ses actions.
        db.execute("CREATE TABLE IF NOT EXISTS proactive_turns (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, "
                   "conversation_id TEXT NOT NULL, mode TEXT NOT NULL, titre TEXT NOT NULL, etat TEXT NOT NULL, at REAL NOT NULL)")
        db.execute("CREATE INDEX IF NOT EXISTS proactive_turns_agent ON proactive_turns(agent_id, at)")
        db.execute("CREATE INDEX IF NOT EXISTS publications_empreinte ON publications(plateforme, empreinte, at)")
        _adopt(db)
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS users_one_owner ON users(role) WHERE role = 'owner'")
        db.commit()  # le changement de journal ne se fait pas au milieu d'une transaction
        # WAL : les lectures ne bloquent plus pendant une écriture (flux de chat et relais en parallèle).
        db.execute("PRAGMA journal_mode = WAL")


def _adopt(db) -> None:
    """Installation d'avant les profils (ou sauvegarde restaurée) : le premier compte devient propriétaire, et ce qui
    n'a pas de propriétaire lui revient. Rejoué à chaque démarrage : une mise à jour annulée a pu écrire sans ces colonnes."""
    db.execute("UPDATE users SET role = 'owner' WHERE id = (SELECT MIN(id) FROM users) "
               "AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'owner')")
    row = db.execute("SELECT id FROM users WHERE role = 'owner'").fetchone()
    if row:
        db.execute("UPDATE agents SET owner_id = ? WHERE owner_id IS NULL", (row["id"],))
        db.execute("UPDATE usage SET owner_id = COALESCE((SELECT owner_id FROM agents a WHERE a.id = usage.agent_id), ?) "
                   "WHERE owner_id IS NULL", (row["id"],))


def owner_id() -> int | None:
    """Le propriétaire de l'installation."""
    with connect() as db:
        row = db.execute("SELECT id FROM users ORDER BY role = 'owner' DESC, id LIMIT 1").fetchone()
    return row["id"] if row else None


def agent_owner(agent_id: str) -> int | None:
    """Le compte à qui appartient cet agent. Une base migrée a toujours `owner_id` ; sans lui, celui de ses conversations."""
    with connect() as db:
        row = db.execute("SELECT owner_id FROM agents WHERE id = ?", (agent_id,)).fetchone()
        if row and row["owner_id"] is not None:
            return row["owner_id"]
        row = db.execute("SELECT user_id FROM conversations WHERE agent_id = ? ORDER BY main DESC, updated_at DESC LIMIT 1",
                         (agent_id,)).fetchone()
    return row["user_id"] if row else None


def _add_columns(db, table: str, wanted: dict[str, str]) -> None:
    have = {r["name"] for r in db.execute(f"PRAGMA table_info({table})")}
    for name, decl in wanted.items():
        if name not in have:
            db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


@contextmanager
def connect():
    db = sqlite3.connect(DATA_DIR / "noah.db")
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA synchronous = NORMAL")
    try:
        yield db
        db.commit()
    finally:
        db.close()


def seal(value: str) -> str:
    return _fernet.encrypt(value.encode()).decode()


def unseal(value: str) -> str:
    return _fernet.decrypt(value.encode()).decode()


def get_setting(key: str, secret: bool = False) -> str | None:
    with connect() as db:
        row = db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    if not row:
        return None
    return _fernet.decrypt(row["value"].encode()).decode() if secret else row["value"]


def set_setting(key: str, value: str, secret: bool = False) -> None:
    if secret:
        value = _fernet.encrypt(value.encode()).decode()
    with connect() as db:
        db.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
