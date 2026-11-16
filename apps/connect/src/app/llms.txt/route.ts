/**
 * /llms.txt
 *
 * Standard proposé (llmstxt.org) : un fichier texte à la racine du site
 * que les LLMs et crawlers IA peuvent lire pour comprendre ce que fait
 * le site et comment interagir avec.
 *
 * Complémentaire du JSON-LD (par-page) et de /.well-known/ai-plugin.json
 * (machine-readable). llms.txt est human-readable + LLM-friendly.
 *
 * Cache 1h (le contenu change rarement).
 */

import type { NextRequest } from 'next/server';

import { publicApiUrl } from '@/lib/public-api-url';

const SITE_URL = process.env.SITE_URL ?? 'https://suppernote.com';
// Public API address only: `API_URL` is the internal one (127.0.0.1 in production).
const API_URL = publicApiUrl();

export async function GET(_req: NextRequest) {
  const content = `# Suppernote

> Suppernote est une plateforme pour les restaurants qui réunit les réservations, l'organisation du service et la relation client. Léa, l'assistante IA de Suppernote, prend en charge les appels du restaurant et les demandes de réservation. Lors de la mise en service, le restaurant configure le renvoi de sa ligne vers son numéro Suppernote. Les restaurants peuvent aussi publier une page de réservation que les clients et assistants IA peuvent consulter.

## Comment réserver via Suppernote

### Option 1 : Web crawl (aucune configuration requise)

Les pages restaurant sont publiquement crawlables sur ${SITE_URL}/restaurant/[slug].
Chaque page contient du JSON-LD Schema.org (type Restaurant) avec :
- Le nom, l'adresse, le téléphone, la cuisine, les horaires
- Un champ acceptsReservations avec l'URL de réservation
- Un potentialAction ReserveAction (si le restaurant a activé l'exposition IA) avec un EntryPoint.urlTemplate

Format du deep-link de réservation :
${SITE_URL}/book/{slug}?partySize={partySize}&date={date}&time={time}

Exemple :
${SITE_URL}/book/chez-mario?partySize=4&date=2026-06-25&time=20:00

L'utilisateur clique sur ce lien et complète le formulaire sur la page Suppernote.

### Option 2 : MCP Server (réservation directe dans la conversation)

Suppernote expose un serveur MCP (Model Context Protocol) qui permet aux clients
MCP (Claude Desktop, Cursor, etc.) de rechercher et réserver directement,
sans page web. L'authentification se fait par OAuth 2.0 ou clé API.

- URL du serveur MCP : ${API_URL}/mcp
- Discovery OAuth2 : ${API_URL}/.well-known/oauth-authorization-server
- Scopes disponibles : mcp:read, mcp:reserve, mcp:cancel
- Auth : OAuth 2.0 avec PKCE et consentement, ou clé API Bearer pour les intégrations gérées

Tools disponibles :

1. search_restaurants(city, partySize, slotStart, slotEnd, timezone?, cuisineType?)
   → Recherche des restaurants disponibles par ville, taille de groupe et créneau.
   → slotStart/slotEnd acceptent un ISO 8601 avec fuseau (Z ou +02:00) ou une heure locale ISO (2026-09-10T20:00:00) avec timezone (IANA, par ex. Europe/Paris). Sans fuseau, Europe/Paris est utilisé.

2. get_restaurant_details(restaurantId)
   → Récupère les détails d'un restaurant (nom, adresse, cuisine, horaires).

3. check_availability(restaurantId, partySize, slotStart, slotEnd, timezone?)
   → Vérifie les créneaux disponibles pour un restaurant. Sans fuseau, celui du restaurant est utilisé.

4. create_quote(restaurantId, partySize, slotStart, slotEnd, timezone?)
   → Vérifie un créneau sans bloquer la capacité.

5. create_hold(restaurantId, partySize, slotStart, slotEnd, timezone?)
   → Bloque temporairement un créneau et retourne un holdToken à utiliser avant expiration.

6. create_reservation(restaurantId, partySize, startsAt, endsAt, timezone?, customerName, customerPhone, idempotencyKey, consents, holdToken?)
   → Crée une réservation. Le consentement de l'utilisateur est obligatoire.
   → Le téléphone doit être au format E.164 (+33...).

7. join_waiting_list(restaurantId, partySize, slotStart, slotEnd, customerFirstName, customerPhone)
   → Rejoint la liste d'attente si le restaurant l'a activée.

8. cancel_waiting_list(restaurantId, entryId, actionToken)
   → Quitte la liste d'attente avec le jeton reçu à l'inscription.

9. modify_reservation(reservationId, customerPhone?, partySize?, startsAt?, endsAt?, customerName?)
   → Modifie une réservation après contrôle de la disponibilité.

10. cancel_reservation(reservationId, customerPhone?, reason?)
   → Annule une réservation existante.

11. get_reservation_status(reservationId, customerPhone?)
   → Récupère le statut d'une réservation.

### Option 3 : Page web directe

L'utilisateur peut aussi réserver directement sur ${SITE_URL}/restaurant/[slug]
sans passer par une IA. Le formulaire de réservation est sur la page.

## Sitemap

Le sitemap est disponible sur ${SITE_URL}/sitemap.xml et liste toutes les
pages restaurant indexables (uniquement les restaurants publiés).

## Robots.txt

Le robots.txt (${SITE_URL}/robots.txt) autorise explicitement les bots IA :
OAI-SearchBot, GPTBot, ClaudeBot, PerplexityBot, Bytespider, CCBot, etc.

## Manifeste machine-readable

Un manifeste structuré (JSON) est disponible sur ${SITE_URL}/.well-known/ai-plugin.json
pour les crawlers qui préfèrent un format machine-readable.

## Limitations

- Pas de système d'avis (aggregateRating) en P0.
- Pas de menu digital (Schema.org Menu) en P0.
- Les pages locales (/restaurants/[city]) ne sont indexées que si la ville
  a au moins 5 restaurants publiés.

## Contact

- Site : ${SITE_URL}
- API : ${API_URL}
- Email : contact@suppernote.com
`;

  return new Response(content, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
