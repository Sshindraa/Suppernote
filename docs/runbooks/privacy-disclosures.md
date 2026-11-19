# Confidentialité : sources et limites des informations publiées

Révision locale du 16 octobre 2026. Les engagements publics sont distingués des
constats de compte : formule et région Workspace consultées, ATDC accepté sur
autorisation ; plan et documents Resend consultés en lecture seule. Les autres
comptes ne sont pas inspectés. Ce document ne vaut pas validation juridique de
la politique.

## Source commune

`packages/shared/src/privacy.ts` fournit uniquement la notice publique : catégories
fonctionnelles de destinataires, conservation, droits et réserves utiles aux
personnes concernées, pour les trois surfaces :

- Dashboard : `apps/dashboard/src/app/privacy/page.tsx`.
- Connect : `apps/connect/src/app/privacy/page.tsx`.
- API : `apps/api/src/modules/rgpd/privacy-policy.ts`, exposé par
  `GET /api/rgpd/privacy-policy`.

La liste nominative ne fait plus partie du paquet partagé ni du texte public de
l'API. Elle est préparée dans `privacy-client-annex.md`, projet de documentation
client non publié et non validé contractuellement. Le présent document conserve
les preuves et les limites techniques internes. Aucun portail ni envoi automatique
de cette annexe n'est implémenté : sa communication et sa mise à jour contractuelles
restent à organiser avant de présenter la documentation client comme finalisée.

Les listes internes identifient les chemins intégrés dans le code. Une option, un secours
ou une expérimentation n'est pas présenté comme actif pour tous les clients.
PostgreSQL et Redis sont des composants auto-hébergés, pas des fournisseurs
externes distincts d'OVHcloud. Aucun usage actif de Twilio, Brevo ou Postmark
n'a été identifié dans les chemins décrits ; ils sont retirés des mentions.

## Fournisseurs et preuves locales

| Fournisseur                  | Chemin constaté                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| OVHcloud                     | Hébergement confirmé dans `docs/audits/2026-10-13-growth-execution.md`, §10.36–10.39 ; région contractuelle non prouvée |
| Cloudflare                   | `infra/nginx/sokar.conf`, `apps/api/src/modules/connect/cloudflare-saas.service.ts`                                     |
| Clerk                        | `apps/api/src/plugins/clerk.ts`                                                                                         |
| Resend                       | `apps/api/src/shared/email/index.ts`, notifications de démonstration                                                    |
| Google Workspace             | Messagerie de réception confirmée dans l'audit §10.39 et le runbook des demandes de démo                                |
| Google Places                | `apps/api/src/modules/connect/google-places.service.ts`                                                                 |
| Cerebras                     | `apps/api/src/modules/voice/llm-provider.ts`                                                                            |
| OpenRouter et modèles routés | `apps/api/src/modules/voice/stream/manager.ts`, analyses sémantiques                                                    |
| ElevenLabs / Cartesia        | `apps/api/src/modules/voice/stream/tts-handler.ts`, `stt-bridge.ts`                                                     |
| Deepgram                     | `apps/api/src/modules/voice/stream/stt-bridge.ts`, `apps/api/src/modules/voice/call-report/job-runtime.ts`              |
| Stripe                       | Modules de paiement, notamment `apps/api/src/modules/experiences/experience-payment.service.ts`                         |
| Sentry                       | `apps/api/src/shared/sentry/client.ts`, configuration par DSN                                                           |
| Respan                       | `apps/api/src/modules/voice/stream/semantic-signals/shadow.ts`, option expérimentale                                    |

Le stockage audio est compatible S3 et configurable. Le SDK utilisé ne suffit
pas à identifier son fournisseur réel, son pays ou le contrat souscrit : ces
éléments restent explicitement ouverts, sans attribuer ce stockage à AWS par
déduction ni le confondre avec l'hébergement principal.

## Conservation : règle et exécution

