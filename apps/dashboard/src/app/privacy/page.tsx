import type { Metadata } from 'next';
import Link from 'next/link';
import { Mail } from 'lucide-react';
import { PRIVACY_DOCUMENT, PRIVACY_PROVIDERS, PRIVACY_RETENTION } from '@suppernote/shared';

export const metadata: Metadata = {
  title: 'Politique de confidentialité — Suppernote',
  description:
    'Comment Suppernote collecte, traite et protège les données personnelles, conformément au RGPD.',
  robots: { index: false, follow: true },
};

const LAST_UPDATED = PRIVACY_DOCUMENT.updatedLabel;

const COMPANY = {
  tradeName: 'Suppernote',
  legalForm: 'Entreprise individuelle (EI)',
  establishmentAddress: '9 rue Vaubecour, 69002 Lyon',
  privacyEmail: PRIVACY_DOCUMENT.contact,
  hostingProvider: PRIVACY_DOCUMENT.hosting,
};

const SUBPROCESSORS = PRIVACY_PROVIDERS;

// Catégories de données, finalités, base légale, durée
const DATA_CATEGORIES = [
  {
    category: 'Données de compte',
    examples: 'E-mail, prénom, nom et organisation.',
    purpose: 'Création et gestion de votre compte Suppernote.',
    legalBasis: 'Exécution du contrat (CGU).',
    retention: PRIVACY_RETENTION.accounts,
  },
  {
    category: 'Données de votre restaurant',
    examples: 'Nom, adresse, numéro SIREN, horaires, menu et préférences du service vocal.',
    purpose: 'Fourniture du service de gestion et de réservation.',
    legalBasis: 'Exécution du contrat.',
    retention: PRIVACY_RETENTION.accounts,
  },
  {
    category: 'Données de vos clients finaux',
    examples: 'Nom, téléphone, adresse e-mail et historique des réservations.',
    purpose:
      'Prise, gestion et annulation des réservations. Envoi des confirmations par e-mail ou SMS. Suivi des préférences (allergies, VIP).',
    legalBasis: PRIVACY_DOCUMENT.reservationProcessing,
    retention: PRIVACY_RETENTION.reservations,
  },
  {
    category: 'Adresse e-mail de la réservation',
    examples: 'Adresse e-mail saisie pour une réservation en ligne.',
    purpose: 'Gestion de la réservation, notamment l’envoi de sa confirmation.',
    legalBasis: PRIVACY_DOCUMENT.reservationProcessing,
    retention: PRIVACY_RETENTION.reservationEmail,
  },
  {
    category: 'Demandes de démonstration',
    examples: 'Établissement, e-mail, téléphone et besoin facultatifs, dates et statut du suivi.',
    purpose: 'Répondre à votre demande, préparer la démonstration et assurer son suivi.',
    legalBasis: 'Intérêt légitime à répondre aux professionnels intéressés par le service.',
    retention: PRIVACY_RETENTION.demo,
  },
  {
    category: 'Métadonnées et transcriptions d’appels',
    examples: 'Numéro de téléphone, dates, durée, statut et transcription selon la fonctionnalité.',
    purpose: 'Gestion des appels et des réservations pour le restaurant.',
    legalBasis: 'Selon les finalités et instructions du restaurant.',
    retention: PRIVACY_RETENTION.calls,
  },
  {
    category: 'Audio et rapports d’appels de test',
    examples: 'Audio des appels de test et rapports de diagnostic associés.',
    purpose: 'Diagnostic et qualification du service sur les établissements de test autorisés.',
    legalBasis: 'Information et conditions du test à valider avant tout élargissement.',
    retention: PRIVACY_RETENTION.recordings,
  },
  {
    category: 'Dialogues de diagnostic de test',
    examples: 'Textes des échanges de test, avec masquage des téléphones et e-mails.',
    purpose: 'Diagnostic du dialogue sur les établissements de test autorisés.',
    legalBasis: 'Information et conditions du test à valider avant tout élargissement.',
    retention: PRIVACY_RETENTION.debugDialogue,
  },
  {
    category: 'Données de paiement',
    examples:
      'Références de paiement et informations de facturation ; les coordonnées de carte sont traitées par le prestataire de paiement.',
    purpose: 'Facturation et recouvrement.',
    legalBasis: 'Exécution du contrat + obligations légales comptables.',
    retention: PRIVACY_RETENTION.billing,
  },
  {
    category: 'Registre d’opposition marketing',
    examples:
      'Empreinte de l’adresse e-mail ou du numéro (HMAC-SHA256), canal, motif, source et date.',
    purpose: 'Ne pas solliciter de nouveau une personne qui s’est opposée à un message marketing.',
    legalBasis:
      'Intérêt légitime du restaurant à respecter durablement l’opposition et à pouvoir le démontrer.',
    retention: PRIVACY_RETENTION.optOutRegister,
  },
  {
    category: 'Logs techniques',
    examples: 'Adresse IP, informations sur le navigateur et événements de sécurité.',
    purpose: 'Sécurité, débogage, détection des abus.',
    legalBasis: 'Intérêt légitime (sécurité du service).',
    retention: PRIVACY_RETENTION.logs,
  },
];

