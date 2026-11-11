/**
 * Suppernote Connect — Root page (suppernote.com/).
 *
 * Landing qui liste les restos publiés via l'API publique paginée
 * (Phase 6 : un seul fetch au lieu de N+1, ISR 5min).
 */

import Link from 'next/link';
import { fetchPublicRestaurants } from '@/lib/api-client';
import { RestaurantCard } from '@/components/restaurant-card';

export const revalidate = 300;

export default async function HomePage() {
  const { restaurants, total } = await fetchPublicRestaurants(1, 12);

  return (
    <main id="main-content" className="mx-auto max-w-6xl px-6 py-12">
      <header className="mb-12">
        <h1 className="text-4xl font-bold text-ink">Suppernote — Agent-Ready Pages</h1>
        <p className="mt-3 text-lg text-muted-foreground">
          Réseau de pages publiques Suppernote rendant chaque restaurant client trouvable,
          compréhensible et réservable par les moteurs de recherche et les assistants IA.
        </p>
      </header>

      <section>
        <h2 className="mb-4 text-2xl font-semibold text-ink">Restaurants publiés ({total})</h2>
        {restaurants.length === 0 ? (
          <p className="text-muted-foreground">
            Aucun restaurant n&apos;a encore activé sa page publique.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {restaurants.map((r) => (
              <li key={r.id}>
                <RestaurantCard restaurant={r} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="mt-16 border-t border-border pt-6 text-sm text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span>Suppernote Connect</span>
          <span aria-hidden>·</span>
          <Link className="text-blue underline" href="/restaurant/chez-suppernote-demo">
            Restaurant démo
          </Link>
          <span aria-hidden>·</span>
          <Link className="text-blue underline" href="/assistant">
            Réserver avec votre IA
          </Link>
          <span aria-hidden>·</span>
          <Link className="text-blue underline" href="/privacy">
            Confidentialité
          </Link>
        </div>
      </footer>
    </main>
  );
}