| Données                                | Source / limite constatée                                                                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Démonstrations                         | `demo-request-retention.md` : règle validée à 12 mois, revue et suppression manuelles ; rappel sans effacement                                                                                  |
| Comptes, restaurants, clientèle        | Aucun délai global appliqué à trois ans établi par cette revue ; échéances à valider                                                                                                            |
| Anciennes réservations                 | `anonymization.service.ts` : création antérieure à 730 jours et absence de réservation par téléphone dans les 180 derniers jours ; worker désactivé par défaut, champs de réservation seulement |
| Audio de test                          | `call-recording.service.ts` : expiration 1–30 jours après stockage ; accès bloqué après expiration ; purge quotidienne dans `schedulers.ts` et `telnyx-webhook.worker.ts`                       |
| Rapports audio                         | Supprimés avec l'audio par la purge ; copies chez Telnyx non couvertes par cette suppression                                                                                                    |
| Dialogue de diagnostic                 | `stream/debug-dialogue.ts` : expiration 14 jours et purge quotidienne ; masquage téléphone/e-mail, pas anonymisation complète                                                                   |
| Transcriptions et métadonnées d'appels | Distinctes des fichiers audio ; aucun délai global ni effacement intégral de transcription établi                                                                                               |
| Journaux serveur                       | `infra/logrotate/sokar` : rotation quotidienne, 14 archives, `notifempty` ; pas une garantie stricte de 14 jours calendaires, ni une règle applicable à Sentry                                  |
| Pièces comptables                      | Obligation de 10 ans pour les pièces concernées ; pas pour toutes les données Stripe. Archivage effectif à vérifier                                                                             |
| Sauvegardes / copies fournisseurs      | Cycles et suppression à vérifier séparément ; aucune promesse d'effacement immédiat                                                                                                             |

La purge audio dépend notamment du maintien du traitement d'enregistrement actif.
L'expiration technique ne prouve pas à elle seule la suppression de l'objet. La
revue ne lit pas les variables distantes et ne prouve pas une exécution en
production. Aucune purge ni activation de traitement n'est effectuée.

## Compatibilité de l'API et consentements

La réponse conserve `summary` et `text`, ainsi que les champs historiques de
`summary` et leurs types. `retentionDays: 730` est conservé pour compatibilité et
qualifié par `retentionDaysMeaning` et `anonymizationReference` : il représente
le seuil du mécanisme de réservation, pas une durée globale d'effacement.
`automaticAnonymizationGuaranteed: false`, `retentionRules`, `providers`,
`status` et `documentationRevision` complètent la réponse. `providers`, ajouté
dans ce lot local non livré, contient désormais cinq catégories fonctionnelles
et non la liste nominative. Le seuil historique et sa qualification restent
exposés pour compatibilité ; les détails des fournisseurs et les paramètres
d'implémentation ne figurent plus dans la notice publique.

La version du texte corrigé est `v1.1-2026-10-16`, enregistrée uniquement pour
les nouveaux consentements lors de son utilisation. Les consentements historiques
conservent leur propre version, notamment `v1.0-2026-06` ; aucune réécriture ni
demande automatique de renouvellement n'est introduite. Cette correction de la
description des traitements ne change ni finalité ni option de consentement.
Une évolution future des traitements ou finalités exige sa propre décision de
version et de déploiement, distincte de cette harmonisation locale.

## Vérification documentaire Resend et Google — 16 octobre 2026

Statut : documentation officielle vérifiée ; compte Workspace consulté le
16 octobre 2026, puis seul ATDC accepté après autorisation spécifique ; compte
Resend consulté en lecture seule (plan et Documents). Les
faits ci-dessous ne sont pas une attestation de conformité de Sokar. Ils restent
internes ; aucune liste technique supplémentaire n'est ajoutée à la notice publique.

### Resend

