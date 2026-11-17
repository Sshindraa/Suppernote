import Image from 'next/image';
import Link from 'next/link';
import { BookCtaLink } from '@/components/book-cta-link';
import type { AvailabilityDto, PublicRestaurantDto } from '@/lib/api-client';
import { TEST_BOOKING_BANNER } from '@/lib/test-booking';
import styles from './demo-restaurant.module.css';

type Props = {
  restaurant: PublicRestaurantDto;
  availability: AvailabilityDto | null;
  today: string;
  bookQuerySuffix: string;
  isTestBooking: boolean;
  localPreview: boolean;
  source?: string;
};

const dayLabels: Record<string, string> = {
  monday: 'Lundi',
  tuesday: 'Mardi',
  wednesday: 'Mercredi',
  thursday: 'Jeudi',
  friday: 'Vendredi',
  saturday: 'Samedi',
  sunday: 'Dimanche',
};

export function DemoRestaurant({
  restaurant,
  availability,
  today,
  bookQuerySuffix,
  isTestBooking,
  localPreview,
  source,
}: Props) {
  const bookUrl = `/book/${restaurant.slug}?source=restaurant${bookQuerySuffix}`;
  const slots = availability?.slots.filter((slot) => slot.available).slice(0, 4) ?? [];

  return (
    <main id="main-content" className={styles.page}>
      <div className={styles.demoNotice}>
        Restaurant fictif · Les réservations servent uniquement aux essais
      </div>
      {isTestBooking && <p className={styles.testNotice}>{TEST_BOOKING_BANNER}</p>}
      <div className={styles.shell}>
        <header className={styles.nav}>
          <a className={styles.wordmark} href="#main-content">
            Chez Suppernote<span> Bistrot de démonstration</span>
          </a>
          <nav aria-label="Navigation du restaurant">
            <a href="#informations">Horaires et lieu</a>
            <a href="#reservation">
              Réserver <span aria-hidden="true">↗</span>
            </a>
          </nav>
        </header>

        <div className={styles.heading}>
          <div>
            <p className={styles.location}>
              Bistrot français <span>·</span> Lyon
            </p>
            <h1>Chez Suppernote</h1>
            <p>Une adresse imaginée pour découvrir la réservation avec Suppernote.</p>
          </div>
          <nav className={styles.headingLinks} aria-label="Accès rapide">
            <a href="#informations">Horaires et lieu</a>
            <a href="#reservation">Réserver</a>
          </nav>
        </div>

        <div className={styles.columns}>
          <div className={styles.content}>
            <figure className={styles.photo}>
              <Image
                src="/connect-assets/demo/chez-suppernote-bistrot.png"
                alt="Illustration d’un bistrot fictif à Lyon"
                fill
                priority
                sizes="(max-width: 850px) 100vw, 66vw"
              />
              <figcaption>Illustration générée par IA</figcaption>
            </figure>
            <section className={styles.about}>
              <h2>À propos</h2>
              <div>
                <p>
                  Chez Suppernote est un bistrot fictif imaginé à Lyon. Cette fiche permet de
                  découvrir comment un client consulte les disponibilités et réserve une table en
                  ligne.
                </p>
                <p>Le lieu, son adresse et ses horaires sont présentés à titre d’exemple.</p>
              </div>
            </section>
            <section id="informations" className={styles.information}>
              <h2>Informations pratiques</h2>
              <div className={styles.informationGrid}>
                <div>
                  <h3>Adresse</h3>
                  <p>
                    Lyon, France
                    <br />
                    Adresse fictive · Démonstration
                  </p>
                </div>
                <div>
                  <h3>Horaires de démonstration</h3>
                  {restaurant.openingHours.length ? (
                    <dl>
                      {Object.entries(dayLabels).map(([day, label]) => {
                        const periods = restaurant.openingHours.filter((hour) => hour.day === day);
                        return (
                          <div key={day}>
                            <dt>{label}</dt>
                            <dd>
                              {periods.length
                                ? periods.map((hour, index) => (
                                    <span key={`${hour.open}-${hour.close}-${index}`}>
                                      {hour.open}–{hour.close}
                                    </span>
                                  ))
                                : 'Fermé'}
                            </dd>
                          </div>
                        );
                      })}
                    </dl>
                  ) : (
                    <p>Horaires non renseignés</p>
                  )}
                </div>
              </div>
              <a href="#reservation" className={styles.informationBooking}>
                Réserver une table <span aria-hidden="true">↑</span>
              </a>
            </section>
          </div>
          <aside id="reservation" className={styles.booking} aria-labelledby="booking-title">
            <div className={styles.bookingHead}>
              <div>
                <p>CHEZ SUPPERNOTE</p>
                <h2 id="booking-title">Réserver une table</h2>
              </div>
              <span aria-hidden="true">↗</span>
            </div>
            <p className={styles.bookingDescription}>
              {localPreview
                ? 'La réservation n’est pas disponible dans cet aperçu local.'
                : 'Choisissez une date et un horaire pour essayer la réservation.'}
            </p>
            {!localPreview && (
              <div className={styles.bookingLine}>
                <span>Disponibilités aujourd’hui</span>
                <span>2 personnes</span>
              </div>
            )}
            {localPreview ? (
              <p className={styles.slotMessage}>
                Cet aperçu utilise des données fictives et ne permet pas de choisir un créneau.
              </p>
            ) : availability === null ? (
              <p className={styles.slotMessage}>
                Les disponibilités sont momentanément indisponibles. Veuillez réessayer dans
                quelques instants.
              </p>
            ) : slots.length ? (
              <div className={styles.slots}>
                {slots.map((slot) => (
                  <Link
                    key={slot.time}
                    href={`/book/${restaurant.slug}?source=restaurant&date=${today}&time=${slot.time}&partySize=2&from=preview${bookQuerySuffix}`}
                  >
                    {slot.time}
                  </Link>
                ))}
              </div>
            ) : (
              <p className={styles.slotMessage}>
                Aucun créneau disponible pour aujourd’hui. Choisissez une autre date.
              </p>
            )}
            {localPreview ? (
              <button className={styles.bookButton} type="button" disabled>
                Réservation indisponible
              </button>
            ) : (
              <BookCtaLink
                href={bookUrl}
                restaurantId={restaurant.id}
                restaurantSlug={restaurant.slug}
                track={!isTestBooking}
                source={source}
                className={styles.bookButton}
              >
                Choisir une date <span aria-hidden="true">→</span>
              </BookCtaLink>
            )}
            <p className={styles.bookingFoot}>
              {localPreview
                ? 'Aucune réservation ne sera créée.'
                : 'Ceci est une réservation d’essai.'}
            </p>
          </aside>
        </div>
      </div>
    </main>
  );
}
