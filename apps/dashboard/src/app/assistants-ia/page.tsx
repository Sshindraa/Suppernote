import Link from 'next/link';
import { ArrowLeft, ChevronDown, MessageCircle, Plug, ShieldCheck } from 'lucide-react';
import MarketingShell from '@/app/MarketingShell';
import { AI_ASSISTANTS_METADATA } from '@/app/marketing-metadata';
import AssistantSetup from './AssistantSetup';
import { MCP_URL } from './mcp-url';

export const metadata = AI_ASSISTANTS_METADATA;

const STEPS = [
  {
    icon: Plug,
    title: 'Ajoutez Suppernote',
    text: 'Une seule fois, en une minute.',
  },
  {
    icon: MessageCircle,
    title: 'Demandez une table',
    text: '« Une table pour 4 vendredi à 20 h à Lyon ? »',
  },
  {
    icon: ShieldCheck,
    title: 'Confirmez',
    text: 'L’assistant vous montre le créneau, vous validez.',
  },
];

const TOOLS = [
  ['Rechercher un restaurant', 'Lecture'],
  ['Consulter un restaurant', 'Lecture'],
  ['Vérifier les disponibilités', 'Lecture'],
  ['Garder un créneau quelques minutes', 'Écriture'],
  ['Créer une réservation', 'Écriture'],
  ['Modifier une réservation', 'Écriture'],
  ['Annuler une réservation', 'Écriture'],
  ['Consulter une réservation (avec le téléphone utilisé)', 'Lecture'],
  ['Rejoindre ou quitter la liste d’attente', 'Écriture'],
];

export default function AiAssistantsPage() {
  return (
    <MarketingShell>
      <main id="main-content" className="day-paper w-full">
        <div className="mx-auto min-h-screen max-w-3xl px-5 pb-20 pt-28 sm:px-8 sm:pt-32">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-all duration-200 hover:text-foreground"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Retour à l’accueil
          </Link>

          <header className="pb-10 pt-12 text-center sm:pt-16">
            <h1 className="font-brand text-4xl font-medium leading-tight tracking-tight sm:text-6xl">
              Réservez en parlant à votre assistant IA
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground">
              Claude, ChatGPT ou Le Chat trouvent une table et la réservent pour vous, dans la
              conversation.
            </p>
          </header>

          <ol className="grid gap-3 sm:grid-cols-3">
            {STEPS.map(({ icon: Icon, title, text }, index) => (
              <li key={title} className="rounded-2xl border border-border p-5">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-muted">
                  <Icon size={17} aria-hidden="true" />
                </span>
                <p className="mt-4 text-xs font-semibold text-muted-foreground">
                  Étape {index + 1}
                </p>
                <p className="mt-1 font-semibold">{title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{text}</p>
              </li>
            ))}
          </ol>

          <section aria-labelledby="ajouter-title" className="mt-14">
            <h2 id="ajouter-title" className="mb-5 font-brand text-2xl font-medium tracking-tight">
              Ajouter Suppernote à votre assistant
            </h2>
            <AssistantSetup />
          </section>

          <section aria-labelledby="donnees-title" className="mt-14">
            <h2 id="donnees-title" className="font-brand text-2xl font-medium tracking-tight">
              Vos données
            </h2>
            <p className="mt-3 text-muted-foreground">
              Votre nom et votre téléphone vont uniquement au restaurant choisi, jamais à des fins
              publicitaires sans votre accord. Vous pouvez retirer Suppernote de votre assistant à
              tout moment.{' '}
              <Link
                href="/privacy"
                className="text-foreground underline underline-offset-4 transition-all duration-200 hover:opacity-70"
              >
                Politique de confidentialité
              </Link>
            </p>
          </section>

          <p className="mt-14 text-sm text-muted-foreground">
            Une question ?{' '}
            <a
              href="mailto:hello@suppernote.com"
              className="text-foreground underline underline-offset-4 transition-all duration-200 hover:opacity-70"
            >
              hello@suppernote.com
            </a>
          </p>

          <details className="group mt-14 rounded-2xl border border-border">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5 text-sm font-semibold transition-all duration-200 hover:bg-muted/50">
              Restaurants, développeurs et relecteurs
              <ChevronDown
                size={16}
                aria-hidden="true"
                className="transition-transform duration-200 group-open:rotate-180"
              />
            </summary>
            <div className="space-y-8 border-t border-border p-5 text-sm leading-6 text-muted-foreground">
              <div>
                <h3 className="font-semibold text-foreground">Pour les restaurants</h3>
                <p className="mt-2">
                  La réservation par IA s’active dans votre espace Suppernote, à l’étape de
                  diffusion en ligne : taille de groupe maximale, délai minimum et validation
                  manuelle restent à vos réglages. Seuls les restaurants qui l’ont activée
                  apparaissent.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-foreground">Référence technique</h3>
                <ul className="mt-2 space-y-1">
                  <li>Serveur MCP (JSON-RPC 2.0 sur HTTPS) : {MCP_URL}</li>
                  <li>OAuth 2.0 avec PKCE S256 et enregistrement dynamique des clients</li>
                  <li>Autorisations : mcp:read, mcp:reserve, mcp:cancel</li>
                  <li>
                    Découverte : https://api.suppernote.com/.well-known/oauth-protected-resource
                  </li>
                </ul>
                <div className="mt-4 overflow-x-auto rounded-xl border border-border">
                  <table className="w-full border-collapse text-left">
                    <caption className="sr-only">
                      Outils exposés par le connecteur Suppernote
                    </caption>
                    <thead>
                      <tr className="border-b border-border">
                        <th scope="col" className="p-3 font-semibold text-foreground">
                          Outil
                        </th>
                        <th scope="col" className="p-3 font-semibold text-foreground">
                          Type
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {TOOLS.map(([tool, kind]) => (
                        <tr key={tool} className="border-b border-border last:border-0">
                          <th scope="row" className="p-3 font-medium text-foreground">
                            {tool}
                          </th>
                          <td className="p-3">{kind}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div lang="en">
                <h3 className="font-semibold text-foreground">In English</h3>
                <p className="mt-2">
                  Suppernote lets you book a table at participating restaurants from Claude, ChatGPT
                  or Le Chat. Add a custom connector with the URL {MCP_URL} and sign in with OAuth.
                  You can search restaurants, check availability, book, modify or cancel a booking,
                  and join a waiting list. Booking requires your name and phone number, shared only
                  with the chosen restaurant; the phone number is also required to read, change or
                  cancel a booking. Support: hello@suppernote.com. Privacy policy:
                  https://suppernote.com/privacy.
                </p>
              </div>
            </div>
          </details>
        </div>
      </main>
    </MarketingShell>
  );
}
