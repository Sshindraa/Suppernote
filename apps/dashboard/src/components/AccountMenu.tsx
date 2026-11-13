'use client';

import { useTranslations } from 'next-intl';
import { useClerk, useUser } from '@clerk/nextjs';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CreditCard, LogOut, Settings as SettingsIcon } from 'lucide-react';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const hasClerkKey = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
const isDemoMode = Boolean(
  process.env.NEXT_PUBLIC_DEMO_RESTAURANT_ID && process.env.NEXT_PUBLIC_DEMO_STAGING,
);

/**
 * AccountMenu — icône restaurant de l'en-tête. Connecté, elle ouvre le menu du
 * compte (Mon abonnement, Réglages, Déconnexion) ; sinon elle renvoie au tableau
 * de bord, sans menu.
 *
 * Le menu utilise `useClerk().signOut` pour la déconnexion puis redirige vers `/login`.
 */

const brandClassName =
  'dashboard-brand-link flex shrink-0 items-center justify-center rounded-xl border border-border bg-card/70 transition-all duration-200 hover:border-foreground/20 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function RestaurantLink() {
  return (
    <Link href="/dashboard" aria-label="Suppernote" title="Suppernote" className={brandClassName}>
      <Image
        src="/restaurant-mark.png"
        alt=""
        width={44}
        height={44}
        className="dashboard-brand-logo h-9 w-9 object-contain"
      />
    </Link>
  );
}
export function AccountMenu({ showSettings = true }: { showSettings?: boolean } = {}) {
  // Sans ClerkProvider, seul le menu des réglages autorisés reste disponible.
  if (!hasClerkKey || isDemoMode) {
    return showSettings ? <RestaurantSettingsMenu /> : <RestaurantLink />;
  }
  return <AccountMenuInner showSettings={showSettings} />;
}

function RestaurantSettingsMenu() {
  const t = useTranslations('account');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-haspopup="menu"
          aria-label={t('label')}
          title={t('label')}
          className={brandClassName}
        >
          <Image
            src="/restaurant-mark.png"
            alt=""
            width={44}
            height={44}
            className="dashboard-brand-logo h-9 w-9 object-contain"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8}>
        <DropdownMenuItem asChild>
          <Link href="/dashboard/settings" className="flex items-center gap-2">
            <SettingsIcon size={14} aria-hidden="true" />
            {t('settings')}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AccountMenuInner({ showSettings }: { showSettings: boolean }) {
  const t = useTranslations('account');
  const { isSignedIn, user } = useUser();
  const { signOut } = useClerk();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close on Escape
  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  if (!isSignedIn || !user) return <RestaurantLink />;

  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  const email = user.primaryEmailAddress?.emailAddress;
  const displayName = fullName || email || t('label');

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut({ redirectUrl: '/login' });
    } catch {
      // signOut redirige ; en cas d'erreur on revient à l'état initial
      setSigningOut(false);
    }
  }

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('label')}
        title={t('label')}
        className={brandClassName}
      >
        <Image
          src="/restaurant-mark.png"
          alt=""
          width={44}
          height={44}
          className="dashboard-brand-logo h-9 w-9 object-contain"
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 min-w-[200px] overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-md"
        >
          <div className="flex flex-col gap-0.5 px-3 py-2.5">
            <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
            {email && email !== displayName && (
              <span className="truncate text-xs text-muted-foreground">{email}</span>
            )}
          </div>
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              router.push('/dashboard/billing');
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-all duration-200 hover:bg-accent"
          >
            <CreditCard size={15} aria-hidden />
            Mon abonnement
          </button>
          {showSettings && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                router.push('/dashboard/settings');
              }}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors duration-150 hover:bg-accent/50 hover:text-foreground"
            >
              <SettingsIcon size={14} aria-hidden />
              {t('settings')}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={signingOut}
            onClick={handleSignOut}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors duration-150',
              'text-destructive hover:bg-destructive/10 hover:text-destructive',
              signingOut && 'opacity-60',
            )}
          >
            <LogOut size={14} aria-hidden />
            {signingOut ? t('signingOut') : t('signOut')}
          </button>
        </div>
      )}
    </div>
  );
}
