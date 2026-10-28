# Wikinder — trier ses cartes Wiki Masters façon Tinder

Extension Chrome **Manifest V3** (non officielle). Elle ajoute un onglet **Wikinder** dans le menu de
[wiki-masters.com](https://www.wiki-masters.com) : tes cartes défilent une par une avec leur **prix moyen**, tu les
**gardes** ou tu les **supprimes**. La suppression part en arrière-plan et la carte suivante s'affiche tout de suite.

## Installation

1. Ouvrir `chrome://extensions/` et activer **Mode développeur**.
2. **Charger l'extension non empaquetée** → choisir ce dossier (celui qui contient `manifest.json`).
3. Ouvrir ou recharger [wiki-masters.com](https://www.wiki-masters.com) connecté à ton compte.
4. Cliquer sur **Wikinder** dans le menu (sous « Collection »). Si le menu n'est pas trouvé, un bouton flottant
   **🔥 Wikinder** apparaît en bas à gauche au bout de quelques secondes.

Désactive les autres extensions Wiki Masters qui chargent aussi les prix, pour éviter les requêtes en double
(le site limite le rythme des requêtes automatiques).

## Utilisation

| Geste | Effet |
| --- | --- |
| **→**, bouton ♥, glisser vers la droite | **Garder** la carte |
| **←**, bouton ✕, glisser vers la gauche | **Supprimer** la carte |
| **Z**, bouton ↩ | Annuler le dernier geste |
| **Échap** | Fermer Wikinder |

- Chaque **exemplaire** est une carte à trier : avoir 3 fois la même carte donne 3 cartes consécutives
  (« 3 exemplaires possédés »), ce qui permet de ne jeter que les doublons.
- **Prix moyen** : moyenne des ventes passées *pour la rareté de ta carte*. Les prix se chargent en arrière-plan
  (2 requêtes en parallèle, la carte affichée et les suivantes en premier) et sont conservés. Compteur « Prix : x / y » en bas.
  **Moy. —** = réponse réussie sans moyenne disponible.
- **Suppression** : un délai de 3 s avant l'envoi permet d'annuler (↩). Une fois envoyée au site, elle est définitive.
  Si le site refuse (limite, erreur), la suppression reste en file et est retentée ; elle survit à la fermeture de l'onglet
  et reprend à la visite suivante.
- **Filtres** : tri (rareté, prix croissant/décroissant, titre, aléatoire), raretés, prix moyen max. Avec un prix max,
  les cartes dont le prix n'est pas encore chargé sont masquées — ré-appliquer les filtres une fois les prix arrivés.
  Un tri par prix est surtout utile une fois les prix chargés.
- **Toujours épargnées (jamais proposées)** : favoris, cartes brillantes, cartes dans un échange en cours, cartes en vente.
  Les échanges et ventes sont revérifiés juste avant chaque envoi.

## Progression : garder une trace, exporter, importer

- Chaque carte gardée ou supprimée est mémorisée (`chrome.storage.local`) : **elle ne revient jamais**, même après un
  redémarrage. Les nouveaux exemplaires obtenus plus tard apparaissent, eux, comme à trier.
- **Exporter** télécharge `wikinder-progression-AAAA-MM-JJ.json` (gardées, supprimées, prix).
- **Importer** fusionne un export avec la progression actuelle (union ; pour un même exemplaire, la décision la plus
  récente gagne ; prix : le plus récent gagne). Pratique pour changer de navigateur ou d'ordinateur, ou sauvegarder
  avant de vider les données du navigateur. Désinstaller l'extension efface la progression : exporte d'abord.

## Notes

- Requêtes utilisées (session déjà ouverte, uniquement vers wiki-masters.com) :
  `GET /api/my-collection`, `GET /api/marketplace?mine=1`, `GET /api/marketplace/cards/{id}/sales?scope=summary`,
  `POST /api/user-cards/{id}/discard`. Aucun serveur tiers, aucune télémétrie.
- Un seul onglet Wikinder à la fois (sinon deux onglets se réécrivent la progression).
- La collection est relue si elle date de plus de 30 min (bouton **Recharger** pour forcer).
- Le site peut imposer une pause (HTTP 429, limite d'automatisation) : prix et suppressions s'arrêtent alors
  automatiquement au moins 2 minutes, indiqué en bas de l'écran.
- Non testée sur un compte réel : les formats d'API sont repris des extensions de référence (`ref/`).
  Si le site change, vérifier les réponses dans la console DevTools.

## Développement

Aucune compilation. Avec Node.js 22+ : `node --test tests/core.test.js tests/api.test.js`.

- `core.js` — logique pure (file de tri, prix, protections, fusion/validation d'import)
- `store.js` — persistance `chrome.storage.local`
- `api.js` — API du site, chargeur de prix, file de suppressions
- `app.js` — interface plein écran (Shadow DOM) et contrôleur
- `nav.js` / `nav.css` — onglet du menu, point d'entrée
- `ui.css` — styles de l'interface
