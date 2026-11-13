'use client';

import Link from 'next/link';
import Image from 'next/image';
import { ReactNode, useEffect, useId, useRef, useState } from 'react';
import { SuppernoteLogo } from '@/components/SuppernoteLogo';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  CalendarCheck,
  ClipboardList,
  Moon,
  Sun,
  Radio,
  PencilRuler,
  ShieldCheck,
  ChevronDown,
  Check,
  PanelLeftOpen,
  PanelLeftClose,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FloorPlanSummary } from '@/types/api';
import { SyncOrganization } from './SyncOrganization';
import { CreateRestaurantGate } from './CreateRestaurantGate';
import MobileBottomNav from '@/components/MobileBottomNav';
import { AccountMenu } from '@/components/AccountMenu';
import { BillingNotice, BillingStatusProvider, TrialChip } from '@/features/billing/trial';
import { OnboardingWizard } from '@/features/onboarding/onboarding-wizard';
import { OnboardingAccessBoundary } from '@/features/onboarding/onboarding-access-boundary';
import { OnboardingProvider } from '@/features/onboarding/onboarding-provider';
import { DashboardThemeProvider, useDashboardTheme } from '@/features/theme/dashboard-theme';
import { useApi } from '@/lib/api';
import { CompanionPanel } from '@/features/companion/CompanionPanel';
import { SubscribeFromPricing } from './SubscribeFromPricing';
import { SiteProvider, SiteSwitcher, useSiteSelection } from '@/features/sites/site-context';
import { SERVICE_STAFF_HOME, canOpenDashboardPath, isServiceStaff } from '@/features/team/roles';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CreateOfferDialog } from '@/features/offers/create-offer-dialog';
import { SectionTabs } from '@/components/SectionTabs';
import {
  navSections,
  isNavEntryActive,
  visibleNavSections,
  type NavSectionId,
} from '@/features/navigation/sections';
import { useCapabilities } from '@/lib/use-capabilities';

function SidebarNavItem({
  href,
  label,
  icon: Icon,
  active,
  expanded = false,
  onClick,
  salleLabel = false,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  expanded?: boolean;
  onClick?: () => void;
  salleLabel?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={href}
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          onClick={onClick}
          className={cn(
            'flex h-12 flex-none items-center rounded-xl text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            expanded ? 'w-full justify-start gap-3 px-3' : 'mx-auto w-10 justify-center',
            active &&
              'bg-popover font-semibold text-foreground shadow-md hover:bg-popover hover:text-foreground',
          )}
        >
          <Icon size={19} strokeWidth={active ? 2.25 : 1.75} />
          <span
            className={cn(
              'truncate',
              salleLabel ? 'text-sm font-medium' : 'text-base font-semibold',
              salleLabel && active && 'font-semibold',
              !expanded && 'sr-only',
            )}
          >
            {label}
          </span>
        </Link>
      </TooltipTrigger>
      {!expanded ? <TooltipContent side="right">{label}</TooltipContent> : null}
    </Tooltip>
  );
}

function SidebarGroupButton({
  id,
  label,
  icon: Icon,
  active,
  open,
  onClick,
  compact = false,
}: {
  id: NavSectionId;
  label: string;
  icon: LucideIcon;
  active: boolean;
  open: boolean;
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={open}
      aria-controls={`nav-group-${id}`}
      title={label}
      onClick={onClick}
      className={cn(
        'flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-base font-semibold text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        compact && 'justify-center px-0',
        (active || open) && 'text-foreground',
      )}
    >
      <Icon size={19} aria-hidden="true" />
      {!compact && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!compact && (
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={cn('transition-transform duration-200', open && 'rotate-180')}
        />
      )}
    </button>
  );
}

const isDemoMode = Boolean(
  process.env.NEXT_PUBLIC_DEMO_RESTAURANT_ID && process.env.NEXT_PUBLIC_DEMO_STAGING,
);
const hasClerkKey = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) && !isDemoMode;
const demoRestaurantId = process.env.NEXT_PUBLIC_DEMO_RESTAURANT_ID;
const defaultRestaurantName = demoRestaurantId ? 'Chez Suppernote' : 'Votre restaurant';

function cleanRestaurantName(name: string | undefined) {
  const trimmed = name?.trim() ?? '';
  return trimmed.replace(/\s+HQ\s*$/i, '').trim();
}

