/**
 * Decides whether `prisma/seed.ts` may create the extra Suppernote Connect demo
 * listings (`chez-sokar-*`, excluding both official demo slugs).
 *
 * Those listings exist so the city pages (`/restaurants/:city`, which require at
 * least five listings per city) have something to render. They are published, so
 * seeding them on a production database puts fake restaurants in the public
 * sitemap and Google index. That is what happened on 2026-06-28 and was only
 * cleaned up on 2026-09-21.
 *
 * The previous guard was `NODE_ENV !== 'production'`, which fails open: a seed
 * run against a remote database with NODE_ENV unset publishes them for real. The
 * guard now looks at the actual database target, so that mistake degrades into
 * "nothing seeded" instead of "fake restaurants published".
 */

const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Structural type on purpose: `prisma/` is outside the package tsconfig, and the
// workspace does not link `@types/node` here. Keeping the guard free of Node type
// dependencies makes it a pure function that is trivial to exercise.
export type SeedEnvironment = {
  readonly DATABASE_URL?: string | undefined;
  readonly NODE_ENV?: string | undefined;
  readonly SEED_DEMO_RESTAURANTS?: string | undefined;
};

export function isLocalDatabaseUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    return LOCAL_DATABASE_HOSTS.has(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

export function shouldSeedDemoListings(env: SeedEnvironment): boolean {
  // Explicit opt-in wins, so staging keeps its demo listings without having to
  // pretend it is a developer machine.
  if (env.SEED_DEMO_RESTAURANTS === 'true') return true;
  if (env.NODE_ENV === 'production') return false;
  return isLocalDatabaseUrl(env.DATABASE_URL);
}

/**
 * Demo MCP credentials are local fixtures, never deployment data. A seed may
 * target a remote database even when NODE_ENV is missing, so require both a
 * non-production environment and a loopback database before creating one.
 */
export function shouldSeedDemoMcpClient(env: SeedEnvironment): boolean {
  return env.NODE_ENV !== 'production' && isLocalDatabaseUrl(env.DATABASE_URL);
}
