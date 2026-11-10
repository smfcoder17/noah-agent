"""À lancer dans le conteneur Python : python /repo/tests/exposition/safefetch_test.py."""
import sys
import unittest
from unittest.mock import patch, MagicMock
sys.path.insert(0, "/repo/server")
sys.path.insert(0, "/app")
from noah import safefetch


def dns(ip):
    return [(2, 1, 6, "", (ip, 443))]


class SafeFetchTest(unittest.TestCase):
    def test_private_metadata_ipv6_and_credentials(self):
        for ip in ("127.0.0.1", "169.254.169.254", "10.0.0.1", "::1", "::ffff:127.0.0.1", "100.64.0.1", "0.0.0.0", "64:ff9b::7f00:1", "2002:7f00:1::"):
            with self.subTest(ip=ip), patch.object(safefetch.socket, "getaddrinfo", return_value=dns(ip)):
                with self.assertRaises(safefetch.UnsafeURL):
                    safefetch.resolve("https://exemple.org/")
        for url in ("file:///etc/passwd", "https://moi:secret@exemple.org", "http://exemple.org:8080", "http://exemple.org\\@localhost"):
            with self.assertRaises(safefetch.UnsafeURL):
                safefetch.resolve(url)

    def test_rebinding_connects_only_to_validated_ip(self):
        conn = MagicMock()
        conn.getresponse.return_value.status = 200
        conn.getresponse.return_value.getheader.side_effect = lambda name, default="": {"Content-Type": "text/html"}.get(name, default)
        conn.getresponse.return_value.read1.side_effect = [b"ok", b""]
        with patch.object(safefetch.socket, "getaddrinfo", side_effect=[dns("93.184.216.34"), dns("127.0.0.1")]) as lookup, patch.object(safefetch.socket, "create_connection") as connect, patch.object(safefetch.http.client, "HTTPConnection", return_value=conn):
            self.assertEqual(safefetch.fetch("http://exemple.org").body, b"ok")
            self.assertEqual(lookup.call_count, 1)
            self.assertEqual(connect.call_args.args[0], ("93.184.216.34", 80))

    def test_redirect_revalidates_dns(self):
        conn = MagicMock()
        conn.getresponse.return_value.status = 302
        conn.getresponse.return_value.getheader.return_value = "http://interne/"
        with patch.object(safefetch.socket, "getaddrinfo", side_effect=[dns("93.184.216.34"), dns("169.254.169.254")]), patch.object(safefetch.socket, "create_connection"), patch.object(safefetch.http.client, "HTTPConnection", return_value=conn):
            with self.assertRaises(safefetch.UnsafeURL):
                safefetch.fetch("http://exemple.org")


if __name__ == "__main__":
    unittest.main()
