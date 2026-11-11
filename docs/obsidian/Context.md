# Contexte Sokar

> État courant; historique : [[Journal]]. Archives : [[archive/Context-log-2026]] (activité), [[archive/Context-decisions-2026]] (décisions).
>
> Activité → `Journal.md`; décisions >30 j → `archive/Context-decisions-2026.md`.
>
> TODOs et décisions du mois uniquement; cible <8 Ko (`scripts/quality/check-vault-size.sh`).

## TODOs actifs

- [ ] Réponses SMS/WhatsApp Telnyx : définir une corrélation fiable et qualifier la revue opérateur en staging ; voir `docs/runbooks/inbound-reply-review.md`.
- [ ] CRM #659 : migration corrective qualifiée en staging ; surveiller les rafales même client avant promotion ; PR sans auto-merge.

- [ ] Suppernote : déployer la compatibilité du slug `chez-suppernote-demo`, qualifier les deux URL en staging, puis migrer le slug stocké ; suivre aussi `migration-suppernote.md` (webhooks, monogramme, paquets et démo) et refaire un appel vocal après recharge OpenRouter.

- [ ] Marketing : avant tout envoi réel, rouvrir l'effacement et l'opposition, et mentionner le ciblage selon l'historique dans la notice client (`privacy-client-annex.md`).
- [ ] RGPD #616 : vérification/export rouverts en prod ; effacement et opposition restent bloqués (503). Examiner les journaux ; demandes manuelles : privacy@sokar.tech.

