/**
 * Suppernote Connect — Page restaurant publique (T5 complète).
 *
 * URL : /restaurant/[slug]
 *
 * Sections :
 * - Header (H1, description, CTA Réserver)
 * - Galerie / cover
 * - Informations pratiques (adresse, tél, cuisine, prix, lien Maps)
 * - Horaires (depuis restaurant.openingHours)
 * - Ambiance & options (dietary, noiseLevel, terrasse, etc. si présents)
 * - CTA Réserver (secondaire, bas de page)
 * - FAQ (1-2 Q/R pour Schema.org FAQPage — bonus SEO)
 *
 * Server Component, ISR 60s, JSON-LD injecté via <script>.
 * Tracke page_view via fetch asynchrone (fire-and-forget).
 */

import type { Metadata } from 'next';
import { isConnectDemoSlug, SUPPERNOTE_DEMO_SLUG } from '@suppernote/shared';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { fetchPublicRestaurant, fetchPublishedSlugs, fetchAvailability } from '@/lib/api-client';
import { fetchPublicExperiences } from '@/lib/api/experiences';
import { ReservationJsonLd, buildPublicRestaurantJsonLd } from '@/lib/jsonld';
import { trackPageView, trackEvent } from '@/lib/tracking';
import { BookCtaLink } from '@/components/book-cta-link';
import { PageViewTracker } from '@/components/page-view-tracker';
import { isValidSlug } from '@/lib/widget-colors';
import { todayInTimezone } from '@/lib/restaurant-day';
import { parseTestBookingToken, TEST_BOOKING_BANNER } from '@/lib/test-booking';
import { DemoRestaurant } from './demo-restaurant';

const SITE_URL = process.env.SITE_URL ?? 'https://suppernote.com';

export const dynamicParams = true;
// Rendue à chaque visite : la page lit `?preview`, `?testBooking` et `?source`, et affiche les
// créneaux du jour. Next répond `no-store` et ni nginx ni Cloudflare ne la cachent ; seules les
// informations du restaurant sont gardées en cache, pas les créneaux.
// shortcut: un rendu complet par visite, à revoir si le trafic SEO monte (paramètres côté client,
// aperçu sur une route à part, puis cache de page).
export const dynamic = 'force-dynamic';

// Au build, l'API peut ne pas être disponible (build local, CI sans API).
// On retourne alors [] pour éviter les erreurs ECONNREFUSED bruyantes ;
// les pages sont alors rendues à la demande au runtime.
export async function generateStaticParams(): Promise<Array<{ slug: string }>> {
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    // Vérifier si l'API est joignable avant de tenter le fetch.
    // Si elle ne l'est pas, on skip : rendu à la demande au runtime.
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${process.env.API_URL ?? 'http://localhost:3001'}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return [];
    } catch {
      return [];
    }
  }
  const slugs = await fetchPublishedSlugs();
  return slugs.map((entry) => ({ slug: entry.slug }));
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ preview?: string; testBooking?: string; localPreview?: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const { preview, testBooking, localPreview } = await searchParams;
  const isPreview = preview === '1';
  const restaurant = await fetchPublicRestaurant(slug, { preview: isPreview });

  if (!restaurant) {
    return {
      title: 'Restaurant introuvable',
      robots: { index: false, follow: true },
    };
  }

  const cuisine = restaurant.cuisineTypes[0] ?? 'Restaurant';
  const canonical = `${SITE_URL}/restaurant/${restaurant.slug}`;
  const isDemo = isConnectDemoSlug(restaurant.slug);
  const indexable =
    !isPreview &&
    testBooking === undefined &&
    localPreview === undefined &&
    (restaurant.slug === SUPPERNOTE_DEMO_SLUG || !isDemo);
  const title = isDemo
    ? `${restaurant.name} — Restaurant de démonstration`
    : `${restaurant.name} — Réservation en ligne à ${restaurant.address.city}`;
  const description = isDemo
    ? 'Établissement fictif de démonstration Suppernote. Les réservations servent uniquement aux essais.'
    : `Réservez une table chez ${restaurant.name}, restaurant ${cuisine.toLowerCase()} à ${restaurant.address.city}. Horaires, adresse et réservation en ligne via Suppernote.`;

  return {
    // La marque est ajoutée par le template du layout (`%s | Suppernote`) : la
    // répéter ici produisait « … | Suppernote | Suppernote » sur chaque fiche.
    title,
    description,
    alternates: { canonical },
    openGraph: {
      type: 'website',
      title,
      description,
      url: canonical,
      images: restaurant.images.cover ? [{ url: restaurant.images.cover }] : [],
    },
    robots: {
      index: indexable,
      follow: true,
      googleBot: {
        index: indexable,
        follow: true,
        'max-snippet': -1,
        'max-image-preview': 'large',
      },
    },
  };
}

