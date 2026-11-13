# Qualification du paiement des expériences

Statut : code local prêt à qualifier ; aucune migration ni activation staging/prod effectuée.
Le pilote public reste fermé par défaut.

## Garde-fous

- `EXPERIENCES_ENABLED=false` désactive le module interne.
- `EXPERIENCE_BOOKING_ENABLED=false` désactive le catalogue et le checkout publics, même si le
  module interne est activé.
- Le checkout est refusé si le restaurant n'est pas publié, si Stripe n'autorise pas les charges
  et versements, ou si le taux de commission n'est pas configuré.
- La commission est une fraction : `0.05` signifie 5 %. Seul un opérateur Suppernote peut la régler via
  `PATCH /api/internal/experiences/payment-config` avec `{ "restaurantId": "…", "commissionRate": 0.05 }`.
  Envoyer `commissionRate: null` retire la configuration.
- Le compte Stripe Connect est le compte du restaurant déjà configuré dans les réglages Stripe des
  cartes cadeaux. La migration copie les comptes existants dans le nouveau champ dédié et le
  checkout conserve un fallback vers le champ historique.

## Contrat du parcours

1. Suppernote Connect ne publie que les expériences actives et les dates futures ouvertes. Le client
   choisit une date et une quantité.
2. L'API réserve les places sous verrou PostgreSQL, fige le prix et la commission, puis crée un
   Checkout Session Stripe idempotent. Le lien expire après 35 minutes.
3. La page de retour ne confirme rien à elle seule. Le webhook Connect signé vérifie compte,
   session, montant, devise et statut avant de créer la réservation. Les événements répétés sont
   enregistrés de façon idempotente.
4. Un retour avant paiement expire la Checkout Session et libère immédiatement les places ; une
   session abandonnée libère les places à l'expiration. Un paiement tardif ou sans capacité restante
   déclenche un remboursement total.
5. Une annulation depuis le dashboard rembourse le paiement total. En cas de remboursement en
   attente, le dashboard l'indique ; un remboursement échoué bloque l'annulation et demande une
   intervention.

Les événements Connect nécessaires sur `POST /webhooks/stripe` sont :
`checkout.session.completed`, `checkout.session.expired`, `refund.created`, `refund.updated` et
`refund.failed`. Configurer une destination Connect qui transmet les événements des comptes
connectés et ajouter son secret à `STRIPE_WEBHOOK_SECRET` sans l'écrire ici.

## Mise en pilote staging

1. Vérifier le snapshot/rollback staging et appliquer la migration additive
   `20261002160000_experience_public_checkout` sur staging uniquement.
2. Utiliser exclusivement des clés et comptes Stripe de test. Terminer l'onboarding Connect du
   restaurant, vérifier `charges_enabled` et `payouts_enabled`, puis configurer le taux convenu par
   l'opérateur.
3. Laisser la production fermée. Activer d'abord `EXPERIENCES_ENABLED=true` et vérifier le
   dashboard, puis ouvrir `EXPERIENCE_BOOKING_ENABLED=true` uniquement sur le périmètre pilote.
4. Vérifier : paiement accepté, réservation créée par webhook, places complètes, abandon puis
   expiration, retour/cancel, rejouement d'un webhook, paiement arrivé après expiration, annulation
   avec remboursement immédiat/en attente/échoué et absence de survente concurrente.
5. Repasser `EXPERIENCE_BOOKING_ENABLED=false` pour rollback applicatif ; les tentatives en cours
   restent consultables par leur retour et les webhooks continuent à les traiter.

## Conditions restant à qualifier avant ouverture commerciale

- Conditions de vente et politique d'annulation/remboursement visibles avant paiement.
- Traitement TVA, justificatif/facture et responsabilités comptables du restaurant et de Suppernote.
- Emails de confirmation client et notification restaurateur, plus procédure de support si un
  remboursement échoue.
- Rapprochement régulier Stripe ↔ réservations et alertes sur les statuts `REFUND_FAILED`.
- Parcours staging complet et validation humaine du montant, du bénéficiaire Connect et des textes
  de paiement.
