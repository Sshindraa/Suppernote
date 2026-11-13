# Phone Number Strategy — Suppernote

> **Date originale** : 2026-05-20
> **Statut original** : En discussion — MVP utilise numéro de test gratuit Vapi
> **Statut 2026-06-24** : **DÉPASSÉ** — Telnyx FR est en prod depuis Phase 2
> (cf. [[Telnyx Pipeline]]). Ce document est conservé comme **trace
> de la décision initiale** et pour les projections de coût.

## Le problème

Un numéro de téléphone par restaurant = coût récurrent linéaire.

| Restaurants | Coût numéros/mois (Telnyx ~$3) | Coût numéros/an |
| ----------- | ------------------------------ | --------------- |
| 10          | $30                            | $360            |
| 50          | $150                           | $1,800          |
| 100         | $300                           | $3,600          |
| 1,000       | $3,000                         | $36,000         |

Le numéro est souvent la première interaction client. Il doit être stable, mémorable, et rassurant.

## Stratégies envisagées

### 1. Numéro dédié par restaurant (Option "Premium")

Chaque restaurant a son propre numéro.

**Avantages**

- Numéro connu du client (même sur Google Maps)
- Professionnel, rassurant
- Le client appelle "son" restaurant directement
- Pas d'étape de sélection

**Inconvénients**

- Coût linéaire (~$1-3/mois par restaurant)
- Portage complexe si le restaurant quitte la plateforme
- Gestion de pool de numéros à prévoir

**Quand l'utiliser**

- MVP Beta (10-20 restaurants)
- Restaurants premium / chaines

---

### 2. Numéro partagé + IVR (Option "Shared")

Un seul numéro pour toute la plateforme. L'IA demande : _"Pour quel restaurant ?"_

**Avantages**

- 1 numéro = ~$3/mois total
- Scaling à l'infini sans coût supplémentaire
- Simple à gérer

**Inconvénients**

- Moins professionnel pour le restaurateur
- Le client doit dire le nom du restaurant (friction)
- Pas de "numéro du restaurant" sur Google Maps

**Quand l'utiliser**

- Phase très early (test produit)
- Petits restaurants sans numéro existant
- Marketplace / agrégateur

---

### 3. Pool de numéros rotatifs (Option "Pool")

Tu achètes N numéros (ex: 20) et tu les assignes dynamiquement aux restaurants actifs.

**Avantages**

- Coût fixe quel que soit le nombre de restaurants
- Économie massive à l'échelle
- Flexibilité

**Inconvénients**

- Numéro change si le restaurant suspend/reactive
- Complexité technique (assignation/désassignation)
- Pas de "propriété" du numéro par le restaurant

**Quand l'utiliser**

- Scale (50+ restaurants)
- Restaurants saisonniers / temporaires

---

### 4. Porting des numéros existants (Option "Port")

Le restaurant garde son numéro actuel (Orange/Free/etc.) et le porte vers Telnyx/Vapi.

**Avantages**

