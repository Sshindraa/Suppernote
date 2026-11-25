# Contexte Suppernote

> État courant; historique : [[Journal]]. Archives : [[archive/Context-log-2026]] (activité), [[archive/Context-decisions-2026]] (décisions).
>
> Activité → `Journal.md`; décisions >30 j → `archive/Context-decisions-2026.md`.
>
> TODOs et décisions du mois uniquement; cible <8 Ko (`scripts/quality/check-vault-size.sh`).

## TODOs actifs

### À finir

- [ ] Appel réel Chez Suppernote : valider compréhension et épellation (« A, deux S, A, M »), délai de relecture, prosodie et répétitions, confirmations, FAQ (terrasse, parking, animaux, inconnu → gérant), anti-bruit (#580, #586–#588). Lire le premier rapport (`voice_call_audio.py report <id>`, statut `linked`), puis décider du style par restaurant pour tous. Renseigner la FAQ pratique de Chez Suppernote, puis étendre à Connect, widget et MCP. Voir `voice-conversation-continuity.md` (#595).
- [ ] Renommage sokar→suppernote : palier 1 TERMINÉ (staging 24/11, prod 24/11, prod déployée 25/11). Reste : cleanup-compat (≥ 30/11, conditions §3.9 du runbook `docs/runbooks/rename-suppernote-vps.md`), publication du correctif signal du script (décision Hamza), PR #796 (groupe de concurrence deploy-prod-v2, en attente de feu vert Hamza), Deploy Production désactivé manuellement. Palier 2 en attente de décision Hamza.
- [ ] Suppernote : suivre `migration-suppernote.md` (webhooks, monogramme, paquets et démo).
- [ ] RGPD et marketing : 503 voulu, posé dans Nginx (`location ^~ /api/rgpd/` dans `infra/nginx/suppernote.conf`). #616, #620, #639 et #662 fusionnés ; reste la PR #774 en revue (cartes cadeaux, fidélité, opposition par canal), puis le test en staging (`docs/runbooks/rgpd-reopening.md`) et le retrait des lignes Nginx. Rouvrir effacement et opposition avant tout envoi marketing réel, et mentionner le ciblage dans `privacy-client-annex.md`.
- [ ] Audits locaux à qualifier en staging : retries ciblés, claims et réparations outbox (Redis, fournisseurs) ; OAuth, limites Redis, clés MCP, dédup SMS/WhatsApp ; retransmissions voix et journaux Nginx à protéger ; sessions voix en mémoire, reprise après redémarrage non garantie. L'isolation des réponses sur numéro partagé n'est pas garantie (`docs/runbooks/inbound-reply-review.md`).
- [ ] SEO : vérifier que Search Console a rattrapé les inspections du 16/11 et que l'URL racine Clerk sort de l'index (`noindex` présent) ; comparer GSC après la couverture 16–22/10 ; valider notice et annexe client, rétention, contrats Google/Resend, mentions légales (`privacy-client-annex.md`).
- [ ] Réponses SMS/WhatsApp Telnyx : définir une corrélation fiable et qualifier la revue opérateur en staging ; SMS via Brevo, Telnyx en secours. Voir `docs/runbooks/inbound-reply-review.md`.
- [ ] WhatsApp : flags off ; WEB avec consentement, téléphone SMS seul. Callbacks Meta (7 j/ID, sinon revue manuelle) ; qualifier fournisseur, abonnement et staging. Voir `whatsapp-reservation-activation.md`.
- [ ] Notifications : #484 qualifiée staging, off en prod ; WEB/outbox/WhatsApp locaux. Annulation/modification #485–#487 actives en prod (17/11), règle par défaut : 2 h avant (#770). Après délai : contact, aucun frais auto.
- [ ] Cartes cadeaux : finir le compte Stripe sandbox démo (encaissements/versements) et qualifier les notifications avant ouverture commerciale.
- [ ] Expériences : migration et qualification Stripe/CGV/TVA/notifications en staging ; garder `EXPERIENCE_BOOKING_ENABLED=false`.
- [ ] Onboarding v2 #404–#411 : numéro attribué manuellement ; valider formule, équipe/rôles, auto-attribution Telnyx et compte Stripe après audit 1.6. Paiement après onboarding ; qualifier transfert Clerk réel en staging.
- [ ] Appel en direct onboarding : compléter un appel de bout en bout avec réservation simulée (écho, latence, disponibilité, confirmation), puis déployer `microphone=(self)` (nginx prod) avant la mise en ligne.
- [ ] Croissance : ICP-01/METRIC-01 prêts localement (§10.23), essais exclus. France entière ; présélection publique, contacts et envois autorisés par Hamza. Entretiens et SEO en parallèle ; deux pilotes, recette avant activation.

### En attente (externe)

- [ ] ChatGPT/OpenAI Reserve : Cloudflare Pages publié, CORS prod vérifié ; accord « ChatGPT merchants » non confirmé, attendre avant activation.
- [ ] Places : valider CGU, attribution, stockage et compatibilité OSM avant activation.
- [ ] CRM #659 : migration corrective qualifiée en staging ; surveiller les rafales même client avant promotion ; PR sans auto-merge.
- [ ] Vitrine : suivi démo manuel à 12 mois, sans purge auto. Avant clôture : identité légale, TVA, garanties Resend/Google, conservation et « Support prioritaire 7j/7 » à valider.
- [ ] Relais LLM : GPT-6 Luna fast principal en prod depuis le 20/10, doublon 700 ms, repli Cerebras ; conservation sans UE acceptée pour l'instant. Suivre `hedge_won`/`primary_won`. Chez Suppernote prêt (#521), sur feu vert de Hamza.

## Décisions récentes

- 2026-11-11 — [Tarifs] Hamza autorise l’ouverture publique Pro/Multi après qualification staging ; décision du 09/11 remplacée. Aucun pilote externe n’est attesté ; PILOTS reste OPEN et différé.
- 2026-11-19 — [Voix, confirmation] Après une création sans empreinte, la confirmation se dit à partir du brouillon vérifié, sans second appel au modèle. Avec empreinte, le second passage reste. L'ordre des champs ne change pas : `say` reste en dernier (mesuré, gain de 7 caractères seulement).
