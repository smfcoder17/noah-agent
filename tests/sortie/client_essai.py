"""Le « navigateur » de tests/sortie/docker_test.sh : un CONNECT par l'aiguillage vers le faux site, puis une requête dans le tunnel.
Affiche l'adresse que le faux site a vue, ou « refus <code> » quand l'aiguillage répond autre chose que 200.

    python client_essai.py <aiguillage> <hote> <port>"""
import socket
import sys

proxy, host, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
s = socket.create_connection((proxy, 3128), timeout=15)
s.sendall(f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n".encode())
head = b""
while b"\r\n\r\n" not in head:
    chunk = s.recv(4096)
    if not chunk:
        break
    head += chunk
code = head.split(b" ")[1].decode() if b" " in head else "?"
if code != "200":
    print(f"refus {code}")
    sys.exit(0)
s.sendall(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
body = b""
while chunk := s.recv(4096):
    body += chunk
print(body.split(b"\r\n\r\n", 1)[-1].decode())
