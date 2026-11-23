/**
 * Next.js instrumentation — initialisation de Sentry côté serveur.
 *
 * Next appelle register() une fois au démarrage du serveur. Sans ce fichier,
 * sentry.server.config.ts n'est jamais chargé et aucune erreur serveur de
 * Connect n'arrive dans Sentry.
 *
 * Ce fichier DOIT rester dans src/ : avec un dossier src/, Next ignore un
 * instrumentation.ts placé à la racine de l'app (sans erreur ni avertissement).
 *
 * Le navigateur n'est volontairement pas instrumenté : les pages de widget
 * sont intégrées chez des tiers sous une CSP nginx qui interdit tout appel
 * sortant, et les liens /r/* portent un identifiant personnel.
 */
import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' || process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.server.config');
  }
}

/** Remonte les erreurs des Server Components et des route handlers imbriqués. */
export const onRequestError = Sentry.captureRequestError;
