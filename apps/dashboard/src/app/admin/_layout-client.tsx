'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useEffect, useState } from 'react';
import {
  Activity,
  BarChart3,
  Building2,
  ChevronRight,
  Gauge,
  Inbox,
  LayoutDashboard,
  Moon,
  Radio,
  Route,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import { AccountMenu } from '@/components/AccountMenu';
import { SuppernoteLogo } from '@/components/SuppernoteLogo';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useApi } from '@/lib/api';
import { DashboardThemeProvider, useDashboardTheme } from '@/features/theme/dashboard-theme';

const adminNavigation = [
  { href: '/admin', label: 'Vue générale', icon: LayoutDashboard },
  { href: '/admin/margin', label: 'Coûts opérationnels', icon: BarChart3 },
  { href: '/admin/health', label: 'Santé des restaurants', icon: Activity },
  { href: '/admin/capacity', label: 'Capacité et système', icon: Gauge },
  { href: '/admin/provisioning', label: 'Provisioning', icon: Radio },
  { href: '/admin/onboarding', label: 'Onboarding — cohorte', icon: Route },
  { href: '/admin/demo-requests', label: 'Demandes de démo', icon: Inbox },
] as const;

function AdminThemeToggle() {
  const { theme, toggleTheme } = useDashboardTheme();
  const isLight = theme === 'light';
  const label = isLight ? 'Passer en mode sombre' : 'Passer en mode clair';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
      className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card/80 text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground"
    >
      {isLight ? <Moon size={16} aria-hidden="true" /> : <Sun size={16} aria-hidden="true" />}
    </button>
  );
}

function isNavigationActive(pathname: string, href: string) {
  return href === '/admin' ? pathname === href : pathname.startsWith(href);
}

function AdminAccessGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { get, isSignedIn } = useApi({ requireSession: true });
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (isSignedIn === undefined) {
      setAllowed(null);
      return;
    }

    if (!isSignedIn) {
      setAllowed(false);
      const redirect = encodeURIComponent(pathname || '/admin');
      router.replace(`/login?redirect_url=${redirect}`);
      return () => {
        cancelled = true;
      };
    }

    setAllowed(null);
    void get<{ allowed?: boolean }>('admin/access')
      .then((response) => {
        if (cancelled) return;
        if (response.allowed === true) {
          setAllowed(true);
          return;
        }
        setAllowed(false);
        router.replace('/dashboard');
      })
      .catch(() => {
        if (cancelled) return;
        setAllowed(false);
        router.replace('/dashboard');
      });

    return () => {
      cancelled = true;
    };
  }, [get, isSignedIn, pathname, router]);

  if (allowed !== true) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6 text-sm text-muted-foreground">
        Vérification de l’accès administrateur…
      </div>
    );
  }

  return <>{children}</>;
}

function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="suppernote-page min-h-screen bg-background text-foreground">
      <aside className="fixed inset-y-4 left-4 z-40 hidden w-64 flex-col rounded-[1.4rem] border border-border bg-card/90 p-3 shadow-2xl shadow-background/40 backdrop-blur-xl md:flex">
        <Link
          href="/admin"
          className="flex items-center gap-3 rounded-xl px-3 py-3 transition-all duration-200 hover:bg-accent"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-background/70">
            <SuppernoteLogo className="h-7 w-7 text-foreground" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-black tracking-tight">
              Suppernote Admin
            </span>
            <span className="block text-xs text-muted-foreground">Opérations internes</span>
          </span>
        </Link>

        <div className="my-3 h-px bg-border" />
        <nav aria-label="Navigation administration" className="flex flex-1 flex-col gap-1">
          {adminNavigation.map((item) => {
            const active = isNavigationActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground',
                  active &&
                    'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="my-3 h-px bg-border" />
        <Link
          href="/dashboard"
          className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground"
        >
          <Building2 className="h-4 w-4" aria-hidden="true" />
          <span>Dashboard restaurant</span>
          <ChevronRight className="ml-auto h-4 w-4" aria-hidden="true" />
        </Link>
      </aside>

      <header className="fixed inset-x-0 top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur-xl md:left-72">
        <div className="mx-auto flex min-h-16 max-w-[1400px] items-center justify-between gap-4 px-4 py-3 md:px-8">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Suppernote · opérations
            </p>
            <h1 className="truncate text-lg font-black tracking-tight sm:text-xl">
              Espace administration
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <AdminThemeToggle />
            <AccountMenu />
          </div>
        </div>
        <nav
          aria-label="Navigation administration mobile"
          className="flex gap-1 overflow-x-auto px-4 pb-3 md:hidden"
        >
          {adminNavigation.map((item) => {
            const active = isNavigationActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'whitespace-nowrap rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground',
                  active && 'border-primary bg-primary text-primary-foreground hover:bg-primary',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>

      <main className="relative mx-auto min-h-screen max-w-[1400px] px-4 pb-12 pt-28 md:ml-72 md:px-8 md:pt-28">
        {children}
      </main>
    </div>
  );
}

export default function AdminLayoutClient({ children }: { children: ReactNode }) {
  return (
    <DashboardThemeProvider>
      <AdminAccessGate>
        <AdminShell>{children}</AdminShell>
      </AdminAccessGate>
    </DashboardThemeProvider>
  );
}
