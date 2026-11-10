"""Lot 2 : préférences isolées par compte, bus durable, aperçus nettoyés, clés et favicon.
Docker : python /repo/tests/exposition/lot2_test.py (requirements serveur installés).
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("NOAH_SECRET_KEY", "lot2-test-" + "x" * 32)
os.environ.setdefault("LAUNCHER_KEY", "test")
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "server"))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from noah import auth, bus, catalog, db, linkpreview, providers, safefetch, sensitive, ui_preferences

db.init()
alice = auth.create_user("alice", "mot-de-passe-alice")
bob = auth.create_user("bob", "mot-de-passe-bob")
app = FastAPI()
app.include_router(ui_preferences.router)
app.include_router(linkpreview.router)
app.include_router(providers.router)
client = TestClient(app)
ha = {"Authorization": "Bearer " + auth.new_session(alice, "Alice", "web")}
hb = {"Authorization": "Bearer " + auth.new_session(bob, "Bob", "android")}


class Lot2(unittest.TestCase):
    def test_discussion_creee_dans_le_bon_compte(self):
        from fastapi import HTTPException
        from noah import main
        with db.connect() as c:
            c.execute("INSERT INTO agents (id, name, api_key, owner_id) VALUES (?, ?, ?, ?)", ("discussion-test", "Noah", "cle-test", alice))
        made = main.create_discussion("discussion-test", alice)
        with db.connect() as c:
            row = c.execute("SELECT user_id, main FROM conversations WHERE id=?", (made["id"],)).fetchone()
        self.assertEqual(row["user_id"], alice)
        self.assertEqual(row["main"], 0)
        with self.assertRaises(HTTPException):
            main.create_discussion("discussion-test", bob)

    def test_notifications_masquees(self):
        value = sensitive.mask("marc@gmail.com +1 514 555 1242 4111 1111 1111 1111")
        self.assertNotIn("marc@gmail.com", value)
        self.assertNotIn("4111 1111 1111 1111", value)
        self.assertNotIn("+1 514 555 1242", value)

    def test_preferences_par_compte(self):
        self.assertEqual(client.put("/api/me/interface", headers=ha, json={"tabs": ["chat", "computer", "files"], "masquer_sensibles": False}).status_code, 200)
        self.assertEqual(client.get("/api/me/interface", headers=ha).json()["tabs"], ["chat", "computer", "files"])
        self.assertTrue(client.get("/api/me/interface", headers=hb).json()["masquer_sensibles"])
        for tabs in (["files"], ["chat", "chat"], ["chat", "__proto__"]):
            self.assertEqual(client.put("/api/me/interface", headers=ha, json={"tabs": tabs}).status_code, 400)
        self.assertEqual(client.get("/api/me/interface").status_code, 401)

    def test_revision_apres_coupure_de_dix_minutes(self):
        with db.connect() as c:
            revision = bus.publish(c, alice, "donnees.changees", {})
            c.execute("UPDATE evenements SET created = created - 600 WHERE user_id = ?", (alice,))
        current, gap, rows = bus.replay(alice, revision - 1)
        self.assertEqual(current, revision)
        self.assertTrue(gap)
        self.assertEqual(rows, [])
        bus.invalidate_all()
        for user in (alice, bob):
            current, gap, rows = bus.replay(user, None)
            self.assertGreater(current, 0)
        with db.connect() as c:
            self.assertEqual(c.execute("SELECT contenu FROM evenements WHERE user_id=? ORDER BY revision DESC", (bob,)).fetchone()[0], "{}")

    def test_open_graph_et_oembed_sans_script(self):
        linkpreview._cache.clear()
        page = b'<title>Repli</title><meta property="og:title" content="&lt;b&gt;Titre&lt;/b&gt;&lt;script&gt;vol()&lt;/script&gt;"><meta property="og:image" content="/image.png"><link rel="alternate" type="application/json+oembed" href="/embed">'
        def fetch(url, **kwargs):
            if url.endswith("image.png") or url.endswith("favicon.ico"):
                return safefetch.Result(url, "image/png", b"\x89PNG\r\n\x1a\nimage")
            if url.endswith("/embed"):
                return safefetch.Result(url, "application/json", b'{"duration": 42, "html": "<script>vol()</script>"}')
            return safefetch.Result(url, "text/html", page)
        with patch.object(safefetch, "fetch", side_effect=fetch) as read:
            result = linkpreview.preview("https://exemple.org/")
            self.assertEqual(result["title"], "Titre")
            self.assertEqual(result["duration"], 42)
            self.assertNotIn("html", result)
            self.assertTrue(result["image"].startswith("/api/liens/image/"))
            count = read.call_count
            linkpreview.preview("https://exemple.org/")
            self.assertEqual(read.call_count, count)
        with patch.object(safefetch, "fetch", side_effect=safefetch.UnsafeURL("privé")):
            self.assertEqual(client.post("/api/liens/apercu", headers=ha, json={"url": "http://127.0.0.1/"}).status_code, 400)

    def test_fournisseur_cle_chiffree_et_acces(self):
        with patch.object(catalog, "models_for", new=AsyncMock(return_value=[{"id": "modele"}])), patch.object(catalog, "check_key", new=AsyncMock()):
            response = client.put("/api/fournisseurs/openai", headers=ha, json={"api_key": "cle-provisoire-de-test"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(providers.key_of("openai"), "cle-provisoire-de-test")
        self.assertNotIn("cle-provisoire-de-test", db.get_setting("provider_key:openai"))
        self.assertNotIn("cle-provisoire-de-test", client.get("/api/fournisseurs", headers=ha).text)
        self.assertEqual(client.put("/api/fournisseurs/openai", headers=hb, json={"api_key": "x"}).status_code, 403)
        with patch.object(safefetch, "fetch", side_effect=safefetch.UnsafeURL("privé")):
            self.assertIsNone(catalog.provider_icon("http://127.0.0.1/v1"))


if __name__ == "__main__":
    unittest.main()
