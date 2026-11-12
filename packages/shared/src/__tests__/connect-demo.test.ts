import { describe, expect, it } from 'vitest';
import {
  canonicalDemoSlug,
  getDemoSlugAlias,
  isConnectDemoSlug,
  isOfficialDemoSlug,
  LEGACY_DEMO_SLUG,
  SUPPERNOTE_DEMO_SLUG,
} from '../connect-demo';

describe('demo restaurant slug migration', () => {
  it('keeps both URLs resolvable and emits only the canonical slug', () => {
    expect(getDemoSlugAlias(SUPPERNOTE_DEMO_SLUG)).toBe(LEGACY_DEMO_SLUG);
    expect(getDemoSlugAlias(LEGACY_DEMO_SLUG)).toBe(SUPPERNOTE_DEMO_SLUG);
    expect(canonicalDemoSlug(LEGACY_DEMO_SLUG)).toBe(SUPPERNOTE_DEMO_SLUG);
    expect(isOfficialDemoSlug(SUPPERNOTE_DEMO_SLUG)).toBe(true);
    expect(isOfficialDemoSlug(LEGACY_DEMO_SLUG)).toBe(true);
    expect(isConnectDemoSlug(SUPPERNOTE_DEMO_SLUG)).toBe(true);
    expect(isConnectDemoSlug(LEGACY_DEMO_SLUG)).toBe(true);
  });
});
