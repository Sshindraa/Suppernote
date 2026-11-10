'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  BarChart3,
  CalendarCheck,
  ClipboardList,
  Moon,
  MoreHorizontal,
  Plus,
  PencilRuler,
  Radio,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useDashboardTheme } from '@/features/theme/dashboard-theme';
import { cn, triggerHaptic } from '@/lib/utils';
import { CreateOfferDialog } from '@/features/offers/create-offer-dialog';
import { useSiteSelection } from '@/features/sites/site-context';
import { isServiceStaff } from '@/features/team/roles';
import { isNavEntryActive, navSections, visibleNavSections } from '@/features/navigation/sections';
import { useCapabilities } from '@/lib/use-capabilities';

const copilotNavItems = [
  { href: '/dashboard', key: 'overview' as const, icon: BarChart3 },
  { href: '/dashboard/reservations', key: 'reservations' as const, icon: CalendarCheck },
  { href: '/dashboard/briefing', key: 'briefing' as const, icon: ClipboardList },
  { href: '/dashboard/customers', key: 'customers' as const, icon: Users },
];

const salleNavItems = [
  { href: '/dashboard/floor-plan?view=service-live', key: 'live' as const, icon: Radio },
  { href: '/dashboard/floor-plan?view=edit-plan', key: 'edition' as const, icon: PencilRuler },
];

/** Navigation de l’équipe de service. */
const staffNavItems = [
  { href: '/dashboard/briefing', key: 'briefing' as const, icon: ClipboardList },
  { href: '/dashboard/reservations', key: 'reservations' as const, icon: CalendarCheck },
  { href: '/dashboard/floor-plan?view=service-live', key: 'live' as const, icon: Radio },
];

type PrimaryNavItem = (typeof copilotNavItems)[number] | (typeof salleNavItems)[number];

// Menu Plus : les sections de la barre latérale, sans ce que la barre du bas montre déjà.
const primaryHrefs = copilotNavItems.map((item) => item.href);
const moreNavSections = navSections
  .map((section) => ({
    ...section,
    entries: section.entries.filter(
      (entry) => !entry.spaceSwitch && !primaryHrefs.includes(entry.href),
    ),
  }))
  .filter((section) => section.entries.length > 0);

function isMobileNavActive(pathname: string, href: string) {
  if (href === '/dashboard') return pathname === href;
  if (href === '/dashboard/gift-cards') return pathname.startsWith('/dashboard/gift-card');
  return pathname.startsWith(href);
}

function isPrimaryNavActive(pathname: string, item: PrimaryNavItem, salleEditMode: boolean) {
  if (item.key === 'live') return pathname.startsWith('/dashboard/floor-plan') && !salleEditMode;
  if (item.key === 'edition') return pathname.startsWith('/dashboard/floor-plan') && salleEditMode;
  return isMobileNavActive(pathname, item.href);
}

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastTime: number;
  previewIndex: number;
  moved: boolean;
};

type NavGeometry = {
  containerRect: DOMRect;
  centers: number[];
  itemWidth: number;
};

