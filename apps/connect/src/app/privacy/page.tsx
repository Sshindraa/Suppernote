/**
 * Suppernote Connect — Politique de confidentialité.
 *
 * Rendu par requête pour que les scripts Next reçoivent le nonce CSP courant.
 * RGPD : Suppernote est un SaaS B2F (business-to-food) traitant des données
 * de réservation pour le compte de restaurants clients.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ArrowUpRight, Mail } from 'lucide-react';
import {
  PRIVACY_DOCUMENT,
  PRIVACY_PROVIDERS,
  PRIVACY_RETENTION,
  PRIVACY_RETENTION_RULES,
} from '@suppernote/shared';

// A per-request nonce cannot be attached to a prerendered HTML document.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Politique de confidentialité',
  description:
    'Politique de confidentialité de Suppernote — traitement des données personnelles pour les demandes de démonstration et les réservations des restaurants.',
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return (
    <main
      id="main-content"
      className="mx-auto max-w-6xl px-5 pb-16 pt-6 text-foreground sm:px-8 sm:pt-8"
    >
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
        <Link
          href="/"
          className="text-lg font-semibold tracking-tight transition-all duration-200 hover:opacity-70"
        >
          Suppernote<span className="text-muted-foreground">.</span>
        </Link>
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-all duration-200 hover:text-foreground"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Retour à l’accueil
        </Link>
      </header>
      <div className="pb-10 pt-12 sm:pb-12 sm:pt-16">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Informations légales
        </p>
        <h1 className="mt-4 max-w-3xl text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
          Politique de confidentialité
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground sm:text-base">
          Les informations utiles pour comprendre comment vos données sont utilisées et exercer vos
          droits.
        </p>
        <p className="mt-5 text-xs text-muted-foreground">
          Dernière mise à jour :{' '}
          <time dateTime={PRIVACY_DOCUMENT.revision}>{PRIVACY_DOCUMENT.updatedLabel}</time>
        </p>
      </div>
      <div className="grid items-start gap-10 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-16">
        <aside className="lg:sticky lg:top-8">
          <nav
            aria-label="Sommaire de la confidentialité"
            className="rounded-2xl border border-border p-4"
          >
            <p className="mb-3 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Sur cette page
            </p>
            <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-1">
              <a
                href="#responsabilites"
                className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Responsabilités
              </a>
              <a
                href="#demo"
                className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Demandes de démo
              </a>
              <a
                href="#donnees"
                className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Données de réservation
              </a>
              <a
                href="#finalites"
                className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Finalités des réservations
              </a>
              <a
                href="#conservation"
                className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Conservation
              </a>
              <a
                href="#fournisseurs"
                className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Fournisseurs
              </a>
              <a
                href="#droits"
                className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Vos droits
              </a>
              <a
                href="#cookies"
                className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Cookies
              </a>
            </div>
          </nav>
          <div className="mt-4 rounded-2xl bg-muted p-5">
            <Mail size={17} className="mb-3 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">Une question sur vos données ?</p>
            <a
              href="mailto:privacy@suppernote.com"
              className="mt-2 inline-flex items-center gap-1 break-all text-sm underline underline-offset-4 transition-all duration-200 hover:opacity-70"
            >
              privacy@suppernote.com
              <ArrowUpRight size={13} aria-hidden="true" />
            </a>
          </div>
        </aside>
        <article
          aria-label="Politique de confidentialité"
          className="min-w-0 max-w-3xl space-y-10 text-sm leading-7 sm:text-base sm:leading-7"
        >
          <section
            id="responsabilites"
            aria-labelledby="responsabilites-title"
            className="scroll-mt-8 border-b border-border pb-10 last:border-0"
          >
            <div className="mb-5 flex items-start gap-3">
              <span aria-hidden="true" className="mt-0.5 font-mono text-xs text-muted-foreground">
                01
              </span>
              <h2
                id="responsabilites-title"
                className="text-lg font-semibold tracking-tight text-foreground sm:text-xl"
              >
                Responsabilités
              </h2>
            </div>
            <p className="text-muted-foreground">
              Suppernote traite les demandes de démonstration pour répondre aux professionnels qui
              le contactent. Pour ces demandes et leur suivi, Suppernote détermine les finalités du
              traitement.
            </p>
            <p className="mt-4 text-muted-foreground">{PRIVACY_DOCUMENT.review}</p>
            <p className="mt-4 text-muted-foreground">
              Pour les réservations gérées pour le compte d’un restaurant, le restaurant détermine
              les finalités de gestion de sa clientèle ; Suppernote intervient comme prestataire
              traitant les données sur ses instructions. Suppernote détermine séparément les
              finalités de ses traitements propres, notamment pour assurer la sécurité de son
              service.
            </p>
            <p className="mt-4 text-muted-foreground">
              Pour toute question relative à vos données, vous pouvez nous contacter à{' '}
              <a
                href="mailto:privacy@suppernote.com"
                className="text-foreground underline transition-all duration-200 hover:text-foreground"
              >
                privacy@suppernote.com
              </a>
              .
            </p>
          </section>

          <section
            id="demo"
            aria-labelledby="demo-title"
            className="scroll-mt-8 border-b border-border pb-10 last:border-0"
          >
            <div className="mb-5 flex items-start gap-3">
              <span aria-hidden="true" className="mt-0.5 font-mono text-xs text-muted-foreground">
                02
              </span>
              <h2
                id="demo-title"
                className="text-lg font-semibold tracking-tight text-foreground sm:text-xl"
              >
                Demandes de démo
              </h2>
            </div>
            <div className="mt-6 first:mt-0">
              <h3 className="mb-2 text-sm font-semibold text-foreground">Informations demandées</h3>
              <p className="text-muted-foreground">
                Le nom de l’établissement et une adresse e-mail valide sont nécessaires pour traiter
                votre demande ; sans ces informations, nous ne pouvons pas vous répondre. Le
                téléphone, votre outil actuel et la description de votre besoin sont facultatifs.
                Évitez d’inclure des données de vos clients ou des informations sensibles dans les
                champs libres.
              </p>
            </div>
            <div className="mt-6 first:mt-0">
              <h3 className="mb-2 text-sm font-semibold text-foreground">
                Pourquoi nous les utilisons
              </h3>
              <p className="mt-4 text-muted-foreground">
                Ces informations servent à répondre à votre demande, préparer la démonstration et en
                assurer le suivi. Ce traitement repose sur l’intérêt légitime de Suppernote à
                répondre aux professionnels intéressés par son service. Une demande de démonstration
                ne vaut pas inscription à une newsletter ni accord pour des campagnes marketing.
              </p>
            </div>
            <div className="mt-6 first:mt-0">
              <h3 className="mb-2 text-sm font-semibold text-foreground">Qui peut y accéder</h3>
              <p className="mt-4 text-muted-foreground">
                Votre demande est accessible à l’équipe Suppernote habilitée à y répondre. Nos
                prestataires d’hébergement, d’envoi d’e-mails et de messagerie interviennent pour
                l’enregistrer, nous la transmettre et permettre le suivi de nos échanges.
              </p>
            </div>
            <div className="mt-6 first:mt-0">
              <h3 className="mb-2 text-sm font-semibold text-foreground">Combien de temps</h3>
              <p className="mt-4 text-muted-foreground">{PRIVACY_RETENTION.demo}</p>
            </div>
            <div className="mt-6 first:mt-0">
              <h3 className="mb-2 text-sm font-semibold text-foreground">Traitements hors UE</h3>
              <p className="mt-4 text-muted-foreground">
                Les services d’envoi et de messagerie peuvent impliquer des traitements hors de
                l’Union européenne. Pour connaître les destinataires de votre demande et obtenir des
                informations sur les pays concernés et les garanties applicables, contactez
                privacy@suppernote.com.
              </p>
            </div>
            <div className="mt-6 first:mt-0">
              <h3 className="mb-2 text-sm font-semibold text-foreground">Exercer vos droits</h3>
              <p className="mt-4 text-muted-foreground">
                Vous pouvez demander l’accès, la rectification, l’effacement ou la limitation de vos
                données et vous opposer au traitement pour des raisons tenant à votre situation.
                Écrivez à{' '}
                <a
                  href="mailto:privacy@suppernote.com"
                  className="underline transition-all duration-200"
                >
                  privacy@suppernote.com
                </a>
                . Vous pouvez également adresser une réclamation à la CNIL, comme indiqué
                ci-dessous.
              </p>
            </div>
          </section>

          <section
            id="donnees"
            aria-labelledby="donnees-title"
            className="scroll-mt-8 border-b border-border pb-10 last:border-0"
          >
            <div className="mb-5 flex items-start gap-3">
              <span aria-hidden="true" className="mt-0.5 font-mono text-xs text-muted-foreground">
                03
              </span>
              <h2
                id="donnees-title"
                className="text-lg font-semibold tracking-tight text-foreground sm:text-xl"
              >
                Données de réservation
              </h2>
            </div>
            <p className="text-muted-foreground">
              Lors d&apos;une réservation en ligne, nous collectons les données suivantes :
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-6 text-muted-foreground">
              <li>Prénom et nom (pour personnaliser la confirmation)</li>
              <li>
                Numéro de téléphone au format international (pour vous joindre au sujet de votre
                réservation)
              </li>
              <li>Adresse e-mail (optionnelle, pour une confirmation par e-mail)</li>
              <li>Demandes spéciales éventuelles (allergies, accès, etc.)</li>
              <li>
                Pour les appels téléphoniques : informations sur l’appel et transcription selon la
                fonctionnalité utilisée. Les enregistrements audio sont limités aux tests autorisés.
              </li>
              <li>
                Informations de navigation : origine de la réservation et données techniques
                nécessaires à la sécurité du service
              </li>
            </ul>
          </section>

          <section
            id="finalites"
            aria-labelledby="finalites-title"
            className="scroll-mt-8 border-b border-border pb-10 last:border-0"
          >
            <div className="mb-5 flex items-start gap-3">
              <span aria-hidden="true" className="mt-0.5 font-mono text-xs text-muted-foreground">
                04
              </span>
              <h2
                id="finalites-title"
                className="text-lg font-semibold tracking-tight text-foreground sm:text-xl"
              >
                Finalités des réservations
              </h2>
            </div>
            <p className="text-muted-foreground">{PRIVACY_DOCUMENT.reservationProcessing}</p>
            <p className="mt-4 text-muted-foreground">{PRIVACY_DOCUMENT.optOutRegister}</p>
            <p className="mt-4 text-muted-foreground">
              La prévention des abus et la protection du service reposent sur l’intérêt légitime à
              assurer sa sécurité.
            </p>
          </section>

          <section
            id="conservation"
            aria-labelledby="conservation-title"
            className="scroll-mt-8 border-b border-border pb-10 last:border-0"
          >
            <div className="mb-5 flex items-start gap-3">
              <span aria-hidden="true" className="mt-0.5 font-mono text-xs text-muted-foreground">
                05
              </span>
              <h2
                id="conservation-title"
                className="text-lg font-semibold tracking-tight text-foreground sm:text-xl"
              >
                Conservation
              </h2>
            </div>
            <dl className="space-y-6">
              {PRIVACY_RETENTION_RULES.map((rule) => (
                <div key={rule.id}>
                  <dt className="font-semibold">{rule.category}</dt>
                  <dd className="mt-2 text-muted-foreground">{rule.description}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section
            id="fournisseurs"
            aria-labelledby="fournisseurs-title"
            className="scroll-mt-8 border-b border-border pb-10 last:border-0"
          >
            <div className="mb-5 flex items-start gap-3">
              <span aria-hidden="true" className="mt-0.5 font-mono text-xs text-muted-foreground">
                06
              </span>
              <h2 id="fournisseurs-title" className="text-lg font-semibold sm:text-xl">
                Fournisseurs et transferts
              </h2>
            </div>
            <p className="text-muted-foreground">{PRIVACY_DOCUMENT.transfers}</p>
            <dl className="mt-6 divide-y divide-border border-y border-border">
              {PRIVACY_PROVIDERS.map((provider) => (
                <div key={provider.id} className="py-5">
                  <dt className="font-semibold">{provider.name}</dt>
                  <dd className="mt-2 space-y-2 text-muted-foreground">
                    <p>{provider.purpose}</p>
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-muted-foreground">{PRIVACY_DOCUMENT.supplierInformation}</p>
          </section>

          <section
            id="droits"
            aria-labelledby="droits-title"
            className="scroll-mt-8 border-b border-border pb-10 last:border-0"
          >
            <div className="mb-5 flex items-start gap-3">
              <span aria-hidden="true" className="mt-0.5 font-mono text-xs text-muted-foreground">
                07
              </span>
              <h2
                id="droits-title"
                className="text-lg font-semibold tracking-tight text-foreground sm:text-xl"
              >
                Vos droits
              </h2>
            </div>
            <p className="text-muted-foreground">
              Conformément au RGPD, vous disposez d&apos;un droit d&apos;accès, de rectification, de
              suppression, de limitation et d&apos;opposition concernant vos données, ainsi que de
              portabilité lorsque les conditions légales sont réunies. Vous pouvez retirer un
              consentement à tout moment. Pour exercer ces droits, contactez-nous à{' '}
              <a
                href="mailto:privacy@suppernote.com"
                className="text-foreground underline transition-all duration-200 hover:text-foreground"
              >
                privacy@suppernote.com
              </a>{' '}
              ou directement auprès du restaurant concerné.
            </p>
            <p className="mt-4 text-muted-foreground">
              Vous pouvez également introduire une réclamation auprès de la CNIL (
              <a
                href="https://www.cnil.fr/fr/plaintes"
                className="text-foreground underline transition-all duration-200 hover:text-foreground"
                target="_blank"
                rel="noopener noreferrer"
              >
                www.cnil.fr/fr/plaintes
              </a>
              ).
            </p>
          </section>

          <section
            id="cookies"
            aria-labelledby="cookies-title"
            className="scroll-mt-8 border-b border-border pb-10 last:border-0"
          >
            <div className="mb-5 flex items-start gap-3">
              <span aria-hidden="true" className="mt-0.5 font-mono text-xs text-muted-foreground">
                08
              </span>
              <h2
                id="cookies-title"
                className="text-lg font-semibold tracking-tight text-foreground sm:text-xl"
              >
                Cookies
              </h2>
            </div>
            <p className="text-muted-foreground">{PRIVACY_DOCUMENT.cookies}</p>
          </section>
          <a
            href="#main-content"
            className="inline-flex text-sm underline underline-offset-4 transition-all duration-200 hover:opacity-70"
          >
            Retour en haut
          </a>
        </article>
      </div>
    </main>
  );
}
