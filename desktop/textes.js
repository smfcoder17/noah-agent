// Textes que la personne lit dans l'app de bureau (fenêtres, menus, zone de notification, boîtes, notifications, écran de
// connexion, bandeau d'accord), en français et en anglais. Français si le système est en français, anglais sinon.
// Chargé par le processus principal (require) et par setup.html (<script>, window.NoahTextes). Ce qui part au serveur
// (résultats des actions, journaux, clés de config) n'est pas ici : il reste en français.
(function (racine, fabrique) {
  if (typeof module === "object" && module.exports) module.exports = fabrique();
  else racine.NoahTextes = fabrique();
})(typeof self !== "undefined" ? self : this, function () {
  const fr = {
    // Menus et zone de notification
    "menu.demarrage": "Lancer Noah au démarrage de l'ordinateur",
    "menu.autonomie": "Autonomie de cet ordinateur",
    "menu.autonomie.auto": "Auto — agir dans les dossiers confiés",
    "menu.autonomie.prudent": "Prudent — demander avant d'écrire ou ranger",
    "menu.ouvrir": "Ouvrir Noah Agent",
    "menu.accord": "Voir l'accord en attente",
    "menu.changer": "Changer de serveur…",
    "menu.couper_acces": "Couper l'accès de l'agent",
    "menu.quitter": "Quitter",
    "menu.masquer": "Masquer Noah Agent",
    "menu.quitter_noah": "Quitter Noah Agent",
    "menu.fichier": "Fichier",
    "menu.fermer": "Fermer la fenêtre",
    "menu.edition": "Édition",
    "menu.annuler": "Annuler",
    "menu.retablir": "Rétablir",
    "menu.couper": "Couper",
    "menu.copier": "Copier",
    "menu.coller": "Coller",
    "menu.tout": "Tout sélectionner",
    "menu.affichage": "Affichage",
    "menu.recharger": "Recharger",
    "menu.agrandir": "Agrandir",
    "menu.reduire": "Réduire",
    "menu.taille_normale": "Taille normale",
    "menu.plein_ecran": "Plein écran",
    "menu.copier_lien": "Copier le lien",
    "zone.coupe": "Noah Agent — accès de l'agent coupé",
    "bulle.titre": "Noah Agent reste ouvert",
    "bulle.texte": "Tes routines continuent. Pour quitter : clic droit sur cette icône, Quitter.",
    // Démarrage et connexion
    "commun.annuler": "Annuler",
    "commun.reessayer": "Réessayer",
    "demarrage.attente": "Démarrage…",
    "accueil.dossier.titre": "Où est installé Noah Agent ?",
    "accueil.dossier.message": "Choisis le dossier qui contient docker-compose.yml (celui créé par install.sh).",
    "accueil.dossier.erreur": "Ce dossier ne contient pas Noah Agent (docker-compose.yml introuvable).",
    "connexion.http": "Ton serveur était relié en http (non chiffré). Relie-le en https, puis déconnecte l'ancienne session dans Réglages → Appareils.",
    "connexion.en_cours": "Connexion à ton serveur…",
    "connexion.injoignable": "Ton serveur ({serveur}) ne répond pas. Nouvel essai automatique toutes les 5 secondes…",
    "connexion.perdue": "Connexion au serveur perdue. Reconnexion automatique…",
    "connexion.adresse": "Indique une adresse en https:// (exemple : https://noah.exemple.com). Le http n'est accepté que sur ton réseau local.",
    "connexion.trousseau": "Le trousseau du système n'est pas disponible : impossible de ranger la session en sécurité. Sous Linux, installe et déverrouille GNOME Keyring (gnome-keyring) ou KWallet, puis relance l'app.",
    "connexion.refus": "Le serveur a refusé ({statut}).",
    "connexion.joindre": "Impossible de joindre {serveur}. Vérifie l'adresse.",
    "connexion.reponse": "Réponse inattendue du serveur.",
    "appareil.nom": "Ordinateur {nom}",
    "appairage.annule": "Appairage annulé.",
    "appairage.refuse": "Demande refusée ou expirée. Recommence.",
    "appairage.nombre": "Ce nombre ne correspond pas à celui du navigateur. Recommence.",
    "appairage.ancienne": "Cette version de l'app est trop ancienne pour ton serveur Noah : mets-la à jour.",
    "appairage.delai": "Pas d'accord dans les 20 minutes. Recommence.",
    "serveur.changer.titre": "Changer de serveur",
    "serveur.changer.message": "Relier cette app à un autre Noah ?",
    "serveur.changer.detail": "Cet ordinateur sera déconnecté du Noah actuel. Tes agents et leurs données ne bougent pas.",
    "serveur.changer.bouton": "Changer",
    "affichage.plante": "L'affichage de Noah s'est arrêté plusieurs fois de suite. Tes agents continuent sur le serveur.",
    "fige.message": "Noah ne répond plus.",
    "fige.detail": "Tu peux recharger la fenêtre, ou attendre encore un peu.",
    "fige.attendre": "Attendre",
    "session.titre": "Session non révoquée",
    "session.message": "Cet ordinateur n'a pas pu se déconnecter de ton serveur Noah.",
    "session.detail": "Sans trousseau système ni réseau, la session ne peut pas être gardée pour plus tard. Sur un autre appareil, ouvre Réglages → Appareils et déconnecte cet ordinateur.",
    "session.compris": "Compris",
    // Noah sur cet ordinateur (noah.js)
    "local.docker": "Vérification de Docker…",
    "local.docker_arrete": "Docker n'est pas démarré. Ouvre Docker Desktop, puis réessaie.",
    "local.demarrage": "Démarrage de Noah…",
    "local.reveil": "Noah se réveille…",
    "local.muet": "Noah ne répond pas. Regarde « docker compose logs server » dans le dossier de Noah.",
    // Dossiers confiés
    "acces.rendre.message": "Rendre l'accès à l'agent ?",
    "acces.rendre.detail": "Il pourra de nouveau lire et écrire dans les dossiers confiés, et demander à agir sur cet ordinateur.",
    "acces.rendre.bouton": "Rendre l'accès",
    "dossier.choisir": "Dossier à confier à Noah",
    "dossier.ajouter": "Dossier à confier à ton agent",
    "dossier.refuse.message": "Ce dossier ne se confie pas.",
    "dossier.refuse.detail": "Ni un disque entier, ni un dossier de clés. Choisis un dossier précis.",
    "dossier.confier.message": "Confier « {nom} » à tes agents, en lecture seule ?",
    "dossier.confier.personnel": "C'est tout ton dossier personnel : mieux vaut un dossier précis.",
    "dossier.confier.detail": "Tes agents pourront le lire quand l'application est ouverte. Ce qu'ils lisent passe par le modèle que tu as choisi. Les fichiers sensibles (.env, clés, mots de passe, profils de navigateur) restent refusés.",
    "dossier.confier.bouton": "Confier",
    "dossier.ecrire.message": "Permettre à tes agents d'écrire dans « {nom} » ?",
    "dossier.ecrire.detail": "Ils y créent des documents sans te demander. Ils ne remplacent jamais un fichier sans ton accord.",
    "dossier.ecrire.bouton": "Permettre",
    // Fichiers de l'agent (fichiers.js)
    "fichier.erreur": "Ce fichier n'a pas pu être récupéré.",
    "fichier.ouvrir": "Ouvrir",
    "fichier.ouvrir_avec": "Ouvrir avec…",
    "fichier.finder": "Afficher dans le Finder",
    "fichier.dossier": "Afficher dans le dossier",
    "fichier.trop_de_noms": "Trop de fichiers portent ce nom.",
    "fichier.statut": "Le serveur a répondu {statut}.",
    "fichier.trop_gros": "Fichier trop gros.",
    // Demandes d'accord (actions.js, dossiers.js), montrées dans le bandeau
    "accord.autoriser": "Autoriser",
    "accord.refuser": "Refuser",
    "accord.toujours": "Toujours autoriser cette commande",
    "accord.presse_papiers": "{agent} veut remplacer le contenu de ton presse-papiers.",
    "accord.page": "{agent} veut ouvrir une page dans ton navigateur.",
    "accord.ouvrir_dossier": "{agent} veut ouvrir un dossier.",
    "accord.ouvrir_fichier": "{agent} veut ouvrir un fichier.",
    "accord.application": "{agent} veut ouvrir l'application « {nom} ».",
    "accord.application.detail": "Programme : {programme}\nArguments : {arguments}\nApplication : {nom}",
    "accord.commande": "{agent} veut exécuter une commande.",
    "accord.commande.detail": "Dans : {dossier}\nProgramme : {programme}\nArguments : {arguments}\nCe dossier n'enferme pas la commande : elle a les mêmes droits que toi sur tout l'ordinateur.\n\nCommande :\n{commande}",
    "accord.ecrire": "{agent} veut écrire un fichier.",
    "accord.deplacer": "{agent} veut déplacer un élément.",
    "accord.corbeille": "{agent} veut mettre un élément à la corbeille.",
    "accord.creer_dossier": "{agent} veut créer un dossier.",
    "accord.fichiers.detail": "Dossier : {dossier}\nChemin : {chemin}",
    "accord.fichiers.detail_vers": "Dossier : {dossier}\nChemin : {chemin}\nVers : {vers}",
    "accord.remplacer": "Un agent veut remplacer un fichier de « {nom} ».",
    "accord.remplacer.detail": "{chemin}\n\nL'ancien contenu sera perdu. Sans ton accord, une copie est créée à côté.",
    // Bandeau d'accord (bandeau.html, bandeau.js)
    "bandeau.page": "Accord sur cet ordinateur — Noah",
    "bandeau.titre": "Accord sur cet ordinateur",
    "bandeau.detail": "Action exacte à vérifier",
    "bandeau.boutons": "Répondre à la demande",
    "bandeau.raccourcis": "Ctrl + Alt + A : autoriser une fois · Ctrl + Alt + R : refuser. Expire après 4 min 40.",
    "bandeau.notif.titre": "Noah attend ton accord",
    "bandeau.notif.texte": "Ouvre Noah pour vérifier l'action sur ton ordinateur.",
    // Écran du premier lancement (setup.html, setup.js)
    "setup.bienvenue": "Bienvenue sur Noah Agent",
    "setup.question": "Où vit ton agent ?",
    "setup.serveur.titre": "Sur mon serveur",
    "setup.serveur.texte": "Un VPS où Noah tourne 24 h/24. Ton ordinateur, ton téléphone et le web parlent au même agent.",
    "setup.local.titre": "Sur cet ordinateur",
    "setup.local.texte": "Noah tourne ici avec Docker Desktop. Il s'arrête quand l'ordinateur s'éteint.",
    "setup.consigne": "Saisis l'adresse de ton Noah. Ton navigateur s'ouvre : connecte-toi si besoin, puis clique « Autoriser cet appareil ».",
    "setup.adresse": "Adresse de ton serveur",
    "setup.adresse.exemple": "https://noah.exemple.com",
    "setup.code": "Code (Réglages → Appareils → « Relier un appareil »)",
    "setup.avec_code": "J'ai un code à la place",
    "setup.avec_navigateur": "Autoriser depuis le navigateur à la place",
    "setup.nombre": "Nombre affiché dans le navigateur, après « Autoriser »",
    "setup.retour": "Retour",
    "setup.relier": "Relier",
    "setup.nombre.demande": "Autorise dans le navigateur, puis saisis le nombre ici",
    "setup.attente.verification": "Sur l'appareil déjà relié, accepte cet ordinateur et saisis le nombre {nombre}",
    "setup.attente": "En attente de ton accord…",
    "setup.attente.navigateur": "En attente de ton accord dans le navigateur…",
    "setup.connexion": "Connexion…",
  };

  const en = {
    "menu.demarrage": "Start Noah when your computer starts",
    "menu.autonomie": "Autonomy on this computer",
    "menu.autonomie.auto": "Auto — act in the folders you've shared",
    "menu.autonomie.prudent": "Careful — ask before writing or tidying up",
    "menu.ouvrir": "Open Noah Agent",
    "menu.accord": "See pending approval",
    "menu.changer": "Change server…",
    "menu.couper_acces": "Cut off agent access",
    "menu.quitter": "Quit",
    "menu.masquer": "Hide Noah Agent",
    "menu.quitter_noah": "Quit Noah Agent",
    "menu.fichier": "File",
    "menu.fermer": "Close window",
    "menu.edition": "Edit",
    "menu.annuler": "Undo",
    "menu.retablir": "Redo",
    "menu.couper": "Cut",
    "menu.copier": "Copy",
    "menu.coller": "Paste",
    "menu.tout": "Select all",
    "menu.affichage": "View",
    "menu.recharger": "Reload",
    "menu.agrandir": "Zoom in",
    "menu.reduire": "Zoom out",
    "menu.taille_normale": "Actual size",
    "menu.plein_ecran": "Full screen",
    "menu.copier_lien": "Copy link",
    "zone.coupe": "Noah Agent — agent access cut off",
    "bulle.titre": "Noah Agent is still running",
    "bulle.texte": "Your routines keep running. To quit, right-click this icon and choose Quit.",
    "commun.annuler": "Cancel",
    "commun.reessayer": "Try again",
    "demarrage.attente": "Starting…",
    "accueil.dossier.titre": "Where is Noah Agent installed?",
    "accueil.dossier.message": "Choose the folder that contains docker-compose.yml (the one install.sh created).",
    "accueil.dossier.erreur": "This folder doesn't contain Noah Agent (docker-compose.yml not found).",
    "connexion.http": "Your server was linked over http (unencrypted). Link it over https, then sign out the old session in Settings → Devices.",
    "connexion.en_cours": "Connecting to your server…",
    "connexion.injoignable": "Your server ({serveur}) isn't responding. Trying again automatically every 5 seconds…",
    "connexion.perdue": "Lost connection to the server. Reconnecting automatically…",
    "connexion.adresse": "Enter an https:// address (for example: https://noah.example.com). http is only accepted on your local network.",
    "connexion.trousseau": "Your system keychain isn't available, so the session can't be stored securely. On Linux, install and unlock GNOME Keyring (gnome-keyring) or KWallet, then restart the app.",
    "connexion.refus": "The server refused ({statut}).",
    "connexion.joindre": "Can't reach {serveur}. Check the address.",
    "connexion.reponse": "Unexpected response from the server.",
    "appareil.nom": "Computer {nom}",
    "appairage.annule": "Linking canceled.",
    "appairage.refuse": "Request declined or expired. Start over.",
    "appairage.nombre": "This number doesn't match the one in your browser. Start over.",
    "appairage.ancienne": "This version of the app is too old for your Noah server. Please update it.",
    "appairage.delai": "No approval within 20 minutes. Start over.",
    "serveur.changer.titre": "Change server",
    "serveur.changer.message": "Link this app to a different Noah?",
    "serveur.changer.detail": "This computer will be signed out of your current Noah. Your agents and their data stay where they are.",
    "serveur.changer.bouton": "Change",
    "affichage.plante": "Noah's display stopped several times in a row. Your agents keep running on the server.",
    "fige.message": "Noah isn't responding.",
    "fige.detail": "You can reload the window, or wait a little longer.",
    "fige.attendre": "Wait",
    "session.titre": "Session not revoked",
    "session.message": "This computer couldn't sign out of your Noah server.",
    "session.detail": "Without a system keychain or a network connection, the session can't be kept for later. On another device, open Settings → Devices and sign out this computer.",
    "session.compris": "Got it",
    "local.docker": "Checking Docker…",
    "local.docker_arrete": "Docker isn't running. Open Docker Desktop, then try again.",
    "local.demarrage": "Starting Noah…",
    "local.reveil": "Noah is waking up…",
    "local.muet": "Noah isn't responding. Check “docker compose logs server” in Noah's folder.",
    "acces.rendre.message": "Give the agent access again?",
    "acces.rendre.detail": "It will be able to read and write in the folders you've shared again, and ask to act on this computer.",
    "acces.rendre.bouton": "Give access",
    "dossier.choisir": "Folder to share with Noah",
    "dossier.ajouter": "Folder to share with your agent",
    "dossier.refuse.message": "This folder can't be shared.",
    "dossier.refuse.detail": "Not a whole drive, and not a folder of keys. Choose a specific folder.",
    "dossier.confier.message": "Share “{nom}” with your agents, read-only?",
    "dossier.confier.personnel": "This is your entire home folder. A specific folder is better.",
    "dossier.confier.detail": "Your agents can read it while the app is open. What they read goes through the model you chose. Sensitive files (.env, keys, passwords, browser profiles) stay off-limits.",
    "dossier.confier.bouton": "Share",
    "dossier.ecrire.message": "Allow your agents to write in “{nom}”?",
    "dossier.ecrire.detail": "They'll create documents there without asking you. They never replace a file without your approval.",
    "dossier.ecrire.bouton": "Allow",
    "fichier.erreur": "This file couldn't be retrieved.",
    "fichier.ouvrir": "Open",
    "fichier.ouvrir_avec": "Open with…",
    "fichier.finder": "Show in Finder",
    "fichier.dossier": "Show in folder",
    "fichier.trop_de_noms": "Too many files have this name.",
    "fichier.statut": "The server responded {statut}.",
    "fichier.trop_gros": "File too large.",
    "accord.autoriser": "Allow",
    "accord.refuser": "Decline",
    "accord.toujours": "Always allow this command",
    "accord.presse_papiers": "{agent} wants to replace what's on your clipboard.",
    "accord.page": "{agent} wants to open a page in your browser.",
    "accord.ouvrir_dossier": "{agent} wants to open a folder.",
    "accord.ouvrir_fichier": "{agent} wants to open a file.",
    "accord.application": "{agent} wants to open the “{nom}” app.",
    "accord.application.detail": "Program: {programme}\nArguments: {arguments}\nApp: {nom}",
    "accord.commande": "{agent} wants to run a command.",
    "accord.commande.detail": "In: {dossier}\nProgram: {programme}\nArguments: {arguments}\nThis folder doesn't confine the command: it has the same permissions as you across the whole computer.\n\nCommand:\n{commande}",
    "accord.ecrire": "{agent} wants to write a file.",
    "accord.deplacer": "{agent} wants to move an item.",
    "accord.corbeille": "{agent} wants to move an item to the trash.",
    "accord.creer_dossier": "{agent} wants to create a folder.",
    "accord.fichiers.detail": "Folder: {dossier}\nPath: {chemin}",
    "accord.fichiers.detail_vers": "Folder: {dossier}\nPath: {chemin}\nTo: {vers}",
    "accord.remplacer": "An agent wants to replace a file in “{nom}”.",
    "accord.remplacer.detail": "{chemin}\n\nThe old content will be lost. Without your approval, a copy is created next to it.",
    "bandeau.page": "Approval on this computer — Noah",
    "bandeau.titre": "Approval on this computer",
    "bandeau.detail": "Exact action to review",
    "bandeau.boutons": "Respond to the request",
    "bandeau.raccourcis": "Ctrl + Alt + A: allow once · Ctrl + Alt + R: decline. Expires after 4 min 40 s.",
    "bandeau.notif.titre": "Noah needs your approval",
    "bandeau.notif.texte": "Open Noah to review the action on your computer.",
    "setup.bienvenue": "Welcome to Noah Agent",
    "setup.question": "Where does your agent live?",
    "setup.serveur.titre": "On my server",
    "setup.serveur.texte": "A VPS where Noah runs around the clock. Your computer, your phone, and the web all talk to the same agent.",
    "setup.local.titre": "On this computer",
    "setup.local.texte": "Noah runs here with Docker Desktop. It stops when your computer turns off.",
    "setup.consigne": "Enter your Noah's address. Your browser will open: sign in if needed, then click “Allow this device”.",
    "setup.adresse": "Your server address",
    "setup.adresse.exemple": "https://noah.example.com",
    "setup.code": "Code (Settings → Devices → “Link a device”)",
    "setup.avec_code": "I have a code instead",
    "setup.avec_navigateur": "Allow from the browser instead",
    "setup.nombre": "Number shown in the browser after “Allow”",
    "setup.retour": "Back",
    "setup.relier": "Link",
    "setup.nombre.demande": "Allow in the browser, then enter the number here",
    "setup.attente.verification": "On your already linked device, approve this computer and enter the number {nombre}",
    "setup.attente": "Waiting for your approval…",
    "setup.attente.navigateur": "Waiting for your approval in the browser…",
    "setup.connexion": "Connecting…",
  };

  const dictionnaires = { fr, en };
  /** « fr » pour toute variante du français (fr-CA, fr_BE…), « en » pour tout le reste. */
  const normaliser = (code) => (/^fr\b|^fr[-_]/i.test(String(code || "")) ? "fr" : "en");

  let choisie = null;
  /** Langue du système, lue une fois côté principal. Sans Electron (tests en Node), français. */
  function langue() {
    if (choisie) return choisie;
    if (typeof require !== "function") {
      // Page locale (setup.html) : la langue de Chromium, qui suit celle de l'app, en attendant celle du preload.
      return typeof navigator !== "undefined" && navigator.language ? normaliser(navigator.language) : "fr";
    }
    let app = null;
    try {
      const electron = require("electron");
      app = electron && typeof electron === "object" ? electron.app : null;
    } catch { /* Node sans Electron (tests) */ }
    if (!app) return (choisie = "fr"); // jamais navigator.language ici : Node 22 l'a aussi, sans rapport avec l'app
    let code = "";
    try {
      code = (typeof app.getLocale === "function" && app.getLocale())
        || (typeof app.getPreferredSystemLanguages === "function" && (app.getPreferredSystemLanguages() || [])[0]) || "";
    } catch { /* app pas encore prête */ }
    if (!code) return "fr"; // pas encore prête : on redemandera
    choisie = normaliser(code);
    return choisie;
  }
  /** Fixe la langue (page qui la reçoit du preload, tests). */
  function choisir(code) {
    choisie = normaliser(code);
    return choisie;
  }

  /** Le texte de `cle` dans la langue choisie, avec ses {variables} remplacées en un seul passage. */
  function t(cle, vars, dans) {
    const dict = dictionnaires[dans || langue()] || fr;
    const modele = dict[cle] ?? fr[cle] ?? cle;
    return vars ? modele.replace(/\{(\w+)\}/g, (tout, nom) => (nom in vars ? String(vars[nom]) : tout)) : modele;
  }

  /** Page locale : remplace les textes marqués data-i18n, data-i18n-placeholder, data-i18n-aria-label, data-i18n-title. */
  function appliquer(doc, dans) {
    const l = dans || langue();
    doc.documentElement.lang = l;
    for (const el of doc.querySelectorAll("[data-i18n]")) el.textContent = t(el.getAttribute("data-i18n"), null, l);
    for (const attr of ["placeholder", "aria-label", "title"]) {
      for (const el of doc.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`), null, l));
    }
  }

  return { dictionnaires, langue, choisir, normaliser, t, appliquer };
});