const USER_RIGHTS = [
  {
    title: "Droit d'accès",
    body: 'Vous pouvez demander une copie des données personnelles vous concernant. Pour les données gérées par un restaurant, adressez-vous à cet établissement.',
  },
  {
    title: 'Droit de rectification',
    body: 'Vous pouvez corriger toute donnée inexacte ou incomplète directement depuis le dashboard, ou en nous contactant.',
  },
  {
    title: "Droit à l'effacement",
    body: 'Vous pouvez demander la suppression de vos données, sous réserve des obligations légales et des exceptions applicables.',
  },
  {
    title: 'Droit à la portabilité',
    body: 'Lorsque les conditions légales sont réunies, vous pouvez recevoir les données que vous avez fournies dans un format structuré et lisible.',
  },
  {
    title: "Droit d'opposition",
    body: 'Vous pouvez vous opposer à la prospection à tout moment, sans donner de motif. Vous pouvez aussi vous opposer à un traitement fondé sur l’intérêt légitime pour des raisons tenant à votre situation particulière, et retirer votre consentement à tout moment.',
  },
  {
    title: 'Droit à la limitation',
    body: "Vous pouvez demander la suspension temporaire d'un traitement pendant que nous examinons une contestation.",
  },
];

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground font-sans antialiased">
      {/* ── HERO ──────────────────────────────────────────── */}
      <section className="border-b border-border">
        <div className="mx-auto max-w-3xl px-5 pb-10 pt-28 sm:px-8">
          <p className="text-sm text-muted-foreground">Informations légales</p>

          <h1 className="mt-4 text-3xl font-semibold leading-tight text-foreground sm:text-4xl">
            Politique de confidentialité
          </h1>

          <p className="mt-5 max-w-2xl text-sm leading-6 text-muted-foreground md:text-base">
            Cette politique décrit les données que nous collectons, leur finalité, leur durée de
            conservation, et les droits dont vous disposez.
          </p>

          <p className="mt-6 text-xs uppercase tracking-wider text-white/40">
            Dernière mise à jour : {LAST_UPDATED}
          </p>
        </div>
      </section>

      <main className="mx-auto max-w-3xl space-y-16 px-5 py-16 sm:px-8">
        <aside
          role="status"
          className="border-l-2 border-border pl-4 text-sm leading-6 text-muted-foreground"
        >
          <p className="font-semibold text-white">Version en cours de vérification</p>
          <p className="mt-2">{PRIVACY_DOCUMENT.review}</p>
        </aside>

        {/* ── 1. RESPONSABLE DE TRAITEMENT ────────────────── */}
        <Section title="1. Responsable de traitement">
          <p>
            Suppernote est le nom commercial d’une entreprise individuelle. Les informations
            disponibles sont les suivantes ; l’identification complète du responsable reste à
            compléter.
          </p>
          <p className="mt-4">{PRIVACY_DOCUMENT.roles}</p>
          <DefList
            items={[
              { label: 'Nom commercial', value: COMPANY.tradeName },
              { label: 'Statut', value: COMPANY.legalForm },
              { label: 'Adresse de l’établissement', value: COMPANY.establishmentAddress },
              { label: 'Contact données personnelles', value: COMPANY.privacyEmail },
            ]}
          />
        </Section>

        {/* ── 2. DONNÉES COLLECTÉES ───────────────────────── */}
        <Section title="2. Quelles données collectons-nous ?">
          <div className="mt-6 divide-y divide-border">
            {DATA_CATEGORIES.map((d) => (
              <div key={d.category} className="py-6 first:pt-0">
                <h3 className="text-base font-semibold text-white">{d.category}</h3>
                <DefList
                  compact
                  items={[
                    { label: 'Exemples', value: d.examples },
                    { label: 'Finalité', value: d.purpose },
                    { label: 'Base légale', value: d.legalBasis },
                    { label: 'Conservation', value: d.retention },
                  ]}
                />
              </div>
            ))}
          </div>
          <p className="mt-6 text-sm leading-7 text-white/72">{PRIVACY_DOCUMENT.optOutRegister}</p>
          <p className="mt-6 text-sm leading-7 text-white/72">{PRIVACY_RETENTION.backups}</p>
        </Section>

        {/* ── 3. SOUS-TRAITANTS ───────────────────────────── */}
        <Section title="3. Fournisseurs et transferts hors UE">
          <p>{PRIVACY_DOCUMENT.transfers}</p>
          <dl className="mt-6 divide-y divide-border border-y border-border">
            {SUBPROCESSORS.map((provider) => (
              <div
                key={provider.id}
                className="grid gap-3 py-6 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-6"
              >
                <dt>
                  <p className="font-semibold text-foreground">{provider.name}</p>
                </dt>
                <dd className="min-w-0 space-y-3 text-sm text-muted-foreground">
                  <p>{provider.purpose}</p>
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-4">{PRIVACY_DOCUMENT.supplierInformation}</p>
          <p className="mt-4 text-xs text-white/50">
            Hébergeur principal : {COMPANY.hostingProvider}
          </p>
        </Section>

        {/* ── 4. DROITS UTILISATEUR ───────────────────────── */}
        <Section title="4. Vos droits">
          <p>
            Conformément au RGPD (articles 15 à 22), vous disposez à tout moment des droits
            suivants, selon les conditions légales applicables. Nous répondons en principe dans un
            délai d&apos;un mois ; une prolongation motivée peut être nécessaire dans les cas prévus
            par le RGPD.
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {USER_RIGHTS.map((r) => (
              <div key={r.title} className="border-t border-border py-4">
                <h3 className="text-sm font-semibold text-white">{r.title}</h3>
                <p className="mt-2 text-sm leading-6 text-white/70">{r.body}</p>
              </div>
            ))}
          </div>
          <p className="mt-6">
            Pour exercer ces droits, écrivez à{' '}
            <a
              href={`mailto:${COMPANY.privacyEmail}`}
              className="inline-flex items-center gap-1.5 text-[hsl(var(--pricing-accent))] hover:underline"
            >
              <Mail size={14} />
              {COMPANY.privacyEmail}
            </a>
            . En cas de réclamation, vous pouvez saisir la CNIL (
            <a
              href="https://www.cnil.fr/fr/plaintes"
              target="_blank"
              rel="noreferrer"
              className="text-[hsl(var(--pricing-accent))] hover:underline"
            >
              www.cnil.fr
            </a>
            ).
          </p>
        </Section>

        {/* ── 5. SÉCURITÉ ────────────────────────────────── */}
        <Section title="5. Sécurité des données">
          <p>{PRIVACY_DOCUMENT.security}</p>
        </Section>

        {/* ── 6. COOKIES ─────────────────────────────────── */}
        <Section title="6. Cookies">
          <p>{PRIVACY_DOCUMENT.cookies}</p>
        </Section>

        {/* ── 7. MODIFICATIONS ────────────────────────────── */}
        <Section title="7. Modifications de cette politique">
          <p>
            Nous pouvons être amenés à modifier cette politique pour refléter les évolutions du
            service, du cadre légal ou de nos sous-traitants. Toute modification substantielle sera
            notifiée par email et signalée par un changement de la date de « dernière mise à jour »
            en haut de cette page. La version précédente est disponible sur demande.
          </p>
        </Section>

        {/* ── 8. CONTACT ─────────────────────────────────── */}
        <Section title="8. Contact">
          <p>Pour toute question relative à cette politique ou à vos données personnelles :</p>
          <p className="mt-4">
            <a
              href={`mailto:${COMPANY.privacyEmail}`}
              className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/90"
            >
              <Mail size={14} />
              Contacter Suppernote
            </a>
          </p>
        </Section>

        <div className="pt-8 text-center text-xs text-white/40">
          <Link href="/" className="hover:text-foreground transition-all duration-200">
            ← Retour à l&apos;accueil
          </Link>
        </div>
      </main>
    </div>
  );
}

/* ─── Helpers ──────────────────────────────────────────────── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-semibold text-foreground">{title}</h2>
      <div className="mt-4 text-sm leading-7 text-white/72 sm:text-base">{children}</div>
    </section>
  );
}

function DefList({
  items,
  compact = false,
}: {
  items: { label: string; value: string }[];
  compact?: boolean;
}) {
  return (
    <dl className={compact ? 'mt-3 space-y-1.5' : 'mt-4 space-y-2'}>
      {items.map((item) => (
        <div
          key={item.label}
          className={`flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4 ${
            compact ? 'py-1' : 'py-2'
          }`}
        >
          <dt className="min-w-[140px] text-[10px] font-semibold uppercase tracking-wider text-white/50">
            {item.label}
          </dt>
          <dd className="text-sm text-white/80">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
