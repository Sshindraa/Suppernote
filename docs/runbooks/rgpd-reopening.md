# Réouverture RGPD : effacement et opposition marketing

Statut au 19/11/2026 : **préparé, toujours fermé en production**. La réouverture est une décision de Hamza. Rien n'est activé par cette PR, et `infra/nginx/` n'est pas modifié.

## Pourquoi c'est fermé

Le 503 vient de Nginx, pas de l'API. Les routes `/api/rgpd/erase` et `/api/rgpd/withdraw-marketing` ne sont pas listées comme `location =` dans la configuration de production ; elles tombent dans le catch-all qui répond 503 :

- `infra/nginx/suppernote.conf`, serveur `suppernote.com` : `location ^~ /api/rgpd/ { return 503 }` (vers la ligne 150), et `location ^~ /api/proxy/api/rgpd/` (vers la ligne 114) côté dashboard.
- `infra/nginx/suppernote.conf`, serveur `api.suppernote.com` : même catch-all (vers la ligne 468).
- `infra/nginx/suppernote-staging.conf` : pas de catch-all. Le staging accepte déjà ces routes, ce qui permet la qualification ci-dessous.

Les journaux API ne montrent pas ces 503 : `access_log off` sur ces locations, et la requête n'atteint jamais l'API. Historique : réouverture partielle du 29/10 (PR #616), export et vérification d'identité seuls ouverts.

## Ce que contient cette PR

- **Effacement** (`apps/api/src/modules/rgpd/erasure.service.ts`) :
  - cartes cadeaux : noms, téléphones, e-mails et messages de l'expéditeur et du destinataire sont effacés ; montant, solde, code, statut et paiements restent ;
  - checkouts cadeaux : les champs personnels du `payload` sont retirés, le reste (montant, `packSnapshot`, `paymentIntent`) est conservé ;
  - contributions : nom, e-mail et message du contributeur sont effacés (correspondance par e-mail uniquement) ;
  - livraisons de cartes en `PENDING` des cartes concernées passent en `SKIPPED` (`lastErrorCode: RGPD_ERASURE`) ;
  - fidélité : la note libre de `LoyaltyGrant` est retirée ; la ligne reste rattachée à la fiche archivée, sans identité.
  - Le sujet connu seulement par ses cartes n'est plus traité comme introuvable (pas de 404).
- **Opposition** (`apps/api/src/modules/rgpd/marketing-withdrawal.service.ts`, nouveau) : `POST /api/rgpd/withdraw-marketing` retire chaque fiche CRM du sujet sur **SMS, e-mail et WhatsApp**, comme un STOP. L'accord historique passe à false pour toutes les variantes du numéro (`+33…` et `06…`). Avant, seul l'accord historique changeait : les permissions par canal et le registre d'opposition n'étaient pas touchés.
- **503 applicatif** `MARKETING_OPTOUT_REGISTER_UNAVAILABLE` : il est voulu. Il se déclenche quand le registre ne peut pas garder l'opposition :
  - `MARKETING_OPTOUT_HASH_SECRET` absent (`SKIPPED_NO_KEY`) ;
  - erreur SQL pendant l'écriture du registre ;
  - pour l'effacement, une opposition connue qu'on ne peut pas préserver.
    Le même code sort aussi de `/api/rgpd/erase` et `/api/rgpd/withdraw-marketing`, avec un 503 rejouable. Pour l'effacement, la transaction est annulée, jeton compris : la demande peut être rejouée.
- **Journaux** : `/api/rgpd/erase` et `/api/rgpd/withdraw-marketing` ne journalisent que le nom de l'erreur, jamais le message (qui peut contenir le numéro).

## Reste à faire avant d'ouvrir

1. **Photo personnalisée** de carte (`customImageUrl`) : le fichier stocké n'est pas supprimé, à traiter à la main.
2. **Checkout encore ouvert** au moment de l'effacement : son payload est purgé. S'il est payé ensuite, la carte est créée sans nom. À annuler à la main.
3. **Casse des e-mails** dans les payloads JSON : le filtre est sensible à la casse. Une casse différente échappe au filtre des checkouts (les cartes et contributions sont, elles, insensibles à la casse).
4. **Sujet sans fiche CRM** : seul l'accord historique est retiré. Le registre est par restaurant, il n'y a donc pas de restaurant à écrire.
5. **Export RGPD** : il ne lit pas les cartes cadeaux ni les checkouts. Décision à prendre (inclure ou non).
6. **Qualification staging** (plan ci-dessous).
7. **Décisions de Hamza** (journal du 03/11) : base légale du registre, rôles responsable ou sous-traitant, accord de traitement, texte public.

## Plan de qualification staging

Données synthétiques uniquement, sur `api-staging.suppernote.com`. Aucune donnée de tiers.

1. Déployer la PR sur staging, CI verte.
2. Créer un jeu synthétique : un téléphone de test avec deux fiches CRM, une carte offerte (expéditeur = ce téléphone), une carte reçue (destinataire = ce téléphone), un checkout PURCHASE payé, une contribution avec un e-mail de test, un `LoyaltyGrant` avec une `redemptionNote`.
3. Vérification d'identité (`request-verification` puis `confirm-verification`), puis `erase` : réponse 200, cartes sans nom ni contact, montants et codes inchangés, note de fidélité nulle.
4. Rejouer le même jeton : refus (EXPIRED).
5. `withdraw-marketing` : 200, puis une permission `OPTED_OUT` sur SMS, EMAIL et WHATSAPP pour chaque fiche, et une entrée dans le registre pour les canaux ayant une adresse.
6. Panne du registre : testée en PostgreSQL (`RGPD_ERASURE_TEST_DATABASE_URL`), pas en changeant l'environnement de staging. Attendu : 503 `MARKETING_OPTOUT_REGISTER_UNAVAILABLE`, transaction annulée.
7. Deux `erase` simultanés sur le même sujet : un seul succès, l'autre refusé.
8. Journaux de staging : aucun numéro, e-mail ni nom dans les lignes de ces requêtes (grep sur le téléphone de test).

## Lignes Nginx à changer pour ouvrir (décision Hamza)

Dans `infra/nginx/suppernote.conf`, pour chacun des deux serveurs (`suppernote.com` et `api.suppernote.com`), ajouter avant le catch-all deux locations de proxy, sur le modèle des routes déjà ouvertes :

```nginx
location = /api/rgpd/erase {
    access_log off;
    proxy_pass http://sokar_api;
    include /etc/nginx/snippets/suppernote-proxy.conf;
}

location = /api/rgpd/withdraw-marketing {
    access_log off;
    proxy_pass http://sokar_api;
    include /etc/nginx/snippets/suppernote-proxy.conf;
}
```

Le catch-all `location ^~ /api/rgpd/ { return 503 }` reste en place pour toute autre route. Les deux lignes à retirer pour ouvrir sont donc les `return 503` des blocs `^~ /api/rgpd/` ; le proxy `/api/proxy/api/rgpd/` n'a pas besoin de changer, le dashboard n'appelle pas ces routes.

Ces modifications sont faites par l'opérateur, après validation staging. Retour arrière : remettre le `return 503`, puis recharger Nginx.
