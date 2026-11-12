import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';

const isProtectedRoute = createRouteMatcher(['/dashboard(.*)', '/admin(.*)', '/onboarding(.*)']);
const isOperatorRoute = createRouteMatcher([
  '/admin(.*)',
  '/dashboard/admin(.*)',
  '/dashboard/usage',
]);
const hasClerkKey = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
// Widget public, aussi servi sur les sous-domaines des restaurants : jamais de session Clerk.
// Sans cela, un restaurateur connecté (cookie Clerk partagé avec *.suppernote.com) serait redirigé
// vers la poignée de main Clerk, refusée hors de suppernote.com.
// Même liste que le bloc des sous-domaines dans infra/nginx/sokar.conf.
const PUBLIC_WIDGET_ROUTE =
  /^\/(?:(?:widget|book)\/[^/]+|api\/proxy\/(?:public\/.+|marketing\/attribution\/click|restaurants\/[^/]+\/(?:public|availability)))$/;

const legacyOperatorDestinations: Record<string, string> = {
  '/dashboard/usage': '/admin/margin',
  '/dashboard/admin': '/admin',
  '/dashboard/admin/margin': '/admin/margin',
  '/dashboard/admin/health': '/admin/health',
  '/dashboard/admin/provisioning': '/admin/provisioning',
};

function getLegacyOperatorDestination(pathname: string): string | null {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return legacyOperatorDestinations[normalizedPath] ?? null;
}

// Staging demo mode : si NEXT_PUBLIC_DEMO_RESTAURANT_ID + NEXT_PUBLIC_DEMO_STAGING
// sont définis, on ne force pas la connexion sur /dashboard. La prod n'a jamais
// ces variables → comportement inchangé.
const hasDemoRestaurant = Boolean(process.env.NEXT_PUBLIC_DEMO_RESTAURANT_ID);
const isStagingDemo = hasDemoRestaurant && Boolean(process.env.NEXT_PUBLIC_DEMO_STAGING);
const isLocalDemo = hasDemoRestaurant && process.env.NODE_ENV !== 'production';
const isDemoMode = isStagingDemo || isLocalDemo;

// En production, l'absence de clé Clerk est une erreur fatale : sans elle le
// middleware devient un no-op et /dashboard + /onboarding sont accessibles
// sans auth. En dev (preview locale sans Clerk) et en CI (E2E sans Clerk),
// on garde le bypass.
if (process.env.NODE_ENV === 'production' && !hasClerkKey && !process.env.CI) {
  throw new Error(
    'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY manquant en production — le middleware ' +
      'ne peut pas protéger les routes authentifiées. Vérifier apps/dashboard/.env.',
  );
}

/** Les liens courts utilisent le même widget en conservant le slug demandé. */
function rewritePublicWidget(req: NextRequest): NextResponse | null {
  const match = req.nextUrl.pathname.match(/^\/book\/([^/]+)$/);
  if (!match) return null;
  const url = new URL(`/widget/${match[1]}`, req.url);
  url.search = req.nextUrl.search;
  return NextResponse.rewrite(url);
}

const clerkProxy = hasClerkKey
  ? clerkMiddleware(async (auth, req) => {
      const rewrite = rewritePublicWidget(req);
      if (rewrite) return rewrite;

      if (isProtectedRoute(req) && (!isDemoMode || isOperatorRoute(req))) {
        const { userId } = await auth();
        if (!userId) {
          const signInUrl = new URL('/login', req.url);
          return NextResponse.redirect(signInUrl);
        }

        const legacyDestination = getLegacyOperatorDestination(req.nextUrl.pathname);
        if (legacyDestination) {
          return NextResponse.redirect(new URL(legacyDestination, req.url));
        }
      }
    })
  : null;

function localPreviewMiddleware(req: NextRequest) {
  const rewrite = rewritePublicWidget(req);
  if (rewrite) return rewrite;

  const legacyDestination = getLegacyOperatorDestination(req.nextUrl.pathname);
  if (legacyDestination) {
    return NextResponse.redirect(new URL(legacyDestination, req.url));
  }

  return NextResponse.next();
}

function proxy(req: NextRequest, event: NextFetchEvent) {
  if (!clerkProxy || PUBLIC_WIDGET_ROUTE.test(req.nextUrl.pathname)) {
    return localPreviewMiddleware(req);
  }
  return clerkProxy(req, event);
}

export default proxy;

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
