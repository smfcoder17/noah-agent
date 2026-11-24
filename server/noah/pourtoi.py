"""« Pour toi » ne garde que ce qui attend encore : ce qui est passé disparaît, au démarrage et chaque minute (pas seulement à l'affichage).

Ce que liste /api/a-toi, type par type, et quand l'élément est passé :

| Type                               | Passé quand                                                                              | Où il reste lisible        |
|------------------------------------|------------------------------------------------------------------------------------------|----------------------------|
| proposition d'un agent             | l'heure ou le jour qu'elle nomme est passé (propositions.echeance), sinon 3 jours       | Activité, « expirée »       |
| question d'un agent (et ses choix) | 48 h sans réponse ; sa tâche est finie ou en échec ; un choix : la personne a écrit après | la ligne, avec son état     |
| question d'un sujet réservé        | comme ci-dessus, mais 7 jours (payer, supprimer pour toujours, secrets et droits, publier) | la ligne, avec son état     |
| choix resté dans une conversation  | sa question est close, ou la conversation n'a pas bougé depuis 48 h                      | la conversation             |
| accord (autoriser / refuser)       | 5 minutes, ou son tour est fini : déjà géré par accords.sweep, chaque seconde            | l'historique des accords    |
| connexion, code demandé            | son délai propre (coffre), ou la tâche s'est arrêtée : géré par coffre._sweep            | rien : l'agent le sait      |
| appel de l'agent (étape à toi)     | rendue ou refusée, ou 1 h sans réponse : géré par handoff                                | rien                        |
| échec du modèle de décision        | le modèle a changé, ou 3 jours (il revient s'il échoue encore)                           | rien : l'échec revient seul |

Un accord, une connexion et une question réservée comptent tant que leur tâche attend : le paiement ou l'accord de sécurité ne
disparaît pas en silence avant son délai, et il garde son état (« expirée », « annulée ») pour qui le cherche.
Le compteur de la barre de gauche relit /api/a-toi : il suit sans autre règle.
"""
import asyncio
import time

from . import bus, db, decision, propositions, questions

CHOIX_JOURS = 2  # un choix dont la question n'existe plus : au bout de 48 h sans mouvement dans la conversation
PERIODE = 60  # secondes entre deux nettoyages


def _choix_passes(now: float) -> int:
    """Une conversation restée « choice » alors que son choix est clos ou que plus rien ne bouge : elle n'attend plus personne."""
    from . import main
    done = 0
    for conv, state in list(main.task_state.items()):
        if state != "choice":
            continue
        with db.connect() as c:
            open_ = c.execute("SELECT 1 FROM questions WHERE conversation_id = ? AND etat = 'attend'", (conv,)).fetchone()
            closed = c.execute("SELECT 1 FROM questions WHERE conversation_id = ? AND genre = 'choix'", (conv,)).fetchone()
            row = c.execute("SELECT CAST(strftime('%s', updated_at) AS REAL) AS maj FROM conversations WHERE id = ?", (conv,)).fetchone()
        gone = row is None or (not open_ and (closed or now - (row["maj"] or 0) > CHOIX_JOURS * 86400))
        if gone:
            main.task_state[conv] = "done"
            done += 1
    return done


def sweep(now: float | None = None) -> int:
    """Sort de « Pour toi » ce qui est passé. Rend le nombre d'éléments sortis."""
    now = now or time.time()
    out = propositions.sweep(now) + questions.sweep(now) + _choix_passes(now) + decision.sweep_failure(now)
    if out:
        bus.invalidate_all()
    return out


async def keep_clean() -> None:
    while True:
        await asyncio.sleep(PERIODE)
        try:
            sweep()
        except Exception as e:  # noqa: BLE001 - le nettoyage ne doit jamais arrêter le serveur
            print(f"[pourtoi] {type(e).__name__} : {e}", flush=True)
