# Protection anti-bot — LeFilou2.0 Studio (Cloudflare Worker + Turnstile)

## Ce que ça fait

Avant cette modif, le Turnstile était juste un widget affiché en bas
de page sans rien bloquer. Maintenant, **aucune requête (même venant
d'un bot qui ignore le JavaScript) ne reçoit le vrai contenu du site
sans avoir d'abord passé la vérification Turnstile**, validée côté
serveur.

## Comment ça marche

```
Visiteur arrive sur le site
        │
        ▼
Worker vérifie le cookie de session (signé HMAC)
        │
   ┌────┴────┐
   │ valide  │ invalide / absent
   ▼         ▼
Sert le    Sert verify.html (page de garde)
vrai site         │
(/protected)      ▼
            Turnstile s'exécute (souvent invisible)
                   │
                   ▼
       POST /api/verify-turnstile avec le token
                   │
                   ▼
       Worker valide le token auprès de
       l'API Cloudflare siteverify
                   │
              ┌────┴────┐
           valide     invalide
              │           │
              ▼           ▼
      Pose un cookie   Erreur affichée,
      de session +     pas d'accès
      redirige vers /
```

Le point clé : la vérification se fait **dans le Worker**, pas
seulement en JavaScript dans le navigateur. Un bot qui télécharge
juste le HTML sans exécuter de JS ne déclenchera jamais le callback
Turnstile, et ne recevra donc jamais de cookie de session valide — il
ne verra que `verify.html`, jamais `index.html`.

## Structure du projet

```
site-protected/
├── worker.js              # Le Worker : logique de garde + validation Turnstile
├── wrangler.jsonc          # Config Cloudflare (pointe vers worker.js + assets)
└── assets/
    ├── verify.html         # Page de garde affichée tant que non vérifié
    └── protected/
        ├── index.html      # Ton vrai site (contenu original)
        ├── sitemap.xml
        ├── BingSiteAuth.xml
        └── SECURITY.md
```

## Configuration avant déploiement

### 1. Récupérer ta clé secrète Turnstile

Sur le dashboard Cloudflare > Turnstile > ton site, tu as deux clés :
- **Site key** (publique, déjà dans `verify.html` : `0x4AAAAAADUWxdzr58kzE8lx`)
- **Secret key** (privée, ne doit JAMAIS apparaître dans le code)

### 2. Définir les secrets du Worker

```bash
cd site-protected
npx wrangler secret put TURNSTILE_SECRET_KEY
# colle ta secret key Turnstile quand demandé

npx wrangler secret put SESSION_SECRET
# génère une chaîne aléatoire longue, ex: openssl rand -hex 32
```

`SESSION_SECRET` sert à signer les cookies de session (HMAC) — sans
lui, personne ne peut forger un cookie valide pour bypasser la
vérification.

### 3. Déployer

```bash
npx wrangler deploy
```

## Tester en local

```bash
npx wrangler dev
```

Ouvre `http://localhost:8787` — tu devrais voir `verify.html`
d'abord, puis être redirigé vers le vrai site une fois le captcha
passé (un cookie `lf2_verified` est posé, visible dans les devtools).

## Ajuster le comportement

- **Durée de la session** : modifie `SESSION_DURATION_SECONDS` dans
  `worker.js` (actuellement 12h — au-delà, le visiteur repasse par la
  vérification).
- **Niveau de friction Turnstile** : dans `verify.html`, le paramètre
  `appearance: "interaction-only"` n'affiche le widget que si
  Cloudflare juge le visiteur suspect ; passe à `"always"` pour
  toujours afficher un défi visible, ou `"execute"` pour une
  vérification 100% invisible (Turnstile gère cela automatiquement
  selon le score de confiance).

## Important

- Le dossier `assets/protected/` est servi **uniquement** après
  validation. Ne mets jamais de contenu sensible ailleurs que dans ce
  dossier en pensant qu'il est protégé par défaut — tout ce qui n'est
  pas explicitement servi via `serveProtectedAsset()` dans `worker.js`
  reste inaccessible tant que la session n'est pas valide, mais reste
  prudent si tu ajoutes de nouvelles routes.
- Si tu ajoutes des images/CSS/JS externes à ton site, place-les aussi
  dans `assets/protected/` et référence-les en chemin relatif
  (`./mon-fichier.css`), pas en chemin absolu commençant par `/`.
