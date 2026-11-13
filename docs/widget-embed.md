# Widget embarqué Suppernote

> **Statut : ACTIF / LIVRÉ — vérifié le 12 septembre 2026.**
> `/embed.js`, l'iframe, la personnalisation, le redimensionnement et le contrôle de l'origine des
> messages sont en place. Voir [`DOCUMENTATION_STATUS.md`](./DOCUMENTATION_STATUS.md).

Le widget de réservation Suppernote peut être intégré sur n'importe quel site web
via un simple snippet JavaScript. Il s'affiche dans un iframe auto-redimensionné
et reprend le flow hold/confirm/idempotency déjà utilisé sur Suppernote Connect.

## Intégration

Copiez le snippet depuis le dashboard (`/dashboard/widget`) et collez-le dans le
HTML de votre site, à l'endroit où vous souhaitez afficher le formulaire :

```html
<script
  src="https://suppernote.com/embed.js"
  data-slug="chez-suppernote-demo"
  data-primary="#0f172a"
  data-accent="#f97316"
></script>
```

Seul l'attribut `data-slug` est obligatoire. Les couleurs `data-primary` (texte
et bordures) et `data-accent` (boutons et focus) sont optionnelles et valent par
défaut le thème Suppernote.

## Hôte personnalisé (local / staging)

Par défaut le snippet charge le widget depuis `https://suppernote.com`. Pour tester en
local ou sur un autre environnement, ajoutez `data-host` :

```html
<script
  src="http://localhost:3000/embed.js"
  data-slug="chez-suppernote-demo"
  data-host="http://localhost:3000"
  data-primary="#0f172a"
  data-accent="#f97316"
></script>
```

## Fonctionnement

`/embed.js` injecte un iframe pointant vers `/widget/:slug?embedded=1`. Le script transmet
l'origine du parent au widget ; le widget envoie sa hauteur via `postMessage` (type
`sokar-widget-resize`) et le script n'accepte que les messages de l'origine attendue et de l'iframe
qu'il a créée. Le middleware Connect
autorise explicitement le framing de `/widget/*` depuis n'importe quel domaine via
la directive CSP `frame-ancestors *`.

## Limites et prochaines étapes

Pour le MVP, n'importe quel domaine peut embarquer le widget d'un restaurant
public. En production, on pourra restreindre `frame-ancestors` aux domaines
enregistrés dans les paramètres du restaurant. La customisation reste limitée aux
deux couleurs ; le multi-langue et les analytics avancés sont hors scope.