const DRAG_THRESHOLD = 6;
const LIQUID_SETTLE_TRANSITION =
  'transform 280ms cubic-bezier(0.22, 1, 0.36, 1), width 240ms cubic-bezier(0.22, 1, 0.36, 1)';
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export default function MobileBottomNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const tNav = useTranslations('nav');
  const capabilities = useCapabilities();
  const moreNavSectionsForUser = visibleNavSections(moreNavSections, capabilities ?? {});
  const tDashboard = useTranslations('dashboard');
  const tOfferChooser = useTranslations('offerChooser');
  const { theme, toggleTheme } = useDashboardTheme();
  const [moreOpen, setMoreOpen] = useState(false);
  const [createOfferOpen, setCreateOfferOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isPressed, setIsPressed] = useState(false);
  const [pointerInteraction, setPointerInteraction] = useState(false);
  const [dragPreviewIndex, setDragPreviewIndex] = useState<number | null>(null);
  const [liquidReady, setLiquidReady] = useState(false);

  const salleMode = pathname.startsWith('/dashboard/floor-plan');
  const salleEditMode = searchParams.get('view') === 'edit-plan';
  const { activeSite } = useSiteSelection();
  const serviceStaff = isServiceStaff(activeSite?.role);
  const activeNavItems = serviceStaff ? staffNavItems : salleMode ? salleNavItems : copilotNavItems;
  const hasMoreMenu = !salleMode && !serviceStaff;

  const containerRef = useRef<HTMLDivElement>(null);
  const liquidRef = useRef<HTMLSpanElement>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const geometryRef = useRef<NavGeometry | null>(null);
  const settledIndexRef = useRef<number | null>(null);

  const moreActive =
    hasMoreMenu &&
    (moreOpen ||
      pathname.startsWith('/dashboard/settings') ||
      moreNavSectionsForUser.some((section) =>
        section.entries.some((entry) => isNavEntryActive(pathname, entry)),
      ));
  const committedIndex = moreActive
    ? activeNavItems.length
    : Math.max(
        0,
        activeNavItems.findIndex((item) => isPrimaryNavActive(pathname, item, salleEditMode)),
      );

  const measureGeometry = useCallback((): NavGeometry | null => {
    const container = containerRef.current;
    if (!container) return null;

    const containerRect = container.getBoundingClientRect();
    const itemCount = activeNavItems.length + (hasMoreMenu ? 1 : 0);
    const centers = Array.from({ length: itemCount }, (_, index) => {
      const item = itemRefs.current[index];
      if (!item) return null;
      const rect = item.getBoundingClientRect();
      return rect.left - containerRect.left + rect.width / 2;
    });

    if (centers.some((center): center is null => center === null)) return null;

    const resolvedCenters = centers as number[];
    const itemWidth = itemRefs.current[0]?.getBoundingClientRect().width ?? 64;

    const geometry = {
      containerRect,
      centers: resolvedCenters,
      itemWidth,
    };
    geometryRef.current = geometry;
    return geometry;
  }, [activeNavItems, hasMoreMenu]);

  const getGeometry = useCallback(
    () => geometryRef.current ?? measureGeometry(),
    [measureGeometry],
  );

  const nearestIndex = useCallback((localX: number, centers: number[]) => {
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;

    centers.forEach((center, index) => {
      const distance = Math.abs(center - localX);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    });

    return closestIndex;
  }, []);

  const setLiquidPosition = useCallback(
    (localX: number, animate: boolean, stretch = 0) => {
      const liquid = liquidRef.current;
      const geometry = getGeometry();
      if (!liquid || !geometry) return;

      // Keep a uniform 2px seam at both ends, even when the lens stretches.
      // The extra 2px accounts for the container's two 1px borders.
      const baseWidth = Math.max(56, geometry.itemWidth * 1.08);
      const width = Math.min(geometry.itemWidth * 1.42, baseWidth + stretch);
      liquid.style.width = `${width}px`;
      const pressure = Number.parseFloat(liquid.style.getPropertyValue('--liquid-pressure') || '0');
      const verticalScale = 1 + Math.min(0.035, Math.max(0, pressure) * 0.018);
      const left = Math.max(
        2,
        Math.min(localX - width / 2, geometry.containerRect.width - width - 4),
      );
      liquid.style.transform = `translate3d(${left}px, -50%, 0) scaleY(${verticalScale})`;
      liquid.style.transition = animate ? LIQUID_SETTLE_TRANSITION : 'none';
    },
    [getGeometry],
  );

  const setLiquidInteraction = useCallback(
    (localX: number, animate: boolean, stretch = 0, pressure = 0) => {
      const liquid = liquidRef.current;
      if (!liquid) return;

      liquid.style.setProperty('--liquid-pressure', `${pressure}`);
      setLiquidPosition(localX, animate, stretch);
    },
    [setLiquidPosition],
  );

  const resetLiquidInteraction = useCallback(() => {
    const liquid = liquidRef.current;
    if (!liquid) return;
    liquid.style.setProperty('--liquid-pressure', '0');
  }, []);

  const settleLiquid = useCallback(
    (index: number, animate: boolean, force = false) => {
      // A route update can arrive while the settle transition is still
      // running. If it points at the same tab, leave the in-flight transform
      // alone instead of cancelling it with a second write.
      if (!force && settledIndexRef.current === index) return false;

      const geometry = getGeometry();
      if (!geometry) return false;
      const center = geometry.centers[index] ?? geometry.centers[0];
      if (center !== undefined) {
        setLiquidPosition(center, animate);
        settledIndexRef.current = index;
        return true;
      }
      return false;
    },
    [getGeometry, setLiquidPosition],
  );

  useIsomorphicLayoutEffect(() => {
    geometryRef.current = null;
    if (settleLiquid(committedIndex, false)) setLiquidReady(true);

    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    const resizeObserver = new ResizeObserver(() => {
      // The bar can change width when rotating or entering the iPad layout.
      // Invalidate the cached measurements before settling the lens.
      geometryRef.current = null;
      if (settleLiquid(committedIndex, false, true)) setLiquidReady(true);
    });
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, [activeNavItems, committedIndex, settleLiquid]);

  // Warm the route cache while the user is reading the current screen. This
  // removes the visible blank interval after a tap without changing the URL
  // or rendering any hidden page content.
  useEffect(() => {
    if (typeof router.prefetch !== 'function') return;
    activeNavItems.forEach((item) => {
      void router.prefetch(item.href);
    });
  }, [activeNavItems, router]);

  useEffect(() => {
    return () => {
      if (suppressClickTimeoutRef.current) {
        clearTimeout(suppressClickTimeoutRef.current);
      }
    };
  }, []);

  const armClickSuppression = useCallback(() => {
    suppressClickRef.current = true;
    if (suppressClickTimeoutRef.current) {
      clearTimeout(suppressClickTimeoutRef.current);
    }
    // Pointer capture does not always dispatch a synthetic click on iOS. Do
    // not let the next legitimate tap get swallowed in that case.
    suppressClickTimeoutRef.current = setTimeout(() => {
      suppressClickRef.current = false;
      suppressClickTimeoutRef.current = null;
    }, 450);
  }, []);

  const clearClickSuppression = useCallback(() => {
    suppressClickRef.current = false;
    if (suppressClickTimeoutRef.current) {
      clearTimeout(suppressClickTimeoutRef.current);
      suppressClickTimeoutRef.current = null;
    }
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    setPointerInteraction(true);

    // A pointer gesture is the point at which cached geometry must be
    // freshest: JSDOM, iOS viewport changes and keyboard/rotation can all
    // move the bar between resize notifications. Measure once per gesture,
    // then reuse that snapshot for the rest of the drag.
    geometryRef.current = null;
    settledIndexRef.current = null;
    const geometry = getGeometry();
    if (!geometry) return;

    const localX = Math.min(
      geometry.centers[geometry.centers.length - 1],
      Math.max(geometry.centers[0], event.clientX - geometry.containerRect.left),
    );
    const previewIndex = nearestIndex(localX, geometry.centers);

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastTime: performance.now(),
      previewIndex,
      moved: false,
    };
    suppressClickRef.current = false;
    setIsDragging(true);
    setIsPressed(true);
    setDragPreviewIndex(previewIndex);
    setLiquidInteraction(localX, false, 0, 1);
    // Pointer capture is needed for a finger that leaves the bar while
    // scrubbing. On a mouse click it would retarget the native click to the
    // container and prevent the underlying Link/button from receiving it.
    if (event.pointerType !== 'mouse') {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.moved && distance < DRAG_THRESHOLD) return;
    drag.moved = true;

    const geometry = getGeometry();
    if (!geometry) return;

    const now = performance.now();
    const elapsed = Math.max(16, now - drag.lastTime);
    const velocity = (event.clientX - drag.lastX) / elapsed;
    drag.lastX = event.clientX;
    drag.lastTime = now;

    const firstCenter = geometry.centers[0];
    const lastCenter = geometry.centers[geometry.centers.length - 1];
    const localX = Math.min(
      lastCenter,
      Math.max(firstCenter, event.clientX - geometry.containerRect.left),
    );
    const previewIndex = nearestIndex(localX, geometry.centers);
    const stretch = Math.min(
      44,
      Math.abs(event.clientX - drag.startX) * 0.16 + Math.abs(velocity) * 14,
    );

    setLiquidInteraction(localX, false, stretch, 1);
    if (previewIndex !== drag.previewIndex) {
      drag.previewIndex = previewIndex;
      setDragPreviewIndex(previewIndex);
      triggerHaptic(6);
    }
    event.preventDefault();
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const didMove = drag.moved && !cancelled;
    const targetIndex = drag.previewIndex;
    dragRef.current = null;
    setIsDragging(false);
    setIsPressed(false);
    setDragPreviewIndex(null);

    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }

    if (!didMove) {
      resetLiquidInteraction();
      // A normal tap has already previewed the item under the pointer. Keep
      // the lens there while Next updates the route; settling back to the
      // previous pathname first creates a visible "there and back" jump.
      settleLiquid(cancelled ? committedIndex : targetIndex, true);
      return;
    }

    event.preventDefault();
    armClickSuppression();
    resetLiquidInteraction();
    settleLiquid(targetIndex, true);

    if (hasMoreMenu && targetIndex === activeNavItems.length) {
      setMoreOpen(true);
      return;
    }

    // A scrub that ends on the current tab should only settle the lens. A
    // redundant router push causes an unnecessary loading transition and was
    // the source of the occasional blank frame in the recording.
    if (targetIndex === committedIndex) return;

    setMoreOpen(false);
    router.push(activeNavItems[targetIndex].href);
  };

  // Le panneau « Plus » appartient au shell du dashboard et reste donc
  // monté pendant une navigation entre les onglets principaux. On le ferme
  // dès que l'URL change afin de ne jamais laisser le voile/modal au-dessus
  // d'une nouvelle page.
  useIsomorphicLayoutEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  // Lock scroll when more menu is open
  useEffect(() => {
    if (!moreOpen) return;

    const previousOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
    };
  }, [moreOpen]);

  return (
    <>
      {moreOpen && (
        <>
          <button
            type="button"
            aria-label={tNav('close')}
            onClick={() => setMoreOpen(false)}
            className="dashboard-mobile-only fixed inset-0 z-40 bg-background/60 backdrop-blur-sm"
          />
          <div
            role="dialog"
            aria-modal="true"
            id="mobile-more-menu"
            aria-label={tNav('more')}
            className="dashboard-mobile-more-menu dashboard-mobile-only fixed left-1/2 z-[60] w-[calc(100%-1.5rem)] max-w-2xl -translate-x-1/2 overflow-y-auto rounded-[1.6rem] border border-border bg-background p-3 shadow-2xl shadow-background/40"
          >
            <div className="mb-3 border-b border-border px-1 pb-3">
              <span
                aria-hidden="true"
                className="mx-auto mb-2 block h-1 w-10 rounded-full bg-muted-foreground/30"
              />
              <div className="flex items-center justify-between gap-3">
                <span className="text-base font-semibold text-foreground">{tNav('more')}</span>
                <button
                  type="button"
                  aria-label={tNav('close')}
                  title={tNav('close')}
                  onClick={() => setMoreOpen(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="space-y-3">
              {moreNavSectionsForUser.map((section) => (
                <div key={section.id}>
                  <h3 className="mb-1.5 px-1 text-sm font-medium text-muted-foreground">
                    {tNav(section.labelKey)}
                  </h3>
                  <div className="grid grid-cols-2 gap-1.5 md:grid-cols-3">
                    {section.entries.map((entry) => {
                      const Icon = entry.icon;
                      const active = isNavEntryActive(pathname, entry);

                      return (
                        <Link
                          key={entry.href}
                          href={entry.href}
                          onClick={() => setMoreOpen(false)}
                          className={cn(
                            'group flex min-h-10 items-center gap-1.5 rounded-xl border border-border bg-card/35 px-2.5 py-1.5 text-left text-sm font-medium leading-tight text-muted-foreground transition-all duration-200 hover:border-foreground/20 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:gap-2 sm:px-3',
                            active && 'border-primary/40 bg-primary/10 text-foreground',
                          )}
                        >
                          <span
                            className={cn(
                              'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-secondary/70 text-muted-foreground transition-colors duration-200 group-hover:bg-background group-hover:text-foreground',
                              active && 'bg-primary/15 text-primary',
                            )}
                          >
                            <Icon size={16} strokeWidth={active ? 2.2 : 1.7} />
                          </span>
                          <span className="break-words">{tNav(entry.key)}</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setMoreOpen(false);
                setCreateOfferOpen(true);
              }}
              className="mt-3 flex min-h-10 w-full items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-all duration-200 hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus size={16} aria-hidden="true" />
              {tOfferChooser('openButton')}
            </button>
            <div className="mt-2 border-t border-border pt-2">
              <button
                type="button"
                onClick={toggleTheme}
                className="group flex min-h-10 w-full items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-left text-sm font-medium text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:gap-2 sm:px-3"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-secondary/70 transition-colors duration-200 group-hover:bg-background">
                  {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
                </span>
                <span>
                  {theme === 'light'
                    ? tDashboard('themeTooltipLight')
                    : tDashboard('themeTooltipDark')}
                </span>
              </button>
            </div>
          </div>
        </>
      )}

      <nav
        aria-label={salleMode ? 'Navigation Salle' : 'Navigation principale'}
        className="dashboard-mobile-nav"
      >
        <div
          ref={containerRef}
          className={cn(
            'dashboard-mobile-nav__inner',
            !liquidReady && 'is-initializing',
            isDragging && 'is-dragging',
            isPressed && 'is-pressed',
          )}
          data-pointer-interaction={pointerInteraction || undefined}
          onKeyDownCapture={() => setPointerInteraction(false)}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={(event) => finishDrag(event, true)}
        >
          <span
            ref={liquidRef}
            className="dashboard-mobile-nav__liquid-indicator"
            aria-hidden="true"
          />
          <div className="dashboard-mobile-nav__items">
            {activeNavItems.map((item, index) => {
              const Icon = item.icon;
              // Quand « Plus » est ouvert, son indicateur devient l'onglet
              // actif. L'onglet de la page courante doit garder son icône et
              // son libellé normaux (notamment « Clients »), sans second
              // état actif visuel sous le panneau.
              const active = !moreOpen && isPrimaryNavActive(pathname, item, salleEditMode);
              const visualActive = isDragging ? dragPreviewIndex === index : active;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-label={tNav(item.key)}
                  draggable={false}
                  ref={(element) => {
                    itemRefs.current[index] = element;
                  }}
                  onClick={(event) => {
                    if (suppressClickRef.current) {
                      event.preventDefault();
                      clearClickSuppression();
                      return;
                    }
                    triggerHaptic(12);
                    setMoreOpen(false);
                  }}
                  aria-current={active ? 'page' : undefined}
                  className={cn('dashboard-mobile-nav__item', visualActive && 'is-active')}
                >
                  <span className="dashboard-mobile-nav__icon" aria-hidden="true">
                    <Icon size={20} strokeWidth={1.8} />
                  </span>
                  <span className="dashboard-mobile-nav__label">
                    <span className="dashboard-mobile-nav__label-full">{tNav(item.key)}</span>
                    <span className="dashboard-mobile-nav__label-compact" aria-hidden="true">
                      {item.key === 'reservations' ? 'Résas' : tNav(item.key)}
                    </span>
                  </span>
                </Link>
              );
            })}

            {hasMoreMenu && (
              <button
                type="button"
                draggable={false}
                ref={(element) => {
                  itemRefs.current[activeNavItems.length] = element;
                }}
                aria-expanded={moreOpen}
                aria-haspopup="dialog"
                aria-controls="mobile-more-menu"
                aria-label={tNav('more')}
                aria-current={moreActive ? 'page' : undefined}
                onClick={(event) => {
                  if (suppressClickRef.current) {
                    event.preventDefault();
                    clearClickSuppression();
                    return;
                  }
                  triggerHaptic(12);
                  setMoreOpen((current) => !current);
                }}
                className={cn(
                  'dashboard-mobile-nav__item',
                  (isDragging ? dragPreviewIndex === activeNavItems.length : moreActive) &&
                    'is-active',
                )}
              >
                <span className="dashboard-mobile-nav__icon" aria-hidden="true">
                  <MoreHorizontal size={20} strokeWidth={1.8} />
                </span>
                <span className="dashboard-mobile-nav__label">
                  <span className="dashboard-mobile-nav__label-full">{tNav('more')}</span>
                  <span className="dashboard-mobile-nav__label-compact" aria-hidden="true">
                    {tNav('more')}
                  </span>
                </span>
              </button>
            )}
          </div>
        </div>
      </nav>
      <CreateOfferDialog open={createOfferOpen} onOpenChange={setCreateOfferOpen} />
    </>
  );
}
