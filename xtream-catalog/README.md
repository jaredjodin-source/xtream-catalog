# Fluxio — Catalogue IPTV Xtream

Une interface web pour parcourir **les chaînes TV, les films et les séries** de votre abonnement Xtream. Le site ne fournit aucun contenu ni aucun abonnement.

## Démarrer sur Windows, macOS ou Linux

1. Installez **Node.js 20 ou supérieur** (https://nodejs.org/).
2. Décompressez le fichier ZIP dans un dossier.
3. Ouvrez un terminal dans ce dossier et lancez :
   ```sh
   node server.js
   ```
4. Ouvrez **http://127.0.0.1:3000** dans votre navigateur.
5. Entrez l'URL du serveur (ex. `http://monserveur.exemple:8080`), votre identifiant et votre mot de passe. Un lien `get.php?username=...&password=...` est également accepté.

**Aucune dépendance npm à installer.** Une connexion Internet est utile pour le lecteur HLS (hls.js depuis jsDelivr) et les polices; Safari lit HLS nativement.

## Fonctions

- Récupération des catalogues TV, VOD et séries depuis `player_api.php`.
- Recherche, catégories, grandes bibliothèques avec chargement progressif.
- Favoris enregistrés localement sur votre navigateur (sans mot de passe).
- Saisons et épisodes de séries.
- Lecture HLS via hls.js, ou HTML5 pour les fichiers compatibles; relais vidéo local pour éviter les problèmes de CORS et de HTTP/HTTPS.
- Session conservée 12 heures en mémoire sur le serveur, via cookie HttpOnly; jamais d'identifiants Xtream dans le stockage du navigateur.

## Remarques et limites

- Il faut des **identifiants Xtream valides** pour voir un catalogue. Le site n'inclut pas de chaîne ni de film.
- La lecture dépend du fournisseur, de son réseau, de l'état de votre abonnement et du format du fichier. Les navigateurs ne lisent pas nativement tous les codecs MKV, AVI, MPEG-TS ou certains profils HLS.
- Certains fournisseurs utilisent des DRM, des IP autorisées, des en-têtes spécifiques ou des architectures non compatibles : dans ce cas, certaines vidéos pourront ne pas fonctionner.
- Par défaut, le site écoute uniquement sur **127.0.0.1** et refuse d'appeler des adresses IP internes. Pour tester un fournisseur accessible sur votre réseau privé, on peut lancer avec `ALLOW_PRIVATE_HOSTS=1 node server.js`, mais **ne jamais utiliser ce réglage sur un serveur accessible à d'autres personnes**.
- **Ne déployez pas ce serveur directement sur Internet** sans ajouter une authentification des utilisateurs, HTTPS, des limites de débit et des protections réseau supplémentaires (notamment contre les attaques SSRF). Le proxy est destiné à un usage personnel local.
- Certains logos ou pochettes peuvent être servis en HTTP et ne pas s'afficher sur un hébergement HTTPS.

## Organisation

- `index.html` : interface
- `style.css` : mise en page responsive
- `app.js` : navigation, catalogue, favoris et lecteur
- `server.js` : serveur local et connecteur à l'API Xtream

**Utilisez uniquement les accès et contenus pour lesquels vous disposez d'une autorisation.**
