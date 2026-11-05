## Installer Noah Agent {{VERSION}}

| Tu veux | Télécharge | Ce que tu fais ensuite |
|---|---|---|
| **Le faire tourner sur ton VPS** | [docker-compose.yml](https://github.com/smfcoder17/noah-agent/releases/download/{{TAG}}/docker-compose.yml) | Déploie-le, puis ouvre le lien affiché dans les journaux. [Les étapes](https://github.com/smfcoder17/noah-agent#installer-sur-un-vps) |
| **L'application Windows** | [noah-agent-windows-setup.exe](https://github.com/smfcoder17/noah-agent/releases/download/{{TAG}}/noah-agent-windows-setup.exe) | Lance le fichier, puis « Sur mon serveur ». Elle n'est pas signée : Windows peut afficher un avertissement. |
| **L'application Android** | [noah-agent-android.apk](https://github.com/smfcoder17/noah-agent/releases/download/{{TAG}}/noah-agent-android.apk) | Ouvre le fichier sur le téléphone, autorise l'installation, puis scanne le QR code de Réglages > Appareils. |

Sur iPhone, Mac ou Linux, il n'y a rien à télécharger : ouvre l'adresse de ton Noah dans le navigateur.

**Noah est déjà sur ton serveur ?** Il se met à jour seul, à l'heure calme. Tu peux le voir dans Réglages > Mises à jour. Les applications, elles, se réinstallent avec ces fichiers. Ton compte et tes agents sont sur le serveur : ils ne bougent pas.

## Ce qui change

{{CHANGEMENTS}}

---

Les autres fichiers ne sont pas pour toi. `manifest.json` et `manifest.json.sig` servent aux serveurs déjà installés : c'est ainsi qu'ils vérifient la version.