[La documentation RGPD officielle](https://resend.com/security/gdpr) indique :

- DPA standard applicable à tous les plans dès l'inscription, sans contresignature
  séparée ; copie signée disponible dans l'espace Documents du compte.
- Contenus et journaux stockés aux États-Unis ; une région européenne d'envoi ne
  déplace pas ce stockage.
- Conservation des e-mails et journaux de 30 jours sur Free, Pro et Scale ;
  conditions particulières possibles en Enterprise.

[Le DPA public](https://resend.com/legal/dpa), daté du 31 décembre 2025, identifie
Plus Five Five, Inc., incorpore les clauses contractuelles types et prévoit dans
son annexe A un effacement sous 90 jours après résiliation du compte.
[La page sécurité](https://resend.com/security) annonce sept jours de sauvegardes.
Ces échéances décrivent des périmètres distincts : ne pas les additionner en une
durée unique, ni les confondre avec la règle Sokar des demandes sans suite à douze mois.

Constats du compte le 16 octobre 2026 :

- Settings > Usage : offre **Transactional Free** affichée. Aucun changement de
  plan ni activation de supplément payant effectué.
- Settings > Documents : DPA présenté comme signé par Resend et pleinement
  applicable à l'inscription. Téléchargement depuis le lien DPA de cette page,
  sans demande de signature supplémentaire.
- Copie archivée hors Git, permissions 0600, dossier privé 0700 :
  `~/.codex/private/sokar/contracts/resend-dpa-downloaded-2026-10-16.pdf`.
- SHA-256 : `f028a0d8c49850dca8ca2959ecd6e853095c55017bf72395567b787dd44c42ef`.
- PDF de 19 pages, mise à jour affichée au 31 décembre 2025 ; signature fournisseur
  visible datée du 14 janvier 2026. La rubrique client est vierge ; la section 12
  précise que les blocs sont fournis à titre de référence et renvoie à
  l'acceptation du contrat pour la prise d'effet. Ne pas présenter cette pièce
  standard comme un document signé nominativement par Sokar, ni comme une
  validation cryptographique de la signature.
- Section 6 : opérations principales aux États-Unis et clauses contractuelles
  types incorporées ; annexe A : suppression sous 90 jours après résiliation.
  Lecture des pages pertinentes et contrôle visuel de la page de signature.
- Capture privée de la page Documents :
  `~/.codex/private/sokar/contracts/resend-documents-2026-10-16.png`.

Le plan observé relève donc des 30 jours annoncés pour les e-mails et journaux
par la documentation officielle ci-dessus. Aucune purge n'est testée dans cette
revue ; confirmer séparément les demandes d'effacement anticipé, les copies des
destinataires et les anciennes notifications. Aucun message ouvert, exporté,
envoyé ou supprimé ; aucune clé API ni donnée de facturation consultée.

Observation opérationnelle : le compteur quotidien Usage dépasse le plafond Free
affiché. Contrôle complémentaire : les requêtes récentes visibles `/emails`
répondent 200 ; le filtre Errors sur les 15 jours proposés affiche 38 lignes.
La réponse de la plus récente erreur consultée (429) indique un dépassement de
cadence de **10 requêtes par seconde**, pas un dépassement du quota quotidien.
Ne pas généraliser ce diagnostic aux autres erreurs sans lire leurs réponses,
ni conclure que le quota quotidien ne pourra pas bloquer de futurs envois.
Aucun e-mail de test envoyé ; pas de demande de rejeu ni export de journaux.

Le code local du monitoring (`system-health.worker.ts` et cooldown partagé)
réémet les problèmes persistants après 30 minutes. Plusieurs problèmes distincts
peuvent donc consommer une part importante des 100 e-mails quotidiens du Free.
Ce constat explique un risque de volume ; il ne mesure pas la part exacte des
alertes dans tout le trafic et ne justifie pas de couper les alertes critiques.

Correction locale connexe : `alert-dispatcher.ts` ne marque plus un canal e-mail
comme réussi lorsque `sendEmail` retourne un refus ou un résultat inconnu. Les
autres canaux continuent et la métrique distingue succès et erreur. 39 tests
alertes/évaluateur/notifications et TypeScript API réussis. Cela ne modifie ni
la cadence ni le quota du fournisseur ; regroupement des rappels, limitation
globale inter-processus et vérification des erreurs restantes sont des travaux
distincts, sans activation ni déploiement dans cette revue.

Références : [erreurs Resend](https://resend.com/docs/api-reference/errors),
[limites des plans](https://resend.com/pricing). Pas de preuve d'effacement réel
obtenue : le diagnostic d'envoi ne clôt pas la revue de conservation, des
archives et des copies en messagerie.

La [liste officielle des sous-traitants](https://resend.com/legal/subprocessors)
fait partie des pièces à référencer pour la chaîne de traitement. Ne pas en
déduire que tous les services optionnels traitent les messages Sokar.

### Google Workspace

La [matrice Data Regions](https://knowledge.workspace.google.com/admin/compliance/data-covered-by-data-regions)
liste Business Standard et Plus avec Fundamental Data Regions, pour certaines
données au repos ; Business Starter ne figure pas dans les éditions couvertes.
Le traitement en utilisation requiert une version éligible distincte, notamment
Enterprise Data Regions. Les journaux et caches ne sont pas couverts par la
promesse régionale de cette matrice. Ni l'adresse professionnelle ni la simple
présence d'un réglage Europe ne prouvent donc un traitement intégralement européen.

Le [Cloud Data Processing Addendum](https://cloud.google.com/terms/data-processing-addendum/)
comprend des dispositions propres à Workspace. Sa section 6.1 prévoit, après
instruction de suppression de données que le client ne peut plus récupérer,
un délai maximal de 180 jours, sauf conservation imposée par la loi. La section
6.2 distingue la fin du contrat et une période de récupération pouvant atteindre
30 jours. Ce n'est pas la durée à appliquer aux échanges commerciaux Sokar.

Constat du compte Sokar le 16 octobre 2026, en lecture seule dans Google Admin :

- Facturation > Abonnements : **Google Workspace Business Starter**, état **Actif**.
- Données > Conformité > Régions de données : **Région de stockage des données au
  repos : Aucune préférence**.
- Aucun changement de formule, sélection de région ou enregistrement de réglage
  effectué. Aucun contenu de messagerie consulté.

Consultation complémentaire de Compte > Paramètres de compte > Mentions légales
et conformité : l'**Avenant relatif au traitement des données dans le cloud
(ATDC)** était affiché au statut **« Refusées »**. Après lecture du document lié
et autorisation explicite de Hamza (« Oui, accepter uniquement l'ATDC Google
Workspace »), acceptation effectuée et constatée dans la console le **16 octobre
2026**. Le document lié par le compte est
`https://admin.google.com/terms/apps/8/2/en/dpa_terms.html` (date de modification
affichée : 20 septembre 2022). Ne pas lui substituer silencieusement la version
publique actuelle comme preuve du texte accepté.

Après fermeture du panneau par OK, le statut d'acceptation et la date restent
affichés. HIPAA et la certification destinée aux clients hors EMEA sont restés
inchangés (« Refusées »). Aucune formule ni région modifiée. Preuve visuelle
locale archivée hors Git : `~/.codex/private/sokar/contracts/google-atdc-accepted-2026-10-16.png`
(dossier privé 0700, fichier 0600). Cette capture prouve le statut affiché,
pas une validation juridique de l'ensemble du contrat.
La preuve d'acceptation ferme ce point précis, pas la validation générale du
traitement, des transferts, de la conservation ou de la sécurité de Sokar.

La présence de ce menu ne rend pas Business Starter éligible à Data Regions.
Ce constat ne localise pas physiquement les messages et ne prouve ni leur
stockage en Europe ni leur stockage aux États-Unis. Ne pas annoncer une
messagerie exclusivement européenne. Contrat, traitement en utilisation,
conservation, archives et copies restent à qualifier séparément ; aucun rapport
de couverture n'a été consulté.

Procédure de vérification (les points 1 et le réglage visible du point 2 sont constatés) :

1. Dans Facturation > Abonnements : relever uniquement le nom de l'édition.
2. Selon les droits et l'édition, consulter Données > Conformité > Régions des
   données : relever le réglage de stockage, celui de traitement s'il existe,
   et le périmètre des utilisateurs concernés, sans changer de valeur.
3. Consulter le rapport de couverture lorsqu'il est disponible. Une politique
   sélectionnée n'est pas à elle seule un résultat de migration.
4. Confirmer le cadre contractuel applicable, les règles de conservation de la
   messagerie, les archives éventuelles et les copies transférées.

[Procédure officielle de consultation des régions et rapports](https://knowledge.workspace.google.com/admin/compliance/choose-a-geographic-location-for-your-data).
Si un menu ou rapport n'est pas disponible, noter « indisponible pour cette
édition ou ces droits », pas « conforme ». Ne pas recommander un changement de
formule uniquement pour fermer cette revue documentaire.

### Preuves minimales restant à recueillir

| Point                                             | Statut                        | Preuve attendue, hors Git                                                                                         |
| ------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Resend : existence du DPA standard et stockage US | Vérifié sur source officielle | Références ci-dessus ; pas de preuve de configuration Sokar déduite                                               |
| Resend : plan et DPA du compte                    | Constatés et pièce archivée   | Transactional Free ; DPA signé fournisseur téléchargé depuis Documents, copie et empreinte ci-dessus              |
| Resend : conservation et effacement réels         | Non testés                    | 30 jours annoncés pour e-mails et journaux sur Free ; sauvegardes et copies distinctes ; aucun effacement exécuté |
| Google : options et limites des régions           | Vérifié sur source officielle | Matrice et CDPA ci-dessus                                                                                         |
| Google : formule et réglage visible               | Constaté en lecture seule     | Business Starter actif ; stockage au repos : Aucune préférence                                                    |
| Google : ATDC du compte                           | Acceptation constatée         | Autorisation explicite et statut daté du 16 octobre 2026 ; preuve locale privée                                   |
| Google : transferts et conservation               | À qualifier                   | Aucune garantie régionale déduite ; suppression des messages et copies non testée                                 |
| Conservation réelle des demandes de démo          | Non vérifié                   | Revue manuelle et résultat de suppression approuvé, incluant les copies                                           |

Ne pas enregistrer ici de facture, identifiant de compte, mot de passe, clé API,
contenu de messagerie ou données de prospect. Conserver les pièces contractuelles
dans un espace privé à accès restreint et n'inscrire dans Git qu'un statut et une
référence non nominative. La formule Workspace, la page des régions et les
informations contractuelles ont été consultées dans le compte. Seul l'ATDC a
été accepté, après autorisation spécifique. Aucun autre réglage modifié ni
effacement effectué.

### Minimisation des notifications de démonstration — local uniquement

`notifyDemoRequest` ne requiert désormais que l'identifiant de demande. L'e-mail
préparé contient cette référence, un lien général vers `/admin/demo-requests`
sur `DASHBOARD_URL` et le rappel qu'un compte administrateur autorisé est requis.
Ni établissement, ni e-mail ou téléphone du prospect, ni outil ou besoin libre
ne sont transmis dans le sujet ou le corps de cette notification. Aucun identifiant
de demande ni jeton d'accès n'est placé dans le lien.

La référence reste une donnée rattachable, pas une anonymisation. La modification
n'est pas déployée : les anciennes notifications, les échanges commerciaux réels
et leurs copies doivent toujours suivre la procédure de conservation. Les
destinataires configurés, leur contrôle d'autorisation, la persistance avant envoi
et la confirmation d'acceptation fournisseur ne changent pas. 28 tests du module
démo et TypeScript API réussis, avec SDK et base simulés ; aucun e-mail envoyé.

## OpenAI via OpenRouter : conservation standard — 19 novembre 2026

Décision du 19 novembre 2026 : Hamza accepte la conservation standard d'OpenAI pour
GPT-6 Luna, modèle principal de l'assistant vocal. Faits internes, pas une attestation
de conformité de Sokar.

- Rôle : dialogue vocal (texte des échanges, dont noms et horaires cités par
  l'appelant) envoyé à OpenAI, ou à Azure en dernier recours, par OpenRouter.
- Configuration : l'ordre `openai/fast, openai, azure` est inchangé ; le code n'envoie
  plus `zdr` ni `data_collection` (`fallbackProviderPreferences` dans
  `apps/api/src/modules/voice/stream/manager.ts`). Le réglage
  `VOICE_STRUCTURED_FALLBACK_ZERO_RETENTION=false` est en production depuis le 20 octobre
  2026 : la décision aligne le code sur la production. Cerebras et Companion (qui garde
  `data_collection: deny`) ne sont pas touchés.
- À qualifier : durée de conservation et usage des contenus chez OpenAI et OpenRouter,
  garanties de transfert vers les États-Unis, DPA applicable, mention dans la notice
  publique. Rien de cela n'est vérifié à ce jour.

## Vérification documentaire ElevenLabs — 18 octobre 2026

Décision du 18 octobre 2026 : Hamza accepte la conservation des textes chez
ElevenLabs. Faits internes, pas une attestation de conformité de Sokar.

- Rôle : reconnaissance vocale Scribe (moteur par défaut, `VOICE_STT_PROVIDER`
  dans `apps/api/src/env.ts`) et synthèse vocale des réponses. Reçoit l'audio de
  l'appelant et le texte des réponses, dont noms, numéros et horaires.
- [Conditions d'utilisation](https://elevenlabs.io/terms-of-use) : le DPA régit les
  données personnelles lorsque les conditions sont acceptées pour une entité ; il
  fait partie des conditions complémentaires.
- [Politique de confidentialité](https://elevenlabs.io/privacy-policy) : Eleven Labs
  Inc. (États-Unis) ; ElevenLabs Poland sp. z o.o. pour l'EEE ; stockage aux
  États-Unis ; certification DPF limitée à l'entité américaine.
- [DPA public](https://elevenlabs.io/dpa), mis à jour le 8 avril 2026 : clauses
  types réputées signées (module 2 ou 3), droit irlandais ; en libre-service,
  suppression possible mais non garantie après 180 jours d'inactivité. La
  désactivation de la conservation (`enable_logging=false`) est réservée à
  l'offre Enterprise.

Constats du compte de production le 18 octobre 2026, en lecture seule :

- Offre **Starter** (6 $/mois, prochain paiement 7,20 $ TTC le 14 novembre). Aucun
  DPA à signer ni à télécharger dans le compte : le DPA public s'applique.
- Copie de la page DPA archivée hors Git, permissions 0600 :
  `~/.codex/private/sokar/contracts/elevenlabs-dpa-downloaded-2026-10-18.html`.
- SHA-256 : `64b840ba641fdd9647564b6ab00f1fd037b9e93899f9fc01ef390f832e97617b`.
- Page HTML de 352 947 octets, mention « Last Updated: 8 April 2026 ».
- Informations de facturation (portail Stripe) mises à jour le 18 octobre 2026
  avec l'accord de Hamza : nom « Hamza AKKIF EI – SOKAR », adresse du siège
  inchangée (SIRET 106 740 202 00010). Aucun numéro de TVA intracommunautaire à
  ce jour ; la TVA reste donc facturée. Moyen de paiement non modifié.
- Double authentification du compte désactivée : choix de Hamza le 18 octobre
  2026, à reconsidérer.
- [Sous-traitants ultérieurs](https://compliance.elevenlabs.io/subprocessors),
  consultés le 18 octobre 2026 (32 entrées) : filiales ElevenLabs (dont Pologne,
  Royaume-Uni, Irlande, Pays-Bas, Suisse, Singapour, Inde, Japon, Émirats) ;
  Google Cloud et AWS pour l'infrastructure et le stockage, hors Enterprise aux
  États-Unis, dans l'UE ou à Singapour ; Anthropic (États-Unis) et OpenAI
  (États-Unis/UE) pour des services de modèles ; outils de support (Zendesk,
  Slack, Asana) et d'analyse (PostHog, UE). La liste indique que les services de
  modèles peuvent servir à l'amélioration des produits dans la mesure permise par
  le contrat. Pas de choix de région hors Enterprise.

## Références vérifiées le 16 octobre 2026

- [Resend : DPA et localisation](https://resend.com/security/gdpr) : DPA standard
  incluant les SCC pour tous les comptes ; stockage aux États-Unis. La région
  d'envoi n'est pas une région de stockage. Copie du DPA signée fournisseur
  téléchargée depuis le compte et archivée en privé le 16 octobre 2026.
- [Google Workspace : choix d'une région](https://support.google.com/a/answer/14310028?hl=fr) :
  couverture selon l'édition et les données ; région au repos distincte du
  traitement. Compte constaté : Business Starter actif et stockage au repos
  sans préférence ; aucune couverture régionale garantie n'en est déduite.
- [CNIL : durées de conservation](https://www.cnil.fr/fr/passer-laction/les-durees-de-conservation-des-donnees) :
  durée à déterminer selon la finalité ; une fonctionnalité d'effacement ne suffit
  pas à démontrer l'application d'une politique de conservation.
- [Documents professionnels : conservation](https://entreprendre.service-public.gouv.fr/vosdroits/F10029) :
  distinguer les pièces comptables des autres catégories de données de paiement.
- [CNIL : articles 12 et 13](https://www.cnil.fr/fr/reglement-europeen-protection-donnees/chapitre3) :
  information claire et accessible ; destinataires ou catégories, transferts,
  durées ou critères de conservation. Une présentation concise ne dispense pas
  de compléter les garanties et les durées encore ouvertes.
- [CEPD : avis 22/2024](https://www.edpb.europa.eu/documents/opinion-of-the-board-art-64/opinion-222024-on-certain-obligations-following-from-the_en) :
  identité des sous-traitants et sous-traitants ultérieurs disponible pour le
  responsable du traitement ; une annexe client ne doit pas être remplacée
  par la seule possibilité de poser une question par e-mail.

Présentation comparée : [TheFork](https://www.thefork.fr/legal) regroupe les
prestataires par catégories ; [Slang AI](https://www.slang.ai/privacy-policy)
fait de même et nomme notamment Stripe (exemple américain, pas modèle juridique
français) ; [Ringover](https://www.ringover.fr/accord-traitement-donnees) publie
une annexe nominative distincte et détaillée. La séparation choisie pour Sokar
n'est pas une dispense d'information et ne prouve pas la conformité du traitement.

L'identité complète de l'éditeur/responsable, les contrats des comptes, les
régions effectives, la première revue des demandes de démonstration et la mise
en pratique des durées restent ouverts. Ces réserves ne sont pas closes par le
seul partage d'une source de texte.

## Fichiers du lot d'harmonisation

- Source commune : `packages/shared/src/privacy.ts`, `packages/shared/src/index.ts`.
- API : `apps/api/src/modules/rgpd/privacy-policy.ts` et ses tests
  `__tests__/privacy-policy.test.ts`, `__tests__/rgpd.routes.test.ts`,
  `__tests__/consent.service.test.ts`.
- Dashboard : `apps/dashboard/src/app/privacy/page.tsx` et `page.test.tsx`.
- Connect : `apps/connect/src/app/privacy/page.tsx` et `page.test.tsx`.
- Régression navigateur : `apps/connect/e2e/privacy.spec.ts`.
- Projet d'annexe client : `docs/runbooks/privacy-client-annex.md`.
- Documentation : ce runbook, `docs/obsidian/Context.md` et l'entrée dédiée de
  `docs/obsidian/Journal.md`.

`apps/dashboard/src/app/legal/page.tsx` comportait déjà la modification locale
d'adresse avant ce lot ; elle n'est pas retouchée par l'harmonisation.
Le journal contient également des ajouts concurrents : conserver ces entrées
et revoir les portions de diff lors d'une éventuelle livraison autorisée.

## Vérifications locales

La revue finale, le manifeste des fichiers à livrer et les résultats élargis
(100 tests unitaires et 4 tests navigateur) sont consignés dans
`privacy-local-review.md`. Ce manifeste distingue la page légale préexistante
et les portions concurrentes du journal.

- Construction de `@suppernote/shared` et vérifications TypeScript API, Dashboard et
  Connect réussies.
- 42 tests ciblés réussis : routes et services de consentement RGPD, seuils du
  mécanisme d'anonymisation et rendu des deux pages depuis le catalogue commun.
- Route publique vérifiée par Fastify inject, champs existants conservés.
- Pages réelles contrôlées avec Playwright en 390, 820 et 1440 pixels : réponses
  200, catégories et descriptions attendues présentes, aucun débordement
  horizontal ni erreur JavaScript. Inventaire technique absent du texte visible.
- Formatage et `git diff --check` réussis. Aucun commit, push, déploiement,
  effacement ni changement de configuration distante.
