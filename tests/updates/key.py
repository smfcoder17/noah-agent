"""Clé de signature jetable pour les tests (base64 de la clé privée Ed25519 brute)."""
import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

raw = Ed25519PrivateKey.generate().private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                                 serialization.NoEncryption())
print(base64.b64encode(raw).decode())