function ThemeToggle() {
  const { theme, toggleTheme } = useDashboardTheme();
  const t = useTranslations('dashboard');
  const isLight = theme === 'light';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-border bg-card/80 text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground"
      title={isLight ? t('themeTooltipLight') : t('themeTooltipDark')}
      aria-label={isLight ? t('themeTooltipLight') : t('themeTooltipDark')}
    >
      {isLight ? <Moon size={16} /> : <Sun size={16} />}
    </button>
  );
}

export function DashboardModeSwitcher({
  salleMode,
  compact = false,
  floorPlans = [],
  selectedFloorPlanId,
  floorPlansLoading = false,
  onSelectFloorPlan,
}: {
  salleMode: boolean;
  compact?: boolean;
  floorPlans?: FloorPlanSummary[];
  selectedFloorPlanId?: string | null;
  floorPlansLoading?: boolean;
  onSelectFloorPlan?: (floorPlanId: string) => void;
}) {
  const tNav = useTranslations('nav');
  const { activeSite } = useSiteSelection();
  // Le Companion lit les chiffres : l'équipe de service et la lecture seule n'y ont pas accès.
  const companionAvailable = activeSite?.role !== 'STAFF' && activeSite?.role !== 'READ_ONLY';
  const [companionOpen, setCompanionOpen] = useState(false);
  const [sallePlanOpen, setSallePlanOpen] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const companionDialogId = useId();
  const sallePlanMenuId = useId();
  const switcherRef = useRef<HTMLDivElement>(null);
  const selectedFloorPlan = floorPlans.find((plan) => plan.id === selectedFloorPlanId);
  const salleLabel = selectedFloorPlan?.name ?? 'Salle';
  const salleHref = selectedFloorPlanId
    ? `/dashboard/floor-plan?view=service-live&floorPlanId=${encodeURIComponent(selectedFloorPlanId)}`
    : '/dashboard/floor-plan?view=service-live';

  useEffect(() => {
    if (!companionOpen && !sallePlanOpen) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!switcherRef.current?.contains(event.target as Node)) {
        setCompanionOpen(false);
        setSallePlanOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCompanionOpen(false);
        setSallePlanOpen(false);
      }
    };

    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [companionOpen, sallePlanOpen]);

  // Une ligne de la carte « Ce soir » change de page : le panneau se referme pour laisser le détail visible.
  useEffect(() => {
    setCompanionOpen(false);
  }, [pathname, searchParams]);

  const selectFloorPlan = (floorPlanId: string) => {
    onSelectFloorPlan?.(floorPlanId);
    setSallePlanOpen(false);
  };

  const modeNav = (
    <nav
      aria-label="Espaces Suppernote"
      className="dashboard-mode-switcher__nav flex h-12 items-center gap-1 rounded-full border border-border bg-card/90 p-1 shadow-xl shadow-background/30 backdrop-blur-xl"
    >
      <Link
        href="/dashboard"
        aria-current={!salleMode ? 'page' : undefined}
        className={cn(
          'dashboard-mode-switcher__item flex min-w-0 items-center justify-center rounded-lg font-medium text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground',
          'h-10 flex-1 rounded-full px-3 text-sm',
          !salleMode &&
            'bg-primary text-primary-foreground shadow-sm hover:bg-primary hover:text-primary-foreground',
        )}
      >
        Copilot
      </Link>
      {salleMode ? (
        <div
          className={cn(
            'dashboard-mode-switcher__item group relative flex min-w-0 items-center justify-center rounded-full font-medium transition-all duration-200',
            'h-10 flex-1 px-3 text-sm',
            'bg-primary text-primary-foreground shadow-sm',
          )}
        >
          <Link
            href={salleHref}
            aria-current="page"
            className="absolute inset-0 z-0 flex min-w-0 items-center justify-center rounded-full px-10 py-2 hover:text-primary-foreground"
          >
            <span className="max-w-full truncate">{salleLabel}</span>
          </Link>
          <button
            type="button"
            aria-label="Choisir un plan de salle"
            aria-expanded={sallePlanOpen}
            aria-controls={sallePlanMenuId}
            onClick={() => {
              setSallePlanOpen((open) => !open);
              setCompanionOpen(false);
            }}
            className="relative z-10 ml-auto mr-1 flex h-8 w-8 flex-none items-center justify-center rounded-full text-primary-foreground/75 transition-all duration-200 hover:bg-primary-foreground/10 hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown
              size={15}
              className={cn('transition-transform duration-200', sallePlanOpen && 'rotate-180')}
            />
          </button>
          {sallePlanOpen && (
            <div
              id={sallePlanMenuId}
              role="listbox"
              aria-label="Plans de salle"
              className="absolute right-0 top-[calc(100%+0.5rem)] z-[60] w-64 rounded-2xl border border-border bg-card/95 p-2 text-left shadow-2xl shadow-background/45 backdrop-blur-xl"
            >
              {floorPlansLoading ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">Chargement…</p>
              ) : floorPlans.length === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">Aucun plan disponible</p>
              ) : (
                <div className="space-y-1">
                  {floorPlans.map((plan) => {
                    const active = plan.id === selectedFloorPlanId;
                    return (
                      <button
                        key={plan.id}
                        type="button"
                        role="option"
                        aria-selected={active}
                        onClick={() => selectFloorPlan(plan.id)}
                        className={cn(
                          'flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm transition-all duration-200 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          active && 'bg-primary/10 text-foreground',
                        )}
                      >
                        <span className="min-w-0 truncate">{plan.name}</span>
                        <span className="flex flex-none items-center gap-2 text-muted-foreground">
                          {plan.tableCount > 0 && (
                            <span className="text-xs">{plan.tableCount} tables</span>
                          )}
                          {active && <Check size={14} className="text-foreground" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <Link
          href={salleHref}
          aria-current={undefined}
          className={cn(
            'dashboard-mode-switcher__item flex min-w-0 items-center justify-center rounded-lg font-medium text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground',
            'h-10 flex-1 rounded-full px-3 text-sm',
          )}
        >
          Salle
        </Link>
      )}
      {companionAvailable && (
        <button
          type="button"
          aria-expanded={companionOpen}
          aria-controls={companionDialogId}
          onClick={() => setCompanionOpen((open) => !open)}
          className={cn(
            'dashboard-mode-switcher__item group relative flex min-w-0 items-center justify-center whitespace-nowrap font-medium text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'h-10 flex-1 gap-2 rounded-full px-3 text-sm',
            companionOpen && 'bg-accent/80 text-foreground',
          )}
        >
          <span>Companion</span>
        </button>
      )}
    </nav>
  );

  return (
    <div
      ref={switcherRef}
      className={cn(
        compact
          ? 'dashboard-mobile-only dashboard-mobile-mode-switcher dashboard-mobile-mode-switcher--inline relative z-30'
          : 'dashboard-desktop-only dashboard-mode-switcher fixed left-1/2 top-3 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2',
      )}
    >
      {modeNav}
      {/* Monté même fermé : une question en cours garde sa réponse, son attente et son erreur. */}
      {companionAvailable && (
        <div
          id={companionDialogId}
          role="dialog"
          aria-label="Companion"
          hidden={!companionOpen}
          className={cn(
            'dashboard-mode-switcher__dialog absolute left-1/2 top-14 max-h-[70vh] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-2xl border border-border bg-card/95 p-4 shadow-2xl shadow-background/40 backdrop-blur-xl',
            companionOpen ? 'flex' : 'hidden',
          )}
        >
          <CompanionPanel />
        </div>
      )}
    </div>
  );
}

export function DashboardSidebar({
  pathname,
  salleView,
  isPlatformOperator,
  onCreateOffer,
  expanded = true,
  onExpandedChange,
}: {
  pathname: string;
  salleView: string;
  isPlatformOperator: boolean;
  onCreateOffer: () => void;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const tNav = useTranslations('nav');
  const capabilities = useCapabilities();
  const tOfferChooser = useTranslations('offerChooser');
  const salleMode = pathname.startsWith('/dashboard/floor-plan');
  const { activeSite } = useSiteSelection();
  const serviceStaff = isServiceStaff(activeSite?.role);
  const [openGroup, setOpenGroup] = useState<NavSectionId | null>(null);
  const groupPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = navSections.find(
      (section) =>
        section.entries.length > 1 &&
        section.entries.some((entry) => !entry.spaceSwitch && isNavEntryActive(pathname, entry)),
    );
    setOpenGroup(active?.id ?? null);
  }, [pathname]);

  useEffect(() => {
    if (!openGroup) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        groupPanelRef.current?.contains(target) ||
        target.closest('[aria-controls^="nav-group-"]')
      )
        return;
      setOpenGroup(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenGroup(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openGroup]);

  return (
    <aside
      className={cn(
        'dashboard-desktop-sidebar fixed bottom-4 left-4 top-4 z-40 flex-col rounded-2xl border border-border bg-card/95 shadow-xl shadow-background/30 backdrop-blur-xl',
        expanded ? 'p-3' : 'p-2',
        expanded ? 'w-56' : 'w-16',
      )}
    >
      <div
        className={cn('mb-3 flex items-center', expanded ? 'justify-between' : 'flex-col gap-2')}
      >
        <Link
          href="/dashboard"
          aria-label="Suppernote"
          title="Suppernote"
          className={cn(
            'flex h-11 items-center gap-2 rounded-xl px-2 text-sm font-semibold text-foreground transition-all duration-200 hover:bg-accent',
            !expanded && 'h-10 w-10 justify-center gap-0 px-0',
          )}
        >
          <SuppernoteLogo className="size-10 text-foreground" />{' '}
          {expanded && (
            <span className={'font-brand text-xl font-medium tracking-tight'}>Suppernote</span>
          )}
        </Link>
        <button
          type="button"
          aria-label={expanded ? 'Replier le menu' : 'Déployer le menu'}
          aria-expanded={expanded}
          onClick={() => onExpandedChange?.(!expanded)}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
        </button>
      </div>
      <nav
        aria-label={salleMode ? 'Navigation Salle' : 'Navigation Copilot'}
        className="dashboard-nav-scroll min-h-0 flex-1 space-y-2 overflow-y-auto"
      >
        {salleMode ? (
          <>
            <SidebarNavItem
              href="/dashboard/floor-plan?view=service-live"
              label={tNav('live')}
              salleLabel
              icon={Radio}
              active={salleView !== 'edit-plan'}
              expanded={expanded}
            />
            {!serviceStaff && (
              <SidebarNavItem
                href="/dashboard/floor-plan?view=edit-plan"
                label={tNav('edition')}
                salleLabel
                icon={PencilRuler}
                active={salleView === 'edit-plan'}
                expanded={expanded}
              />
            )}
          </>
        ) : serviceStaff ? (
          <>
            <SidebarNavItem
              href="/dashboard/briefing"
              label={tNav('briefing')}
              icon={ClipboardList}
              active={pathname === '/dashboard/briefing'}
              expanded={expanded}
            />
            <SidebarNavItem
              href="/dashboard/reservations"
              label={tNav('reservations')}
              icon={CalendarCheck}
              active={pathname.startsWith('/dashboard/reservations')}
              expanded={expanded}
            />
            <SidebarNavItem
              href="/dashboard/floor-plan?view=service-live"
              label={tNav('floorPlan')}
              icon={Radio}
              active={false}
              expanded={expanded}
            />
          </>
        ) : (
          visibleNavSections(navSections, capabilities ?? {}).map((section) => {
            if (section.entries.length === 1) {
              const [entry] = section.entries;
              return (
                <SidebarNavItem
                  key={section.id}
                  href={entry.href}
                  label={tNav(entry.key)}
                  icon={entry.icon}
                  active={isNavEntryActive(pathname, entry)}
                  expanded={expanded}
                  onClick={() => setOpenGroup(null)}
                />
              );
            }
            const open = openGroup === section.id;
            const active = section.entries.some((entry) => isNavEntryActive(pathname, entry));
            return (
              <div key={section.id}>
                <SidebarGroupButton
                  id={section.id}
                  label={tNav(section.labelKey)}
                  icon={section.icon}
                  active={active}
                  open={expanded && open}
                  compact={!expanded}
                  onClick={() => {
                    if (!expanded) {
                      onExpandedChange?.(true);
                      setOpenGroup(section.id);
                    } else setOpenGroup(open ? null : section.id);
                  }}
                />
                {expanded && open && (
                  <div
                    ref={groupPanelRef}
                    id={`nav-group-${section.id}`}
                    className="relative ml-5 space-y-1 py-1 pl-4 before:absolute before:bottom-6 before:left-0 before:top-0 before:border-l before:border-border"
                  >
                    {section.entries.map((entry) => (
                      <Link
                        key={entry.href}
                        href={entry.href}
                        aria-current={isNavEntryActive(pathname, entry) ? 'page' : undefined}
                        onClick={() => setOpenGroup(null)}
                        className={cn(
                          'relative flex min-h-11 items-center rounded-xl px-3 text-sm font-medium text-muted-foreground transition-all duration-200 before:pointer-events-none before:absolute before:-left-4 before:top-0 before:h-1/2 before:w-4 before:rounded-bl-xl before:border-b before:border-l before:border-border hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          isNavEntryActive(pathname, entry) &&
                            'bg-popover font-semibold text-foreground shadow-md hover:bg-popover',
                        )}
                      >
                        {tNav(entry.key)}
                      </Link>
                    ))}
                    {section.id === 'offers' && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-9 w-full rounded-lg"
                        onClick={() => {
                          setOpenGroup(null);
                          onCreateOffer();
                        }}
                      >
                        {tOfferChooser('openButton')}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </nav>
      {isPlatformOperator && !salleMode && (
        <SidebarNavItem
          href="/admin"
          label={tNav('admin')}
          icon={ShieldCheck}
          active={pathname.startsWith('/admin')}
          expanded={expanded}
          onClick={() => setOpenGroup(null)}
        />
      )}
      <div
        className={cn(
          'mt-3 flex items-center gap-2 border-t border-border pt-3',
          !expanded && 'flex-col items-center',
        )}
      >
        <ThemeToggle />
      </div>
    </aside>
  );
}

function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { orgId, get, isSignedIn } = useApi();
  const salleMode = pathname.startsWith('/dashboard/floor-plan');
  const requestedFloorPlanId = searchParams.get('floorPlanId');
  const [restaurantName, setRestaurantName] = useState(defaultRestaurantName);
  const [floorPlans, setFloorPlans] = useState<FloorPlanSummary[]>([]);
  const [selectedFloorPlanId, setSelectedFloorPlanId] = useState<string | null>(null);
  const [floorPlansLoading, setFloorPlansLoading] = useState(false);
  const [floorPlanRefreshKey, setFloorPlanRefreshKey] = useState(0);
  const [operatorAccess, setOperatorAccess] = useState<boolean | null>(null);
  const [createOfferOpen, setCreateOfferOpen] = useState(false);
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const { activeSite, accountId } = useSiteSelection();
  // Same rule as the settings page: on a multi-site account, only the owner manages billing.
  const canManageBilling = !accountId || activeSite?.role === 'OWNER';
  const siteRole = activeSite?.role;
  const showRestaurantSettings = !isServiceStaff(siteRole);
  const showThemeInHeader = salleMode || isServiceStaff(siteRole);
  const roleBlocked = !canOpenDashboardPath(siteRole, pathname, searchParams.get('view'));
  const isLegacyOperatorPath =
    pathname === '/dashboard/usage' ||
    pathname === '/dashboard/admin' ||
    pathname.startsWith('/dashboard/admin/');
  const legacyOperatorDestination =
    pathname === '/dashboard/usage'
      ? '/admin/margin'
      : pathname.replace(/^\/dashboard\/admin(?=\/|$)/, '/admin') || '/admin';

  useEffect(() => {
    let cancelled = false;

    if (!isSignedIn) {
      setOperatorAccess(false);
      return () => {
        cancelled = true;
      };
    }

    setOperatorAccess(null);
    void get<{ allowed?: boolean }>('admin/access')
      .then((response) => {
        if (!cancelled) setOperatorAccess(response.allowed === true);
      })
      .catch(() => {
        // Fail closed: an unavailable capability probe must never reveal an
        // internal navigation item or page to a restaurant account.
        if (!cancelled) setOperatorAccess(false);
      });

    return () => {
      cancelled = true;
    };
  }, [get, isSignedIn]);

  // L'équipe de service arrive sur les réservations, pas sur les chiffres du restaurant.
  useEffect(() => {
    if (isServiceStaff(siteRole) && pathname === '/dashboard') router.replace(SERVICE_STAFF_HOME);
  }, [pathname, router, siteRole]);

  useEffect(() => {
    if (!isLegacyOperatorPath || operatorAccess === null) return;
    if (operatorAccess) {
      router.replace(legacyOperatorDestination);
    } else {
      router.replace('/dashboard');
    }
  }, [isLegacyOperatorPath, legacyOperatorDestination, operatorAccess, router]);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void get<{ name?: string }>(`restaurants/${orgId}`)
      .then((restaurant) => {
        const name = cleanRestaurantName(restaurant.name);
        // Le seed/API de certains environnements historiques renvoie encore
        // « Restaurant ». En démo, garder le nom du restaurant de référence
        // évite d'afficher un en-tête générique ; un compte réel conserve
        // toujours le nom fourni par son établissement.
        const isGenericDemoName = demoRestaurantId && name.toLowerCase() === 'restaurant';
        if (!cancelled && name && !isGenericDemoName) setRestaurantName(name);
      })
      .catch(() => {
        // Le libellé de repli reste affiché si l'identité du restaurant est indisponible.
      });
    return () => {
      cancelled = true;
    };
  }, [get, orgId]);

  useEffect(() => {
    const refreshFloorPlans = () => setFloorPlanRefreshKey((key) => key + 1);
    window.addEventListener('suppernote:floor-plans-changed', refreshFloorPlans);
    return () => window.removeEventListener('suppernote:floor-plans-changed', refreshFloorPlans);
  }, []);

  useEffect(() => {
    if (!salleMode || !orgId) {
      setFloorPlansLoading(false);
      return;
    }

    let cancelled = false;
    setFloorPlansLoading(true);
    setFloorPlans([]);

    void get<FloorPlanSummary[]>(`restaurants/${orgId}/floor-plans`)
      .then((plans) => {
        if (cancelled) return;

        setFloorPlans(plans);
        let persistedFloorPlanId: string | null = null;
        try {
          persistedFloorPlanId = window.localStorage.getItem(`sokar.floor-plan.${orgId}`);
        } catch {
          // Local storage may be unavailable in a private browsing context.
        }
        const preferred =
          plans.find((plan) => plan.id === persistedFloorPlanId) ??
          plans.find((plan) => plan.isDefault && plan.isActive) ??
          plans.find((plan) => plan.isActive) ??
          plans[0] ??
          null;
        setSelectedFloorPlanId(preferred?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setFloorPlans([]);
          setSelectedFloorPlanId(null);
        }
      })
      .finally(() => {
        if (!cancelled) setFloorPlansLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [floorPlanRefreshKey, get, orgId, salleMode]);

  useEffect(() => {
    if (!salleMode || !requestedFloorPlanId) return;
    if (floorPlans.some((plan) => plan.id === requestedFloorPlanId)) {
      setSelectedFloorPlanId(requestedFloorPlanId);
    }
  }, [floorPlans, requestedFloorPlanId, salleMode]);

  const handleSelectFloorPlan = (floorPlanId: string) => {
    setSelectedFloorPlanId(floorPlanId);
    try {
      window.localStorage.setItem(`sokar.floor-plan.${orgId}`, floorPlanId);
    } catch {
      // Local storage may be unavailable in a private browsing context.
    }
    const params = new URLSearchParams(searchParams.toString());
    if (!params.has('view')) params.set('view', 'service-live');
    params.set('floorPlanId', floorPlanId);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div
      className={cn(
        'dashboard-shell suppernote-page relative min-h-screen overflow-hidden',
        !sidebarExpanded && 'dashboard-shell--sidebar-compact',
      )}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,hsl(var(--foreground)/0.10),transparent_36%),linear-gradient(hsl(var(--border)/0.18)_1px,transparent_1px),linear-gradient(90deg,hsl(var(--border)/0.14)_1px,transparent_1px)] bg-[auto,72px_72px,72px_72px] opacity-70" />
      <SubscribeFromPricing />
      <DashboardModeSwitcher
        salleMode={salleMode}
        floorPlans={floorPlans}
        selectedFloorPlanId={selectedFloorPlanId}
        floorPlansLoading={floorPlansLoading}
        onSelectFloorPlan={handleSelectFloorPlan}
      />
      <DashboardSidebar
        pathname={pathname}
        salleView={searchParams.get('view') ?? ''}
        isPlatformOperator={operatorAccess === true}
        onCreateOffer={() => setCreateOfferOpen(true)}
        expanded={sidebarExpanded}
        onExpandedChange={setSidebarExpanded}
      />
      <CreateOfferDialog open={createOfferOpen} onOpenChange={setCreateOfferOpen} />
      <div
        className={cn(
          'dashboard-desktop-only fixed top-3 z-50 h-12 items-center gap-3',
          sidebarExpanded ? 'left-64 max-w-[calc(50vw-22rem)]' : 'left-24 max-w-[calc(50vw-18rem)]',
        )}
      >
        <SiteSwitcher />
      </div>
      <div className="dashboard-desktop-only fixed right-8 top-3 z-50 h-12 items-center gap-2">
        <AccountMenu showSettings={showRestaurantSettings} />
      </div>
      <div
        className={cn(
          'dashboard-shell-content relative z-10 w-full px-4 py-3',
          salleMode && 'dashboard-shell-content--salle',
        )}
      >
        {/*
          En-tête du dashboard.
          - Téléphone et iPad portrait : identité et contrôles restent sur une
            ligne compacte dans le flux.
          - PC et iPad paysage : ils rejoignent la barre supérieure fixe pour
            libérer l'espace vertical du contenu.
        */}
        <div className="dashboard-flow-header mb-3 gap-2 sm:mb-4">
          <div className="dashboard-flow-header__brand flex min-w-0 items-center gap-2">
            <SiteSwitcher className="hidden w-[9rem] max-w-[20vw] md:flex" />
          </div>
          <DashboardModeSwitcher
            salleMode={salleMode}
            floorPlans={floorPlans}
            selectedFloorPlanId={selectedFloorPlanId}
            floorPlansLoading={floorPlansLoading}
            onSelectFloorPlan={handleSelectFloorPlan}
            compact
          />
          <div className="dashboard-flow-header__actions ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
            <TrialChip canManageBilling={canManageBilling} />
            {showThemeInHeader && <ThemeToggle />}
            <AccountMenu showSettings={showRestaurantSettings} />
          </div>
        </div>
        <main
          className={cn(
            'min-h-[calc(100vh-12rem)] md:min-h-[calc(100vh-14rem)]',
            salleMode && 'flex flex-1 flex-col min-h-0',
          )}
        >
          {isLegacyOperatorPath && operatorAccess !== true ? (
            <div
              className="flex min-h-[calc(100vh-16rem)] items-center justify-center text-sm text-muted-foreground"
              aria-busy="true"
            >
              Vérification des accès…
            </div>
          ) : roleBlocked ? (
            <div
              role="alert"
              className="flex min-h-[calc(100vh-16rem)] flex-col items-center justify-center gap-3 text-center"
            >
              <p className="text-sm text-muted-foreground">
                Cette page est réservée au responsable de l’établissement.
              </p>
              <Link
                href={SERVICE_STAFF_HOME}
                className="rounded-full border border-border px-4 py-2 text-sm font-medium transition-all duration-200 hover:bg-accent"
              >
                Retour aux réservations
              </Link>
            </div>
          ) : (
            <>
              <BillingNotice canManageBilling={canManageBilling} />
              <SectionTabs />
              {children}
            </>
          )}
        </main>
      </div>
      {/* Mobile bottom tab bar */}
      <MobileBottomNav />
    </div>
  );
}

function DashboardSiteBoundary({ children }: { children: ReactNode }) {
  // useApi fournit l'organisation Clerk sans que le provider de sites ait à
  // appeler directement les hooks Clerk. Cela garde le mode démo compatible
  // avec les aperçus locaux sans ClerkProvider.
  const { organizationId } = useApi();
  return <SiteProvider organizationId={organizationId}>{children}</SiteProvider>;
}

export default function DashboardLayoutClient({
  children,
  crmQualificationRestaurantIds = [],
}: {
  children: ReactNode;
  crmQualificationRestaurantIds?: string[];
}) {
  return (
    <OnboardingProvider>
      <DashboardThemeProvider>
        <CreateRestaurantGate>
          <DashboardSiteBoundary>
            {hasClerkKey && <SyncOrganization />}
            <OnboardingAccessBoundary
              enforceAccess={hasClerkKey}
              crmQualificationRestaurantIds={crmQualificationRestaurantIds}
              controls={
                <div className="flex items-center gap-3">
                  <SiteSwitcher />
                  <ThemeToggle />
                  <AccountMenu />
                </div>
              }
              onboarding={<OnboardingWizard />}
            >
              <BillingStatusProvider>
                <DashboardShell>{children}</DashboardShell>
              </BillingStatusProvider>
            </OnboardingAccessBoundary>
          </DashboardSiteBoundary>
        </CreateRestaurantGate>
      </DashboardThemeProvider>
    </OnboardingProvider>
  );
}
