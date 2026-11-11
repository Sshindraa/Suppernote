export const SUPPERNOTE_DEMO_SLUG = 'chez-suppernote-demo';
export const LEGACY_DEMO_SLUG = 'chez-sokar-demo';
export const OFFICIAL_DEMO_SLUGS = [SUPPERNOTE_DEMO_SLUG, LEGACY_DEMO_SLUG] as const;

export function getDemoSlugAlias(slug: string): string | undefined {
  if (slug === SUPPERNOTE_DEMO_SLUG) return LEGACY_DEMO_SLUG;
  if (slug === LEGACY_DEMO_SLUG) return SUPPERNOTE_DEMO_SLUG;
  return undefined;
}

export function canonicalDemoSlug(slug: string): string {
  return slug === LEGACY_DEMO_SLUG ? SUPPERNOTE_DEMO_SLUG : slug;
}

/** Legacy alias retained for existing shared-package callers. */
export function resolveDemoSlug(slug: string): string {
  return slug === SUPPERNOTE_DEMO_SLUG ? LEGACY_DEMO_SLUG : slug;
}

export function isOfficialDemoSlug(slug: string): boolean {
  return (OFFICIAL_DEMO_SLUGS as readonly string[]).includes(slug);
}

/** Explicit seed fixtures, never a name or prefix heuristic. Keep their direct test pages accessible. */
export const CONNECT_DEMO_SLUGS = [
  SUPPERNOTE_DEMO_SLUG,
  LEGACY_DEMO_SLUG,
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

export function isConnectDemoSlug(slug: string): boolean {
  return (CONNECT_DEMO_SLUGS as readonly string[]).includes(slug);
}
