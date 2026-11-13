import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRight,
  Bot,
  CalendarCheck,
  Check,
  CheckCircle2,
  Code2,
  Copy,
  KeyRound,
  Search,
  ShieldCheck,
  Sparkles,
  Utensils,
  XCircle,
} from 'lucide-react';

export const metadata: Metadata = {
  title: 'Suppernote MCP — Connectez votre restaurant à ChatGPT, Claude & Mistral',
  description:
    'Model Context Protocol officiel de Suppernote. Permettez à vos clients de réserver, vérifier les disponibilités et annuler depuis leurs assistants IA préférés.',
  openGraph: {
    title: 'Suppernote MCP — Reservations IA pour restaurateurs',
    description: 'Connectez Suppernote à Claude.ai, ChatGPT et Mistral. Six outils OAuth + PKCE.',
    type: 'website',
  },
};

const MCP_URL = 'https://api.suppernote.com/mcp';

const TOOLS = [
  {
    name: 'search_restaurants',
    title: 'Rechercher des restaurants',
    description:
      "Trouve les restaurants disponibles selon la ville, la taille du groupe, l'horaire et le type de cuisine.",
    readOnly: true,
  },
  {
    name: 'get_restaurant_details',
    title: "Détails d'un restaurant",
    description:
      "Retourne la fiche complète d'un restaurant : adresse, cuisine, gamme de prix, horaires d'ouverture.",
    readOnly: true,
  },
  {
    name: 'check_availability',
    title: 'Vérifier les disponibilités',
    description: 'Liste les créneaux disponibles pour une taille de groupe et une période donnée.',
    readOnly: true,
  },
  {
    name: 'create_reservation',
    title: 'Créer une réservation',
    description:
      'Crée une réservation nominative. Consentement explicite requis pour le traitement des données.',
    readOnly: false,
  },
  {
    name: 'cancel_reservation',
    title: 'Annuler une réservation',
    description: 'Annule une réservation existante par son identifiant. Le client est notifié.',
    readOnly: false,
  },
  {
    name: 'get_reservation_status',
    title: "État d'une réservation",
    description: "Retourne le statut courant d'une réservation : taille du groupe, date, état.",
    readOnly: true,
  },
];

const PROMPTS = [
  {
    title: 'Trouver un resto pour ce soir',
    body: 'Trouve-moi un restaurant italien à Paris pour 4 personnes samedi à 20h.',
    tools: ['search_restaurants', 'check_availability'],
  },
  {
    title: 'Réserver pour un anniversaire',
    body: 'Réserve une table pour 6 chez Bistro Marais ce vendredi 20h30, au nom de Camille Martin. Confirme avant de valider.',
    tools: ['check_availability', 'create_reservation'],
  },
  {
    title: 'Décaler un rendez-vous',
    body: "Ma réservation d'origine R-XXXXX est annulée. Vérifie mon statut actuel et propose un autre créneau demain midi.",
    tools: ['get_reservation_status', 'check_availability', 'cancel_reservation'],
  },
];

const SCOPES = [
  {
    name: 'mcp:read',
    description:
      'Lecture seule : rechercher des restaurants et consulter les détails / disponibilités.',
  },
  {
    name: 'mcp:reserve',
    description:
      "Création de réservations nominatives. Déclenche l'envoi d'un SMS de confirmation.",
  },
  {
    name: 'mcp:cancel',
    description: 'Annulation de réservations. Action destructive, journalisée.',
  },
];

