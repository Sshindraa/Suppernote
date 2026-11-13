# Onboarding checklist — Pilote Lyon (15 restos)

> Cette checklist n'est PAS exécutable tant que les stops suivants ne sont pas levés :
>
> 1. **RGPD identité** : endpoints `/api/rgpd/erase` et `/api/rgpd/export` doivent avoir
>    une preuve d'identité durcie (OTP SMS, lien signé, ou workflow admin vérifié).
>    Sans ça, on ne peut pas légalement accepter des clients finaux.
> 2. **Node version** : l'environnement local et CI doit être sur Node 20 ou 22
>    (actuellement v26.3.0, hors range `>=20 <23`).
>
> Le déblocage est porté par l'owner : à toi de dire GO quand les deux sont OK.

## Composition cible des 15 restos

| Catégorie                | Nombre | Critères                                           |
| ------------------------ | ------ | -------------------------------------------------- |
| Bistrot / Brasserie      | 5      | Volume moyen, carte classique, 30-80 couverts      |
| Gastronomique            | 3      | Menu dégustation, resa obligatoire, 20-40 couverts |
| Brunch / Café            | 3      | Petit-déj/midi, 20-50 couverts                     |
| Touristique (Presqu'île) | 2      | Vieux Lyon / Place Bellecour, international        |
| Petite capacité (< 20)   | 2      | Tables prisées, résa critique pour eux             |

## Critères de sélection (par resto)

- [ ] Lyon intramuros (1er, 2e, 6e arrondissements prioritaires)
- [ ] Plan PRO ou PREMIUM (Suppernote actif)
- [ ] Lat/lng + formattedAddress + phoneE164 + websiteUrl renseignés
      dans le dashboard
- [ ] Gérent joignable pour formation 1h
- [ ] Acceptance du pilote (signé via onboarding service)

## Étapes d'onboarding (par resto, ~30 min total)

### 1. Configuration technique (avant formation)

- [ ] Restaurant créé en DB (via onboarding service existant)
- [ ] Champ `mcp_enabled` par défaut `false`
- [ ] Champ `openai_reserve_enabled` par défaut `false`
- [ ] Vérifier lat/lng/phone/website/address (gating admin Phase 2)

### 2. Formation 1h (visio ou présentiel)

- [ ] Démo live : "Recherche resto Lyon 19h 4 personnes" dans ChatGPT / Claude Desktop
- [ ] Démo live : "Réserve chez Le Bistrot samedi 20h 2 personnes"
- [ ] Démo live : annulation d'une résa
- [ ] Démo dashboard : toggles opt-in, exposure settings
- [ ] FAQ : "qui paie les commissions ?", "mes clients voient Suppernote ?",
      "je peux bloquer un client ?"

### 3. Opt-in progressif (J+0 → J+3)

- [ ] **J+0** : MCP activé (test interne)
- [ ] **J+1** : OpenAI Reserve activé (test interne)
- [ ] **J+3** : ouverture au public, monitoring serré

### 4. Suivi quotidien (première semaine)

- [ ] 9h : daily async dans `#sokar-pilot-data`
- [ ] 14h : check incidents Sentry
- [ ] 18h : check KPIs du jour
- [ ] 21h : récap dans Slack, demande feedback si négatif

## Indicateurs de succès (4 semaines)

| KPI                    | Cible         | Source                      |
| ---------------------- | ------------- | --------------------------- |
| Réservations créées    | ≥ 100 cumulés | `reservations_total`        |
| Taux honor             | ≥ 50%         | `honor_rate`                |
| Double booking         | = 0 (strict)  | `double_booking_attempts`   |
| PII leak               | = 0 (strict)  | `pii_leak_incidents`        |
| Latence p95            | < 800ms       | `check_availability_p95_ms` |
| NPS resto (fin pilote) | ≥ 8/10        | Sondage T+4 semaines        |

## Critères de sortie (quand arrêter le pilote)

- Tous les KPIs cible atteints à T+4 semaines → scaling (50+ restos)
- 1+ KPI non-atteint à T+4 semaines → rétrospective + décision GO/NO-GO
- Incident P0 (PII leak confirmé) à tout moment → rollback + DPO
- > 2 double bookings en 7 jours → pause MCP/OpenAI Reserve + audit

## Post-pilote : scaling

- [ ] 50 restos Lyon (même playbook)
- [ ] Expansion Paris / Bordeaux / Marseille (Q3 2026)
- [ ] 200+ restos (national, Q4 2026)

## Annexe : scripts d'activation

### Activer MCP pour 1 resto

```sql
UPDATE restaurants
SET mcp_enabled = true
WHERE id = '<restaurantId>';
```

### Activer OpenAI Reserve (gating 5 champs)

```sql
UPDATE restaurants
SET openai_reserve_enabled = true
WHERE id = '<restaurantId>'
  AND lat IS NOT NULL
  AND lng IS NOT NULL
  AND phone_e164 IS NOT NULL
  AND website_url IS NOT NULL
  AND formatted_address IS NOT NULL;
```

### Désactiver tout (urgence)

Voir `infra/sql/emergency-disable.sql`.

---

## Liste des 15 restos (à remplir avant lancement)

| #   | Nom        | Catégorie       | Contact    | Date onboarding | Status          |
| --- | ---------- | --------------- | ---------- | --------------- | --------------- |
| 1   | Le Bistrot | Bistrot         | [nom, tel] | —               | 🔴 Pas commencé |
| 2   | TBD        | Bistrot         | —          | —               | 🔴              |
| ... |            |                 |            |                 |                 |
| 15  | TBD        | Petite capacité | —          | —               | 🔴              |

> **Stops actifs** : voir début du fichier. Pas d'onboarding réel autorisé avant
> levée des 2 stops (RGPD identité + Node version).
