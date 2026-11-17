/** Contrôle d'un site client : fetch sûr + détection. Les signaux Redis sont ajoutés par la route. */
import { fetchSitePage, SiteFetchFailure, type SiteFetchError } from './safe-fetch';
import {
  cspHeader,
  detectEmbedScript,
  detectFramingBlocked,
  detectPlatform,
  detectProviders,
  extractBookingLinks,
  type BookingLink,
  type ReservationProvider,
  type SitePlatform,
} from './detect';

export interface WebsiteInspection {
  url: string;
  platform: SitePlatform;
  providers: ReservationProvider[];
  bookingLinks: BookingLink[];
  scriptFound: boolean;
  slugMatches: boolean | null;
  framingBlocked: boolean | null;
  fetchError: SiteFetchError | null;
}

export async function inspectWebsite(rawUrl: string, slug: string): Promise<WebsiteInspection> {
  const url = rawUrl.trim();
  try {
    const page = await fetchSitePage(url);
    const script = detectEmbedScript(page.html, page.finalUrl, slug);
    return {
      url: page.finalUrl,
      platform: detectPlatform(page.html),
      providers: detectProviders(page.html),
      bookingLinks: extractBookingLinks(page.html, page.finalUrl),
      scriptFound: script.scriptFound,
      slugMatches: script.slugMatches,
      framingBlocked: detectFramingBlocked(cspHeader(page.headers)),
      fetchError: null,
    };
  } catch (err) {
    return {
      url,
      platform: 'unknown',
      providers: [],
      bookingLinks: [],
      scriptFound: false,
      slugMatches: null,
      framingBlocked: null,
      fetchError: err instanceof SiteFetchFailure ? err.code : 'http_error',
    };
  }
}
