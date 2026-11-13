'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SuppernoteLogo } from '@/components/SuppernoteLogo';
import { Button } from '@/components/ui/button';

export default function Header() {
  const pathname = usePathname();

  // Exclude pages that have their own specialized headers/navbars
  const excludedPaths = [
    '/',
    '/pricing',
    '/login',
    '/register',
    '/dashboard',
    '/admin',
    '/onboarding',
    '/widget',
    '/book',
    '/r',
  ];
  const isExcluded = excludedPaths.some((p) => pathname === p || pathname.startsWith(p + '/'));

  if (isExcluded) {
    return null;
  }

  return (
    <header className="ios-fixed-header fixed left-1/2 top-5 z-50 w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 rounded-full border border-border bg-card/85 px-3 py-2 shadow-2xl shadow-background/40 backdrop-blur-xl">
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/"
          className="flex min-w-0 items-center gap-2 rounded-full px-2 transition-all duration-200 hover:opacity-80"
        >
          <SuppernoteLogo className="h-9 w-9 text-foreground" />
          <span className="text-sm font-semibold text-foreground">Suppernote</span>
        </Link>
        <div className="flex items-center gap-1 sm:gap-2">
          <Link
            href="/pricing"
            className="suppernote-pill border-transparent bg-transparent px-3 py-2 min-h-[44px] inline-flex items-center justify-center"
          >
            Tarifs
          </Link>
          <Button
            asChild
            size="sm"
            className="rounded-full transition-all duration-200 min-h-[44px] px-4"
          >
            <Link href="/login">Connexion</Link>
          </Button>
          <Link
            href="/dashboard"
            className="hidden rounded-full px-3 py-1.5 text-sm font-medium text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground sm:inline-flex"
          >
            Dashboard
          </Link>
        </div>
      </div>
    </header>
  );
}
