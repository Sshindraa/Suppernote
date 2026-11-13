# Next 16 — migration et recette Clerk

## Périmètre

Dashboard, Connect et widget utilisent Next 16.4.2 et ESLint 9 (configuration plate).
Clerk reste en 6.39.5, Sentry en 10.63.0 et next-intl en 4.13.1 : leurs plages de
compatibilité incluent Next 16. Ne pas coupler cette migration aux majeures de ces SDK.
Les scripts dev/build conservent Webpack explicitement. Les points d’entrée réseau deviennent
`src/proxy.ts` ; les routes, redirections et en-têtes restent identiques.
Node doit être >=20.9 et <23 (CI : Node 22).

L’override `minimatch@3>brace-expansion` conserve la branche CommonJS 1.1.21 corrigée :
la branche 5 imposée globalement exporte un objet et casse ESLint 9 (`expand is not a function`).
L’audit production doit rester à deux alertes connues dans la chaîne Tailwind 3.

Les nouveaux diagnostics React Compiler (`set-state-in-effect`, `refs`, `purity`,
`immutability`) restent en avertissement pour les composants existants ; `rules-of-hooks`
reste bloquant et `exhaustive-deps` conserve son niveau précédent. Leur remise à niveau constitue
un chantier distinct, avant une éventuelle activation du compilateur React.

## Vérifications locales

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
CI=1 pnpm turbo build --filter=@suppernote/dashboard... --filter=@suppernote/connect... --filter=@suppernote/widget...
```

`apps/dashboard/src/proxy.test.ts` contrôle les routes protégées sans session, la session
authentifiée, les anciennes URL opérateur, l’exception démo, la réservation publique et le refus
de démarrer en production sans configuration Clerk. Ces tests simulent le SDK ; ils ne prouvent
pas une connexion réelle au fournisseur.

## Recette avec Clerk réel avant mise en production

Utiliser le staging de cette version avec les clés Clerk de staging injectées par l’environnement,
et un compte de test existant. Ne pas créer de réservation, de paiement ou envoyer de notification.
Conserver les résultats datés sans jeton, cookie, adresse e-mail ni identifiant personnel.

1. En navigation privée, `/dashboard`, `/onboarding`, `/admin` et
   `/dashboard/admin/margin` redirigent vers `/login`. Même en démo staging, `/admin` exige
   une session. Le formulaire Clerk charge sans erreur console ni erreur de chargement réseau.
2. Se connecter avec un compte restaurant : retour au dashboard, organisation active retrouvée,
   lecture via `/api/proxy` autorisée (pas de boucle de redirection ni de 401 répétés).
3. Recharger une page protégée puis ouvrir un autre onglet : la session persiste et
   l’organisation reste cohérente. Vérifier le parcours onboarding si le compte y est éligible.
4. Avec un compte opérateur existant, vérifier `/admin` et la redirection de
   `/dashboard/admin/margin` vers `/admin/margin`. Un compte restaurant ne doit pas obtenir
   l’accès opérateur via l’API.
5. Se déconnecter via le menu du compte : les pages protégées renvoient vers `/login`, y compris
   après rechargement. Refaire une connexion pour vérifier le renouvellement de session.
6. Vérifier l’accueil (déjà dynamique sous Next 15 à cause du cookie de langue), `/privacy`, une page restaurant publiée et le widget intégré
   (CSP et framing), sans soumettre de réservation.

La CI sans clé Clerk et les tests avec SDK simulé ne remplacent pas cette recette. Tant que
la session réelle n’a pas été vérifiée sur cette version, garder la PR en brouillon.

## Retour arrière

Revenir aux artefacts de la dernière release Next 15 avec le runbook `rollback.md` ; cette migration
ne modifie ni le schéma ni les données. Conserver le snapshot de release et les résultats de santé.

Sources : [migration Next 16](https://nextjs.org/docs/app/guides/upgrading/version-16),
`peerDependencies` des versions installées de `@clerk/nextjs`, `@sentry/nextjs` et `next-intl`.

## Preuve de qualification — 18 octobre 2026

- Code qualifié : `8f1f2d78df7c7e2ab6b38ce247db177b1c235431` (#511, dépend de #510).
- CI : 18 contrôles verts sur ce commit.
- [Workflow staging 39165720884](https://github.com/Sshindraa/Sokar/actions/runs/39165720884) :
  succès ; release `20261018T210139Z`. Retour arrière testé, santé vérifiée, puis release
  courante restaurée. Version du serveur standalone constatée : 16.4.2.
- E2E staging : dashboard/widget 8 réussis, 4 ignorés ; Connect 5 réussis.
- API `/livez` OK, accueil HTTP 200, quatre processus PM2 staging online.
- Navigateur avec session opérateur existante : `/admin` fonctionne après rechargement ;
  `/dashboard/admin/margin` redirige vers `/admin/margin` et les données se chargent ;
  aucune erreur navigateur observée.
- Instance locale Next 16 hors démo, configuration Clerk Development injectée uniquement
  en mémoire depuis staging : `/dashboard`, `/onboarding`, `/admin` et
  `/dashboard/admin/margin` renvoient en 307 vers `/login` sans session ; formulaire Clerk
  réel et redirection Google chargés.
- Connexion Google réelle réussie avec le compte existant : établissement de test retrouvé,
  reprise de l’onboarding existant, persistance après rechargement et dans un second onglet.
  Le proxy `/api/auth/sync` a répondu 200. L’accès opérateur fonctionne également.
- Déconnexion via le menu Suppernote réussie : retour `/login`, puis accès `/admin` refusé dans
  le second onglet après rechargement.
- Reconnexion non validée : chargement bloqué sur `/login/sso-callback` et erreurs répétées
  Cloudflare Turnstile `300030` dans les logs navigateur. Les URLs Clerk de staging ont été
  ajoutées à l’injection locale (pas seulement les deux clés) ; le blocage persiste. Ne pas
  conclure à une régression Next 16 : la comparaison avec Next 15 n’a pas validé un cycle
  OAuth complet. Ne pas désactiver la protection anti-robot pour terminer la recette.
  La famille `300*` correspond à un échec de challenge selon la
  [documentation Cloudflare](https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/).
- Compte restaurant sans privilège opérateur : pas de second compte réel qualifié ;
  le refus 403 est couvert par `clerk.operator.test.ts` et les contrôles CI existants.
- Décision : garder la PR en brouillon jusqu’à une reconnexion réelle complète sans blocage.
  Aucune fusion et aucun déploiement production.
