# Délivrabilité des e-mails et des SMS

Audit du 17 octobre 2026 (production). Les constats SMS de cette date sont historiques ; voir la mise à jour du 24 octobre ci-dessous.

## SMS en production — 24 octobre 2026

- Relevé en lecture seule : API et workers en ligne, `/health` et `/livez` verts ;
  `TELNYX_SMS_FROM=SOKAR` et profil de messagerie configurés.
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
   `TELNYX_SMS_FROM=SOKAR`, puis redémarrer l'API et les workers.
3. Envoyer un SMS de test vers un téléphone de l'équipe et vérifier sa réception.

Un identifiant alphanumérique ne reçoit pas de réponse : les clients ne peuvent plus répondre OUI
ou NON par SMS (le rappel ne le demande pas ; WhatsApp reste possible). Pour des réponses par SMS,
il faut un numéro dédié à la messagerie, à demander à Telnyx pour la France.
