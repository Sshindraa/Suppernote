# Délivrabilité des e-mails et des SMS

Audit du 17 octobre 2026 (production). Les constats SMS de cette date sont historiques ; voir la mise à jour du 24 octobre ci-dessous.

## Bascule des SMS vers Brevo — 15 novembre 2026

Telnyx route les numéros portés vers l’opérateur d’origine (bug confirmé par son support) : 12 SMS sur 16
vers la France refusés en `40008`. L’envoi passe donc par Brevo, derrière `SMS_PROVIDER` (global, `telnyx`
par défaut). La voix, WhatsApp et la route entrante `/sms/telnyx/inbound` restent chez Telnyx.

**Réponses OUI/NON** : impossibles avec Brevo tant que l’expéditeur est un nom (« Suppernote »). Brevo ne
transmet les réponses que par e-mail à l’adresse de connexion du compte, et seulement si l’expéditeur est un
numéro : « If you use a text sender, there will be no way to link the recipient to the sender and the SMS
response will fail » ([Brevo, Receive and reply to SMS messages by email](https://help.brevo.com/hc/en-us/articles/209447465)).
Les liens de gestion de réservation restent la voie de réponse.

**Webhook de livraison** : Brevo ne signe pas ses webhooks ; il publie seulement ses plages IP
(`1.179.112.0/20`, `172.246.240.0/20`, [liste Brevo](https://help.brevo.com/hc/en-us/articles/15127404548498)).
La route `/sms/brevo/events` exige donc le jeton `BREVO_SMS_WEBHOOK_SECRET` dans l’URL ; un filtrage IP Nginx
peut s’ajouter. Compteur Prometheus : `suppernote_brevo_sms_events_total{status}`. Statuts : `sent`/`accepted` → `sent`, `delivered` → `delivered`, `soft_bounce`,
`hard_bounce`, `rej`, `bl`, `skip` → `delivery_failed` ; `replied`, `subscribe`, `unsubscribed` ignorés. Le
dernier statut est gardé 7 jours dans Redis : il sert de relecture pour la réconciliation (Brevo n’a pas de
lecture par identifiant) et rend les doublons sans effet. Coût : provider `brevo`, non tarifé.

### Bascule (prod ou staging)

1. Attendre la validation de l’ID d’expéditeur « Suppernote » pour la France chez Brevo.
1. Vérifier que le vhost déployé coupe le journal d’accès de `/sms/brevo/events` (le jeton est dans l’URL).
   Le déploiement l’installe (`scripts/deploy.sh` → `install-nginx`, qui lance `nginx -t`) ; sinon, en root :
   `sudo /usr/local/sbin/sokar-deploy-root install-nginx prod` (ou `staging`). Contrôle :
   `grep -A2 'location = /sms/brevo/events' /etc/nginx/sites-enabled/sokar` doit montrer `access_log off;`.
1. Dans le `.env` de l’environnement, avec sauvegarde `.env.bak-sms-provider-<date>` :
   `BREVO_SMS_WEBHOOK_SECRET=<openssl rand -hex 32>`, puis `SMS_PROVIDER=brevo`. `BREVO_API_KEY` est déjà posé ;
   `BREVO_SMS_SENDER` seulement si l’expéditeur validé diffère de `Suppernote`. `PUBLIC_API_URL` doit viser
   l’environnement (sinon les événements de staging arrivent en prod).
1. Redémarrer API et workers sans `--update-env`, avec 0 appel vocal en cours ; vérifier `pm2 jlist` et
   `/health`.
1. Un seul SMS de test vers un numéro de l’équipe ; attendre l’événement `delivered` dans les journaux
   (`Brevo SMS delivered`) et la réception sur le téléphone.

### Retour à Telnyx

Mettre `SMS_PROVIDER=telnyx` (ou retirer la ligne), redémarrer de la même façon. Les SMS déjà envoyés par
Brevo gardent leur suivi : la route `/sms/brevo/events` reste active et les identifiants numériques Brevo sont
relus côté Brevo.

## SMS en production — 24 octobre 2026

- Relevé en lecture seule : API et workers en ligne, `/health` et `/livez` verts ;
  `TELNYX_SMS_FROM=SUPPERNOTE` et profil de messagerie configurés.
- `smsConfirmEnabled=false` sur les trois restaurants après désactivation de deux
  fiches dormantes sans slug public ni réservation ; Chez Suppernote démo était déjà
  off. `WHATSAPP_ENABLED=false` et `MARKETING_WHATSAPP_ENABLED=false`.
- Un seul SMS technique a été envoyé via l’API Telnyx (1 segment), sans
  créer de réservation. Telnyx l’a accepté puis son reçu final a indiqué
  `delivery_failed`, code `40008`. Telnyx définit ce code comme **Undeliverable**,
  rejeté par l’opérateur destinataire ; le reçu ne donne pas la cause précise
  ([codes d’erreur Telnyx](https://support.telnyx.com/en/articles/6505121-telnyx-messaging-error-codes)).
- Identifiant fournisseur : `4031a16d-f4fc-4ff0-9883-f72664271eb9`. Aucun rejeu.

Garder les notifications de réservation et WhatsApp désactivées. Demander à
Telnyx la cause précise du `40008` et les conditions d’autorisation de
l’expéditeur avant tout nouvel essai ; après correction, refaire un seul test
contrôlé et exiger le statut `delivered` ainsi que la réception sur le téléphone.

## E-mails

| Élément                     | État                                                                                                                           | Action                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Envoi applicatif            | Resend, `noreply@suppernote.com`, signature DKIM `resend._domainkey` et retour `send.suppernote.com` (SPF Amazon SES) présents | Rien                                                            |
| Nom affiché                 | Adresse nue, affichée « noreply »                                                                                              | Corrigé : `Suppernote <noreply@suppernote.com>` (`emailSender`) |
| Réponses                    | Partaient vers `noreply`                                                                                                       | Corrigé : `Reply-To: hello@suppernote.com` (`EMAIL_REPLY_TO`)   |
| Adresse de secours du code  | une adresse de secours sur un domaine non vérifié                                                                              | Corrigé                                                         |
| Clerk (connexion)           | DKIM `clk`/`clk2` et `clkmail` présents                                                                                        | Rien                                                            |
| Google Workspace (`hello@`) | DKIM `google._domainkey` présent, mais **SPF racine sans Google**                                                              | DNS ci-dessous                                                  |
| DMARC                       | **Absent** (exigé par Gmail et Yahoo pour les envois en volume)                                                                | DNS ci-dessous                                                  |

### Enregistrements à poser chez Cloudflare

1. Remplacer le SPF racine `suppernote.com` (TXT) par :

   ```text
   v=spf1 include:_spf.google.com include:mail.qald09162xf0.clerk.services ~all
   ```

2. Ajouter `_dmarc.suppernote.com` (TXT) :

   ```text
   v=DMARC1; p=none; rua=mailto:hello@suppernote.com; adkim=r; aspf=r
   ```

   Lire les rapports deux à quatre semaines, puis passer à `p=quarantine` quand Resend, Clerk et
   Google sortent tous alignés.

### État historique du 17 octobre

| Élément                     | État                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Numéro `TELNYX_FROM_NUMBER` | Numéro fixe (« longcode »), **rattaché à aucun profil de messagerie**, compteur Telnyx à 0 : aucun SMS n'est parti en production |
| Profil de messagerie        | « Sokar transactional » existe (destinations FR), mais `TELNYX_MESSAGING_PROFILE_ID` n'est pas configuré                         |
| WhatsApp                    | `TELNYX_WHATSAPP_FROM` configuré ; le rappel J-1 tente WhatsApp puis bascule sur SMS                                             |

Le code accepte désormais `TELNYX_SMS_FROM`, distinct du numéro d'appel.

### Réglage recommandé

1. Dans la console Telnyx, profil « Sokar transactional » : activer un identifiant alphanumérique
   `SOKAR` (vérifier les conditions françaises affichées par Telnyx).
2. Dans `/opt/sokar/apps/api/.env` (et staging) : `TELNYX_MESSAGING_PROFILE_ID=<id du profil>` et
   `TELNYX_SMS_FROM=SUPPERNOTE`, puis redémarrer l'API et les workers.
3. Envoyer un SMS de test vers un téléphone de l'équipe et vérifier sa réception.

Un identifiant alphanumérique ne reçoit pas de réponse : les clients ne peuvent plus répondre OUI
ou NON par SMS (le rappel ne le demande pas ; WhatsApp reste possible). Pour des réponses par SMS,
il faut un numéro dédié à la messagerie, à demander à Telnyx pour la France.
