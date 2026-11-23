/**
 * Next.js 15 instrumentation — Sentry init for server and edge runtimes.
 *
 * Replaces sentry.server.config.ts and sentry.edge.config.ts.
 * Next.js calls register() once on server/edge startup.
 *
 * Ce fichier DOIT rester dans src/ : avec un dossier src/, Next ignore un
 * instrumentation.ts placé à la racine de l'app (sans erreur ni avertissement).
 */
import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' || process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.server.config');
  }
}

/**
 * Capture errors from nested React Server Components.
 * Required by @sentry/nextjs for Next 15 App Router.
 */
export const onRequestError = Sentry.captureRequestError;