export default function McpPage() {
  return (
    <div className="min-h-screen bg-background text-foreground font-sans antialiased">
      {/* ── HERO ──────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b border-white/8">
        <div className="absolute inset-0 liquid-field pointer-events-none" aria-hidden="true" />
        <div className="relative z-10 mx-auto flex max-w-5xl flex-col items-center px-5 pb-24 pt-32 text-center sm:px-8">
          <p className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/8 px-4 py-2 text-[11px] font-semibold text-white/76 shadow-2xl shadow-black/20">
            <Bot size={13} />
            Model Context Protocol
            <ArrowRight size={12} />
          </p>

          <h1 className="mt-7 max-w-4xl text-[2.5rem] font-semibold leading-[0.98] tracking-tight text-white sm:text-6xl md:text-7xl font-display">
            Suppernote dans <span className="text-[hsl(var(--pricing-accent))]">ChatGPT</span>,{' '}
            <span className="text-[hsl(var(--pricing-accent))]">Claude</span> &amp;{' '}
            <span className="text-[hsl(var(--pricing-accent))]">Mistral</span>
          </h1>

          <p className="mx-auto mt-5 max-w-2xl text-sm leading-6 text-white/62 md:text-base">
            Permettez à vos clients de réserver, vérifier les disponibilités et gérer leurs
            réservations directement depuis leur assistant IA. OAuth 2.0, PKCE, six outils
            documentés.
          </p>

          <div className="mt-8 flex w-full flex-col items-stretch justify-center gap-3 sm:w-auto sm:flex-row">
            <CodeBlock label="Endpoint MCP" code={MCP_URL} />
            <Link
              href="/register"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-semibold text-black transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/90 active:scale-[0.98]"
            >
              Démarrer l&apos;intégration
              <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </section>

      {/* ── EXEMPLES DE PROMPTS ───────────────────────────── */}
      <section className="border-b border-white/8 py-20">
        <div className="mx-auto max-w-5xl px-5 sm:px-8">
          <SectionHeader
            icon={<Sparkles size={14} />}
            eyebrow="Exemples"
            title="Trois prompts qui marchent"
            description="Copiez-collez dans ChatGPT, Claude ou Mistral après avoir connecté Suppernote. Les outils s'enchaînent automatiquement."
          />

          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {PROMPTS.map((prompt) => (
              <article
                key={prompt.title}
                className="group flex flex-col rounded-2xl border border-white/8 bg-white/[0.02] p-6 transition-all duration-200 hover:border-white/20 hover:bg-white/[0.04]"
              >
                <h3 className="text-base font-semibold text-white">{prompt.title}</h3>
                <blockquote className="mt-3 flex-1 rounded-lg border border-white/10 bg-black/40 p-4 text-sm leading-6 text-white/80">
                  {prompt.body}
                </blockquote>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {prompt.tools.map((t) => (
                    <code
                      key={t}
                      className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-mono text-white/70"
                    >
                      {t}
                    </code>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── TOOLS ─────────────────────────────────────────── */}
      <section className="border-b border-white/8 py-20">
        <div className="mx-auto max-w-5xl px-5 sm:px-8">
          <SectionHeader
            icon={<Code2 size={14} />}
            eyebrow="Outils"
            title="Six outils, un contrat strict"
            description="Chaque tool est validé par Zod. Pas de champs implicites. Annotations readOnly / destructive respectées par les clients MCP."
          />

          <div className="mt-12 grid gap-4 md:grid-cols-2">
            {TOOLS.map((tool) => (
              <article
                key={tool.name}
                className="rounded-2xl border border-white/8 bg-white/[0.02] p-6"
              >
                <div className="flex items-start justify-between gap-3">
                  <code className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[12px] font-mono text-[hsl(var(--pricing-accent))]">
                    {tool.name}
                  </code>
                  {tool.readOnly ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-foreground">
                      <CheckCircle2 size={10} />
                      read-only
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                      <ShieldCheck size={10} />
                      mutation
                    </span>
                  )}
                </div>
                <h3 className="mt-3 text-base font-semibold text-white">{tool.title}</h3>
                <p className="mt-2 text-sm leading-6 text-white/62">{tool.description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── SETUP ─────────────────────────────────────────── */}
      <section className="border-b border-white/8 py-20">
        <div className="mx-auto max-w-5xl px-5 sm:px-8">
          <SectionHeader
            icon={<KeyRound size={14} />}
            eyebrow="Connexion"
            title="Ajouter Suppernote à votre assistant"
            description="Trois étapes. OAuth 2.0 + PKCE S256. Aucun secret à copier."
          />

          <p className="mx-auto mt-3 max-w-2xl text-center text-sm text-white/62">
            OAuth 2.0 + PKCE S256. Aucun secret à copier-coller. Fonctionne sur les principaux
            assistants IA.
          </p>

          {/* Grid de plateformes */}
          <div className="mt-12 grid gap-4 md:grid-cols-2">
            <PlatformCard
              name="Claude.ai"
              tag="Anthropic"
              steps={[
                'Settings → Connectors',
                'Bouton "Add custom connector"',
                "Coller l'URL ci-dessus",
                'Cliquer "Connect" → écran de consentement Suppernote',
                'Une fois autorisé, le connecteur apparaît dans la liste',
              ]}
            />
            <PlatformCard
              name="ChatGPT"
              tag="OpenAI"
              steps={[
                'Settings → Connectors → "Create"',
                'Mode "Developer" (nécessite un compte Pro/Team/Enterprise)',
                "Coller l'URL ci-dessus",
                'OAuth flow automatique → consentement Suppernote',
                'Le connecteur apparaît dans la liste des outils disponibles',
              ]}
            />
            <PlatformCard
              name="Mistral Le Chat"
              tag="Mistral AI"
              steps={[
                'Settings → Connectors → "Custom MCP server"',
                "Coller l'URL ci-dessus",
                'Bouton "Connect" → écran de consentement Suppernote',
                'Une fois autorisé, le serveur apparaît dans la liste',
              ]}
            />
            <PlatformCard
              name="Claude Code (CLI)"
              tag="Terminal"
              steps={[
                "Ajout direct via variable d'environnement ou commande",
                'claude mcp add suppernote --transport http https://api.suppernote.com/mcp',
                'Le flow OAuth se déclenche à la première utilisation',
                'Le connecteur est persisté dans ~/.claude/mcp.json',
              ]}
              mono
            />
          </div>

          <div className="mt-12 rounded-2xl border border-white/8 bg-white/[0.02] p-6">
            <h3 className="text-base font-semibold text-white">Comment ça marche</h3>
            <p className="mt-3 text-sm leading-6 text-white/70">
              Quand vous ajoutez l&apos;URL, l&apos;assistant fait un GET sur{' '}
              <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-xs">
                /.well-known/oauth-protected-resource
              </code>{' '}
              pour découvrir le serveur d&apos;autorisation. Il s&apos;enregistre automatiquement
              via Dynamic Client Registration (DCR, RFC 7591), génère un PKCE S256, affiche
              l&apos;écran de consentement Suppernote, et vous redirige avec un code
              d&apos;autorisation. Le consentement est lié à votre organisation Clerk : aucun mot de
              passe n&apos;est partagé avec l&apos;assistant, et l&apos;accès est limité à votre
              restaurant.
            </p>
          </div>
        </div>
      </section>

      {/* ── SCOPES ────────────────────────────────────────── */}
      <section className="border-b border-white/8 py-20">
        <div className="mx-auto max-w-5xl px-5 sm:px-8">
          <SectionHeader
            icon={<ShieldCheck size={14} />}
            eyebrow="Sécurité"
            title="Trois scopes distincts"
            description="Tokens opaques stockés en Redis. Refresh automatique. Révocation à tout moment depuis le dashboard."
          />

          <div className="mt-12 grid gap-4 md:grid-cols-3">
            {SCOPES.map((scope) => (
              <div
                key={scope.name}
                className="rounded-2xl border border-white/8 bg-white/[0.02] p-6"
              >
                <code className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[12px] font-mono text-[hsl(var(--pricing-accent))]">
                  {scope.name}
                </code>
                <p className="mt-3 text-sm leading-6 text-white/62">{scope.description}</p>
              </div>
            ))}
          </div>

          <div className="mt-10 grid gap-3 text-sm text-white/62 sm:grid-cols-2">
            <Fact
              icon={<Check size={14} className="text-foreground" />}
              text="PKCE S256 obligatoire, plain rejeté"
            />
            <Fact
              icon={<Check size={14} className="text-foreground" />}
              text="Rate limit 60 calls / 60s par client"
            />
            <Fact
              icon={<Check size={14} className="text-foreground" />}
              text="Données personnelles filtrées (PII redaction)"
            />
            <Fact
              icon={<Check size={14} className="text-foreground" />}
              text="Consent CSRF + Clerk org-scoped"
            />
            <Fact
              icon={<XCircle size={14} className="text-rose-300" />}
              text="Pas de stockage de cartes ou paiements"
            />
            <Fact
              icon={<XCircle size={14} className="text-rose-300" />}
              text="Pas d'accès à d'autres restaurants que le vôtre"
            />
          </div>
        </div>
      </section>

      {/* ── FOOTER ────────────────────────────────────────── */}
      <footer className="py-10 text-center text-sm text-muted-foreground">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-2 px-5 sm:flex-row sm:justify-between sm:px-8">
          <span>&copy; {new Date().getFullYear()} Suppernote. Tous droits réservés.</span>
          <div className="flex items-center gap-5">
            <Link href="/pricing" className="hover:text-foreground transition-all duration-200">
              Tarifs
            </Link>
            <a href="/privacy" className="hover:text-foreground transition-all duration-200">
              Confidentialité
            </a>
            <Link href="/login" className="hover:text-foreground transition-all duration-200">
              Connexion
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ─── Helpers ──────────────────────────────────────────────── */

function SectionHeader({
  icon,
  eyebrow,
  title,
  description,
}: {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-white/70">
        {icon}
        {eyebrow}
      </p>
      <h2 className="mt-4 text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl font-display">
        {title}
      </h2>
      <p className="mt-3 text-sm leading-6 text-white/62 md:text-base">{description}</p>
    </div>
  );
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="flex w-full items-center gap-2 rounded-full border border-white/10 bg-black/60 px-5 py-3 font-mono text-xs text-white sm:w-auto">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-white/50">
        {label}
      </span>
      <code className="truncate text-white/90">{code}</code>
    </div>
  );
}

function PlatformCard({
  name,
  tag,
  steps,
  mono = false,
}: {
  name: string;
  tag: string;
  steps: string[];
  mono?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-white">{name}</h3>
        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/60">
          {tag}
        </span>
      </div>
      <ol className="mt-4 space-y-2">
        {steps.map((s, idx) => (
          <li key={idx} className="flex items-start gap-3 text-sm text-white/72">
            <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-[10px] font-bold text-white/60">
              {idx + 1}
            </span>
            {mono ? (
              <code className="rounded-md border border-white/10 bg-black/40 px-2 py-0.5 font-mono text-xs text-[hsl(var(--pricing-accent))]">
                {s}
              </code>
            ) : (
              <span className="leading-6">{s}</span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function SetupStep({
  number,
  title,
  items,
}: {
  number: number;
  title: string;
  items: { label: string; body: string; mono?: boolean }[];
}) {
  return (
    <li className="flex gap-5 rounded-2xl border border-white/8 bg-white/[0.02] p-6">
      <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-sm font-bold text-white">
        {number}
      </span>
      <div className="flex-1">
        <h3 className="text-base font-semibold text-white">{title}</h3>
        <ul className="mt-3 space-y-2">
          {items.map((item, idx) => (
            <li key={idx} className="flex items-start gap-3 text-sm text-white/70">
              <span className="min-w-[80px] text-[10px] font-semibold uppercase tracking-wider text-white/50">
                {item.label}
              </span>
              {item.mono ? (
                <code className="rounded-md border border-white/10 bg-black/40 px-2 py-0.5 font-mono text-xs text-[hsl(var(--pricing-accent))]">
                  {item.body}
                </code>
              ) : (
                <span className="leading-6">{item.body}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}

function Fact({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 flex-shrink-0">{icon}</span>
      <span className="leading-6">{text}</span>
    </div>
  );
}
