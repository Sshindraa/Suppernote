/**
 * Suppernote Connect — Page /assistant
 *
 * Page publique qui explique comment réserver dans les restaurants Suppernote
 * via un assistant IA (ChatGPT, Claude, Mistral, Perplexity, etc.).
 *
 * 2 audiences :
 * 1. Grand public : "Votre IA peut trouver et réserver chez nos restaurants"
 *    — pas de config, juste de l'info sur ce qui est possible.
 * 2. Power users / devs : "Vous utilisez un client MCP ?"
 *    — URL du serveur MCP + comment obtenir une API key.
 *
 * Page statique (○, pas de ƒ) — aucun fetch, aucun state.
 */

import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  // Marque ajoutée par le template du layout (cf. restaurant/[slug]).
  title: 'Réserver avec votre assistant IA',
  description:
    'Les restaurants du réseau Suppernote sont trouvables et réservables via ChatGPT, Claude, Mistral et Perplexity. Votre assistant IA trouve le restaurant et vous réserve une table.',
  robots: { index: true, follow: true },
  alternates: { canonical: '/assistant' },
};

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'https://api.suppernote.com';

export default function AssistantPage() {
  return (
    <main id="main-content" className="mx-auto max-w-3xl px-6 py-12">
      {/* ─── Hero ─── */}
      <div className="space-y-4">
        <div className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
          Réservation par IA
        </div>
        <h1 className="text-3xl font-bold text-ink sm:text-4xl">
          Réservez avec votre assistant IA
        </h1>
        <p className="text-lg text-muted-foreground">
          Les restaurants du réseau Suppernote sont trouvables et réservables via ChatGPT, Claude,
          Mistral, Perplexity et tous les assistants IA qui naviguent sur le web.
        </p>
      </div>

      {/* ─── Comment ça marche (grand public) ─── */}
      <section className="mt-12 space-y-4">
        <h2 className="text-xl font-semibold text-ink">Comment ça marche</h2>
        <div className="space-y-3 text-muted-foreground">
          <p>
            Demandez simplement à votre assistant IA de trouver un restaurant. S&apos;il trouve un
            restaurant Suppernote, il vous donnera un lien pour réserver en ligne, avec le nombre de
            personnes et l&apos;heure déjà pré-remplis.
          </p>
          <p>
            Vous cliquez, vous confirmez vos coordonnées, c&apos;est réservé. Aucune application à
            installer, aucun compte à créer.
          </p>
        </div>
        <div className="mt-4 space-y-3">
          {[
            '« Trouve-moi un restaurant à Lyon pour 4 personnes vendredi soir. »',
            '« Je veux réserver chez Mario pour 2 personnes demain à 20h. »',
            '« Quels restaurants sont disponibles à Paris samedi midi ? »',
          ].map((example) => (
            <div
              key={example}
              className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm italic text-muted-foreground"
            >
              {example}
            </div>
          ))}
        </div>
      </section>

      {/* ─── Sans config ─── */}
      <section className="mt-10 rounded-lg border border-border bg-muted/30 p-6">
        <h2 className="text-lg font-semibold text-ink">Aucune configuration nécessaire</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Vous n&apos;avez rien à configurer. Les pages restaurants Suppernote sont publiques et
          optimisées pour les moteurs de recherche et les assistants IA. L&apos;indexation par
          Google et les IA prend du temps — plus le réseau compte de restaurants, plus Suppernote
          devient visible. Si votre IA ne trouve pas encore de restaurant Suppernote, c&apos;est que
          le réseau est encore en déploiement.
        </p>
      </section>

      {/* ─── Section power users (MCP) ─── */}
      <section className="mt-12 space-y-6">
        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-ink">Vous utilisez un client MCP ?</h2>
          <p className="text-sm text-muted-foreground">
            Si vous utilisez Claude Desktop, Cursor, ou un autre client qui supporte le Model
            Context Protocol, vous pouvez connecter Suppernote directement. L&apos;IA pourra alors
            rechercher et réserver sans vous rediriger vers une page web.
          </p>
        </div>

        <div className="rounded-lg border border-border p-6">
          <h3 className="text-lg font-semibold text-ink">Configuration</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Ajoutez le serveur MCP Suppernote dans votre client :
          </p>
          <pre className="mt-3 overflow-x-auto rounded bg-muted p-3 text-xs text-ink">
            <code>{`{
  "mcpServers": {
    "suppernote": {
      "url": "${API_URL}/mcp"
    }
  }
}`}</code>
          </pre>
          <p className="mt-4 text-sm text-muted-foreground">
            La connexion utilise OAuth 2.0 avec une page de consentement. Les intégrations gérées
            peuvent aussi utiliser une clé API.
          </p>
        </div>

        <div className="rounded-lg border border-border p-6">
          <h3 className="text-lg font-semibold text-ink">Tools disponibles</h3>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            <li>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">search_restaurants</code> —
              Rechercher par ville, taille de groupe et créneau
            </li>
            <li>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">get_restaurant_details</code>{' '}
              — Détails d&apos;un restaurant (nom, adresse, cuisine, horaires)
            </li>
            <li>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">check_availability</code> —
              Vérifier les créneaux disponibles
            </li>
            <li>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">create_quote</code> — Obtenir
              une estimation sans bloquer la capacité
            </li>
            <li>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">create_hold</code> — Garder
              temporairement un créneau pendant votre confirmation
            </li>
            <li>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">create_reservation</code> —
              Créer une réservation (consentement obligatoire)
            </li>
            <li>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">join_waiting_list</code> —
              Rejoindre la liste d&apos;attente si elle est disponible
            </li>
            <li>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">cancel_waiting_list</code> —
              Quitter la liste d&apos;attente
            </li>
            <li>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">modify_reservation</code> —
              Modifier l&apos;heure, le nombre de personnes ou le nom
            </li>
            <li>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">cancel_reservation</code> —
              Annuler une réservation
            </li>
            <li>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">get_reservation_status</code>{' '}
              — Statut d&apos;une réservation
            </li>
          </ul>
        </div>
      </section>

      {/* ─── Sécurité ─── */}
      <section className="mt-12 space-y-3">
        <h2 className="text-xl font-semibold text-ink">Sécurité et confidentialité</h2>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li>
            • L&apos;IA ne peut <strong className="text-ink">jamais</strong> réserver sans les
            informations explicites de l&apos;utilisateur (nom + téléphone).
          </li>
          <li>
            • Le numéro de téléphone est obligatoire pour une réservation (format international, ex
            : +33612345678).
          </li>
          <li>• Les connexions OAuth et les clés API MCP sont révocables.</li>
          <li>
            • Suppernote ne partage jamais vos données au-delà de ce qui est nécessaire pour la
            réservation.
          </li>
        </ul>
      </section>

      {/* ─── CTA ─── */}
      <section className="mt-12 rounded-lg bg-primary/5 p-6 text-center">
        <p className="text-lg font-medium text-ink">Réservez directement</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Pas besoin d&apos;IA : trouvez un restaurant et réservez en ligne.
        </p>
        <Link
          href="/"
          className="mt-4 inline-flex items-center rounded-md bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition-all duration-200 hover:bg-primary/90"
        >
          Trouver un restaurant
        </Link>
      </section>
    </main>
  );
}
