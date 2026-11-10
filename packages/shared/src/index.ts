/**
 * @suppernote/shared — types, enums, and labels shared between API and dashboard.
 *
 * Rules of engagement:
 * - NO runtime dependencies on server-only packages (Prisma, Fastify, BullMQ).
 * - NO secrets, no env access, no side effects.
 * - Mirrors of Prisma enums live here; if you change the Prisma schema,
 *   mirror the change here in the same commit.
 *
 * Adding a new module: create `src/<domain>.ts`, re-export from this barrel.
 */

export * from './plan';
export * from './brand';
export * from './reservation';
export * from './call';
export * from './agent';
export * from './api';
export * from './confidence';
export * from './jsonld';
export * from './phone';
export * from './utils/csv';
export * from './utils/csv-table';
export * from './utils/csv-column-ai';
export * from './utils/fetch-with-timeout';
export * from './utils/format';
export * from './utils/opening-hours';
export * from './utils/slugify';

export * from './pricing-catalog.cjs';

export * from './connect-demo';
export * from './privacy';
export * from './marketing-consent';