- [ ] Notifications : #484 qualifiée staging/off prod; WEB/outbox/WhatsApp locaux. Annulation/modification #485–#487 actives et qualifiées staging; liens off prod. Après délai : contact, aucun frais auto.
- [ ] Audit notifications local : qualifier retries ciblés, claims et réparations avec Redis/fournisseurs en staging ; autres sujets outbox manuels.
- [ ] Audit entrées publiques local : OAuth/limites Redis, clés MCP et dédup SMS/WhatsApp locaux ; qualifier Postgres, Redis et Telnyx en staging. L’isolation des réponses sur numéro partagé n’est pas garantie ; voir `docs/runbooks/inbound-reply-review.md`. RGPD suit le TODO dédié.
- [ ] WhatsApp : flags off ; WEB avec consentement, téléphone SMS seul. Callbacks Meta (7 j/ID, sinon revue manuelle) ; qualifier fournisseur, abonnement et staging. Voir `whatsapp-reservation-activation.md`.
- [ ] SEO/confidentialité : comparer GSC après couverture 16–22/10 ; valider notice/annexe client, rétention, contrats Google/Resend et mentions légales. Voir `privacy-client-annex.md`.
- [ ] Démo : demande/réception/traitement qualifiés en production. DEMO-SIM vérifié localement : animation isolée, fictive (§10.22). Aucun délai annoncé.
- [ ] Vitrine : suivi démo manuel à 12 mois, sans purge auto. Avant clôture : identité légale, TVA, garanties Resend/Google, conservation et promesse « Support prioritaire 7j/7 » à valider.
- [ ] Notifications ops #463 : prod saine, doublons groupés en staging ; suivre volumes et jobs historiques. Quota Free ≠ débit. Voir `resend-alert-regulation.md`.
- [ ] SMS : staging livré ; Telnyx 40008 en prod, aucun rejeu ; réservations/WhatsApp restent off. Cause à établir.
- [ ] Croissance : ICP-01/METRIC-01 prêts localement (§10.23), essais exclus. France entière; présélection publique, contacts/envois autorisés par Hamza. Entretiens/SEO en parallèle; deux pilotes, recette avant activation.
- [ ] Voix #586–#588/#580 : livrés ; seuil DG inchangé, rejeux verts, 160 ms en branche. Finir la qualification sur appel staging (`voice-stt-qualification.md`) ; clients off.
- [ ] Audit voix local : qualifier appel/retransmissions en staging et protéger les journaux Nginx ; sessions en mémoire, reprise après redémarrage/multiprocessus non garantie.
- [ ] Naturel/#595 : écouter prosodie, répétitions et confirmations sur Chez Sokar avant extension ; voir `voice-conversation-continuity.md`.
- [ ] Cartes cadeaux : finir le compte Stripe sandbox démo (encaissements/versements) et qualifier les notifications avant ouverture commerciale.
- [ ] Expériences : migration et qualification Stripe/CGV/TVA/notifications en staging; garder `EXPERIENCE_BOOKING_ENABLED=false`.
- [ ] Places : valider CGU, attribution, stockage et compatibilité OSM avant activation.
- [ ] Onboarding v2 #404–#411 : numéro attribué manuellement ; valider formule, équipe/rôles, auto-attribution Telnyx et compte Stripe après audit 1.6. Paiement après onboarding ; qualifier transfert Clerk réel en staging.
- [ ] FAQ pratique : renseigner Chez Sokar, l'ajouter à `VOICE_PRACTICAL_INFO_RESTAURANT_IDS`, tester par appel (terrasse, parking, animaux, inconnu → gérant) puis étendre à Connect, widget et MCP.
- [ ] Span-01 : annoter 300 à 500 tours difficiles, puis décider de la phase 2 (advisory).
- [ ] Banc voix : décider phase 1b et annoter humainement `bf3893ae` (`truthStatus: unverified`); ablation/substitution ne discriminent pas.
- [ ] Appel en direct onboarding : compléter un appel de bout en bout avec réservation simulée (écho, latence, disponibilité, confirmation), puis déployer `microphone=(self)` (nginx prod) avant la mise en ligne.
- [ ] Appel réel Chez Sokar : valider compréhension/épellation, mesurer le délai de relecture et tester « A, deux S, A, M ».
- [ ] Après l’appel réel, vérifier `judge` (disponibilité/délai) et rejouer « je voudrais bien venir »; retrait via `VOICE_TURN_JUDGE_RESTAURANT_IDS`.
- [ ] Banc voix : traiter la répétition mot pour mot (20–55 %, seuil 80 %) et utiliser le vrai prompt `prompts.ts`.
- [ ] Relais LLM : GPT-6 Luna fast principal en prod depuis le 20/10, doublon 700 ms, repli Cerebras ; conservation sans UE acceptée pour l’instant. Suivre `hedge_won`/`primary_won` ; Chez Sokar prêt (#521), sur feu vert.
- [ ] Essai staging L16 : confirmer l’endianness avec la sonde.
- [ ] Activer `VOICE_STT_CHUNK_MS=100` après vérification staging.
- [ ] Étudier le débruitage et le parser par étape.
- [ ] Après phase 6, refaire l’appel pilote Deepgram + Dialogue V2 et analyser latence/fallback.
- [ ] Flux non retenu (20/10, courts/épellations perdus); allowlist vide. Mesurer les tours « inachevés ».
- [ ] Phase A3 : décider du canary keyterms métier/L16 après revue des résultats et validation staging.
- [ ] Rapport d’appel : après le prochain test réel, vérifier le lien de l’appel et le statut `linked` dans `voice_call_audio.py report <id>`.
- [ ] Après déploiement, lire le premier rapport d’appel et décider si l’ancien code de dialogue réservé au banc STT peut être déplacé.
- [ ] Voix locale non déployée : écouter répétitions/confirmations avec le vrai modèle avant activation ; décider ensuite si le style par restaurant s’étend à tous.
- [ ] Voix #580 : correctif anti-bruit livré en production ; effectuer et analyser un appel entrant réel sur Chez Sokar.
- [ ] ChatGPT/OpenAI Reserve : Cloudflare Pages publié ; l’URL `.html` redirige (308) vers `/restaurant-reservation` (200), CORS prod vérifié. Accord « ChatGPT merchants » non confirmé ; attendre l’accord avant activation.

## Décisions récentes

- 2026-11-11 — [Tarifs] Hamza autorise l’ouverture publique Pro/Multi après qualification staging ; décision du 09/11 remplacée. Aucun pilote externe n’est attesté ; PILOTS reste OPEN et différé.
