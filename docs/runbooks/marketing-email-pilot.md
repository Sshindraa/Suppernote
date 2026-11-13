# Pilote marketing par e-mail (Chez Suppernote)

Préparé le 22 octobre 2026. Portes concernées : `P3_MARKETING` (segments, campagnes, conformité) et
`P4_ATTRIBUTION` (attribution et ROI), toutes deux `LOCAL_ONLY` dans
[`product-gates.json`](../release/product-gates.json).

**Périmètre : e-mail uniquement.** Les SMS restent bloqués (erreur Telnyx 40008 depuis l'expéditeur
« SOKAR », en attente du support Telnyx) ; WhatsApp marketing reste coupé. Aucun message n'a été envoyé
pour préparer ce document : tout ce qui suit est une procédure, pas un constat d'exécution.

Références : [ADR du plan de contrôle CRM/marketing](../architecture/adr-crm-marketing-control-plane.md),
[variables d'environnement](environment.md), [délivrabilité](email-sms-deliverability.md).

## 1. Ce qui est prêt dans le code

| Élément                                                                                              | État                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Segments, aperçu d'audience, brouillon, préparation, programmation, envoi, annulation, rapport + CSV | Livrés (`apps/api/src/modules/marketing/`), protégés par `marketing.campaigns` (plan Pro) (plus de drapeau `MARKETING_FEATURES_ENABLED`, fonction toujours ouverte)                                  |
| Consentement par canal (`MarketingPermission`) avec preuve hachée et journal d'événements            | Livré. **Recueil ajouté** : case non pré-cochée sur la page de réservation Suppernote Connect, et état par canal avec saisie d'un accord oral et retrait dans la fiche client du dashboard (voir §4) |
| Désinscription signée par canal, immédiate, sans révéler l'adresse                                   | Livrée ; page de confirmation en français et en-têtes `List-Unsubscribe` ajoutés par cette PR                                                                                                        |
| Contrôle au dernier moment : contact, consentement, suppression, plafond de 3 messages par jour      | Livré (worker `marketing-campaign`, deux contrôles avant l'appel Resend)                                                                                                                             |
| Callbacks Resend signés (Svix) → statut du message, rapprochement des identifiants inconnus          | Livrés ; endpoint `POST /marketing/webhooks/resend`                                                                                                                                                  |
| Suppression automatique après plainte ou rebond définitif                                            | **Ajoutée par cette PR** (il n'existait aucun code qui créait une suppression)                                                                                                                       |
| Liste blanche de destinataires propre au marketing (`MARKETING_RECIPIENT_ALLOWLIST`)                 | **Ajoutée par cette PR** ; vide = aucune restriction                                                                                                                                                 |
| Mode « test » d'une campagne                                                                         | `POST /marketing/campaigns/:id/test` est un **dry-run** : il rend le message mais ne contacte aucun fournisseur. L'envoi réel de test passe par la liste blanche                                     |

## 2. Défauts constatés et corrigés (PR dédiée)

1. **Plainte ou rebond définitif sans effet.** Un statut `COMPLAINED` ou `BOUNCED` était enregistré sur
   le message, mais l'adresse pouvait recevoir la campagne suivante. Désormais une suppression
   (`COMPLAINED` ou `HARD_BOUNCE`, canal e-mail) est créée ; l'audience et le worker l'excluent déjà.
   Un rebond temporaire (`Transient`) ne supprime rien.
2. **Désinscription par GET.** Le lien de l'e-mail désinscrivait dès l'ouverture de l'URL et répondait en
   JSON brut. Les anti-virus et aperçus de lien (Outlook, Gmail) ouvrent les liens : les destinataires
   auraient été désinscrits sans le savoir, ce qui fausse le pilote. Désormais le GET affiche une page de
   confirmation en français ; le bouton envoie un POST. Le POST accepte aussi le jeton dans l'URL, comme le
   fait le « un clic » RFC 8058 des messageries.
3. **Pas d'en-têtes `List-Unsubscribe`.** Ajoutés (avec `List-Unsubscribe-Post: List-Unsubscribe=One-Click`) :
   Gmail et Outlook affichent un bouton « Se désabonner » natif.
4. **Adresses non cliquables.** Le corps de l'e-mail n'était que du texte échappé : le lien de désinscription
   et celui de réservation sont maintenant des liens `<a>`.
5. **Rapprochement encombré.** Le webhook Resend reçoit aussi les événements des e-mails transactionnels, qui
   ne correspondent à aucun message de campagne et restaient `OPEN` pour toujours, bloquant la fenêtre de
   100 lignes lue toutes les cinq minutes. Une ligne sans message de campagne est fermée (`IGNORED`,
   `AUTO_EXPIRED_NO_CAMPAIGN_MESSAGE`) après deux heures.

## 3. Constats à connaître avant d'envoyer

- **Verrou de déploiement production.** `scripts/verify-product-gates.mjs` refuse tout `deploy.sh --env prod`
  si `MARKETING_SENDS_ENABLED=true` figure dans `apps/api/.env` (le profil `core-operator-foundations` le
  déclare dans `disabledFeatureFlags`). Conséquence : pendant une fenêtre d'envoi en production, **aucun
  déploiement ne passe** tant que le flag est à `true`. Soit la fenêtre est courte et coupée aussitôt, soit
  une PR distincte retire ce flag du profil (décision de release, non faite ici).
- **`EMAIL_TEST_ALLOWLIST` ne convient pas à la production.** Elle filtre **tous** les e-mails du site
  (confirmations, alertes, démos). Elle n'existe côté CI que pour staging (`EMAIL_TEST_ALLOWLIST_STAGING`).
  En production, utilisez `MARKETING_RECIPIENT_ALLOWLIST`, qui ne touche que les messages marketing.
- **Secrets non propagés par la CI.** `RESEND_WEBHOOK_SECRET`, `MARKETING_UNSUBSCRIBE_SECRET`,
  `MARKETING_ATTRIBUTION_SECRET`, `MARKETING_EMAIL_FROM`, `MARKETING_SENDS_ENABLED` et `MARKETING_RECIPIENT_ALLOWLIST` ne passent par
  aucun workflow ni `sync-env.sh` : ils se posent à la main dans `apps/api/.env` du VPS, puis
  `pm2 reload sokar-api --update-env` et rechargement des workers.
- **Quota Resend et budget marketing.** Le plan constaté est Free : 100 e-mails par jour et 3 000 par mois,
  partagés avec les e-mails transactionnels. Le marketing ne doit jamais consommer ce quota : il est plafonné à
  `MARKETING_EMAIL_DAILY_BUDGET` e-mails par jour pour **toute la plateforme** (40 par défaut, entier ≥ 0 validé
  au démarrage, jour UTC). Le contrôle a lieu **au lancement** : envoi immédiat, ou programmation. Une programmation
  est recontrôlée au jour réel de son envoi, qu'elle parte avant ou après la date prévue. Une campagne dont
  l'audience dépasse le reste du jour est refusée (409 : « Audience trop grande pour aujourd’hui », ou « pour ce
  jour-là » en programmation) : elle n'est ni tronquée, ni étalée en silence. Une programmation refusée au moment
  de partir redevient prête, avec `MARKETING_DAILY_BUDGET_EXCEEDED`. Le reste compte les e-mails acceptés ce
  jour-là, les envois en cours ou suspendus et les programmations de ce jour. Une
  campagne **prête (READY) ne réserve rien** : une campagne oubliée ne bloque pas les autres. Seule exception :
  une automatisation prête, avec ses occasions, réserve son audience, puisqu'elle part à la même passe. Relevez ou retirez
  ce plafond au passage à un plan Resend supérieur (`shortcut:` dans `marketing-campaign.service.ts`).
- **Automatisations e-mail.** Elles contrôlent leur audience à leur création, puisqu'elles partent à la même
  passe. Un lot n'est jamais refusé en entier : il est découpé sur le reste du jour, et ce qui ne tient pas reste
  candidat au scan suivant (toutes les heures, à :15). Une occasion déjà servie (même anniversaire, même premier
  passage) n'est jamais renvoyée. Les anniversaires, dont la fenêtre est bornée, passent avant les autres à
  l'échelle de la plateforme ; dans un lot, les échéances les plus proches passent d'abord. Un seul avertissement
  par automatisation et par jour quand le budget est atteint (par processus worker).
- **Jeton dans les journaux d'accès.** L'URL de désinscription contient le jeton ; il n'embarque que des
  identifiants opaques (aucune adresse), mais ne le copiez pas dans un ticket.
- **Le consentement historique n'autorise plus l'e-mail.** Un `CustomerConsent.marketingOptIn` est un
  indicateur rattaché à un numéro de téléphone : il ne démontre pas que la personne a accepté la prospection
  par e-mail du restaurant concerné. Depuis cette PR, il ne peut plus autoriser que le SMS (période de
  migration, SMS bloqués de toute façon) ; l'e-mail exige une permission `EMAIL` dédiée (ADR mis à jour).
  Les consentements historiques ne sont utilisables pour l'e-mail que si leur preuve établit un accord
  préalable couvrant ce canal et ce restaurant ; à défaut, le destinataire est exclu. Rien dans le dashboard,
  le widget ou Connect ne met `marketingOptIn` à `true` (seuls des appels API directs de type MCP le
  peuvent) : les cases de §4 créent une `MarketingPermission` par canal.

## 4. Base légale du consentement

- Prospection électronique à des particuliers : consentement préalable (article L.34-5 du Code des postes et
  des communications électroniques, RGPD article 6.1.a). La décision d'architecture suit cette règle : l'opt-in
  est un acte explicite, jamais pré-coché, daté, versionné et rattaché à une preuve hachée (le texte brut n'est
  pas stocké).
- Retrait à tout moment, sans effet sur les traitements antérieurs : prévu par la politique de confidentialité
  (`apps/api/src/modules/rgpd/privacy-policy.ts`) et par le lien de chaque message.
- Chaque message doit identifier le restaurant et porter `{{unsubscribeUrl}}` (le serveur refuse un modèle qui
  l'omet). Mettez le nom du restaurant dans le corps (`{{restaurant.name}}`).
- **Pour le pilote**, les destinataires sont uniquement des personnes qui ont donné leur accord pour ce test
  (vous, collaborateurs, proches informés). Version de preuve proposée : `pilote-interne-2026-11`, texte de
  preuve : « Accord donné par le titulaire de l'adresse pour recevoir de Chez Suppernote (envoi opéré par Suppernote)
  les e-mails de test du pilote marketing, du <début> au <fin>, sans offre commerciale réelle, retirable à
  tout moment ». Il identifie qui envoie, la nature des messages et la période (à compléter). À conserver tel
  quel pour que le hachage reste identique, et à noter avec la date et la personne qui a donné l'accord.
- **À valider par vous** (je ne tranche pas le droit) : le texte qui sera montré à de vrais clients (case à
  cocher non pré-cochée), la finalité (« offres et actualités de <restaurant> »), la durée de conservation de
  la preuve, et la mention dans l'annexe client (`privacy-client-annex.md`). Resend : DPA signé archivé en
  privé ; conservation effective à valider (voir `Context.md`).

### Décisions de Hamza du 27/10/2026 (ouverture de l'envoi e-mail)

1. **Base légale** : opt-in explicite uniquement (case jamais cochée d'avance). Pas de soft opt-in en v1 ;
   à revoir avec un juriste quand le volume le justifiera.
2. **Texte de consentement** : validé le 27/10/2026, puis raccourci le même jour à la demande de Hamza (version `marketing-consent-2026-10-27`). Relecture juridique à faire avant les vrais clients.
3. **Conservation** : fichier de prospection 3 ans après le dernier contact venant du client (une réservation
   en est un) ; preuve du consentement tant que la permission est active, puis 5 ans après le retrait
   (prescription civile) ; registre d'opposition 3 ans (décision du 23/10). Le code applique les deux premières durées depuis le 28/10 (purge marketing du worker de réconciliation).
4. **Expéditeur** : sous-domaine dédié `news.suppernote.com`, nom affiché = restaurant, `Reply-To` = adresse
   du restaurant. Les e-mails transactionnels gardent leur domaine.
5. **Resend** : plan Free pour l'instant (pas encore de volume) ; passage au plan supérieur dès les premiers
   clients. D'ici là, le marketing ne doit jamais consommer le quota des transactionnels.
6. **Verrou** : fenêtre courte pendant le pilote, puis suppression de `MARKETING_SENDS_ENABLED` et de son
   entrée dans `verify-product-gates.mjs` (règle : aucun drapeau actif durable).
7. **Testeurs** : Hamza et deux ou trois proches prévenus, sur des messageries différentes (Gmail, Outlook,
   Orange).
8. **Contrat restaurant** : clause « Sokar sous-traitant » dans les CGV, attestation de consentement pour
   toute liste importée ; relecture juridique de la clause.
9. **Vocal** : Léa ne recueille rien ; le consentement passe par un lien dans la confirmation de réservation.
10. **Tarifs** : « Envoi de campagnes » reste dans l'offre Pro (fonction en cours de livraison).

### Texte de consentement (version 2026-10-28)

Ce texte a été **validé par Hamza le 27/10/2026**, puis raccourci le même jour. Le 28/10/2026, « de {nom} » est devenu « du restaurant {nom} » (évite « de Le Bistrot ») : nouvelle version. Il n'a pas de relecture juridique externe. Il vit à un seul endroit,
`packages/shared/src/marketing-consent.ts`, utilisé à la fois par les écrans et par l'API.

| Canal  | Texte affiché à côté de la case (jamais cochée d'avance)                           |
| ------ | ---------------------------------------------------------------------------------- |
| E-mail | « Recevoir les offres et actualités du restaurant {nom du restaurant} par e-mail » |
| SMS    | « Recevoir les offres et actualités du restaurant {nom du restaurant} par SMS »    |

- **Version** : `marketing-consent-2026-10-28` (`MARKETING_CONSENT_VERSION`). Les preuves enregistrées avec `marketing-consent-2026-10-27` ou `marketing-consent-2026-10-22` gardent l'ancien texte. Toute modification du texte
  exige une nouvelle version : une preuve ancienne doit rester rattachée au texte que le client a lu. Une
  page qui envoie une version inconnue n'enregistre rien (la réservation, elle, aboutit).
- **Finalité** : envoi d'offres et d'actualités du restaurant, par le canal coché, rien d'autre.
- **Ce qui est conservé** (par canal et par client) : état (donné / retiré), date, source (`CONNECT`,
  `DASHBOARD_IN_PERSON`, `DASHBOARD_PHONE`, `DASHBOARD_PAPER`, `UNSUBSCRIBE_LINK`, `DASHBOARD_WITHDRAWAL`,
  `CONFIRMATION_EMAIL`),
  version du texte et **empreinte SHA-256** de la preuve `version|canal|phrase exacte`. La phrase exacte est
  aussi conservée dans le journal (`proof_text`) : une preuve reste lisible si le texte change. Pour un accord saisi par le
  restaurant, la manière de le recueillir est ajoutée à la preuve. Chaque changement ajoute une ligne au
  journal `MarketingPermissionEvent` (aucune adresse ni téléphone dans les journaux applicatifs).
- **Durées de conservation : trois obligations distinctes.** Le registre d'opposition est conservé **3 ans** (décision de Hamza du 23/10/2026, appliquée par une purge sur le worker de réconciliation). Le fichier de prospection et la preuve ont une durée appliquée depuis le 28/10 (purge marketing du worker de réconciliation, chaque nuit à 3 h 20).
  La politique de confidentialité (`PRIVACY_RETENTION_RULES`) n'a de ligne marketing que pour le registre d'opposition. Les durées
  ci-dessous sont des **recommandations de la CNIL à contextualiser, pas une durée universelle ni une
  décision validée** :

  | Données                          | Règle à prévoir                                                                                                                                                                                     |
  | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Fichier de prospection           | Durée adaptée ; la CNIL recommande 3 ans après la fin de la relation client, ou après la collecte ou le dernier contact **venant du prospect** (un e-mail envoyé par le restaurant n'en est pas un) |
  | Preuve du consentement           | Conservation probatoire distincte, justifiée et à accès limité (aujourd'hui : avec la fiche client)                                                                                                 |
  | Liste d'opposition (désinscrits) | **3 ans retenus**, uniquement pour empêcher une nouvelle sollicitation (table `marketing_opt_outs`, voir ci-dessous)                                                                                |

  **Registre d'opposition (livré, migration `20261023120000_marketing_opt_out_register`)** : la preuve et
  l'état « retiré » restent supprimés en cascade avec la fiche client (effacement RGPD), mais chaque retrait
  (lien de désinscription, dashboard) et chaque plainte inscrit aussi, **par restaurant et par canal**, un
  **HMAC-SHA256** de l'adresse ou du numéro dans `marketing_opt_outs`, sans lien avec la fiche : il survit à
  l'effacement. Il gagne sur un accord en base (exclusion `OPTED_OUT_REGISTER` dans l'aperçu et au dernier
  contrôle avant envoi, y compris pour les automatisations). Une nouvelle case cochée par la personne le lève
  (le journal garde les deux actes). Sans `MARKETING_OPTOUT_HASH_SECRET`, aucun message n'est envoyé. Les
  **STOP par SMS** (`sms/sms-marketing-stop.ts`) : un message entier « STOP », « STOP SMS » ou « ARRÊT »
  (sans casse, accents ni espaces) retire l'accord SMS marketing dans le restaurant du **dernier SMS marketing
  accepté à ce numéro** (`source` `SMS_STOP`, motif `UNSUBSCRIBE`), puis inscrit le registre. Il ne touche ni
  aux réservations ni aux consentements transactionnels, et n'envoie aucun SMS. Sans SMS marketing à ce numéro,
  le message suit le flux de réponse habituel. Un échec du registre répond 503 (Telnyx doit rejouer).
  Limite : un expéditeur alphanumérique « SOKAR » ne reçoit aucune réponse ; le STOP n'arrive que si
  l'expéditeur est un numéro. Les filtres STOP propres à Telnyx ne sont pas vérifiés dans ce dépôt.
  retraits antérieurs à la migration se reprennent avec
  `pnpm --filter @suppernote/api exec tsx scripts/backfill-marketing-opt-out-register.ts --dry-run` puis `--apply`
  (comptes seulement, jamais d'adresse). Le registre est une donnée personnelle pseudonymisée : il figure
  dans la politique (`PRIVACY_DOCUMENT.optOutRegister`) et dans l'annexe client (`privacy-client-annex.md`).
  Position recommandée (intérêt légitime du restaurant, Sokar sous-traitant, trois ans comme minimum recommandé
  par la CNIL et non comme obligation légale) : `docs/legal/registre-opposition-marketing.md`. Analyse préparatoire
  produite par une IA : à valider par Hamza et un professionnel du droit, comme les points à corriger avant
  l'envoi réel, notamment le droit d'accès.

- **Protections du registre (03/11/2026)** : la clé d'empreinte est dérivée par restaurant, et seul le geste de
  la personne (case de réservation, lien de confirmation) lève une opposition. Un accord saisi par l'équipe
  sur une adresse opposée est refusé (`MARKETING_OPPOSITION_REGISTERED`). Si l'accord passe par une autre adresse,
  ou une case cochée pour autrui, cette limite ne le détecte pas.
- **Limites acceptées (Hamza, 03/11/2026)** :
  - **Fiches partageant une adresse** : une nouvelle case cochée sur l'une lève l'opposition pour cette
    adresse dans le restaurant, donc aussi pour une autre fiche déjà inscrite avant le retrait. Il s'agit de la
    même personne, qui vient de redonner son accord.
  - **Plainte reçue après l'effacement** : la fiche n'existe plus, l'événement part en rapprochement et rien
    n'est inscrit au registre. Une fiche recréée à cette adresse n'est pas contactée sans nouvel accord
    explicite ; si la personne le redonne, la plainte n'est pas opposée.

  L'effacement retire aussi `marketingOptIn` des consentements conservés. La ligne reste, sans la trace de
  l'accord marketing initial.

- **Preuve : ce qui est conservé** : l'empreinte de `version|canal|phrase` seule ne prouve pas que le
  titulaire de l'adresse a accepté. Chaque ligne du journal `MarketingPermissionEvent` conserve donc
  désormais aussi **la chaîne exacte hachée** (`proof_text` : version, canal, phrase avec le nom du
  restaurant à ce moment-là, méthode pour une saisie manuelle), qui n'est pas une donnée personnelle, et
  **l'auteur d'une saisie ou d'un retrait par l'équipe** (`actor_user_id`, identifiant opaque de la session
  du dashboard ; vide quand c'est le client lui-même). Les lignes antérieures à la migration n'ont que
  l'empreinte. Une déclaration du restaurateur dans le dashboard reste une preuve plus fragile qu'un accord
  donné par le client lui-même ; l'auteur n'est pas inclus dans l'export RGPD du client (l'export liste les
  permissions, pas le journal). Toujours **non fait** : la double confirmation par e-mail.
- **Suivi des ouvertures et des clics : désactivé par défaut pour le pilote.** L'accord pour recevoir des
  offres ne vaut pas accord pour suivre individuellement leur ouverture ou leurs clics (recommandation CNIL
  sur les pixels, avril 2026 : certains usages exigent un consentement, d'autres une exemption encadrée).
  N'activez pas les événements `opened` / `clicked` dans Resend, et vérifiez dans le domaine Resend que le suivi
  des ouvertures et des clics est coupé. L'attribution réservation/visite (identifiants, cookies éventuels,
  rapprochements CRM, finalité, conservation) est à qualifier séparément avant l'étape H.
- **Information complète à proximité de la case** : la case ne remplit pas l'obligation d'information
  (RGPD art. 13). Un lien « Informations sur le traitement de vos données » (`/privacy`) est affiché sous les
  cases, mais cette notice est encore « en cours de finalisation » : responsable, finalités, destinataires,
  durées, droits, contact et transferts hors UE restent à compléter.
- **Rôles** : pour les campagnes décidées par un restaurant, qualification habituelle à confirmer : le
  restaurant est responsable du traitement, Sokar sous-traitant, Resend sous-traitant ultérieur. Le DPA Resend
  signé ne règle pas toute la chaîne : contrat restaurant–Sokar, sous-traitance ultérieure, conservation et
  transferts hors UE doivent être documentés. Une réutilisation par Sokar pour ses propres finalités exige une
  analyse distincte.
- **Expéditeur** : le message doit rendre identifiable le restaurant pour lequel il est envoyé. Un e-mail
  marketing part de `MARKETING_EMAIL_FROM` (par exemple `bonjour@news.suppernote.com`), avec le nom du restaurant
  comme nom affiché et son adresse en `Reply-To` (`managerEmail`, la seule adresse e-mail du restaurant dans le
  schéma). Sans `MARKETING_EMAIL_FROM`, le worker refuse l'envoi (`MARKETING_EMAIL_FROM_MISSING`) et ne se rabat
  jamais sur `EMAIL_FROM` (`noreply@suppernote.com`), réservé aux transactionnels.
- **Pas de double confirmation** : l'adresse saisie n'est pas vérifiée par un e-mail de confirmation. Ce
  n'est pas une obligation générale pour toute newsletter, mais une mesure recommandée ici pour réduire les
  inscriptions avec l'adresse d'autrui et renforcer la preuve. Une personne peut cocher la case avec l'adresse
  de quelqu'un d'autre ; la désinscription ultérieure ne remplace jamais l'autorisation préalable.
  Acceptable pour le pilote (adresses de test, personnes informées), à ajouter avant d'écrire à de vrais
  clients (jeton signé et état « en attente de confirmation » : phase suivante, non faite).
- **Adresse enregistrée seulement avec l'accord** : l'adresse saisie sur la page de réservation est gardée
  sur la réservation, comme le téléphone, pour envoyer la confirmation (`reservations.customer_email`,
  anonymisée avec la réservation). Elle n'est rattachée à la fiche client que si le client coche la case
  e-mail (formulaire ou lien de la confirmation), et jamais en remplacement d'une adresse déjà connue (dans
  ce cas, l'accord n'est pas enregistré).
- **E-mail de confirmation** : après une réservation web confirmée avec une adresse, un e-mail transactionnel
  part depuis `EMAIL_FROM` (outbox `reservation-confirmation-email`, une fois par réservation). Il ne contient
  aucune offre. La ligne « Recevoir les offres et actualités du restaurant {restaurant} » y figure seulement si
  `marketingEmailConsentStatus` l'autorise (adresse de la confirmation, pas d'accord ni de retrait, pas
  d'opposition). Sans `MARKETING_OPTOUT_HASH_SECRET` ou `MARKETING_UNSUBSCRIBE_SECRET`, la confirmation part
  sans la ligne.
- **Où les cases apparaissent** : sur le formulaire de réservation en ligne du dashboard, servi sur
  `suppernote.com`, les sous-domaines et les domaines personnalisés (`/widget/<slug>`, `/book/<slug>`,
  `embed.js`). Uniquement sous le formulaire de coordonnées, après l'adresse (case e-mail) ou le
  téléphone (case SMS) saisis. Le consentement n'est jamais une condition pour réserver. Le texte
  « Facultatif, sans effet sur votre réservation. Désinscription possible à tout moment. » est affiché sous les cases.
- **Retrait** : par le client avec le lien de désinscription de chaque message ; par le restaurant depuis la
  fiche client (« Retirer l'accord », avec confirmation).
- **Non couvert** : l'agent vocal (aucun accord recueilli à l'appel), la liste d'attente Connect, le widget
  embarqué `apps/widget` (gelé avant production ; le champ API optionnel `marketingConsent` de
  `POST /public/r/:slug/confirm` est prêt à l'emploi).

## 5. Liste de vérification du pilote (adresses de test seulement)

Faites les étapes dans l'ordre. Chaque étape a un critère de réussite ; s'il n'est pas atteint, arrêtez-vous.
Recommandation : déroulez tout d'abord sur **staging** (sans verrou de déploiement), puis répétez en
production la fenêtre d'envoi.

### Étape A — Configuration (aucun envoi)

| #   | Action                                                                                                                                                                                                                                                                                                                                                            | Critère de réussite                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Resend : domaine `suppernote.com` vérifié (DKIM `resend._domainkey`, retour `send.suppernote.com`), clé d'envoi présente dans `RESEND_API_KEY`, `EMAIL_FROM` = `noreply@suppernote.com`, `MARKETING_EMAIL_FROM` = `bonjour@news.suppernote.com` (domaine `news.suppernote.com` vérifié)                                                                           | Tableau de bord Resend : domaine « Verified » ; `readiness.email.missing` vide                                                      |
| A2  | DNS : SPF racine avec Google, DMARC `_dmarc.suppernote.com` (voir `email-sms-deliverability.md`, absents à la date du 17/10, à reconfirmer)                                                                                                                                                                                                                       | `dig TXT suppernote.com` et `dig TXT _dmarc.suppernote.com` renvoient les valeurs attendues                                         |
| A3  | Resend → Webhooks : endpoint `https://api.suppernote.com/marketing/webhooks/resend` (staging : `api-staging.suppernote.com`), événements `email.sent`, `delivered`, `bounced`, `complained`, `failed`, `suppressed` (**pas** `opened` ni `clicked` : voir §4, suivi des ouvertures et des clics). Copier le secret de signature dans `RESEND_WEBHOOK_SECRET`      | `readiness.email.callbackConfigured` = `true` ; l'historique du webhook Resend montre des réponses 200 (et aucune 403 de signature) |
| A4  | Poser `MARKETING_UNSUBSCRIBE_SECRET` (≥ 32 caractères, distinct de l'attribution), `MARKETING_ATTRIBUTION_SECRET`, `MARKETING_OPTOUT_HASH_SECRET` (≥ 32 caractères, **à sauvegarder** : sans elle aucun envoi, et la perdre rend le registre d'opposition inutilisable), et `MARKETING_UNSUBSCRIBE_BASE_URL` = `https://api.suppernote.com/marketing/unsubscribe` | `GET` d'un lien généré affiche la page de confirmation sur le bon domaine                                                           |
| A5  | `MARKETING_WHATSAPP_ENABLED=false`, `MARKETING_SENDS_ENABLED=false`                                                                                                                                                                                                                                                                                               | `GET /marketing/providers/readiness` : `sendsEnabled=false`, `whatsapp.configured=false`                                            |
| A6  | `MARKETING_RECIPIENT_ALLOWLIST=<adresse-1>,<adresse-2>` (vos adresses de test, en minuscules)                                                                                                                                                                                                                                                                     | `readiness.recipientAllowlistActive=true` (la liste elle-même n'est jamais renvoyée)                                                |
| A7  | Chez Suppernote a la capacité `marketing.campaigns` (plan Pro)                                                                                                                                                                                                                                                                                                    | Le menu Marketing du dashboard s'ouvre sans message de plan                                                                         |

### Étape B — Destinataires de test et consentement

| #   | Action                                                                                                                                                                                                                                                                            | Critère de réussite                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Créez une réservation de test sur `/book/<slug-du-restaurant>` pour **chaque** adresse de test (ou utilisez un client existant à votre nom) : la fiche CRM `/dashboard/customers/crm/<id>` apparaît avec son e-mail                                                               | Chaque testeur a une fiche CRM avec e-mail renseigné                                                                                                           |
| B2  | Sur chaque fiche, ajoutez l'étiquette `pilote-email` (clé minuscule, séparée par des tirets)                                                                                                                                                                                      | L'étiquette est visible sur la fiche                                                                                                                           |
| B3  | Enregistrez le consentement e-mail de chaque testeur : soit en cochant la case e-mail à la réservation de test, soit dans la fiche client (« Consentement marketing » → « Enregistrer un accord », méthode « À l'oral, sur place » ou autre, adresse e-mail requise sur la fiche) | La fiche affiche « Accord donné le … » avec la source ; `GET /crm/customers/<id>/marketing-permissions` renvoie `EMAIL`, `OPTED_IN`, `proofVersion` renseignée |
| B4  | Gardez un testeur **sans** consentement et un testeur déjà « désinscrit » : ils servent de témoins                                                                                                                                                                                | Ils figureront dans les exclusions de l'aperçu (étape C)                                                                                                       |

Équivalent par API, sans interface (jeton de session Clerk d'un Owner/Manager dans `$TOKEN`, ne le collez nulle part) :

```bash
curl -sS -X PUT "https://api.suppernote.com/crm/customers/<id-client>/marketing-permissions/EMAIL" \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"status":"OPTED_IN","source":"PILOT_INTERNAL","proofVersion":"pilote-interne-2026-11","proof":"Accord donné par le titulaire de l'\''adresse pour recevoir de Chez Suppernote (envoi opéré par Suppernote) les e-mails de test du pilote marketing, du <début> au <fin>, sans offre commerciale réelle, retirable à tout moment"}'
```

### Étape C — Segment, brouillon, aperçu (toujours sans envoi)

| #   | Action                                                                                                                                                                                             | Critère de réussite                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | `/dashboard/marketing/segments` : segment « Pilote e-mail » = étiquette `pilote-email` (règle `tag` / `EXISTS` / `pilote-email`)                                                                   | L'aperçu donne exactement le nombre de testeurs étiquetés                                                                                                    |
| C2  | `/dashboard/marketing/campaigns/new` : canal E-mail, objet « Pilote Suppernote — test », corps avec `{{customer.firstName}}`, `{{restaurant.name}}`, `{{reservationLink}}` et `{{unsubscribeUrl}}` | Brouillon créé ; `audienceCount` = nombre de testeurs avec consentement ; le témoin sans consentement apparaît en `NO_CONSENT`, le désinscrit en `OPTED_OUT` |
| C3  | Aperçu de la campagne et test « gérant » (dry-run)                                                                                                                                                 | `providerContacted=false`, aucun message créé, coût estimé `PRICED` ou `NOT_AVAILABLE` (jamais d'erreur)                                                     |
| C4  | Préparer la campagne (`READY`)                                                                                                                                                                     | Statut `READY` ; audience figée = celle de C2                                                                                                                |

**Point d'arrêt** : si l'effectif de C2 diffère du nombre de testeurs attendu, n'allez pas plus loin.

### Étape D — Fenêtre d'envoi (action de votre part uniquement)

| #   | Action                                                                                                                                                                        | Critère de réussite                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Vérifiez `recipientAllowlistActive=true`, puis passez `MARKETING_SENDS_ENABLED=true` et rechargez API et workers. **Production : aucun déploiement pendant la fenêtre (§3).** | `readiness.sendsEnabled=true`                                                                                                                                          |
| D2  | Lancez l'envoi de la campagne `READY` (bouton Envoyer ou `POST /marketing/campaigns/:id/send`)                                                                                | Statut `SENDING` puis `SENT` ; `acceptedCount` = nombre de testeurs ; zéro `FAILED`                                                                                    |
| D3  | Contrôlez les boîtes de réception (et le dossier spam)                                                                                                                        | Chaque testeur reçoit **un** message, expéditeur « Suppernote », réponse vers `hello@suppernote.com`, lien de désinscription cliquable, bouton natif « Se désabonner » |
| D4  | Contrôlez les callbacks                                                                                                                                                       | Messages en `DELIVERED` (`deliveredCount`) ; aucune ligne `OPEN` dans `/api/internal/marketing/reconciliation` (avec `SOKAR_INTERNAL_MARKETING_TOKEN`)                 |
| D5  | **Remettez aussitôt** `MARKETING_SENDS_ENABLED=false` et rechargez                                                                                                            | `readiness.sendsEnabled=false`                                                                                                                                         |

### Étape E — Désinscription de bout en bout

| #   | Action                                                                              | Critère de réussite                                                                                                           |
| --- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| E1  | Un testeur ouvre le lien de désinscription reçu                                     | Page « Ne plus recevoir ces messages ? » ; **rien n'est encore modifié** (`GET …/marketing-permissions` toujours `OPTED_IN`)  |
| E2  | Il clique sur « Me désinscrire »                                                    | Page « Vous êtes désinscrit » ; permission `EMAIL` = `OPTED_OUT`, source `UNSUBSCRIBE_LINK`, événement horodaté dans la fiche |
| E3  | Créez un second brouillon sur le même segment, aperçu d'audience                    | Le testeur désinscrit est exclu (`OPTED_OUT`), l'effectif baisse de 1                                                         |
| E4  | (Optionnel) le bouton natif « Se désabonner » de Gmail/Outlook sur un autre testeur | Même résultat qu'en E2 (réponse 200 du POST)                                                                                  |
| E5  | Vérifiez le message d'un lien falsifié ou expiré                                    | Page « Ce lien n'est plus valide », aucune modification                                                                       |

Si un nouvel envoi était nécessaire pour prouver l'exclusion côté worker, refaites D1–D5 : le message du
désinscrit doit finir `CANCELLED` avec `OPTED_OUT`, sans appel Resend.

### Étape F — Rebond et plainte (optionnel, prouve la suppression automatique)

Resend fournit des adresses de test (`delivered@resend.dev`, `bounced@resend.dev`, `complained@resend.dev`,
à reconfirmer dans sa documentation). Créez une fiche par adresse, consentement et étiquette comme à l'étape B,
ajoutez-les à `MARKETING_RECIPIENT_ALLOWLIST`, envoyez, puis :

| Critère de réussite                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------- |
| `bounced@resend.dev` → message `BOUNCED`, suppression `HARD_BOUNCE` ; `complained@resend.dev` → `COMPLAINED`, suppression `COMPLAINED` |
| L'aperçu d'audience suivant les exclut (`SUPPRESSED:HARD_BOUNCE` / `SUPPRESSED:COMPLAINED`)                                            |

### Étape G — Coûts et rapprochement (P3)

| Action                                                | Critère de réussite                                                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /marketing/campaigns/:id/report` et `report.csv` | Compteurs audience / acceptés / livrés cohérents avec les boîtes ; le CSV ne contient aucune adresse                         |
| Événements d'usage (`EMAIL_MESSAGES`) de la campagne  | Un par message accepté, identifiant Resend rapproché du `providerMessageId` du message                                       |
| Rapprochement                                         | `/api/internal/marketing/reconciliation?status=OPEN` vide                                                                    |
| Coût réel e-mail                                      | Aujourd'hui `NOT_AVAILABLE` tant qu'aucun tarif Resend n'est rapproché : notez le coût réel du plan (Free = 0 € à ce volume) |

### Étape H — Attribution (P4)

| Action                                             | Critère de réussite                                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Un testeur clique `{{reservationLink}}` et réserve | Le rapport indique un clic puis une conversion `RESERVATION_CREATED`                                                       |
| La visite est marquée honorée dans le dashboard    | Conversion `RESERVATION_HONORED` ; annuler la réservation désactive la conversion sans effacer l'historique                |
| Comparer à une période de référence                | Le rapport garde séparés réservations, visites honorées, revenus estimés et revenus confirmés ; aucune affirmation causale |

### Étape I — Fermeture

`MARKETING_SENDS_ENABLED=false`, supprimer ou conserver la liste blanche (à votre choix, elle protège),
exporter le rapport, ajouter une entrée au Journal, mettre à jour les bloqueurs de `P3_MARKETING` et
`P4_ATTRIBUTION` dans `product-gates.json` (en PR distincte).

## 6. Ce qui reste à faire par vous

1. **Resend** : confirmer le domaine vérifié, créer le webhook (A3) et laisser les événements
   d'ouverture/clic désactivés (§4) ; copier le secret dans l'`.env` du VPS (staging puis production).
2. **Secrets et drapeaux sur le VPS** : poser `MARKETING_UNSUBSCRIBE_SECRET`, `MARKETING_ATTRIBUTION_SECRET`,
   `MARKETING_UNSUBSCRIBE_BASE_URL`, `MARKETING_EMAIL_FROM`, `MARKETING_RECIPIENT_ALLOWLIST` ; décider qui ouvre la fenêtre
   `MARKETING_SENDS_ENABLED=true` (voir le verrou de déploiement du §3). Je n'y ai pas touché.
3. **DNS** : reconfirmer SPF/DMARC chez Cloudflare.
4. **Choisir les testeurs** : liste des adresses réelles (hors dépôt), avec leur accord.
5. **Recueil du consentement** : les cases existent désormais (Connect, fiche client). Il reste à les
   valider : parcours réel sur staging avec une réservation de test (case cochée, puis non cochée), et
   décision sur la confirmation par e-mail (§4). L'agent vocal, la liste d'attente et le widget gelé ne
   recueillent encore rien.
6. **Base légale** : valider le texte de consentement proposé et décider la durée de conservation de la preuve (§4).
7. **Verrou de déploiement** : décider entre fenêtre courte sans déploiement et retrait du flag du profil
   `core-operator-foundations`.
8. **Telnyx** : toujours en attente du support (40008) ; hors périmètre de ce pilote.
9. **Revue et fusion** de la PR qui accompagne ce document (correctifs du §2).

## 7. Retour arrière

La migration `20261023120000_marketing_opt_out_register` est additive (voir la PR du registre) ; le retrait du code se fait avant celui de la migration. Pour couper : `MARKETING_SENDS_ENABLED=false` et rechargement ; les messages
`PENDING` restent en attente et la campagne peut être annulée (`POST /marketing/campaigns/:id/cancel`).
Les suppressions créées automatiquement se retirent une à une en base (ligne `marketing_suppressions`) après
vérification de l'adresse concernée. **Retirer une suppression ne recrée pas un consentement** : une plainte
ou une opposition réelle ne se retire jamais ; seule une erreur technique ou un rebond établi comme tel peut
l'être, par une procédure documentée qui distingue ces trois cas (l'opposition doit être prise en compte
durablement).
