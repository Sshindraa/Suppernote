import type { NextRequest } from 'next/server';
import { auth } from '@clerk/nextjs/server';

/**
 * Extrait les headers à forwarder vers l'API depuis la requête entrante.
 * Exporté dans un module séparé (et non depuis route.ts) car Next.js interdit
 * les exports non-route depuis les fichiers route handlers.
 *
 * Garde-fou non-régression : X-Forwarded-For doit être forwardé pour que le
 * rate-limit global Fastify s'applique par IP cliente réelle (trustProxy).
 */
export function forwardedHeaders(req: NextRequest) {
  const cookie = req.headers.get('cookie') || '';
  const authorization = req.headers.get('authorization') || '';
  const forwardedFor = req.headers.get('x-forwarded-for') || '';
  const requestId = req.headers.get('x-request-id') || '';
  const idempotencyKey = req.headers.get('idempotency-key') || '';
  // Audio elements cannot attach custom headers, so the calls page may pass
  // the already validated site selection as a query parameter. The API still
  // resolves membership and account ownership server-side.
  const siteId =
    req.headers.get('x-suppernote-site-id') ||
    req.headers.get('x-sokar-site-id') ||
    req.nextUrl.searchParams.get('siteId') ||
    '';
  const range = req.headers.get('range') || '';
  // Preuve d'identité de l'export RGPD d'un client (code SMS saisi) : sans elle, l'API répond
  // « identité requise » et l'export ne peut jamais aboutir.
  const identityToken = req.headers.get('x-identity-token') || '';

  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  if (authorization) headers.Authorization = authorization;
  if (forwardedFor) headers['X-Forwarded-For'] = forwardedFor;
  if (requestId) headers['X-Request-ID'] = requestId;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (siteId) headers['X-Suppernote-Site-ID'] = siteId;
  if (range) headers.Range = range;
  if (identityToken) headers['X-Identity-Token'] = identityToken;
  return headers;
}

/**
 * Enrichit les headers du proxy avec le jeton de session Clerk côté serveur.
 *
 * Le cookie Clerk est conservé pour compatibilité, mais il n'est pas toujours
 * exploitable par une API Fastify située sur un autre sous-domaine. Le jeton
 * Bearer généré par `auth().getToken()` rend le proxy explicite et évite qu'un
 * dashboard authentifié soit traité comme une requête anonyme.
 */
export async function authenticatedHeaders(req: NextRequest) {
  const headers = forwardedHeaders(req);

  try {
    const { getToken } = await auth();
    const token = await getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      // Le cookie __clerk_handshake est lié à l'origine du dashboard. Envoyé
      // vers api-staging/api, il peut être tronqué et faire échouer Clerk
      // avant même l'examen du Bearer. Le jeton serveur devient la source
      // d'authentification explicite pour cet appel inter-sous-domaine.
      delete headers.Cookie;
    }
  } catch {
    // Le mode démo local/staging peut fonctionner sans session Clerk. Le
    // cookie ou l'Authorization entrant restent disponibles comme fallback.
  }

  return headers;
}

/**
 * Headers de la réponse API à renvoyer au navigateur quand le proxy reconstruit le JSON.
 * Sans `Retry-After`, un client limité (429) ne connaît pas le délai et réessaie trop tôt.
 */
export function upstreamResponseHeaders(res: Response): Record<string, string> {
  const retryAfter = res.headers.get('retry-after');
  return retryAfter ? { 'Retry-After': retryAfter } : {};
}
