# secpriv-rss-bridge

Flux RSS destinés aux agents de sécurité privée ainsi qu'aux gérants. Aucune newsletter ni compte, simplement entrer l'URL dans un lecteur RSS tel que **Feedly** ou **Thunderbird**.

Flux RSS disponibles:
- [x] **Journal officiel Légifrance** - dès qu'une loi, un décret ou un arrêté touche aux activités privées de sécurité (live VI du CSI, CNAPS, cartes professionnelles, formation, sûreté...), il arrivera ici avec un résumé en français clair de ce qui change pour les agents et les gérants sur le terrain.
- [ ] **Actualités CNAPS** - *à venir*

## Le flux Journal officiel Légifrance

```
https://SEKLYR.github.io/secpriv-rss-bridge/legifrance-jorf.feed.xml
```

Chaque entrée de ce flux contient le titre tel-quel du texte ainsi que sa date de publication, un résumé rédigé par IA et le lien vers le texte intégral sur le site https://www.legifrance.gouv.fr/ .

Le flux se met à jour chaque matin via **GitHub Actions** (créneaux 04:17, 06:17, 08:17 et 10:17 UTC : GitHub retarde parfois de plusieurs heures les workflows planifiés, le premier créneau qui part publie). 

### Comment ça marche

`legifrance-jorf.ts` tourne une fois par jour et enchaîne cinq étapes distinctes:

1. **Recherche** sur l'API officielle Légifrance (fonds JORF, 12 derniers mois) avec des expressions exactes : `sécurité privée`, `activités privées de sécurité`, `CNAPS`, `livre VI du code de la sécurité intérieure`…
2. **Consultation** du contenu intégral de chaque nouveau texte: *visas, articles, signataires*.
3. **Filtrage** par score de pertinence: un texte est gardé si son titre parle de sécurité privée, s'il cite au moins trois articles du livre VI, ou si les termes métier sont assez présents et assez denses dans le corps. Ça permet d'écarter le décret sur les contrats d'apprentissage qui parfois cite "agent de sécurité" une fois toutes les 20 000 lignes.
4. **Résumé** via [Google Gemini](https://gemini.google.com), en file d'attente cadencée pour tenir dans le plan gratuit. Le cache est sauvegardé après chaque résumé, un texte non résumé attend simplement le passage suivant.
5. **Publication** du flux RSS régénéré depuis le cache. Un texte n'y entre qu'une fois résumé.

Les fichiers de travail sont versionnés dans le dépôt:

| Fichier | Rôle |
|---|---|
| `legifrance-jorf.feed.xml` | Le flux RSS |
| `legifrance-jorf.cache.json` | Les textes retenus, leur contenu intégral et leur résumé |
| `legifrance-jorf.ignored.json` | Les textes écartés, avec leur titre, pour auditer le filtre |
| `site/` | La page d'accueil publiée sur GitHub Pages, qui affiche le flux en direct, avec ses polices et son logo |

## Faire tourner les flux en local

Pour faire tourner le tout en local, [Deno](https://deno.com), un compte [PISTE](https://piste.gouv.fr) et une clé [Gemini](https://aistudio.google.com) (le plan gratuit suffit) sont requises.

Créer un fichier `.env` :

```
LEGIFRANCE_CLIENT_ID=...
LEGIFRANCE_CLIENT_SECRET=...
GEMINI_API_KEY=...
```

Puis :

```
deno run --allow-net --allow-env --allow-read --allow-write --env-file=.env legifrance-jorf.ts
```

> Pour tester sans consommer le quota Gemini, ajoute `--no-gemini`: le scrape et le flux se font sans les résumés rédigés par Gemini.

### Réglages

Tout se pilote par variables d'environnement, aucune n'est obligatoire:

| Variable | Défaut | Rôle |
|---|---|---|
| `GEMINI_MODELS` | `gemini-3.5-flash-lite,gemini-3.6-flash` | Chaîne de modèles. Un modèle en 404 ou à quota épuisé passe la main au suivant |
| `GEMINI_RPM` | `10` | Requêtes par minute autorisées |
| `GEMINI_TPM` | `250000` | Jetons par minute autorisés, budget glissant sur 60s basé sur la consommation réelle |
| `GEMINI_MAX_PER_RUN` | `100` | Résumés maximum par passage |
| `GEMINI_ENABLED` | `true` | `false` équivaut à `--no-gemini` |
| `FEED_URL` | vide | URL publique du flux, pour le lien `self` du RSS |
| `FEED_LINK` | Légifrance | Lien du canal RSS |

Les termes de recherche, les motifs de pertinence, les exclusions de titres et les seuils sont en tête de `legifrance-jorf.ts`, commentés.

### En automatique

Le workflow `.github/workflows/legifrance-jorf.yml` lance le script chaque matin (04:17, 06:17, 08:17 et 10:17 UTC, GitHub pouvant retarder chaque créneau de plusieurs heures), commite le cache si un texte a changé, puis publie à chaque passage `site/` (la page d'accueil et ses actifs) et les flux sur GitHub Pages. Il attend trois secrets dans le dépôt: `LEGIFRANCE_CLIENT_ID`, `LEGIFRANCE_CLIENT_SECRET` et `GEMINI_API_KEY`.

Pour activer la publication, une seule manipulation: dans les réglages du dépôt, **Pages**, choisir la source **GitHub Actions**. Le premier déploiement se déclenche à la main depuis l'onglet Actions (« Run workflow »), les suivants sont automatiques.

## À savoir

Les résumés sont générés par une IA. Ils aident à repérer vite ce qui concerne les agents et les gérants **MAIS** ils ne remplacent pas la lecture du texte et n'ont aucune valeur juridique. Le lien vers le texte intégral est dans chaque entrée.

Les textes proviennent de Légifrance (DILA), réutilisés sous [Licence Ouverte 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/). Rien n'est modifié, seul le résumé est ajouté.

> Proposé via [SEKLYR](https://seklyr.fr).
