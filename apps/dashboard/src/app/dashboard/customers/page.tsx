'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useApi } from '../../../lib/api';
import { ApiError } from '@/lib/api-error';
import { getErrorMessage, type Customer, type CustomerLifecycleStatus } from '@/types/api';
import { useIsMobile } from '@/lib/useMediaQuery';
import { useSiteSelection } from '@/features/sites/site-context';
import { cn, formatPhone } from '@/lib/utils';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Users,
  Search,
  Star,
  Phone,
  Copy,
  Lock,
  StickyNote,
  X,
  Download,
  ArrowDown,
  Upload,
} from 'lucide-react';
import { CustomerImportDialog } from './customer-import-dialog';
import { DataFetchError } from '@/components/DataFetchError';
import { CustomerLifecycleBadge } from '@/components/CustomerLifecycleBadge';

type CustomerListResponse = Customer[] | { data?: Customer[]; total?: number };

const PAGE_SIZE = 50;

type Filters = {
  search: string;
  isVip: 'all' | 'true' | 'false';
  lifecycle: 'all' | CustomerLifecycleStatus;
  minVisits: string;
  sort: 'recent' | 'visits365d' | 'lastVisit';
};
const NO_FILTERS: Filters = {
  search: '',
  isVip: 'all',
  lifecycle: 'all',
  minVisits: '',
  sort: 'recent',
};

type Segment = {
  key: string;
  label: string;
  isVip: Filters['isVip'];
  lifecycle: Filters['lifecycle'];
  // Statuts : filtres serveur réservés au CRM Pro.
  crmOnly?: boolean;
};
const SEGMENTS: Segment[] = [
  { key: 'all', label: 'Tous', isVip: 'all', lifecycle: 'all' },
  { key: 'vip', label: 'VIP', isVip: 'true', lifecycle: 'all' },
  { key: 'regular', label: 'Habitués', isVip: 'all', lifecycle: 'regular', crmOnly: true },
  { key: 'at_risk', label: 'À risque', isVip: 'all', lifecycle: 'at_risk', crmOnly: true },
  { key: 'dormant', label: 'Endormis', isVip: 'all', lifecycle: 'dormant', crmOnly: true },
  { key: 'new', label: 'Nouveaux', isVip: 'all', lifecycle: 'new', crmOnly: true },
];

/** La fiche s'ouvre dès Essential (fiche simple) ; fermée ou en panne, le nom reste un simple texte. */
function ProfileLink({
  id,
  linked,
  children,
}: {
  id: string;
  linked: boolean;
  children: React.ReactNode;
}) {
  if (!linked) return <>{children}</>;
  return (
    <Link
      href={`/dashboard/customers/crm/${id}`}
      className="transition-all duration-200 hover:underline"
    >
      {children}
    </Link>
  );
}

