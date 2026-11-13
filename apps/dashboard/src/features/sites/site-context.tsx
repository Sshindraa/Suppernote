'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Building2, Check, Loader2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

export type RestaurantSite = {
  id: string;
  name: string;
  siteStatus: string;
  isPrimary: boolean;
  role: string;
};

type SitesResponse = {
  accountId?: string | null;
  activeSiteId?: string;
  sites?: RestaurantSite[];
};

type SiteContextValue = {
  organizationId?: string;
  accountId?: string;
  sites: RestaurantSite[];
  activeSiteId?: string;
  activeSite?: RestaurantSite;
  status: 'idle' | 'loading' | 'ready' | 'error';
  selectSite: (siteId: string) => void;
  refresh: () => void;
};

const SiteContext = createContext<SiteContextValue>({
  sites: [],
  status: 'idle',
  selectSite: () => undefined,
  refresh: () => undefined,
});

function storageKey(organizationId: string) {
  return `sokar.active-site:${organizationId}`;
}

function readStoredSite(organizationId: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(organizationId));
  } catch {
    return null;
  }
}

function storeSite(organizationId: string, siteId: string) {
  try {
    window.localStorage.setItem(storageKey(organizationId), siteId);
  } catch {
    // Le choix reste fonctionnel en mémoire si le navigateur bloque le stockage.
  }
}

function parseSites(payload: SitesResponse): RestaurantSite[] {
  if (!Array.isArray(payload.sites)) return [];
  return payload.sites.filter((site): site is RestaurantSite =>
    Boolean(
      site &&
      typeof site.id === 'string' &&
      typeof site.name === 'string' &&
      typeof site.siteStatus === 'string',
    ),
  );
}

function selectableSites(sites: RestaurantSite[]) {
  return sites.filter((site) => site.siteStatus !== 'SUSPENDED' && site.siteStatus !== 'ARCHIVED');
}

export function SiteProvider({
  organizationId,
  children,
}: {
  organizationId?: string;
  children: ReactNode;
}) {
  const [sites, setSites] = useState<RestaurantSite[]>([]);
  const [accountId, setAccountId] = useState<string>();
  const [activeSiteId, setActiveSiteId] = useState<string>();
  const [status, setStatus] = useState<SiteContextValue['status']>('idle');
  const [refreshToken, setRefreshToken] = useState(0);
  // Organisation à laquelle appartiennent les sites affichés.
  const loadedOrganizationRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const handleOrganizationSynced = () => setRefreshToken((token) => token + 1);
    window.addEventListener('suppernote:organization-synced', handleOrganizationSynced);
    return () =>
      window.removeEventListener('suppernote:organization-synced', handleOrganizationSynced);
  }, []);

  useEffect(() => {
    if (!organizationId) {
      loadedOrganizationRef.current = undefined;
      setSites([]);
      setAccountId(undefined);
      setActiveSiteId(undefined);
      setStatus('idle');
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    // Une actualisation de la même organisation garde la sélection : l'effacer changerait le
    // client API et relancerait toutes les lectures du dashboard.
    const isRefresh = loadedOrganizationRef.current === organizationId;
    loadedOrganizationRef.current = organizationId;
    if (!isRefresh) {
      setSites([]);
      setAccountId(undefined);
      setActiveSiteId(undefined);
      setStatus('loading');
    }

    void fetch('/api/proxy/restaurants/sites', {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as SitesResponse;
        if (!response.ok) {
          throw new Error('Impossible de charger vos établissements.');
        }
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        const nextSites = parseSites(payload);
        setAccountId(payload.accountId ?? undefined);
        const nextSelectableSites = selectableSites(nextSites);
        const savedSiteId = readStoredSite(organizationId);
        const nextActiveSiteId =
          (savedSiteId &&
            nextSelectableSites.some((site) => site.id === savedSiteId) &&
            savedSiteId) ||
          (payload.activeSiteId &&
            nextSelectableSites.some((site) => site.id === payload.activeSiteId) &&
            payload.activeSiteId) ||
          nextSelectableSites[0]?.id;
        setSites(nextSites);
        setActiveSiteId(nextActiveSiteId);
        setStatus('ready');
        if (nextActiveSiteId) {
          storeSite(organizationId, nextActiveSiteId);
        }
      })
      .catch(() => {
        if (cancelled) return;
        if (isRefresh) {
          // Une actualisation qui échoue garde les sites déjà chargés.
          setStatus((current) => (current === 'loading' ? 'error' : current));
          return;
        }
        setSites([]);
        setAccountId(undefined);
        setActiveSiteId(undefined);
        setStatus('error');
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [organizationId, refreshToken]);

  const selectSite = useCallback(
    (siteId: string) => {
      if (!sites.some((site) => site.id === siteId)) return;
      setActiveSiteId(siteId);
      if (organizationId) storeSite(organizationId, siteId);
    },
    [organizationId, sites],
  );

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);
  const activeSite = sites.find((site) => site.id === activeSiteId);
  const value = useMemo(
    () => ({
      organizationId,
      accountId,
      sites,
      activeSiteId,
      activeSite,
      status,
      selectSite,
      refresh,
    }),
    [accountId, activeSite, activeSiteId, organizationId, refresh, selectSite, sites, status],
  );

  return <SiteContext.Provider value={value}>{children}</SiteContext.Provider>;
}

export function useSiteSelection() {
  return useContext(SiteContext);
}

/**
 * Compact selector used in the dashboard header. It is hidden for a legacy
 * or single-site account, while the active site still travels with every API
 * request through useApi().
 */
export function SiteSwitcher({ className }: { className?: string }) {
  const { sites, activeSiteId, activeSite, status, selectSite } = useSiteSelection();
  const availableSites = selectableSites(sites);

  if (availableSites.length < 2) return null;

  return (
    <Select value={activeSiteId} onValueChange={selectSite}>
      <SelectTrigger
        className={cn(
          'h-9 w-[15rem] rounded-full border-border bg-card/80 px-3 text-xs shadow-sm',
          className,
        )}
        aria-label="Établissement actif"
        disabled={status === 'loading'}
      >
        <span className="flex min-w-0 items-center gap-2">
          {status === 'loading' ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : (
            <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <SelectValue placeholder={activeSite?.name ?? 'Établissement'} />
        </span>
      </SelectTrigger>
      <SelectContent align="start">
        {availableSites.map((site) => (
          <SelectItem key={site.id} value={site.id}>
            <span className="flex items-center gap-2">
              <span className="truncate">{site.name}</span>
              {site.isPrimary && (
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  principal
                </span>
              )}
              {site.id === activeSiteId && <Check className="h-3.5 w-3.5" />}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
