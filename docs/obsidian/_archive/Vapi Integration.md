# Vapi Integration — Sprint 1/2

Test de Vapi en parallèle du pipeline Telnyx existant.

## Architecture

```
Appel entrant (numéro Vapi ou transfert Telnyx)
    → Vapi orchestre : STT → LLM (GPT-4o) → TTS (Cartesia Sonic 3.5)
    → Quand l'IA veut "créer une réservation"
      → Webhook POST /webhooks/vapi
      → API Fastify exécute la fonction
      → Réponse envoyée à Vapi → IA lit le résultat au client
```

## Comparaison Vapi vs Telnyx

|              | Vapi                            | Telnyx (actuel)                       |
| ------------ | ------------------------------- | ------------------------------------- |
| **STT**      | ancien fournisseur STT (inclus) | ancien fournisseur STT (manuel)       |
| **LLM**      | GPT-4o / Claude (inclus)        | OpenRouter (manuel)                   |
| **TTS**      | Cartesia Sonic 3.5              | Cartesia Sonic 3.5                    |
| **Coût**     | ~$0.05/min (crédits)            | ~$0.004/min Telnyx + coûts AI séparés |
| **Code**     | Minimal (webhooks uniquement)   | Pipeline complet custom               |
| **Contrôle** | Limité (dashboard Vapi)         | Total                                 |

## Configuration

### 1. Variables d'environnement (déjà dans .env.example)

```env
VAPI_API_KEY="sk_vapi_..."
VAPI_WEBHOOK_SECRET="whsec_..."
VAPI_ASSISTANT_ID="asst_..."
PUBLIC_URL="https://api.sokar.fr"
```

### 2. Dashboard Vapi

1. Créer un compte sur [vapi.ai](https://vapi.ai)
2. Créditer le compte (tu as 10 crédits)
3. Créer un **Assistant** :
   - Name: `Suppernote Assistant`
   - First message: `"Bonjour, je suis l'assistant virtuel de votre restaurant..."`
   - Model: `gpt-4o`
   - Voice: `11labs` → `Adam` (français)
   - Server URL: `https://api.sokar.fr/webhooks/vapi`
   - Server Secret: (optionnel)
4. Ajouter un **numéro de téléphone** (ou utiliser le numéro Telnyx)
5. Lier l'assistant au numéro

### 3. Fonctions configurées (dans le code)

| Fonction            | Description             | Status                         |
| ------------------- | ----------------------- | ------------------------------ |
| `createReservation` | Créer une réservation   | Stub (TODO connecter DB)       |
| `checkAvailability` | Vérifier disponibilité  | Stub (TODO connecter DB)       |
| `getRestaurantInfo` | Infos restaurant        | Mock (retourne horaires fixes) |
| `cancelReservation` | Annuler une réservation | Stub (TODO connecter DB)       |

## Endpoints

| Route            | Méthode | Description                  |
| ---------------- | ------- | ---------------------------- |
| `/webhooks/vapi` | POST    | Point d'entrée webhooks Vapi |
| `/health/vapi`   | GET     | Vérifier la config           |

## Tester en local

```bash
# 1. Démarrer l'API
pnpm dev

# 2. Exposer l'API via ngrok
ngrok http 3000
# → https://abc123.ngrok.io

# 3. Configurer Vapi avec l'URL ngrok
# Dashboard → Assistant → Server URL = https://abc123.ngrok.io/webhooks/vapi

# 4. Appeler le numéro Vapi et tester la conversation
```

## Coûts avec 10 crédits

| Scénario                 | Durée estimée | Crédits consommés |
| ------------------------ | ------------- | ----------------- |
| Test rapide (1 appel)    | ~2 min        | ~$0.10            |
| Session de test complète | ~30 min       | ~$1.50            |
| 10 appels tests          | ~20 min total | ~$1.00            |

**Avec 10 crédits, tu peux faire environ 200 minutes d'appel.**

## Migration progressive

| Phase | Action                                   | Sprint   |
| ----- | ---------------------------------------- | -------- |
| 1     | Tester Vapi avec stubs (pas de DB)       | Sprint 1 |
| 2     | Connecter les fonctions à la DB Prisma   | Sprint 1 |
| 3     | Comparer performances Vapi vs Telnyx     | Sprint 2 |
| 4     | Choisir le provider principal ou hybride | Sprint 2 |

## Fallback

Si Vapi ne répond pas ou les crédits sont épuisés :

- Telnyx reste le pipeline principal
- Aucune dépendance critique à Vapi
- Switch instantané dans la config