// Une seule date pour tout l'écran (tableau et cartes).
function formatVisitDate(value: string | null) {
  if (!value) return '—';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

function customerInitials(name: string | null) {
  return (name || '?')
    .split(' ')
    .filter(Boolean)
    .map((word) => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function CustomerMobileCard({
  customer,
  onToggleVip,
  profileLinked,
}: {
  customer: Customer;
  onToggleVip: (id: string, current: boolean) => void;
  profileLinked: boolean;
}) {
  const name = customer.name || 'Client sans nom';

  return (
    <article className="overflow-hidden rounded-2xl border border-border bg-card/80 shadow-sm">
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-secondary text-sm font-semibold text-foreground"
            >
              {customerInitials(customer.name)}
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-semibold text-foreground">
                <ProfileLink id={customer.id} linked={profileLinked}>
                  {name}
                </ProfileLink>
              </h2>
              <p className="mt-0.5 truncate text-xs tabular-nums text-muted-foreground">
                {formatPhone(customer.phone)}
              </p>
            </div>
          </div>
          {customer.isVip ? (
            <span className="inline-flex flex-none items-center gap-1 rounded-full border border-primary/20 bg-secondary px-2.5 py-1 text-[11px] font-medium text-foreground">
              <Star size={12} className="fill-current" />
              VIP
            </span>
          ) : null}
        </div>

        <div className="mt-4 grid grid-cols-3 divide-x divide-border border-y border-border/60 py-3">
          <div className="px-2 text-center">
            <p className="text-xs text-muted-foreground">Visites 365 j</p>
            <p className="mt-1 text-base font-semibold text-foreground">
              {customer.visitSummary?.visits365d ?? '—'}
            </p>
          </div>
          <div className="px-2 text-center">
            <p className="text-xs text-muted-foreground">Statut</p>
            <div className="mt-1 flex justify-center">
              <CustomerLifecycleBadge lifecycle={customer.lifecycle} />
            </div>
          </div>
          <div className="min-w-0 px-2 text-center">
            <p className="text-xs text-muted-foreground">Dernière</p>
            <p className="mt-1 truncate text-sm font-medium text-foreground">
              {formatVisitDate(customer.visitSummary?.lastVisitAt ?? null)}
            </p>
          </div>
        </div>

        {customer.notes && (
          <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
            <StickyNote size={14} className="mt-0.5 flex-none" />
            <span className="line-clamp-2">{customer.notes}</span>
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 border-t border-border/70 bg-background/20 p-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onToggleVip(customer.id, customer.isVip)}
          className="h-10 min-w-0 px-2 text-xs"
        >
          <Star size={14} className={customer.isVip ? 'fill-current' : ''} />
          <span className="truncate">{customer.isVip ? 'Retirer VIP' : 'Marquer VIP'}</span>
        </Button>
        {/* Sur téléphone, le numéro se compose d'un geste : lien tel:, pas une fenêtre sans action. */}
        <Button asChild variant="secondary" size="sm" className="h-10 min-w-0 px-2 text-xs">
          <a href={`tel:${customer.phone}`} aria-label={`Appeler ${name}`}>
            <Phone size={14} />
            Appeler
          </a>
        </Button>
      </div>
    </article>
  );
}

export default function CustomersPage() {
  const { get, post, orgId } = useApi();
  const { activeSite } = useSiteSelection();
  const router = useRouter();
  // Export réservé au propriétaire ; sans rôle connu, c'est le serveur qui tranche.
  const canExport = !activeSite?.role || activeSite.role === 'OWNER';
  const isMobile = useIsMobile();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  // Saisie en cours, et filtres réellement appliqués (ceux que « Afficher plus » doit continuer).
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  // Segment actif = celui dont les filtres correspondent au brouillon (aucun si filtres libres).
  const activeSegmentKey = SEGMENTS.find(
    (segment) => draft.isVip === segment.isVip && draft.lifecycle === segment.lifecycle,
  )?.key;
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [error, setError] = useState('');
  // Le premier chargement affiche des squelettes ; une recherche garde la page et le champ en place.
  const [loadedOnce, setLoadedOnce] = useState(false);
  // CRM Pro : « open » = filtres et fiches ouverts, « locked » = hors formule (CRM de base), « hidden » = fermé ou en panne.
  const [crmState, setCrmState] = useState<'open' | 'locked' | 'hidden'>('hidden');

  const customersUrl = useCallback((filters: Filters, offset: number) => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    // Un nom ou un numéro tel qu'on le tape (« 06 12 34 56 78 »), entier ou en partie.
    if (filters.search) params.set('search', filters.search);
    if (filters.isVip !== 'all') params.set('isVip', filters.isVip);
    if (filters.lifecycle !== 'all') params.set('lifecycle', filters.lifecycle);
    if (filters.minVisits) params.set('minHonored365d', filters.minVisits);
    // Le tri récent est celui de l'API par défaut : inutile de le transmettre.
    if (filters.sort !== 'recent') params.set('sort', filters.sort);
    return `customers?${params.toString()}`;
  }, []);

  // La saisie ne se réécrit pas depuis la réponse : une lettre tapée pendant le chargement serait perdue.
  const fetchCustomers = useCallback(
    async (filters: Filters = NO_FILTERS) => {
      setLoading(true);
      setError('');
      setMoreError('');
      try {
        const response = await get<CustomerListResponse>(customersUrl(filters, 0));
        const rows = Array.isArray(response) ? response : response.data;
        const list = Array.isArray(rows) ? rows : [];
        setCustomers(list);
        setTotal(
          !Array.isArray(response) && typeof response.total === 'number'
            ? response.total
            : list.length,
        );
        setApplied(filters);
        setLoadedOnce(true);
      } catch (err: unknown) {
        setError(getErrorMessage(err, 'Impossible de charger les clients'));
      }
      setLoading(false);
    },
    [get, customersUrl],
  );

  // Segment, effacement ou Entrée : la saisie suit tout de suite et la liste se recharge.
  function applyFilters(next: Filters) {
    setDraft(next);
    void fetchCustomers({ ...next, search: next.search.trim() });
  }

  // Sans suite, la liste s'arrêtait aux 50 premiers clients et l'en-tête annonçait « 50 clients ».
  async function loadMore() {
    setLoadingMore(true);
    setMoreError('');
    try {
      const response = await get<CustomerListResponse>(customersUrl(applied, customers.length));
      const rows = Array.isArray(response) ? response : response.data;
      const next = Array.isArray(rows) ? rows : [];
      setCustomers((current) => {
        const known = new Set(current.map((customer) => customer.id));
        return [...current, ...next.filter((customer) => !known.has(customer.id))];
      });
      if (!Array.isArray(response) && typeof response.total === 'number') setTotal(response.total);
    } catch (err: unknown) {
      setMoreError(getErrorMessage(err, 'Impossible de charger les clients suivants'));
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    if (!orgId) return;
    void fetchCustomers();
  }, [orgId, fetchCustomers]);

  // Recherche à la frappe : une pause de 300 ms évite une requête par lettre.
  useEffect(() => {
    const search = draft.search.trim();
    if (search === applied.search && draft.minVisits === applied.minVisits) return;
    const timer = setTimeout(() => {
      void fetchCustomers({ ...draft, search });
    }, 300);
    return () => clearTimeout(timer);
  }, [draft, applied, fetchCustomers]);

  // Une seule sonde, une fois la liste chargée : elle ne doit ni ralentir ni perturber le chargement des clients.
  const crmProbed = useRef(false);
  useEffect(() => {
    if (!orgId || !loadedOnce || crmProbed.current) return;
    crmProbed.current = true;
    Promise.resolve(get('crm/customers?limit=1'))
      .then(() => setCrmState('open'))
      // Hors formule : les filtres avancés sont présentés comme inclus dans CRM Pro. Fermé ou en panne : on les cache.
      .catch((err: unknown) =>
        setCrmState(err instanceof ApiError && err.kind === 'not-included' ? 'locked' : 'hidden'),
      );
  }, [orgId, get, loadedOnce]);

  // Le tri n'est pas un filtre : il ne compte pas dans « filtres actifs ».
  const hasFilters =
    JSON.stringify({ ...applied, sort: NO_FILTERS.sort }) !== JSON.stringify(NO_FILTERS);

  // Compteurs par segment (CRM Pro), recalculés à chaque recherche ; en cas d'échec, pas de compteur.
  const [segmentCounts, setSegmentCounts] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    if (crmState !== 'open') return;
    let cancelled = false;
    const query = applied.search
      ? `?${new URLSearchParams({ search: applied.search }).toString()}`
      : '';
    void (async () => {
      try {
        const response = await get<{ data: Record<string, number> }>(
          `customers/segment-counts${query}`,
        );
        if (!cancelled) setSegmentCounts(response.data);
      } catch {
        if (!cancelled) setSegmentCounts(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [crmState, applied.search, get]);

  // Un second clic sur la colonne active revient au tri récent.
  function toggleSort(sort: 'visits365d' | 'lastVisit') {
    applyFilters({ ...draft, sort: applied.sort === sort ? 'recent' : sort });
  }

  // Les en-têtes ne sont cliquables qu'au CRM Pro ouvert ; ailleurs, simple texte.
  function sortHeader(label: string, sort: 'visits365d' | 'lastVisit') {
    if (crmState !== 'open') return label;
    const active = applied.sort === sort;
    return (
      <button
        type="button"
        onClick={() => toggleSort(sort)}
        className={cn(
          'inline-flex items-center gap-1 transition-all duration-200 hover:text-foreground',
          active && 'text-foreground',
        )}
      >
        {label}
        {active ? <ArrowDown size={14} aria-hidden="true" /> : null}
      </button>
    );
  }

  const [exporting, setExporting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  async function exportCsv() {
    setExporting(true);
    setError('');
    try {
      const res = await get<{ data: { csv: string } }>('customers/export');
      const url = URL.createObjectURL(new Blob([res.data.csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `clients-sokar-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Impossible d'exporter le fichier clients"));
    } finally {
      setExporting(false);
    }
  }

  async function toggleVip(id: string, current: boolean) {
    try {
      await post(`customers/${id}/vip`, { isVip: !current });
      setCustomers((prev) => prev.map((c) => (c.id === id ? { ...c, isVip: !current } : c)));
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Impossible de modifier le statut VIP'));
    }
  }

  if (loading && !loadedOnce) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-24 rounded-full" />
          <Skeleton className="h-4 w-20" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-10 w-24" />
        </div>
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-start justify-between gap-3">
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight">
          Clients <span className="text-muted-foreground font-normal tabular-nums">{total}</span>
        </h1>
        <div className="flex flex-none items-center gap-2">
          {canExport ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="px-2.5 transition-all duration-200 sm:px-3"
              onClick={() => void exportCsv()}
              disabled={exporting}
            >
              <Download size={14} />
              {exporting ? 'Export…' : 'Exporter'}
            </Button>
          ) : null}
          {canExport ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="px-2.5 transition-all duration-200 sm:px-3"
              onClick={() => setImportOpen(true)}
            >
              <Upload size={14} />
              Importer
            </Button>
          ) : null}
          {crmState === 'open' ? (
            <Button asChild variant="outline" size="sm" className="px-2.5 sm:px-3">
              <Link href="/dashboard/customers/crm/duplicates">
                <Copy size={14} />
                Doublons
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      {canExport ? (
        <CustomerImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          onImported={() => void fetchCustomers()}
        />
      ) : null}

      {/* Segments : un clic recharge la liste, la recherche en cours reste en place */}
      <Tabs
        value={activeSegmentKey ?? ''}
        onValueChange={(key) => {
          const segment = SEGMENTS.find((item) => item.key === key);
          if (segment) {
            applyFilters({ ...draft, isVip: segment.isVip, lifecycle: segment.lifecycle });
          }
        }}
      >
        <TabsList aria-label="Segments de clients">
          {SEGMENTS.filter((segment) => !segment.crmOnly || crmState === 'open').map((segment) => {
            const active = segment.key === activeSegmentKey;
            // L'onglet actif montre le total de la liste (il suit aussi « Visites min. ») ; les autres,
            // leur effectif quand le CRM Pro le fournit.
            const count = crmState === 'open' ? segmentCounts?.[segment.key] : undefined;
            const shown = active ? total : (count ?? null);
            return (
              <TabsTrigger key={segment.key} value={segment.key}>
                {segment.label}
                {shown !== null ? (
                  <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">{shown}</span>
                ) : null}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      {/* Recherche */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters(draft);
        }}
        className="flex min-w-0 flex-wrap gap-2"
        role="search"
      >
        <div className="relative min-w-[16rem] flex-1">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="text"
            placeholder="Rechercher un nom, un téléphone ou un email…"
            value={draft.search}
            onChange={(e) => setDraft((current) => ({ ...current, search: e.target.value }))}
            aria-label="Rechercher un client par nom ou téléphone"
            className="w-full pl-9 pr-10"
          />
          {draft.search && (
            <button
              type="button"
              aria-label="Effacer la recherche"
              onClick={() => applyFilters({ ...draft, search: '' })}
              className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X size={15} />
            </button>
          )}
        </div>
        {crmState === 'open' ? (
          <label>
            <span className="sr-only">Visites honorées minimum</span>
            <Input
              type="number"
              min={0}
              max={10000}
              className="w-40"
              value={draft.minVisits}
              onChange={(event) =>
                setDraft((current) => ({ ...current, minVisits: event.target.value }))
              }
              placeholder="Visites min. (365 j)"
            />
          </label>
        ) : null}
      </form>
      {crmState === 'locked' ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Lock size={12} aria-hidden="true" />
          Segments par statut, valeur client et doublons : CRM Pro.
          <Link
            href="/pricing"
            className="underline underline-offset-4 transition-all duration-200 hover:text-foreground"
          >
            Voir les formules
          </Link>
        </p>
      ) : null}

      {/* Contenu */}
      {error && (
        <DataFetchError
          message={error}
          onRetry={() => fetchCustomers(applied)}
          retrying={loading}
        />
      )}
      {customers.length === 0 ? (
        error ? null : (
          <div className="sokar-empty">
            <Users size={40} className="opacity-30" />
            <p className="text-sm">
              {hasFilters
                ? 'Aucun client ne correspond à cette recherche'
                : 'Aucun client enregistré'}
            </p>
            <p className="max-w-sm text-xs opacity-60">
              {hasFilters
                ? 'Essayez un autre nom, seulement quelques chiffres du numéro, ou retirez un filtre.'
                : 'Les clients apparaîtront après vos premiers appels.'}
            </p>
            {hasFilters ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-1"
                onClick={() => applyFilters(NO_FILTERS)}
              >
                Effacer les filtres
              </Button>
            ) : (
              <Button asChild size="sm" variant="outline" className="mt-1">
                <Link href="/dashboard/calls">Voir les appels</Link>
              </Button>
            )}
          </div>
        )
      ) : isMobile ? (
        /* ========== MOBILE: Card List ========== */
        <div className="space-y-3">
          {customers.map((customer) => (
            <CustomerMobileCard
              key={customer.id}
              customer={customer}
              onToggleVip={toggleVip}
              profileLinked={crmState !== 'hidden'}
            />
          ))}
        </div>
      ) : (
        /* ========== DESKTOP: Table ========== */
        <div className="sokar-card overflow-hidden">
          <div className="mobile-table-wrapper">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nom</TableHead>
                  <TableHead className="hidden lg:table-cell">Téléphone</TableHead>
                  <TableHead
                    aria-sort={
                      crmState === 'open' && applied.sort === 'visits365d'
                        ? 'descending'
                        : undefined
                    }
                  >
                    {sortHeader('Visites 365 j', 'visits365d')}
                  </TableHead>
                  <TableHead>Statut</TableHead>
                  <TableHead
                    aria-sort={
                      crmState === 'open' && applied.sort === 'lastVisit' ? 'descending' : undefined
                    }
                  >
                    {sortHeader('Dernière visite', 'lastVisit')}
                  </TableHead>
                  <TableHead>VIP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.map((c) => (
                  <TableRow
                    key={c.id}
                    onClick={
                      crmState === 'hidden'
                        ? undefined
                        : (event) => {
                            // Le nom et le bouton VIP ont leur propre action : la ligne ne les doublonne pas.
                            if ((event.target as HTMLElement).closest('a,button')) return;
                            router.push(`/dashboard/customers/crm/${c.id}`);
                          }
                    }
                    className={cn(
                      'transition-all duration-200 hover:bg-accent',
                      crmState !== 'hidden' && 'cursor-pointer',
                    )}
                  >
                    <TableCell className="font-medium">
                      <div className="flex min-w-0 items-center gap-3">
                        <span
                          aria-hidden="true"
                          className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-secondary text-xs font-semibold text-foreground"
                        >
                          {customerInitials(c.name)}
                        </span>
                        <div className="min-w-0">
                          <ProfileLink id={c.id} linked={crmState !== 'hidden'}>
                            {c.name || <span className="opacity-50">Client sans nom</span>}
                          </ProfileLink>
                          {/* Sous 1024 px la colonne Téléphone disparaît : le numéro passe sous le nom. */}
                          <p className="text-xs tabular-nums text-muted-foreground lg:hidden">
                            {formatPhone(c.phone)}
                          </p>
                          {c.emailNormalized ? (
                            <p className="hidden max-w-[220px] truncate text-xs text-muted-foreground lg:block">
                              {c.emailNormalized}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden tabular-nums text-muted-foreground lg:table-cell">
                      {formatPhone(c.phone)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {c.visitSummary?.visits365d ?? '—'}
                    </TableCell>
                    <TableCell>
                      {/* Le motif du statut n'est pas dans la cellule : on le lit au survol. */}
                      {c.lifecycle ? (
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex">
                                <CustomerLifecycleBadge lifecycle={c.lifecycle} />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>{c.lifecycle.reason}</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <CustomerLifecycleBadge lifecycle={c.lifecycle} />
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {formatVisitDate(c.visitSummary?.lastVisitAt ?? null)}
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={c.isVip ? 'Retirer VIP' : 'Marquer VIP'}
                        aria-pressed={c.isVip}
                        onClick={(event) => {
                          event.stopPropagation();
                          void toggleVip(c.id, c.isVip);
                        }}
                        className="transition-all duration-200"
                      >
                        <Star
                          size={16}
                          className={
                            c.isVip ? 'fill-current text-foreground' : 'text-muted-foreground'
                          }
                        />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {customers.length > 0 && customers.length < total && (
        <div className="flex flex-col items-center gap-2">
          {moreError && <p className="text-sm text-destructive">{moreError}</p>}
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="transition-all duration-200"
          >
            {loadingMore
              ? 'Chargement…'
              : `Afficher plus de clients (${customers.length} sur ${total})`}
          </Button>
        </div>
      )}
    </div>
  );
}
