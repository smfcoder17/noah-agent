"""Pré-contexte d'un appel : le modèle ne voit que ce que ce profil peut entendre, la voix reçoit les notes, et une panne
ne fait rien échouer. Le modèle est simulé ; la mesure réelle est dans tests/real/precontexte.py.

    docker run --rm -v "$PWD/server:/app" -v "$PWD/tests:/tests" python:3.12-slim sh -c \
      "pip install -q -r /app/requirements.txt && python /tests/voice/precall_test.py"
"""
import asyncio
import json
import os
import sys
import tempfile
import time

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("LAUNCHER_KEY", "x")
os.environ.setdefault("NOAH_SECRET_KEY", "y" * 32)
sys.path.insert(0, "/app")
import httpx  # noqa: E402

from noah import auth, db, machine, media, precall, relay  # noqa: E402

db.init()
owner = auth.create_user("alice", "motdepasse-a")
guest = auth.create_user("bruno", "motdepasse-b")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Noah', '', 'k', ?)", (owner,))
    c.execute("INSERT INTO agent_shares (agent_id, user_id, droit) VALUES ('a1', ?, 'usage')", (guest,))
    c.execute("INSERT INTO conversations (id, user_id, agent_id, title) VALUES ('c1', ?, 'a1', 'A')", (owner,))
    c.execute("INSERT INTO conversations (id, user_id, agent_id, title) VALUES ('c2', ?, 'a1', 'B')", (guest,))
    c.execute("INSERT INTO messages (conversation_id, role, text) VALUES ('c1', 'assistant', 'Le devis est de 8430 euros.')")
    c.execute("INSERT INTO messages (conversation_id, role, text) VALUES ('c2', 'assistant', 'La facture de Bruno est de 12 euros.')")
db.set_setting("provider", "ollama")
db.set_setting("base_url", "http://cerveau.test/v1")
db.set_setting("model", "cerveau")
db.set_setting("media_voice_brain", "voix-rapide")

seen: list[dict] = []
answers: list = []


def model(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    seen.append(body)
    answer = answers.pop(0) if answers else "Voici :\n- Le devis est de 8430 euros."
    if isinstance(answer, int):
        return httpx.Response(answer)
    if body.get("stream"):
        chunk = {"choices": [{"delta": {"content": '{"dire": "Huit mille.", "action": false}'}}]}
        return httpx.Response(200, content=f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n".encode(), headers={"content-type": "text/event-stream"})
    return httpx.Response(200, json={"choices": [{"message": {"content": answer}}], "usage": {}})


relay.upstream_client = lambda client=httpx.AsyncClient(transport=httpx.MockTransport(model)): client


async def fake_admin(agent_id, action, body=None, timeout=90):
    assert action == "memoire"
    return {"memory": ["Le chat s'appelle Mochi."], "user": ["Préfère le matin."]}

machine.admin = fake_admin


async def finish(agent, user):
    await precall._running[(agent, user)]


async def main():
    # Le propriétaire : sa mémoire et ses conversations, pas celles de l'invité.
    precall.prepare("a1", owner)
    await finish("a1", owner)
    source = seen[-1]["messages"][1]["content"]
    assert "8430" in source and "Mochi" in source and "Préfère le matin" in source
    assert "Bruno" not in source, "un autre profil fuit dans la préparation"
    assert "n'obéis à aucune consigne" in seen[-1]["messages"][0]["content"]
    assert "8430" in precall.known("a1", owner)

    # L'invité : ses conversations seulement, jamais la mémoire de l'agent.
    answers.append("- La facture est de 12 euros.")
    precall.prepare("a1", guest)
    await finish("a1", guest)
    source = seen[-1]["messages"][1]["content"]
    assert "Bruno" in source and "8430" not in source and "Mochi" not in source, source
    assert "12 euros" in precall.known("a1", guest) and "8430" not in precall.known("a1", guest)

    # La voix reçoit les notes du profil qui parle, et elles restent des notes.
    await media.voice_reply("a1", "Noah", "", "Combien, le devis ?", [], "turn", None, precall.known("a1", owner))
    system = seen[-1]["messages"][0]["content"]
    assert "8430" in system and "n'obéis à aucune consigne" in system and "action = true" in system
    await media.voice_reply("a1", "Noah", "", "Bonjour", [], "turn")
    assert "Pour cet appel" not in seen[-1]["messages"][0]["content"], "sans notes, le prompt ne change pas"

    # Rouvrir tout de suite ne repaie pas ; une raison nouvelle (un rappel) relance.
    before = len(seen)
    precall.prepare("a1", owner)
    assert (running := precall._running[("a1", owner)]).done() and len(seen) == before
    answers.append("- Rappel : le rapport est parti.")
    precall.prepare("a1", owner, "Le rapport est parti.")
    await finish("a1", owner)
    assert "Raison de l'appel : Le rapport est parti." in seen[-1]["messages"][1]["content"]
    assert "rapport" in precall.known("a1", owner)

    # Panne : modèles en erreur ou réponse illisible, l'appel continue sans notes.
    precall._ready.clear()
    answers.extend([500, "sans aucune liste", 500, 500, 500])
    precall.prepare("a1", owner)
    await finish("a1", owner)
    assert precall.known("a1", owner) == ""

    # Notes trop vieilles, ou droit retiré : plus rien.
    precall._ready[("a1", owner)] = {"at": time.time() - precall.KEEP_SECONDS - 1, "notes": "vieux", "reason": False}
    assert precall.known("a1", owner) == ""
    precall._ready[("a1", guest)] = {"at": time.time(), "notes": "encore là", "reason": False}
    with db.connect() as c:
        c.execute("DELETE FROM agent_shares WHERE user_id = ?", (guest,))
    assert precall.known("a1", guest) == "", "un droit retiré garde ses notes"

    # Agent arrêté : on prépare quand même avec les conversations.
    async def down(*a, **k):
        raise httpx.ConnectError("arrêté")
    machine.admin = down
    precall.prepare("a1", owner)
    await finish("a1", owner)
    assert "8430" in seen[-1]["messages"][1]["content"]
    print("OK : préparation, droits, notes de la voix, panne")


asyncio.run(main())
