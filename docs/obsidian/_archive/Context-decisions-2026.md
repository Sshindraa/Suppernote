# Décisions archivées de Context.md — 2026

## Octobre

- 2026-10-31 — [Companion] Modèle de production : Claude Sonnet 5.5 (`anthropic/claude-sonnet-5.5`), raisonnement bas, pour tous les restaurants ; aucun réglage par restaurant ni aiguillage entre modèles. Banc : questions simples 105/105 contre 101/105 pour Haiku, ancrage 139/141.
- 2026-10-28 — [Fidélité et intégrations] Fidélité manuelle ouverte à Pro/Multi-site après livraison ; POS et groupes restent coupés jusqu’au premier client L’Addition / multi-site.
- 2026-10-25 — [Intégrations] Google Agenda retiré complètement (code, UI, offre, colonnes DB) : peu utile aux restaurateurs et synchro partielle (téléphone seulement).
- 2026-10-22 — [Voix] Aucune fonction voix par restaurant ni coupée par défaut : tout est actif pour tous les restaurants (seuls le débogage et l'enregistrement restent limités).
- 2026-10-11 — [Onboarding/horaires] Dernières arrivées réglées une fois par service et propagées automatiquement aux jours ouverts ; si une fermeture plus tôt rend l’heure invalide, retenir le dernier créneau valide avant cette limite.
- 2026-10-06 — [Voix/TTS] Voix Cartesia par défaut : Sarah (`90358bc7-3328-4b93-a942-d0447d7d4b5c`), à la place de Katie pour les profils sans voix personnalisée.
- 2026-10-06 — [Onboarding audio] Réponses de démonstration alignées sur les phrases du client ; le cache inclut le texte pour invalider les anciens audios après une modification du script.
- 2026-10-06 — [Onboarding] Appel test sur le numéro public uniquement.
- 2026-10-03 — [UI/widget] Retour à la référence visuelle de phase 2 ; conserver les corrections fonctionnelles suivantes.
- Cartes cadeaux : encaissement restaurant via Stripe Connect ; aucun débit à la réservation, consommation sur l’addition réelle. Qualification financière avant ouverture commerciale ; commit/push du lot autorisés le 06/10.
