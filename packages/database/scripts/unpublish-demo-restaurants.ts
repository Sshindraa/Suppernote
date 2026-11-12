import { PrismaClient } from '@prisma/client';

/**
 * Unpublishes the Suppernote Connect demo listings (`chez-sokar-*`).
 *
 * `prisma/seed.ts` creates these listings so local/staging city pages
 * (`/restaurants/:city` requires at least 5 listings per city) have something to
 * render. They live behind `NODE_ENV !== 'production'`, but a seed run against a
 * production database with NODE_ENV unset publishes them for real: they then show
 * up in the public sitemap and get indexed.
 *
 * `chez-suppernote-demo` is deliberately excluded: it is the official demo
 * listing. Its legacy alias `chez-sokar-demo` is not in this list either.
 *
 * This only flips `connectPublished`/`connectPublishedAt` back to false/null. The
 * rows are kept, so republishing is a single boolean.
 *
 * Dry run by default, `--apply` to execute:
 *   pnpm --filter @suppernote/database unpublish:demo-restaurants
 *   pnpm --filter @suppernote/database unpublish:demo-restaurants -- --apply
 */

const DEMO_SLUGS = [
  'chez-sokar-bouchon-lyon',
  'chez-sokar-italien-lyon',
  'chez-sokar-sushi-lyon',
  'chez-sokar-terrasse-lyon',
  'chez-sokar-bistrot-paris',
  'chez-sokar-neo-paris',
  'chez-sokar-ramen-paris',
  'chez-sokar-tapas-paris',
  'chez-sokar-veggie-paris',
] as const;

async function main() {
  const apply = process.argv.slice(2).includes('--apply');
  const db = new PrismaClient();

  try {
    const rows = await db.restaurant.findMany({
      where: { slug: { in: [...DEMO_SLUGS] } },
      select: {
        id: true,
        slug: true,
        city: true,
        exposureSettings: { select: { connectPublished: true } },
      },
      orderBy: { slug: 'asc' },
    });

    const missing = DEMO_SLUGS.filter((slug) => !rows.some((row) => row.slug === slug));
    const published = rows.filter((row) => row.exposureSettings?.connectPublished === true);

    // CLI output is the audit trail for the dry-run/apply decision.
    // eslint-disable-next-line no-console
    console.log(`Fiches de démonstration trouvées : ${rows.length}/${DEMO_SLUGS.length}`);
    if (missing.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`  absentes de cette base : ${missing.join(', ')}`);
    }

    if (published.length === 0) {
      // eslint-disable-next-line no-console
      console.log('Aucune fiche de démonstration publiée : rien à faire.');
      return;
    }

    // eslint-disable-next-line no-console
    console.log(`Fiches encore publiées : ${published.length}`);
    for (const row of published) {
      // eslint-disable-next-line no-console
      console.log(`  - ${row.slug} (${row.city ?? 'ville inconnue'})`);
    }

    if (!apply) {
      // eslint-disable-next-line no-console
      console.log('\nDry run. Relancer avec --apply pour dépublier ces fiches.');
      return;
    }

    const { count } = await db.restaurantExposureSettings.updateMany({
      where: { restaurantId: { in: published.map((row) => row.id) } },
      data: { connectPublished: false, connectPublishedAt: null },
    });

    // eslint-disable-next-line no-console
    console.log(`\n${count} fiche(s) dépubliée(s).`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
