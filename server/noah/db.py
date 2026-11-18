import base64
import hashlib
import json
import sqlite3
import time
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
CREATE TABLE IF NOT EXISTS accords (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conv_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('attend', 'donne', 'refuse', 'expire', 'annule')),
  created REAL NOT NULL,
  answered_by TEXT,
  answered_at REAL,
  UNIQUE(agent_id, run_id, request_id, generation)
);
CREATE INDEX IF NOT EXISTS accords_user ON accords(user_id, state, created);
CREATE TABLE IF NOT EXISTS evenements_revisions (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS evenements (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  genre TEXT NOT NULL,
  contenu TEXT NOT NULL,
  created REAL NOT NULL,
  PRIMARY KEY (user_id, revision)
);
CREATE INDEX IF NOT EXISTS evenements_created ON evenements(created);
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
        # Réponse de l'agent : le modèle qui l'a écrite (relay.turn_model). Vide pour les anciens messages et ce que Noah écrit seul.
        _add_columns(db, "messages", {"model": "TEXT"})
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
        _add_columns(db, "desktop_attente", {"agent_id": "TEXT", "conv_id": "TEXT"})
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
        # Routines d'un modèle d'agent, en pause dans Noah tant que la personne ne les active pas (presets.py) : hors du cron d'Hermes.
        db.execute("CREATE TABLE IF NOT EXISTS routines_suggerees (id INTEGER PRIMARY KEY AUTOINCREMENT, "
                   "agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, nom TEXT NOT NULL, quand TEXT NOT NULL, "
                   "horaire TEXT NOT NULL, consigne TEXT NOT NULL, cree REAL NOT NULL)")
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
        # 0.2.0 : heures actives, plafond de propositions par jour, briefing du matin ; un tour coupé se reprend une fois (`reprise`).
        _add_columns(db, "proactive", {"heures_de": "INTEGER NOT NULL DEFAULT 8", "heures_a": "INTEGER NOT NULL DEFAULT 21",
                                       "propositions_max": "INTEGER NOT NULL DEFAULT 3", "briefing_day": "TEXT NOT NULL DEFAULT ''",
                                       "briefing_at": "REAL NOT NULL DEFAULT 0",
                                       # une note « plafond atteint » par jour au plus ; l'idée du jour qui échoue attend (1 h, 4 h, demain)
                                       "plafond_dit": "TEXT NOT NULL DEFAULT ''", "idee_echecs": "INTEGER NOT NULL DEFAULT 0",
                                       "idee_echec_jour": "TEXT NOT NULL DEFAULT ''", "idee_reessai": "REAL NOT NULL DEFAULT 0"})
        _add_columns(db, "proactive_turns", {"reprise": "INTEGER NOT NULL DEFAULT 0"})
        # Passage à la 0.2.0 : les agents déjà là passent tous à « Me signaler » d'un coup. Le jour du passage (24 h à partir de
        # cette heure), une proposition par compte au plus, sans point du matin ni premier relevé (proactif.py). Écrit une fois :
        # « 0 » pour une installation neuve, qui n'a rien à calmer.
        if not db.execute("SELECT 1 FROM settings WHERE key = 'migr_020'").fetchone():
            had = db.execute("SELECT 1 FROM agents LIMIT 1").fetchone()
            db.execute("INSERT INTO settings (key, value) VALUES ('migr_020', ?)", (repr(time.time()) if had else "0",))
        # Ce qu'un agent propose de lui-même (propositions.py) : `demande` part telle quelle à l'agent si la personne dit « Fais-le ».
        db.execute("CREATE TABLE IF NOT EXISTS propositions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, "
                   "owner INTEGER, genre TEXT NOT NULL, texte TEXT NOT NULL, demande TEXT NOT NULL, "
                   "etat TEXT NOT NULL DEFAULT 'ouverte' CHECK (etat IN ('ouverte', 'faite', 'refusee', 'expiree')), "
                   "jour TEXT NOT NULL, conversation_id TEXT, message_id INTEGER, created REAL NOT NULL, repondu REAL)")
        db.execute("CREATE INDEX IF NOT EXISTS propositions_owner ON propositions(owner, etat)")
        db.execute("CREATE INDEX IF NOT EXISTS propositions_agent ON propositions(agent_id, jour)")
        db.execute("CREATE INDEX IF NOT EXISTS publications_empreinte ON publications(plateforme, empreinte, at)")
        _adopt(db)
        # 0.3.0 : le coffre appartient à la personne (coffre.py), partagé par ses agents selon un droit par agent.
        db.execute("CREATE TABLE IF NOT EXISTS coffre (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
                   "genre TEXT NOT NULL DEFAULT 'login' CHECK (genre IN ('login', 'carte', 'totp')), nom TEXT NOT NULL DEFAULT '', "
                   "origine TEXT NOT NULL DEFAULT '', secret TEXT NOT NULL, created_at REAL NOT NULL, used_at REAL)")
        db.execute("CREATE INDEX IF NOT EXISTS coffre_user ON coffre(user_id, genre)")
        db.execute("CREATE TABLE IF NOT EXISTS coffre_agents (agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE, "
                   "utiliser INTEGER NOT NULL)")
        # « Retirer de cet agent » (Connexions) : cet agent ne s'en sert plus, l'élément reste dans le coffre de la personne.
        db.execute("CREATE TABLE IF NOT EXISTS coffre_retraits (agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, "
                   "coffre_id TEXT NOT NULL REFERENCES coffre(id) ON DELETE CASCADE, PRIMARY KEY (agent_id, coffre_id))")
        _migrate_logins(db)
        # 0.4.0. Une tâche : un travail qu'un agent fait pour la personne, pour un autre agent, de lui-même ou pour une routine.
        # Elle se replie dans le fil de l'agent (`fil_id`, sa conversation principale pour ce compte), juste après le message `ancre`.
        # `conversation_id` garde ses échanges et sa session Hermes : c'est l'ancienne sous-conversation, jamais listée.
        # `trace_id` : l'ancienne ligne de trace que la tâche remplace à l'écran. `source_id` : la ligne d'origine
        # (delegations.id, proactive_turns.id, id de routine). `migree` : créée par la reprise des anciennes sous-conversations.
        db.execute("CREATE TABLE IF NOT EXISTS taches (id TEXT PRIMARY KEY, "
                   "owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
                   "agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, "
                   "fil_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, "
                   "conversation_id TEXT UNIQUE REFERENCES conversations(id) ON DELETE CASCADE, "
                   "genre TEXT NOT NULL CHECK (genre IN ('demande', 'fil', 'initiative', 'sous_tache', 'routine', 'discussion')), "
                   "demandeur TEXT NOT NULL DEFAULT '', parent_id TEXT, "
                   "titre TEXT NOT NULL, titre_source TEXT NOT NULL DEFAULT 'auto' CHECK (titre_source IN ('auto', 'modele', 'personne')), "
                   "consigne TEXT NOT NULL DEFAULT '', "
                   "etat TEXT NOT NULL DEFAULT 'encours' CHECK (etat IN ('encours', 'attend', 'fini', 'echec')), "
                   "resume TEXT NOT NULL DEFAULT '', fichiers TEXT NOT NULL DEFAULT '[]', "
                   "ancre INTEGER NOT NULL DEFAULT 0, trace_id INTEGER, source_id TEXT NOT NULL DEFAULT '', "
                   "cree REAL NOT NULL, fini_a REAL, maj REAL NOT NULL, migree INTEGER NOT NULL DEFAULT 0)")
        db.execute("CREATE INDEX IF NOT EXISTS taches_fil ON taches(fil_id, ancre)")
        db.execute("CREATE INDEX IF NOT EXISTS taches_owner ON taches(owner_id, etat, maj)")
        db.execute("CREATE INDEX IF NOT EXISTS taches_agent ON taches(agent_id, cree)")
        db.execute("CREATE INDEX IF NOT EXISTS taches_parent ON taches(parent_id)")
        # Une question posée pendant un travail (X4). `de` : l'agent qui demande. `a` : qui doit répondre maintenant
        # (un id d'agent, ou vide = la personne). `chemin` : la liste JSON de ceux qui l'ont eue en main, dans l'ordre.
        # `reserve` : un sujet que seule la personne tranche ; la question ne passe alors par aucun agent.
        # `repondu_par` : 'personne', un id d'agent, ou 'regle:<id>' quand une règle retenue a répondu.
        # Une réponse d'agent est une « décision prise pour toi » (X35) ; `correction` : ce que la personne a rectifié ensuite.
        db.execute("CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, "
                   "owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
                   "tache_id TEXT REFERENCES taches(id) ON DELETE CASCADE, "
                   "conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, "
                   "de TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, a TEXT NOT NULL DEFAULT '', "
                   "genre TEXT NOT NULL DEFAULT 'question' CHECK (genre IN ('question', 'choix')), "
                   "titre TEXT NOT NULL, pourquoi TEXT NOT NULL DEFAULT '', choix TEXT NOT NULL DEFAULT '[]', "
                   "libre INTEGER NOT NULL DEFAULT 1, "
                   "reserve TEXT NOT NULL DEFAULT '' CHECK (reserve IN ('', 'payer', 'supprimer', 'secrets', 'publier')), "
                   "chemin TEXT NOT NULL DEFAULT '[]', tours INTEGER NOT NULL DEFAULT 0, "
                   "etat TEXT NOT NULL DEFAULT 'attend' CHECK (etat IN ('attend', 'repondue', 'annulee', 'expiree')), "
                   "reponse TEXT NOT NULL DEFAULT '', repondu_par TEXT NOT NULL DEFAULT '', repondu_a REAL, "
                   "correction TEXT NOT NULL DEFAULT '', corrige_a REAL, regle_id TEXT, "
                   "message_id INTEGER, cree REAL NOT NULL, maj REAL NOT NULL)")
        db.execute("CREATE INDEX IF NOT EXISTS questions_owner ON questions(owner_id, etat, a)")
        db.execute("CREATE INDEX IF NOT EXISTS questions_tache ON questions(tache_id, cree)")
        db.execute("CREATE INDEX IF NOT EXISTS questions_decidees ON questions(owner_id, repondu_a)")
        # Ce que la personne a tranché une fois et qui vaut ensuite (X35) : sa correction d'une réponse donnée par un agent.
        # `agent_id` vide : la règle vaut pour tous ses agents. `servie` : le nombre de fois où elle a répondu à sa place.
        db.execute("CREATE TABLE IF NOT EXISTS regles (id TEXT PRIMARY KEY, "
                   "owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
                   "agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE, "
                   "question_id TEXT REFERENCES questions(id) ON DELETE SET NULL, "
                   "sujet TEXT NOT NULL, texte TEXT NOT NULL, "
                   "etat TEXT NOT NULL DEFAULT 'active' CHECK (etat IN ('active', 'retiree')), "
                   "cree REAL NOT NULL, servie INTEGER NOT NULL DEFAULT 0, servie_a REAL)")
        db.execute("CREATE INDEX IF NOT EXISTS regles_owner ON regles(owner_id, etat)")
        # Chaque passage d'une routine, gardé hors du fil (X6). Relevé par machine.deliver_routines_once.
        # `fichier` : l'horodatage du fichier de sortie d'Hermes ; avec la routine, il rend le relevé rejouable sans doublon.
        # `amene` : la personne a amené ce résultat dans le fil.
        db.execute("CREATE TABLE IF NOT EXISTS routine_passages (id INTEGER PRIMARY KEY AUTOINCREMENT, "
                   "agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, routine_id TEXT NOT NULL, nom TEXT NOT NULL, "
                   "fichier TEXT NOT NULL, etat TEXT NOT NULL CHECK (etat IN ('ok', 'err')), "
                   "resume TEXT NOT NULL DEFAULT '', rendu TEXT NOT NULL DEFAULT '', erreur TEXT NOT NULL DEFAULT '', "
                   "duree REAL, passe_a REAL NOT NULL, amene INTEGER NOT NULL DEFAULT 0, "
                   "UNIQUE(agent_id, routine_id, fichier))")
        db.execute("CREATE INDEX IF NOT EXISTS routine_passages_agent ON routine_passages(agent_id, passe_a)")
        # Jusqu'où chaque compte a vu les passages d'un agent : le voyant d'Activité et « passées depuis ta dernière visite ».
        db.execute("CREATE TABLE IF NOT EXISTS routine_vues (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
                   "agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, vu_a REAL NOT NULL DEFAULT 0, "
                   "PRIMARY KEY (user_id, agent_id))")
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


def _migrate_logins(db) -> None:
    """Les identifiants retenus par agent (avant 0.3.0) passent au coffre de son propriétaire : même id (le handle que l'agent
    connaît), même secret scellé, mêmes dates. Un même compte (propriétaire, origine, identifiant) ne garde que sa ligne la plus
    récente. Aucun droit n'est écrit : celui d'office vaut (allumé pour un agent à lui seul, éteint pour un agent partagé, ce que
    Réglages > Coffre montre au propriétaire), et la migration ne donne jamais tout le coffre à un agent partagé.
    Une ligne dont l'agent n'a pas de propriétaire va à celui de l'installation ; sans aucun compte, elle attend le démarrage suivant."""
    rows = db.execute("SELECT l.id, l.agent_id, l.origine, l.secret, l.created_at, l.used_at, a.owner_id FROM agent_logins l "
                      "JOIN agents a ON a.id = l.agent_id ORDER BY l.created_at, l.id").fetchall()
    installation = db.execute("SELECT id FROM users ORDER BY role = 'owner' DESC, id LIMIT 1").fetchone()

    def identifier(secret: str):
        try:
            return json.loads(unseal(secret)).get("identifiant")
        except Exception:  # noqa: BLE001 - illisible : la ligne passe telle quelle, sans être rapprochée d'une autre
            return None

    def recent(r) -> float:
        return max(r["used_at"] or 0, r["created_at"] or 0)

    for row in rows:
        user = row["owner_id"] if row["owner_id"] is not None else (installation["id"] if installation else None)
        if user is None:
            continue
        who = identifier(row["secret"])
        twin = next((r for r in db.execute("SELECT id, secret, created_at, used_at FROM coffre WHERE user_id = ? AND genre = 'login' AND origine = ? AND id != ?",
                                           (user, row["origine"], row["id"])).fetchall() if who is not None and identifier(r["secret"]) == who), None)
        if twin is not None and recent(twin) >= recent(row):
            db.execute("DELETE FROM agent_logins WHERE id = ?", (row["id"],))  # le même compte, déjà là et plus récent
            continue
        if twin is not None:
            db.execute("DELETE FROM coffre WHERE id = ?", (twin["id"],))
        db.execute("INSERT OR IGNORE INTO coffre (id, user_id, genre, nom, origine, secret, created_at, used_at) VALUES (?, ?, 'login', '', ?, ?, ?, ?)",
                   (row["id"], user, row["origine"], row["secret"], row["created_at"], row["used_at"]))
        if db.execute("SELECT 1 FROM coffre WHERE id = ? AND secret = ?", (row["id"], row["secret"])).fetchone():
            db.execute("DELETE FROM agent_logins WHERE id = ?", (row["id"],))


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
