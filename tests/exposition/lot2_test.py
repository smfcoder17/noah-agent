"""Lot 2 : préférences isolées par compte, bus durable, aperçus nettoyés, clés et favicon.
Docker : python /repo/tests/exposition/lot2_test.py (requirements serveur installés).
"""
import os
import asyncio
import http.client
import json
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

os.environ["NOAH_DATA_DIR"] = tempfile.mkdtemp()
os.environ.setdefault("NOAH_SECRET_KEY", "lot2-test-" + "x" * 32)
os.environ.setdefault("LAUNCHER_KEY", "test")
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "server"))
from fastapi import FastAPI, Request, Response
from fastapi.testclient import TestClient
from noah import auth, bus, catalog, connexion, db, linkpreview, providers, push, relay, safefetch, sensitive, ui_preferences

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
        with patch.object(catalog, "models_for", new=AsyncMock(return_value=[{"id": "modele"}])):
            self.assertNotIn("cle-provisoire-de-test", client.get("/api/fournisseurs", headers=ha).text)
        self.assertEqual(client.put("/api/fournisseurs/openai", headers=hb, json={"api_key": "x"}).status_code, 403)
        with patch.object(safefetch, "fetch", side_effect=safefetch.UnsafeURL("privé")):
            self.assertIsNone(catalog.provider_icon("http://127.0.0.1/v1"))

    def test_01_session_absente_et_resolution_unique(self):
        from noah import main
        async def request(token):
            scope = {"type": "http", "method": "POST", "path": "/api/essai", "headers": [(b"x-noah-timezone", b"Europe/Paris")], "query_string": b""}
            with patch.object(auth, "request_token", return_value=token) as extract, \
                 patch.object(auth, "owner_of", return_value=alice) as owner, \
                 patch.object(main.access, "is_owner", return_value=True), \
                 patch.object(main.updates, "saw_client"), patch.object(bus, "invalidate") as invalidate:
                result = await main.same_origin_only(Request(scope), AsyncMock(return_value=Response(status_code=200)))
                self.assertEqual(result.status_code, 200)
                self.assertEqual(extract.call_count, 1)
                self.assertEqual(owner.call_count, 1 if token else 0)
                if token:
                    invalidate.assert_called_once_with(alice)
                else:
                    invalidate.assert_not_called()
        asyncio.run(request(None))
        asyncio.run(request("session-test"))

    def test_02_reponses_http_malformees_refusees_partout(self):
        for failure in (http.client.BadStatusLine("invalide"), http.client.LineTooLong("en-tête"), http.client.IncompleteRead(b"x", 10)):
            conn = MagicMock()
            conn.getresponse.side_effect = failure
            with self.subTest(failure=type(failure).__name__), \
                 patch.object(safefetch, "resolve", return_value=("http", "exemple.org", 80, "93.184.216.34", "/")), \
                 patch.object(safefetch.socket, "create_connection"), \
                 patch.object(safefetch.http.client, "HTTPConnection", return_value=conn):
                with self.assertRaises(safefetch.UnsafeURL):
                    safefetch.fetch("http://exemple.org/")
                linkpreview._cache.clear()
                self.assertEqual(client.post("/api/liens/apercu", headers=ha, json={"url": "http://exemple.org/"}).status_code, 400)
                self.assertEqual(client.post("/api/liens/media", headers=ha, json={"url": "http://exemple.org/image"}).status_code, 400)
                self.assertIsNone(catalog.provider_icon("http://exemple.org/v1"))
                self.assertTrue(conn.close.called)

    def test_03_requete_voix_vers_adresse_personnalisee(self):
        import httpx
        relay_app = FastAPI()
        relay_app.include_router(relay.router)
        settings = {"provider": "custom", "base_url": "https://voix.exemple.org/v1", "api_key": "cle-test"}
        upstream = MagicMock()
        upstream.post = AsyncMock(return_value=httpx.Response(200, content=b"audio-test", headers={"content-type": "audio/mpeg"}))
        with patch.object(relay, "_agent_from", return_value="a"), patch.object(relay, "_task_of", return_value=None), \
             patch.object(db, "get_setting", side_effect=lambda key, **kw: settings.get(key)), \
             patch.object(relay, "spending_refusal", return_value=None), patch.object(relay, "upstream_client", return_value=upstream), \
             patch.object(relay, "_note_status"), patch.object(relay, "_record", new=AsyncMock()):
            result = TestClient(relay_app).post("/relay/v1/audio/speech", json={"model": "voix", "input": "Bonjour"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.content, b"audio-test")
        self.assertEqual(upstream.post.call_args.args[0], "https://voix.exemple.org/v1/audio/speech")
        self.assertEqual(relay.upstream_base("ollama", "https://machine.exemple.org"), "https://machine.exemple.org/v1")

    def test_04_catalogues_directs_uniquement_modeles_a_outils(self):
        import httpx
        data = {"data": [{"id": "chat", "capabilities": {"function_calling": True}},
                         {"id": "embedding", "capabilities": {"function_calling": False}}, {"id": "inconnu"}]}
        async def check():
            for provider in ("mistral", "deepseek"):
                response = httpx.Response(200, json=data, request=httpx.Request("GET", "https://exemple.org/models"))
                with patch.object(catalog, "price_index", new=AsyncMock(return_value={})), \
                     patch.object(httpx.AsyncClient, "get", new=AsyncMock(return_value=response)):
                    models = await catalog.models_for(provider, "test")
                self.assertEqual([m["id"] for m in models], ["chat"])
                self.assertEqual(models[0]["lab"], provider)
            # DeepSeek n'annonce pas ses capacités : le catalogue connu fournit la preuve.
            data["data"] = [{"id": "deepseek-chat"}, {"id": "deepseek-embedding"}]
            response = httpx.Response(200, json=data, request=httpx.Request("GET", "https://exemple.org/models"))
            with patch.object(catalog, "price_index", new=AsyncMock(return_value={"deepseekchat": {"tools": True}})), \
                 patch.object(httpx.AsyncClient, "get", new=AsyncMock(return_value=response)):
                self.assertEqual([m["id"] for m in await catalog.models_for("deepseek", "test")], ["deepseek-chat"])
        asyncio.run(check())

    def test_05_send_masque_extra_selon_le_compte(self):
        session = auth.new_session(alice, "push-test", "web")
        key = auth.session_key(session)
        endpoint = "https://ntfy.sh/lot2-test"
        with db.connect() as c:
            c.execute("INSERT OR REPLACE INTO push_subscriptions (endpoint, session, p256dh, auth) VALUES (?, ?, ?, ?)", (endpoint, key, "test", "test"))
        extra = {"titre": "contournement marc@gmail.com", "nested": [{"mail": "marc@gmail.com", "card": "4111 1111 1111 1111"}], "nombre": 3}
        for hidden in (True, False):
            db.set_setting(f"ui:{alice}", json.dumps({**ui_preferences.defaults(), "masquer_sensibles": hidden}))
            delivered = AsyncMock(return_value="livre")
            with patch.object(push, "_send_one", new=delivered):
                result = asyncio.run(push.send("Salut marc@gmail.com", "+1 514 555 1242", user_id=alice, extra=extra))
            self.assertEqual(result["livres"], 1)
            payload = json.loads(delivered.call_args.args[2])
            self.assertEqual(payload["masquer_sensibles"], hidden)
            self.assertTrue(payload["titre"].startswith("Salut"))
            self.assertEqual(payload["nombre"], 3)
            for value in ("marc@gmail.com", "4111 1111 1111 1111", "+1 514 555 1242"):
                self.assertEqual(value in json.dumps(payload), not hidden)
        self.assertEqual(extra["nested"][0]["mail"], "marc@gmail.com")
        with db.connect() as c:
            c.execute("DELETE FROM push_subscriptions WHERE endpoint=?", (endpoint,))

    def test_06_route_compte_modeles_du_fournisseur_principal(self):
        with patch.object(providers, "connected", side_effect=lambda p: p == "openrouter"), \
             patch.object(providers, "key_of", return_value="test"), \
             patch.object(catalog, "models_for", new=AsyncMock(return_value=[{"id": "un"}, {"id": "deux"}])) as models:
            rows = client.get("/api/fournisseurs", headers=ha).json()
        self.assertEqual(next(r for r in rows if r["id"] == "openrouter")["models"], 2)
        self.assertEqual(db.get_setting("provider_count:openrouter"), "2")
        models.assert_awaited_once()

    def test_07_connexion_signale_seulement_son_compte(self):
        before = bus.replay(bob, None)[0]
        before_alice = bus.replay(alice, None)[0]
        login = {"finish": AsyncMock(), "user": alice, "agent": "a", "nom": "test"}
        self.assertTrue(asyncio.run(connexion._quietly(login, {"code": "test"})))
        self.assertEqual(bus.replay(bob, None)[0], before)
        self.assertGreater(bus.replay(alice, None)[0], before_alice)
        login["user"] = None
        before_alice = bus.replay(alice, None)[0]
        self.assertTrue(asyncio.run(connexion._quietly(login, {})))
        self.assertEqual(bus.replay(alice, None)[0], before_alice)

    def test_08_cache_ne_rend_aucune_image_expulsee(self):
        linkpreview._cache.clear()
        linkpreview._images.clear()
        def fetch(url, **kwargs):
            if url.endswith(".png") or url.endswith(".ico"):
                return safefetch.Result(url, "image/png", b"\x89PNG\r\n\x1a\n" + url.encode())
            return safefetch.Result(url, "text/html", b'<title>Titre</title><meta property="og:image" content="image.png">')
        with patch.object(safefetch, "fetch", side_effect=fetch) as read, patch.object(linkpreview, "MAX_IMAGES", 4):
            first = linkpreview.preview("https://un.exemple.org/")
            linkpreview.preview("https://deux.exemple.org/")
            linkpreview.preview("https://trois.exemple.org/")
            self.assertNotIn("https://un.exemple.org/", linkpreview._cache)
            count = read.call_count
            renewed = linkpreview.preview("https://un.exemple.org/")
            self.assertGreater(read.call_count, count)
            self.assertEqual(first["title"], renewed["title"])
            for _, cached in linkpreview._cache.values():
                for field in ("image", "icon"):
                    if cached[field]:
                        self.assertIn(cached[field].rsplit("/", 1)[-1], linkpreview._images)
            for field in ("image", "icon"):
                self.assertEqual(client.get(renewed[field], headers=ha).status_code, 200)

    def test_15_deux_patchs_concurrents_ne_perdent_rien(self):
        for _ in range(10):
            db.set_setting(f"ui:{alice}", json.dumps(ui_preferences.defaults()))
            ready = threading.Barrier(2)
            def write(patch):
                ready.wait(timeout=5)
                return client.put("/api/me/interface", headers=ha, json=patch)
            with ThreadPoolExecutor(max_workers=2) as pool:
                responses = list(pool.map(write, [{"tabs": ["chat", "files"], "masquer_sensibles": False}, {"theme": "dark", "texte": "grand"}]))
            self.assertTrue(all(r.status_code == 200 for r in responses))
            self.assertEqual(ui_preferences.read(alice), {"tabs": ["chat", "files"], "masquer_sensibles": False, "theme": "dark", "texte": "grand"})


if __name__ == "__main__":
    unittest.main()