- Le restaurant garde son numéro connu
- Pas de coût numéro supplémentaire (déjà payé chez l'opérateur)
- Plus value immédiate pour le client

**Inconvénients**

- Processus de portage = 2-4 semaines
- Paperwork, preuve de propriété du numéro
- Si le restaurant quitte = repportage ou perte du numéro
- Dépendant de la coopération de l'opérateur sortant

**Quand l'utiliser**

- Restaurants existants avec numéro établi
- Phase de conversion (challenger vs concurrent)

---

### 5. SIP Trunking + DID (Option "Enterprise")

Un seul "trunk" SIP avec plusieurs DID (numéros virtuels). Les DID sont ~$0.50-1/mois chez certains carriers.

**Avantages**

- DID à $0.50 vs $3 chez Telnyx
- Volume = négociation possible
- Architecture propre pour les ops vocales

**Inconvénients**

- Nécessite un contrat SIP (commitment)
- Setup technique (PBX, SBC)
- Overkill pour < 100 restaurants

**Quand l'utiliser**

- Enterprise (500+ restaurants)
- Multi-pays

---

## Matrice de décision

| Phase             | Nombre | Stratégie              | Numéro/restaurant | Justification                   |
| ----------------- | ------ | ---------------------- | ----------------- | ------------------------------- |
| **MVP Phase 1-2** | 1-5    | Test gratuit Vapi      | $0                | Validation produit, pas de coût |
| **Beta**          | 10-20  | Numéro dédié Telnyx    | ~$1-3/mois        | Professionnel, test acquisition |
| **Growth**        | 20-50  | Pool rotatif + porting | ~$0.50-3/mois     | Équilibre coût/expérience       |
| **Scale**         | 50-500 | Pool + porting mixte   | ~$0.50-1/mois     | Optimisation, SIP trunking      |
| **Enterprise**    | 500+   | SIP Trunking + DID     | Négociable        | Volume, multi-pays              |

## Implémentation technique

### Numéro dédié (Beta)

```
Dashboard Telnyx → Acheter numéro FR
  → Webhook Telnyx → /webhooks/telnyx
    → Vapi SIP URI (optional)
      → Assistant Vapi personnalisé par restaurant
```

### Pool rotatif (Growth+)

```
Table PhoneNumberPool:
  - id, number, assignedTo (restaurantId | null)
  - purchasedAt, releasedAt, status

Cron job nightly:
  - Restaurants actifs sans numéro → assigner numéro libre
  - Restaurants inactifs depuis 30j → libérer numéro
```

### Porting

```
Restaurant demande portage
  → Telnyx Port Request (LOA + facture)
    → 2-4 semaines de traitement
      → Numéro actif sur Telnyx
        → Redirection vers Vapi SIP
```

## KPIs à suivre

| KPI                             | Target                         | Pourquoi               |
| ------------------------------- | ------------------------------ | ---------------------- |
| Coût numéro / restaurant / mois | <$1 en scale                   | Marges opérationnelles |
| Temps d'assignation numéro      | <5 min                         | Onboarding fluide      |
| Taux de portage                 | >30% des restaurants existants | Adoption               |
| Taux de churn lié au numéro     | <5%                            | Stabilité perçue       |

## Risques

| Risque                               | Probabilité | Impact | Mitigation                       |
| ------------------------------------ | ----------- | ------ | -------------------------------- |
| Pénurie de numéros FR chez Telnyx    | Moyenne     | Élevé  | Multi-carrier (Twilio backup)    |
| Portage bloqué par opérateur sortant | Élevée      | Moyen  | Processus clair, LOA signée      |
| Coût numéros qui grimpe              | Faible      | Élevé  | Négociation volume, SIP trunking |
| Numéro partagé = confusion client    | Moyenne     | Moyen  | IVR clair, fallback humain       |

## Décision actuelle (état 2026-06-24)

> **Phase 1-2 (mai 2026)** : ✅ Fait — Vapi US pour valider le MVP, mais abandonné.
>
> **Phase 2 (juin 2026)** : ✅ Fait — Migration Telnyx FR complète.
> `apps/api/src/modules/voice/telnyx.pipeline.ts` est le pipeline prod.
> Numéro actuel visible : `+33 4 51 22 15 28` (cf. [[Session Telnyx Debug 2026-06-10]]).
>
> **Avant Scale (P1+)** : Non tranché. Les projections de coût du
> tableau initial (1 numéro/resto = $3/mois Telnyx) restent valides
> comme référence. La décision "pool rotatif vs portage" est
> repoussée au moment où on signe > 10 restos.

## Liens

- [[Telnyx Pipeline]] — Pipeline custom Telnyx (référence actuelle)
- [[Session Telnyx Debug 2026-06-10]] — Post-mortem Telnyx prod
- ~~[[Vapi Integration]]~~ — Archivé, Vapi legacy
