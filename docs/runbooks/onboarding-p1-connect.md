# Onboarding Pilote P1 Suppernote Connect

> **Statut : MODÈLE DE RUNBOOK — audité le 12 septembre 2026.** Les prérequis techniques sont
> livrés. Les cases vides ci-dessous doivent être copiées et remplies pour chaque restaurant ; elles
> ne décrivent pas des fonctions manquantes dans Suppernote. La campagne de 10 restaurants n'est pas
> documentée comme terminée. Voir [`../DOCUMENTATION_STATUS.md`](../DOCUMENTATION_STATUS.md).

La finalisation du provisioning admin est gardée côté API : `POST
 /admin/provisioning/:restaurantId/complete` refuse un restaurant sans numéro attribué, webhook/renvoi
vérifié ou appel test validé. Le code `PROVISIONING_NOT_READY` renvoie les prérequis manquants ; les
dates `testCallValidatedAt` et `forwardingConfiguredAt` ne sont jamais fabriquées par ce bouton.

## Objectif

10 restaurants réels onboardés sur Suppernote Connect pour valider les 4 critères go/no-go P1.

## Critères go/no-go P1 (dashboard `/dashboard/connect/pilot`)

1. **holdToConfirmRate** ≥ 30 % (réservations web confirmées / holds créés)
2. **slugP95Ms** < 500 ms (latence p95 sur `GET /public/r/:slug`)
3. **piiLeakIncidents** = 0 (jamais de fuite PII dans les logs)
4. **aggregateRatingSafe** = true (aucun `aggregateRating` inventé dans le JSON-LD)

Source : `apps/api/src/modules/connect/connect-kpis.service.ts` (`CONNECT_TARGETS`).

## Pré-requis techniques (déjà prêts)

- [x] Sitemap dynamique (`apps/connect/src/app/sitemap.ts`)
- [x] robots.txt (`apps/connect/src/app/robots.ts`)
- [x] Endpoint `GET /public/sitemap-data` (`apps/api/src/modules/connect/connect.routes.ts`)
- [x] KPIs service (`apps/api/src/modules/connect/connect-kpis.service.ts`)
- [x] Dashboard pilot (`apps/dashboard/src/app/dashboard/connect/pilot/page.tsx`, polling 60 s)
- [x] Onboarding 5 étapes Connect (`apps/api/src/modules/restaurants/onboarding.service.ts`)

## Étapes d'onboarding par restaurant

### 1. Collecte des données (restaurant)

- [ ] Nom du restaurant
- [ ] Slug souhaité (validation via `GET /api/restaurants/check-slug?slug=...`)
- [ ] Adresse complète (rue, ville, code postal, pays)
- [ ] Coordonnées GPS (géocodage via Nominatim)
- [ ] Type de cuisine
- [ ] Gamme de prix (1-4)
- [ ] Tables de la salle (nombre par taille) et règles (durée d'un repas, taille max de groupe, annulation, acompte) : étape `floor`, valables pour tous les canaux
- [ ] Horaires d'ouverture (jour par jour, midi/soir)
- [ ] Photo de couverture (upload via `POST /api/restaurants/:id/images`)
- [ ] Description courte (1-2 phrases, vous-forme)
- [ ] Numéro de téléphone E.164 (pour Telnyx)
- [ ] Email de contact

### 2. Configuration via dashboard

- [ ] Accéder au dashboard Suppernote (`https://suppernote.com/dashboard`)
- [ ] Créer le restaurant
- [ ] Compléter le socle commun (`restaurant`, `hours`, `floor` : salle et règles) puis les 2 étapes Connect (nouveau parcours local, 9 octobre 2026) :
  - `connect-identity` — Votre page : éditeur et aperçu côte à côte ; adresse importée à la sélection Google et enregistrée à l’étape restaurant ; correction de l’adresse intégrée. Photo, présentation, cuisine, gamme de prix, régimes et ambiance facultatifs.
  - `connect-activation` — Publication : vérification finale, publication explicite, lien et widget.
  - Compatibilité : les tâches API `connect-location` et `connect-cuisine` restent acceptées/exposées ; elles n’entrent plus dans la progression. Leurs anciennes URL et paramètres `?step=` ouvrent l’éditeur unique. Le nom et les horaires proviennent du socle commun.
  - Une adresse incomplète est corrigée dans l’éditeur ; les coordonnées Google sont réutilisées, avec le géocodage existant en secours et une saisie manuelle si celui-ci échoue. La page doit être enregistrée avant publication.
- [ ] Vérifier la preview sur `/restaurant/[slug]`
- [ ] Activer `connectPublished` via `PATCH /api/restaurants/:id/connect`

### 3. Provisioning Telnyx

- [ ] Lister les numéros disponibles : `GET /api/admin/provisioning/available-numbers`
- [ ] Attribuer un numéro : `POST /api/admin/provisioning/:restaurantId/assign-phone`
- [ ] Vérifier le webhook : `POST /api/admin/provisioning/:restaurantId/verify-webhook`
- [ ] Confirmer le renvoi opérateur après composition du code USSD : `POST /api/admin/provisioning/:restaurantId/mark-forwarding`
- [ ] Tester l'appel : `POST /api/admin/provisioning/:restaurantId/test-call`
- [ ] Confirmer que l'appel test a été reçu et entendu : `POST /api/admin/provisioning/:restaurantId/validate-test-call` avec le `callControlId` retourné
- [ ] Finaliser le provisioning : `POST /api/admin/provisioning/:restaurantId/complete`

### 4. Validation

- [ ] Page `/restaurant/[slug]` accessible (HTTP 200)
- [ ] Sitemap inclut le restaurant (`GET /sitemap.xml` sur `https://suppernote.com`)
- [ ] Widget de réservation fonctionnel (`/restaurant/[slug]/book`)
- [ ] Test de réservation end-to-end : hold (`POST /public/r/:slug/hold`) → confirm (`POST /public/r/:slug/confirm`)

### 5. Google Search Console (one-time)

- [ ] Créer la propriété `https://suppernote.com` dans Google Search Console
- [ ] Vérifier via `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` (meta tag dans `apps/connect/src/app/layout.tsx`) ou fichier `google<hash>.html`
- [ ] Soumettre le sitemap `https://suppernote.com/sitemap.xml`
- [ ] Surveiller l'indexation (jours → semaines)

## Suivi du pilote

- **Dashboard** : `/dashboard/connect/pilot` (polling 60 s)
- **Endpoint KPIs** : `GET /api/internal/connect-kpis`
- **Période** : 2-4 semaines après onboarding complet
- **Décision go/no-go** : basée sur les 4 critères ci-dessus

## Rollback

- Désactiver `connectPublished` pour un restaurant : `PATCH /api/restaurants/:id/connect` avec `{ connectPublished: false }`
- Le restaurant reste dans la base mais n'est plus public (retiré du sitemap, page 404)

> Depuis le 2026-10-07, l'étape `connect-capacity` n'existe plus : ses règles (durée d'un repas, taille
> maximale des groupes, annulation, acompte) sont dans l'étape `floor` « Votre salle et vos règles »,
> commune à tous les canaux. Connect compte 4 étapes.