const DAY_LABELS_FR: Record<string, string> = {
  monday: 'Lundi',
  tuesday: 'Mardi',
  wednesday: 'Mercredi',
  thursday: 'Jeudi',
  friday: 'Vendredi',
  saturday: 'Samedi',
  sunday: 'Dimanche',
};

const DAY_ORDER: string[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

/** Construit une URL Google Maps à partir d'une adresse. */
function googleMapsUrl(line1: string, city: string, country: string): string {
  const q = encodeURIComponent(`${line1}, ${city}, ${country}`);
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

export default async function RestaurantPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    source?: string;
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    preview?: string;
    testBooking?: string;
    localPreview?: string;
  }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const isPreview = sp.preview === '1';
  // Parcours d'essai lancé depuis l'onboarding : jeton signé, ni statistique ni attribution.
  const testBookingToken = parseTestBookingToken(sp.testBooking);
  const isTestBooking = testBookingToken !== undefined;
  const bookQuerySuffix = `${sp.source ? `&utm=${sp.source}` : ''}${testBookingToken ? `&testBooking=${encodeURIComponent(testBookingToken)}` : ''}`;

  // Valider le slug (anti-injection — audit sécurité Phase 2)
  if (!isValidSlug(slug)) {
    notFound();
  }

  const restaurant = await fetchPublicRestaurant(slug, { preview: isPreview });

  if (!restaurant) {
    notFound();
  }

  const isDemo = restaurant.slug === SUPPERNOTE_DEMO_SLUG;
  const coverImage =
    restaurant.images.cover ??
    (isDemo ? '/connect-assets/demo/chez-suppernote-bistrot.png' : undefined);

  // Track page_view côté client (en ISR, le server-side ne s'exécute qu'au revalidate)
  // PageViewTracker est un composant client qui track au mount — chaque visite est comptée

  const jsonLd = buildPublicRestaurantJsonLd({
    siteUrl: process.env.SITE_URL ?? 'https://suppernote.com',
    restaurant,
  });

  const cuisine = restaurant.cuisineTypes[0] ?? 'Restaurant';
  const mapsUrl = googleMapsUrl(
    restaurant.address.line1,
    restaurant.address.city,
    restaurant.address.country,
  );

  // Horaires triés par jour de la semaine
  const hoursByDay = restaurant.openingHours
    .slice()
    .sort((a, b) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day));

  // Groupe les horaires par jour (support multi-créneaux : midi + soir).
  // [{day: monday, open: 12:00, close: 14:30}, {day: monday, open: 19:00, close: 22:30}]
  // → [{day: monday, slots: [{open: 12:00, close: 14:30}, {open: 19:00, close: 22:30}]}]
  const hoursGrouped = hoursByDay.reduce<
    Array<{ day: string; slots: Array<{ open: string; close: string }> }>
  >((acc, h) => {
    const existing = acc.find((g) => g.day === h.day);
    if (existing) {
      existing.slots.push({ open: h.open, close: h.close });
    } else {
      acc.push({ day: h.day, slots: [{ open: h.open, close: h.close }] });
    }
    return acc;
  }, []);

  // Disponibilités inline (Phase 2) : aperçu des créneaux du jour pour
  // éviter le clic supplémentaire vers /book. Les créneaux sont lus à chaque visite.
  // Le jour CHEZ le restaurant, pas le jour UTC (entre minuit et 2 h à Paris, ce dernier retarde d'un jour).
  const today = todayInTimezone(restaurant.timezone);
  const previewPartySize = 2;
  const availability = await fetchAvailability(restaurant.slug, {
    date: today,
    partySize: previewPartySize,
  });
  const availableSlots = availability?.slots.filter((s) => s.available).slice(0, 4) ?? [];
  const previewShown = availableSlots.length > 0;
  let hasBookableExperiences = false;
  try {
    const experienceCatalog = await fetchPublicExperiences(restaurant.slug);
    hasBookableExperiences = experienceCatalog.experiences.length > 0;
  } catch {
    // The public experience module is independently feature-gated.
  }

  // Track availability_preview_shown (fire-and-forget, best-effort) — jamais en réservation test
  if (previewShown && !isTestBooking) {
    trackEvent({
      event: 'availability_preview_shown',
      restaurantId: restaurant.id,
      restaurantSlug: restaurant.slug,
      date: today,
      partySize: previewPartySize,
      availableCount: availableSlots.length,
    });
  }

  // JSON-LD FAQ (1 Q/R pour Schema.org FAQPage — bonus SEO sans sur-promesse)
  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: `${restaurant.name} accepte-t-il les réservations ?`,
        acceptedAnswer: {
          '@type': 'Answer',
          text: `Oui, vous pouvez réserver une table en ligne chez ${restaurant.name} via Suppernote.`,
        },
      },
    ],
  };

  if (restaurant.slug === SUPPERNOTE_DEMO_SLUG) {
    return (
      <>
        {!isTestBooking && (
          <PageViewTracker
            restaurantId={restaurant.id}
            restaurantSlug={restaurant.slug}
            city={restaurant.address.city}
            source={sp.source}
            utmSource={sp.utm_source}
            utmMedium={sp.utm_medium}
            utmCampaign={sp.utm_campaign}
          />
        )}
        <DemoRestaurant
          restaurant={restaurant}
          availability={availability}
          today={today}
          bookQuerySuffix={bookQuerySuffix}
          isTestBooking={isTestBooking}
          localPreview={process.env.NODE_ENV !== 'production' && sp.localPreview === '1'}
          source={sp.source}
        />
      </>
    );
  }

  return (
    <>
      {!isConnectDemoSlug(restaurant.slug) && <ReservationJsonLd jsonLd={jsonLd} />}
      {!isConnectDemoSlug(restaurant.slug) && (
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
        />
      )}

      <main id="main-content" className="mx-auto max-w-4xl px-6 py-12">
        {!isTestBooking && (
          <PageViewTracker
            restaurantId={restaurant.id}
            restaurantSlug={restaurant.slug}
            city={restaurant.address.city}
            source={sp.source}
            utmSource={sp.utm_source}
            utmMedium={sp.utm_medium}
            utmCampaign={sp.utm_campaign}
          />
        )}
        {isTestBooking && (
          <p className="mb-6 rounded-xl border border-border bg-muted p-6 text-foreground">
            {TEST_BOOKING_BANNER}
          </p>
        )}
        {isConnectDemoSlug(restaurant.slug) && (
          <p className="mb-6 rounded-xl border border-border bg-muted p-6 text-foreground">
            Établissement de démonstration — les réservations servent uniquement aux essais. Cette
            fiche ne correspond pas à un restaurant réel.
          </p>
        )}
        <article>
          <header className="mb-8">
            <h1 className="text-3xl font-bold text-ink sm:text-4xl">
              {restaurant.name} — Restaurant {cuisine.toLowerCase()} à {restaurant.address.city}
            </h1>
            {restaurant.aggregateRating && (
              <p className="mt-2 text-sm text-muted-foreground">
                <span className="font-semibold text-blue">
                  {restaurant.aggregateRating.ratingValue.toFixed(1)} ★
                </span>{' '}
                · {restaurant.aggregateRating.reviewCount} avis Google
              </p>
            )}
            {(isDemo || restaurant.description) && (
              <p className="mt-3 text-lg text-muted-foreground">
                {isDemo
                  ? 'Un bistrot de quartier imaginé à Lyon, où une cuisine française de saison se découvre dans une atmosphère conviviale. Une table fictive pour découvrir la réservation en ligne Suppernote.'
                  : restaurant.description}
              </p>
            )}

            {/* CTA principal — au-dessus de la ligne de flottaison (acceptance T5) */}
            <div className="mt-6">
              <BookCtaLink
                href={`/book/${restaurant.slug}?source=restaurant${bookQuerySuffix}`}
                restaurantId={restaurant.id}
                restaurantSlug={restaurant.slug}
                track={!isTestBooking}
                source={sp.source}
                className="inline-flex items-center justify-center rounded-lg bg-ink px-6 py-3 text-base font-semibold text-white transition-all duration-200 hover:bg-ink/90 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                Réserver une table
              </BookCtaLink>
            </div>
          </header>

          {coverImage && (
            <figure className="mb-8 overflow-hidden rounded-xl">
              <Image
                src={coverImage}
                alt={
                  isDemo
                    ? 'Illustration d’un bistrot fictif à Lyon'
                    : `Vue du restaurant ${restaurant.name} à ${restaurant.address.city}`
                }
                width={1200}
                height={320}
                className="h-64 w-full object-cover sm:h-80"
                priority
              />
              {isDemo && !restaurant.images.cover && (
                <figcaption className="mt-2 text-xs text-muted-foreground">
                  Illustration générée par IA · Restaurant fictif
                </figcaption>
              )}
            </figure>
          )}

          {restaurant.images.gallery.length > 0 && (
            <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {restaurant.images.gallery.slice(0, 6).map((url, idx) => (
                <figure key={idx} className="overflow-hidden rounded-lg">
                  <Image
                    src={url}
                    alt={`Photo ${idx + 1} du restaurant ${restaurant.name}`}
                    width={400}
                    height={160}
                    loading="lazy"
                    className="h-32 w-full object-cover transition-transform duration-200 hover:scale-105 sm:h-40"
                  />
                </figure>
              ))}
            </section>
          )}

          {/* Disponibilités inline (Phase 2) — aperçu des créneaux du jour */}
          <section className="mb-8 rounded-xl border border-border bg-background p-6">
            <h2 className="mb-3 text-xl font-semibold text-ink">Disponibilités aujourd&apos;hui</h2>
            {availability === null ? (
              <p className="text-sm text-muted-foreground">
                Les disponibilités sont momentanément indisponibles. Veuillez réessayer dans
                quelques instants.
              </p>
            ) : availableSlots.length > 0 ? (
              <>
                <p className="mb-3 text-sm text-muted-foreground">
                  Table de {previewPartySize} — {availableSlots.length} créneau
                  {availableSlots.length > 1 ? 'x' : ''} disponible
                  {availableSlots.length > 1 ? 's' : ''} :
                </p>
                <div className="flex flex-wrap gap-2">
                  {availableSlots.map((slot) => (
                    <Link
                      key={slot.time}
                      href={`/book/${restaurant.slug}?source=restaurant&date=${today}&time=${slot.time}&partySize=${previewPartySize}&from=preview${bookQuerySuffix}`}
                      className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold text-ink transition-all duration-200 hover:border-blue hover:bg-blue/5"
                    >
                      {slot.time}
                    </Link>
                  ))}
                </div>
                <Link
                  href={`/book/${restaurant.slug}?source=restaurant${bookQuerySuffix}`}
                  className="mt-3 inline-block text-sm text-blue underline hover:no-underline"
                >
                  Voir tous les créneaux et tailles de table
                </Link>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Aucun créneau disponible pour aujourd&apos;hui (table de {previewPartySize}).{' '}
                <Link
                  href={`/book/${restaurant.slug}?source=restaurant${bookQuerySuffix}`}
                  className="text-blue underline hover:no-underline"
                >
                  Vérifier un autre jour
                </Link>
              </p>
            )}
          </section>

          <section className="mb-8 rounded-xl border border-border bg-cream p-6">
            <h2 className="mb-3 text-xl font-semibold text-ink">Informations</h2>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-sm font-medium text-muted-foreground">Adresse</dt>
                <dd>
                  {isDemo ? (
                    <span>Lyon · adresse fictive</span>
                  ) : (
                    <a
                      href={mapsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue underline hover:no-underline"
                    >
                      {restaurant.address.line1}
                    </a>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-muted-foreground">Téléphone</dt>
                <dd>
                  {isDemo ? (
                    <span>Non disponible · démonstration</span>
                  ) : (
                    <a
                      href={`tel:${restaurant.phone}`}
                      className="text-blue underline hover:no-underline"
                    >
                      {restaurant.phone}
                    </a>
                  )}
                </dd>
              </div>
              {restaurant.cuisineTypes.length > 0 && (
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Cuisine</dt>
                  <dd className="text-ink">{restaurant.cuisineTypes.join(', ')}</dd>
                </div>
              )}
              {restaurant.priceRange && (
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Prix</dt>
                  <dd className="text-ink">{restaurant.priceRange}</dd>
                </div>
              )}
            </dl>
          </section>

          {hoursGrouped.length > 0 && (
            <section className="mb-8 rounded-xl border border-border bg-background p-6">
              <h2 className="mb-3 text-xl font-semibold text-ink">
                {isDemo ? 'Horaires de démonstration' : 'Horaires'}
              </h2>
              <ul className="space-y-1 text-ink">
                {hoursGrouped.map((g) => (
                  <li key={g.day} className="flex justify-between">
                    <span className="font-medium">{DAY_LABELS_FR[g.day] ?? g.day}</span>
                    <span>{g.slots.map((s) => `${s.open}–${s.close}`).join(', ')}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(restaurant.ambiance?.length || restaurant.dietary?.length || restaurant.noiseLevel) && (
            <section className="mb-8 rounded-xl border border-border bg-background p-6">
              <h2 className="mb-3 text-xl font-semibold text-ink">Ambiance & options</h2>
              <ul className="space-y-2 text-ink">
                {restaurant.ambiance?.length ? (
                  <li>
                    <span className="text-sm font-medium text-muted-foreground">Ambiance : </span>
                    {restaurant.ambiance.join(', ')}
                  </li>
                ) : null}
                {restaurant.dietary?.length ? (
                  <li>
                    <span className="text-sm font-medium text-muted-foreground">
                      Options alimentaires :{' '}
                    </span>
                    {restaurant.dietary.join(', ')}
                  </li>
                ) : null}
                {restaurant.noiseLevel ? (
                  <li>
                    <span className="text-sm font-medium text-muted-foreground">
                      Niveau sonore :{' '}
                    </span>
                    {restaurant.noiseLevel}
                  </li>
                ) : null}
              </ul>
            </section>
          )}

          <section className="mb-8 rounded-xl border border-border bg-background p-6">
            <h2 className="mb-3 text-xl font-semibold text-ink">Réservation</h2>
            <p className="text-ink">Réservation en ligne avec confirmation rapide.</p>
            <BookCtaLink
              href={`/book/${restaurant.slug}?source=restaurant${bookQuerySuffix}`}
              restaurantId={restaurant.id}
              restaurantSlug={restaurant.slug}
              track={!isTestBooking}
              source={sp.source}
              className="mt-4 inline-flex items-center justify-center rounded-lg border border-border bg-background px-5 py-2 text-sm font-semibold text-ink transition-all duration-200 hover:bg-muted"
            >
              Voir les disponibilités
            </BookCtaLink>
          </section>

          {hasBookableExperiences && (
            <section className="mb-8 rounded-xl border border-border bg-background p-6">
              <h2 className="mb-2 text-xl font-semibold text-ink">Ateliers et événements</h2>
              <p className="text-sm text-muted-foreground">
                Découvrez les expériences proposées par le restaurant et réservez votre date.
              </p>
              <Link
                href={`/restaurant/${restaurant.slug}/experiences`}
                className="mt-4 inline-flex items-center justify-center rounded-lg bg-ink px-5 py-2 text-sm font-semibold text-white transition-all duration-200 hover:bg-ink/90"
              >
                Découvrir les expériences
              </Link>
            </section>
          )}

          <section className="rounded-xl border border-border bg-background p-6">
            <h2 className="mb-3 text-xl font-semibold text-ink">Questions fréquentes</h2>
            <details className="group">
              <summary className="cursor-pointer text-base font-medium text-ink">
                {restaurant.name} accepte-t-il les réservations ?
              </summary>
              <p className="mt-2 text-ink">
                Oui, vous pouvez réserver une table en ligne via Suppernote.
                {restaurant.connectAgentic
                  ? ' Les assistants IA (ChatGPT, Perplexity) peuvent aussi vous y envoyer directement.'
                  : ''}
              </p>
            </details>
          </section>
        </article>
      </main>
    </>
  );
}
