import { format } from 'date-fns';
import { StatsPanel } from '../../briefing/StatsPanel';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampZoom,
  computeCenterScroll,
  computeFitZoom,
  computeFocusScroll,
  computeLiveContentBounds,
  computeZoomAnchorScroll,
  findNearbyFreeTablePosition,
  settleTableDrop,
  findOverlappingTableChairs,
  FloorPlanCanvas,
  getTableAlignmentGuides,
  getTableSpacingGuides,
  getSafeTableDimensions,
  isDoubleTap,
  nudgeTableClearOfChairs,
  tablePlatesOverlapAtPosition,
  TABLE_LAYOUT,
  WaitingListPanel,
} from './FloorPlanCanvas';
import type {
  FloorPlan,
  FloorPlanWall,
  FloorPlanZone,
  PlanningReservation,
  WaitingListEntry,
} from '@/types/api';

const accessMocks = vi.hoisted(() => ({ allowed: true }));
vi.mock('@/lib/use-service-copilot-access', () => ({
  useServiceCopilotAccess: () => ({ allowed: accessMocks.allowed }),
}));
beforeEach(() => {
  accessMocks.allowed = true;
});

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

const activeWall: FloorPlanWall = {
  id: 'wall-active',
  x1: 300,
  y1: 280,
  x2: 456,
  y2: 280,
  type: 'wall',
  name: null,
};

const referenceWall: FloorPlanWall = {
  id: 'wall-reference',
  x1: 480,
  y1: 100,
  x2: 480,
  y2: 280,
  type: 'wall',
  name: null,
};

const floorPlan: FloorPlan = {
  id: 'floor-plan-test',
  name: 'Plan test',
  isDefault: true,
  isActive: true,
  width: 700,
  height: 420,
  sections: [],
  tables: [
    {
      id: 'table-t4-minimum-round',
      name: 'T4',
      capacity: 4,
      minCapacity: 1,
      isActive: true,
      positionX: 64,
      positionY: 64,
      width: TABLE_LAYOUT.minimumDimension,
      height: TABLE_LAYOUT.minimumDimension,
      rotation: 0,
      shape: 'round',
    },
  ],
  walls: [activeWall, referenceWall],
};

const waitingListEntry: WaitingListEntry = {
  id: 'waiting-list-1',
  partySize: 4,
  customerFirstName: 'Alice',
  customerLastName: 'Martin',
  customerPhone: '+33612345678',
  slotStart: '2025-06-10T19:30:00.000Z',
  slotEnd: '2025-06-10T21:00:00.000Z',
  preferredSectionName: 'Terrasse',
  status: 'PENDING',
  position: 1,
  createdAt: '2025-06-10T18:00:00.000Z',
};

vi.mock('@/lib/api', () => ({
  useApi: () => apiMocks,
}));

// jsdom n'implémente pas `matchMedia` : le mock rend le chemin tactile
// pilotable par test, tout en gardant le rendu desktop par défaut.
const mediaMocks = vi.hoisted(() => ({ mobile: false, touch: false, coarse: false }));

vi.mock('@/lib/useMediaQuery', () => ({
  useIsMobile: () => mediaMocks.mobile,
  useMediaQuery: (query: string) =>
    query === '(pointer: coarse)' ? mediaMocks.coarse : mediaMocks.touch,
}));

beforeEach(() => {
  mediaMocks.mobile = false;
  mediaMocks.touch = false;
  mediaMocks.coarse = false;
  apiMocks.get.mockReset();
  apiMocks.post.mockReset();
  apiMocks.patch.mockReset();
  apiMocks.del.mockReset();
  apiMocks.get.mockImplementation(async (path: string) => {
    if (path.includes('/reservations')) return [];
    return floorPlan;
  });
  apiMocks.post.mockResolvedValue({});
  apiMocks.patch.mockResolvedValue({});
  apiMocks.del.mockResolvedValue({});
});

describe('FloorPlanCanvas — disposition des chaises', () => {
  it('clamps unsafe dimensions without changing safe ones', () => {
    const safeWidth = TABLE_LAYOUT.minimumDimension + 24;
    const safeHeight = TABLE_LAYOUT.minimumDimension + 40;

    expect(getSafeTableDimensions(1, safeHeight)).toEqual({
      width: TABLE_LAYOUT.minimumDimension,
      height: safeHeight,
    });
    expect(getSafeTableDimensions(safeWidth, 1)).toEqual({
      width: safeWidth,
      height: TABLE_LAYOUT.minimumDimension,
    });
    expect(getSafeTableDimensions(0, -1)).toEqual({
      width: TABLE_LAYOUT.minimumDimension,
      height: TABLE_LAYOUT.minimumDimension,
    });
    expect(getSafeTableDimensions(safeWidth, safeHeight)).toEqual({
      width: safeWidth,
      height: safeHeight,
    });
  });
});

describe('FloorPlanCanvas — guides et duplication de table', () => {
  const referenceTable = {
    id: 'reference',
    name: 'T1',
    capacity: 4,
    minCapacity: 1,
    isActive: true,
    positionX: 100,
    positionY: 100,
    width: 80,
    height: 80,
    rotation: 0,
    shape: 'rect' as const,
  };

  it('propose les guides de bord et de centre les plus proches pendant un drag', () => {
    // Plateau rectangulaire affiché à 132 px de large (minimum) : bords visibles à x-26 et x+106.
    const guides = getTableAlignmentGuides({
      x: 104,
      y: 100,
      width: 80,
      height: 80,
      tables: [referenceTable],
      excludedTableId: 'moving',
    });

    // Bord gauche visible (78) contre bord gauche visible de la référence (74) : même bord.
    expect(guides.x).toMatchObject({ axis: 'x', value: 74, position: 100, distance: 4 });
    expect(guides.y).toMatchObject({ axis: 'y', value: 108, position: 100, distance: 0 });
  });

  it('préfère une table de même forme à une ronde plus proche', () => {
    const round = {
      ...referenceTable,
      id: 'round',
      shape: 'round' as const,
      positionX: 400,
      positionY: 86,
    };
    const guides = getTableAlignmentGuides({
      x: 600,
      y: 86,
      width: 80,
      height: 80,
      shape: 'rect',
      tables: [referenceTable, round],
      excludedTableId: 'moving',
      threshold: 20,
    });
    // Le haut de T1 est à 14 px, la ronde plus près : la rangée de rectangles l'emporte.
    expect(guides.y).toMatchObject({ position: 100, reference: { id: 'reference' } });
  });

  it('privilégie la table la plus proche sur un même axe', () => {
    const second = { ...referenceTable, id: 'second', positionX: 300 };
    const off = { ...referenceTable, id: 'off', positionX: 500, positionY: 140 };
    const guides = getTableAlignmentGuides({
      x: 700,
      y: 104,
      width: 80,
      height: 80,
      tables: [referenceTable, second, off],
      excludedTableId: 'moving',
    });
    expect(guides.y?.reference.id).toBe('second');
  });

  it("reprend l'écart déjà présent dans la rangée", () => {
    // Plateaux de 132 px : T1 à x=100 (plateau 74-206), T2 à 300 (274-406), écart 68.
    const second = { ...referenceTable, id: 'second', positionX: 300 };
    const spacing = getTableSpacingGuides({
      x: 505, // plateau à 479, écart de 73 avec T2 : à 5 px de 68
      y: 100,
      width: 80,
      height: 80,
      shape: 'rect',
      tables: [referenceTable, second],
      excludedTableId: 'moving',
    });
    expect(spacing.x).toMatchObject({ position: 500, gap: 68 });
    expect(spacing.x?.segments).toHaveLength(2);
    expect(spacing.y).toBeNull();
  });

  it('centre une table entre deux voisines', () => {
    const right = { ...referenceTable, id: 'right', positionX: 500 };
    const spacing = getTableSpacingGuides({
      x: 296,
      y: 100,
      width: 80,
      height: 80,
      shape: 'rect',
      tables: [referenceTable, right],
      excludedTableId: 'moving',
    });
    expect(spacing.x).toMatchObject({ position: 300, gap: 68 });
  });

  it('duplique à proximité sans chevaucher la table voisine', () => {
    const source = { ...referenceTable, id: 'source', positionX: 96, positionY: 96 };
    const occupiedRight = {
      ...referenceTable,
      id: 'occupied-right',
      positionX: 192,
      positionY: 96,
    };

    // Juste en dessous, mais assez bas pour que ses chaises ne touchent pas celles de l'original.
    expect(findNearbyFreeTablePosition(source, [source, occupiedRight], 800, 500)).toEqual({
      x: 96,
      y: 208,
    });
  });

  it('place à côté de la table visée si le point de dépôt est occupé', () => {
    const moving = {
      ...referenceTable,
      id: 'moving',
      positionX: 96,
      positionY: 96,
      width: 144,
      height: 104,
    };
    const occupied = { ...moving, id: 'occupied' };

    expect(findNearbyFreeTablePosition(moving, [occupied], 800, 500)).toEqual({
      x: 256,
      y: 96,
    });
  });

  describe('settleTableDrop', () => {
    const other = {
      ...referenceTable,
      id: 'other',
      positionX: 96,
      positionY: 96,
      width: undefined,
      height: undefined,
    } as unknown as typeof referenceTable;
    const dropped = (x: number, y: number) =>
      ({ ...other, id: 'moving', positionX: x, positionY: y }) as typeof referenceTable;
    const plateOverlap = (table: typeof referenceTable, gap: number) =>
      tablePlatesOverlapAtPosition({
        x: table.positionX,
        y: table.positionY,
        width: 144,
        height: 104,
        shape: 'rect',
        tables: [other],
        gap,
      });

    it('pose une table lâchée sur une autre contre elle, alignée', () => {
      const result = settleTableDrop(dropped(100, 120), [other], 800, 500, false)!;
      expect(result.aside).toBe(true);
      expect(result.x).toBe(96);
      expect(plateOverlap({ ...dropped(result.x, result.y) }, 0)).toBe(false);
      expect(plateOverlap({ ...dropped(result.x, result.y) }, 5)).toBe(true);
    });

    it('aligne une table lâchée à côté d’une autre sans la déplacer sur l’autre axe', () => {
      const result = settleTableDrop(dropped(260, 120), [other], 800, 500, false)!;
      expect(result).toEqual({ x: 260, y: 96, aside: false });
    });

    it('laisse la pose libre avec Alt, sauf pour un plateau superposé', () => {
      expect(settleTableDrop(dropped(260, 120), [other], 800, 500, true)).toEqual({
        x: 260,
        y: 120,
        aside: false,
      });
      expect(settleTableDrop(dropped(100, 120), [other], 800, 500, true)!.aside).toBe(true);
    });

    it('renvoie null quand aucune place n’existe', () => {
      // Plan de la taille d’une seule table, déjà occupé.
      const full = { ...other, positionX: 0, positionY: 0 };
      expect(settleTableDrop(dropped(4, 4), [full], 144, 104, false)).toBeNull();
    });
  });

  it('signale les chaises qui se chevauchent même quand les plateaux sont séparés', () => {
    const moving = { ...referenceTable, id: 'moving', positionY: 192 };
    const tables = [moving, referenceTable];

    expect(
      tablePlatesOverlapAtPosition({
        x: moving.positionX,
        y: moving.positionY,
        width: moving.width,
        height: moving.height,
        tables: [referenceTable],
      }),
    ).toBe(false);
    expect(findOverlappingTableChairs(moving, tables)).toBe(referenceTable);
    expect(findOverlappingTableChairs(moving, tables, { plateOnly: true })).toBeUndefined();
    expect(findOverlappingTableChairs({ ...moving, positionY: 210 }, tables)).toBeUndefined();
  });

  it('au lâcher, garde le même passage entre deux rectangles qu’avec une ronde', () => {
    // Plateaux de 132 px côte à côte, collés bord à bord (aucune chaise sur les côtés).
    const moving = { ...referenceTable, id: 'moving', positionX: 232 };
    const placed = nudgeTableClearOfChairs(moving, [referenceTable], 800, 600, 80, undefined, true);
    expect(placed).toBeDefined();
    // Bord gauche du plateau déplacé à au moins 16 px du bord droit de la référence (206).
    expect(placed!.positionX - 26 - 206).toBeGreaterThanOrEqual(16);
  });

  it('au lâcher, écarte une table dont les chaises touchent celles de la voisine', () => {
    const moving = { ...referenceTable, id: 'moving', positionY: 192 };
    const placed = nudgeTableClearOfChairs(moving, [referenceTable], 800, 600, 32, undefined, true);
    expect(placed).toBeDefined();
    expect(
      findOverlappingTableChairs({ ...moving, ...placed }, [moving, referenceTable]),
    ).toBeUndefined();
  });

  it('signale une chaise ronde qui touche le plateau voisin sans collision de plateaux', () => {
    const rect = { ...referenceTable, positionX: 0, positionY: 0, width: 144, height: 104 };
    const round = {
      ...rect,
      id: 'round',
      shape: 'round' as const,
      positionX: 151,
      width: 100,
      height: 100,
    };
    const overlaps = (x: number) =>
      tablePlatesOverlapAtPosition({
        x,
        y: 0,
        width: 100,
        height: 100,
        shape: 'round',
        tables: [rect],
      });
    expect(nudgeTableClearOfChairs(round, [rect], 400, 300)).toEqual({
      positionX: 163,
      positionY: 0,
    });
    expect(nudgeTableClearOfChairs(round, [rect], 255, 100)).toBeUndefined();
    expect(overlaps(151)).toBe(false);
    expect(findOverlappingTableChairs(round, [rect], { plateOnly: true })).toBe(rect);
    expect(findOverlappingTableChairs(rect, [round])).toBe(round);
    expect(overlaps(130)).toBe(true);
  });

  it('détecte le chevauchement réel des plateaux ronds, pas celui de leurs coins', () => {
    const roundTable = {
      ...referenceTable,
      id: 'round-moving',
      positionX: 0,
      positionY: 0,
      width: 100,
      height: 100,
      shape: 'round' as const,
    };

    expect(
      tablePlatesOverlapAtPosition({
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        shape: 'round',
        tables: [{ ...roundTable, id: 'round-neighbor', positionX: 85, positionY: 85 }],
      }),
    ).toBe(false);
    expect(
      tablePlatesOverlapAtPosition({
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        shape: 'round',
        tables: [{ ...roundTable, id: 'round-neighbor', positionX: 70, positionY: 70 }],
      }),
    ).toBe(true);
  });
});

describe('FloorPlanCanvas — taille des tables', () => {
  it.each(['rect', 'round'] as const)(
    'affiche une seule fois la capacité complète en édition pour une table %s',
    async (shape) => {
      apiMocks.get.mockResolvedValue({
        ...floorPlan,
        tables: [{ ...floorPlan.tables![0], shape, capacity: 4 }],
      });
      render(<FloorPlanCanvas orgId="org_test" />);
      const table = await screen.findByRole('button', { name: 'T4 · 4 places' });
      expect(within(table).getAllByText('4 places')).toHaveLength(1);
      expect(within(table).queryByText('4 pl.')).not.toBeInTheDocument();
    },
  );

  it.each([
    ['rect', 2, 2],
    ['rect', 6, 6],
    ['round', 2, 2],
    ['round', 6, 6],
    ['rect', 10, 0],
    ['round', 10, 0],
  ] as const)(
    'représente %i places sur une table %s sans comptage trompeur',
    async (shape, capacity, chairs) => {
      apiMocks.get.mockImplementation(async (path: string) => {
        if (path.includes('/floor-plan/reservations') || path.includes('/waiting-list')) return [];
        return { ...floorPlan, tables: [{ ...floorPlan.tables![0], shape, capacity }] };
      });

      render(<FloorPlanCanvas orgId="org_test" mode="service" />);
      const table = await screen.findByRole('button', { name: `T4 · ${capacity} places` });
      expect(table.querySelectorAll('[data-floor-seat]')).toHaveLength(chairs);
      expect(within(table).getByText(`${capacity} places`)).toBeInTheDocument();
    },
  );

  it('keeps a minimum-size round T4 card shrinkable to its explicit dimensions', async () => {
    render(<FloorPlanCanvas orgId="org_test" />);

    const table = await screen.findByRole('button', { name: 'T4 · 4 places' });

    expect(table).toHaveClass('min-w-0', 'min-h-0');
    expect(table).toHaveStyle({ width: '64px', height: '64px' });

    const tableName = within(table).getByText('T4');
    const capacity = within(table).getByText('4 places');

    expect(tableName).toHaveClass('max-w-full', 'truncate');
    expect(capacity).toHaveClass('truncate');
    expect(table.querySelectorAll('[data-floor-seat]')).toHaveLength(4);
    expect(table.querySelector('.rounded-full[data-floor-top]')).toHaveStyle({
      width: '72px',
      height: '72px',
    });
    // Plus de bande décorative en édition : la table se lit à son nom et ses places.
    expect(table.querySelector('.bg-floor-table-accent')).toBeNull();
  });

  it.each(['service', 'design'] as const)(
    'dessine quatre assises de même taille en mode %s',
    async (mode) => {
      render(<FloorPlanCanvas orgId="org_test" mode={mode} />);
      const table = await screen.findByRole('button', { name: 'T4 · 4 places' });
      const chairs = table.querySelectorAll<HTMLElement>('[data-floor-seat]');
      expect(chairs).toHaveLength(4);
      for (const chair of chairs) {
        expect(chair).toHaveStyle({ width: '14px', height: '1px' });
      }
      expect(chairs[1].style.transform).toBe('rotate(90deg)');
    },
  );

  it('conserve la géométrie des tables, chaises et zones entre édition et service', async () => {
    const plan = {
      ...floorPlan,
      zones: [
        {
          id: 'zone-main',
          floorPlanId: floorPlan.id,
          sectionId: null,
          name: 'Salle',
          x: 32,
          y: 24,
          width: 520,
          height: 340,
          rotation: 0,
        },
      ],
    };
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/reservations')) return [];
      return plan;
    });

    const layouts = [];
    for (const mode of ['design', 'service'] as const) {
      const { container, unmount } = render(<FloorPlanCanvas orgId="org_test" mode={mode} />);
      const table = await screen.findByRole('button', { name: 'T4 · 4 places' });
      const zone = screen.getByRole('button', { name: 'Salle' });
      layouts.push({
        table: [table.style.left, table.style.top, table.style.width, table.style.height],
        chairs: [...table.querySelectorAll<HTMLElement>('[data-floor-seat]')].map((chair) =>
          [chair.style.left, chair.style.top, chair.style.width, chair.style.height].join(','),
        ),
        zone: [zone.style.left, zone.style.top, zone.style.width, zone.style.height],
      });
      expect(container.querySelectorAll('svg line[stroke-width="4"]')).toHaveLength(2);
      unmount();
    }

    expect(layouts[0]).toEqual(layouts[1]);
  });

  it('cadre les deux vues à la même échelle sur le même écran', async () => {
    mediaMocks.touch = true;
    const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(390);
    const height = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(420);
    const zoomLevels = [];
    try {
      for (const mode of ['design', 'service'] as const) {
        const { unmount } = render(<FloorPlanCanvas orgId="org_test" mode={mode} />);
        await screen.findByRole('button', { name: 'T4 · 4 places' });
        // L'édition n'affiche plus de pourcentage : on lit l'échelle appliquée au plan.
        const scale = [...document.querySelectorAll<HTMLElement>('[style*="scale("]')]
          .map((element) => /scale\(([\d.]+)\)/.exec(element.style.transform)?.[1])
          .find(Boolean);
        zoomLevels.push(Math.round(Number(scale) * 100));
        unmount();
      }
      expect(zoomLevels[0]).toBe(zoomLevels[1]);
    } finally {
      mediaMocks.touch = false;
      width.mockRestore();
      height.mockRestore();
    }
  });

  it('garde les chaises et la capacité des tables rapprochées', async () => {
    const first = { ...floorPlan.tables![0], shape: 'rect' as const };
    const second = { ...first, id: 'table-t5', name: 'T5', positionX: 90 };
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations') || path.includes('/waiting-list')) return [];
      return { ...floorPlan, tables: [first, second] };
    });
    render(<FloorPlanCanvas orgId="org_test" mode="service" />);
    for (const name of ['T4', 'T5']) {
      const table = await screen.findByRole('button', { name: `${name} · 4 places` });
      expect(table.querySelectorAll('[data-floor-seat]')).toHaveLength(4);
      expect(within(table).getByText('4 places')).toBeInTheDocument();
    }
  });

  it('annonce la combinaison et la détaille dans la fiche', async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations') || path.includes('/waiting-list')) return [];
      return {
        ...floorPlan,
        tableCombinations: [
          {
            id: 'combo',
            floorPlanId: floorPlan.id,
            name: null,
            members: [{ tableId: floorPlan.tables![0].id }],
          },
        ],
      };
    });
    render(<FloorPlanCanvas orgId="org_test" mode="service" />);
    const table = await screen.findByRole('button', { name: 'T4 · 4 places' });
    expect(table).toHaveAccessibleDescription(/Peut être combinée avec d’autres tables/);
    expect(within(table).queryByTitle('Tables combinables')).not.toBeInTheDocument();
    fireEvent.click(table);
    expect(screen.getAllByText('Peut être combinée avec d’autres tables').length).toBeGreaterThan(
      0,
    );
  });

  it('récupère le plan spécifique quand floorPlanId est fourni', async () => {
    render(<FloorPlanCanvas orgId="org_test" floorPlanId="fp-2" />);

    await waitFor(() => {
      expect(apiMocks.get).toHaveBeenCalledWith('restaurants/org_test/floor-plans/fp-2');
    });

    const table = await screen.findByRole('button', { name: 'T4 · 4 places' });
    expect(table).toBeInTheDocument();
  });
});

describe('FloorPlanCanvas — guides des murs', () => {
  beforeEach(() => {
    apiMocks.patch.mockReset();
    apiMocks.patch.mockImplementation(async (path: string, body: Record<string, unknown>) => {
      if (path.includes('/tables/')) {
        const table = floorPlan.tables?.[0];
        if (!table) throw new Error('Fixture table missing');
        return { ...table, ...body };
      }
      return { ...activeWall, ...body };
    });
  });

  it('affiche et applique le guide de même longueur pendant le resize d’un mur', async () => {
    const { container } = render(<FloorPlanCanvas orgId="org_test" />);

    await waitFor(() => {
      expect(container.querySelector('line[x1="300"][x2="456"]')).toBeInTheDocument();
    });

    fireEvent.click(container.querySelector('line[x1="300"][x2="456"]')!);

    const endHandle = await waitFor(() => {
      const handle = container.querySelector('circle[cx="456"][cy="280"]');
      expect(handle).toBeInTheDocument();
      return handle!;
    });

    fireEvent.pointerDown(endHandle, { clientX: 456, clientY: 280 });
    fireEvent.pointerMove(window, { clientX: 456, clientY: 280 });

    expect(await screen.findByText('Même longueur · 180 px')).toBeInTheDocument();
    expect(screen.queryByText('Aligné')).not.toBeInTheDocument();

    const snappedWall = container.querySelector('line[x1="300"][x2="480"]');
    expect(snappedWall).toBeInTheDocument();
  });

  it('annule et rétablit une mutation géométrique de mur', async () => {
    const { container } = render(<FloorPlanCanvas orgId="org_test" />);

    await waitFor(() => {
      expect(container.querySelector('line[x1="300"][x2="456"]')).toBeInTheDocument();
    });

    const undo = screen.getByRole('button', { name: 'Annuler' });
    const redo = screen.getByRole('button', { name: 'Rétablir' });
    expect(undo).toBeDisabled();
    expect(redo).toBeDisabled();

    fireEvent.click(container.querySelector('line[x1="300"][x2="456"]')!);
    const endHandle = await waitFor(() => {
      const handle = container.querySelector('circle[cx="456"][cy="280"]');
      expect(handle).toBeInTheDocument();
      return handle!;
    });

    fireEvent.pointerDown(endHandle, { clientX: 456, clientY: 280 });
    fireEvent.pointerMove(window, { clientX: 608, clientY: 280 });
    fireEvent.pointerUp(window);

    await waitFor(() => expect(undo).toBeEnabled());
    const movedWall = apiMocks.patch.mock.calls[
      apiMocks.patch.mock.calls.length - 1
    ][1] as FloorPlanWall;
    expect(movedWall.x2).not.toBe(456);

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => {
      const revertedWall = apiMocks.patch.mock.calls[
        apiMocks.patch.mock.calls.length - 1
      ][1] as FloorPlanWall;
      expect(revertedWall).toMatchObject({ x1: 300, y1: 280, x2: 456, y2: 280 });
    });

    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() => {
      const restoredWall = apiMocks.patch.mock.calls[
        apiMocks.patch.mock.calls.length - 1
      ][1] as FloorPlanWall;
      expect(restoredWall.x2).toBe(movedWall.x2);
    });
  });

  it('ignore une réponse de drag arrivée après undo', async () => {
    let resolveMove!: (wall: FloorPlanWall) => void;
    const delayedMove = new Promise<FloorPlanWall>((resolve) => {
      resolveMove = resolve;
    });
    apiMocks.patch
      .mockImplementationOnce(() => delayedMove)
      .mockImplementationOnce(async (_path: string, wall: Partial<FloorPlanWall>) => ({
        ...activeWall,
        ...wall,
      }));

    const { container } = render(<FloorPlanCanvas orgId="org_test" />);
    await waitFor(() => {
      expect(container.querySelector('line[x1="300"][x2="456"]')).toBeInTheDocument();
    });

    fireEvent.click(container.querySelector('line[x1="300"][x2="456"]')!);
    const endHandle = await waitFor(() => {
      const handle = container.querySelector('circle[cx="456"][cy="280"]');
      expect(handle).toBeInTheDocument();
      return handle!;
    });
    fireEvent.pointerDown(endHandle, { clientX: 456, clientY: 280 });
    fireEvent.pointerMove(window, { clientX: 608, clientY: 280 });
    fireEvent.pointerUp(window);

    await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledTimes(1));
    const movedWall = apiMocks.patch.mock.calls[0][1] as FloorPlanWall;

    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(() => {
      expect(container.querySelector('line[x1="300"][x2="456"]')).toBeInTheDocument();
    });
    expect(apiMocks.patch).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveMove(movedWall);
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledTimes(2));

    await waitFor(() => {
      expect(container.querySelector('line[x1="300"][x2="456"]')).toBeInTheDocument();
      expect(container.querySelector(`line[x1="300"][x2="${movedWall.x2}"]`)).toBeNull();
    });
  });

  it('annule une position de mur modifiée depuis l’inspecteur', async () => {
    const { container } = render(<FloorPlanCanvas orgId="org_test" />);
    await waitFor(() => {
      expect(container.querySelector('line[x1="300"][x2="456"]')).toBeInTheDocument();
    });

    fireEvent.click(container.querySelector('line[x1="300"][x2="456"]')!);
    const positionX = await screen.findByLabelText('Position X');
    fireEvent.change(positionX, { target: { value: '320' } });
    fireEvent.blur(positionX);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Annuler' })).toBeEnabled());
    fireEvent.keyDown(window, { key: 'z', metaKey: true });

    await waitFor(() => {
      const revertedWall = apiMocks.patch.mock.calls[
        apiMocks.patch.mock.calls.length - 1
      ][1] as FloorPlanWall;
      expect(revertedWall).toMatchObject({ x1: 300, x2: 456 });
    });
  });

  it('déplace une table sélectionnée avec les flèches et annule avec ⌘Z', async () => {
    const { container } = render(<FloorPlanCanvas orgId="org_test" />);
    await waitFor(() => {
      expect(container.querySelector('line[x1="300"][x2="456"]')).toBeInTheDocument();
    });

    const table = await screen.findByRole('button', { name: 'T4 · 4 places' });
    fireEvent.click(table);

    const undo = screen.getByRole('button', { name: 'Annuler' });
    expect(undo).toBeDisabled();

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(undo).toBeEnabled());

    const movedTable = apiMocks.patch.mock.calls[apiMocks.patch.mock.calls.length - 1][1] as {
      positionX: number;
      positionY: number;
    };
    expect(movedTable.positionX).toBe(65);
    expect(movedTable.positionY).toBe(64);

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => {
      const revertedTable = apiMocks.patch.mock.calls[apiMocks.patch.mock.calls.length - 1][1] as {
        positionX: number;
        positionY: number;
      };
      expect(revertedTable.positionX).toBe(64);
      expect(revertedTable.positionY).toBe(64);
    });

    fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true });
    await waitFor(() => {
      const shiftedTable = apiMocks.patch.mock.calls[apiMocks.patch.mock.calls.length - 1][1] as {
        positionX: number;
        positionY: number;
      };
      expect(shiftedTable.positionX).toBe(64);
      expect(shiftedTable.positionY).toBe(74);
    });
  });

  it('bloque un déplacement au clavier qui chevaucherait une autre table', async () => {
    const table = floorPlan.tables![0];
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/reservations')) return [];
      return {
        ...floorPlan,
        tables: [table, { ...table, id: 'table-next', name: 'T5', positionX: 128 }],
      };
    });

    render(<FloorPlanCanvas orgId="org_test" mode="design" />);
    fireEvent.click(await screen.findByRole('button', { name: 'T4 · 4 places' }));
    fireEvent.keyDown(window, { key: 'ArrowRight' });

    expect(apiMocks.patch).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Annuler' })).toBeDisabled();
  });

  it('annule une duplication avec ⌘Z en supprimant la copie', async () => {
    const table = floorPlan.tables![0];
    apiMocks.post.mockImplementation(async (_path: string, body: Record<string, unknown>) => ({
      ...table,
      ...body,
      id: 'table-copy',
    }));

    render(<FloorPlanCanvas orgId="org_test" mode="design" />);
    fireEvent.click(await screen.findByRole('button', { name: 'T4 · 4 places' }));
    fireEvent.keyDown(window, { key: 'd', metaKey: true });
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Annuler' })).not.toBeDisabled());

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() =>
      expect(apiMocks.del).toHaveBeenCalledWith(
        expect.stringContaining('restaurants/org_test/floor-plan/tables/table-copy'),
      ),
    );
  });

  it('ouvre la confirmation de suppression avec Delete sur une table sélectionnée', async () => {
    const { container } = render(<FloorPlanCanvas orgId="org_test" />);
    await waitFor(() => {
      expect(container.querySelector('line[x1="300"][x2="456"]')).toBeInTheDocument();
    });

    fireEvent.click(await screen.findByRole('button', { name: 'T4 · 4 places' }));
    fireEvent.keyDown(window, { key: 'Delete' });

    expect(await screen.findByRole('heading', { name: 'Supprimer T4' })).toBeInTheDocument();
  });

  it('supprime le mur sélectionné avec Backspace', async () => {
    const { container } = render(<FloorPlanCanvas orgId="org_test" />);
    await waitFor(() => {
      expect(container.querySelector('line[x1="300"][x2="456"]')).toBeInTheDocument();
    });

    fireEvent.click(container.querySelector('line[x1="300"][x2="456"]')!);
    await screen.findByLabelText('Type');
    fireEvent.keyDown(window, { key: 'Backspace' });

    await waitFor(() => {
      expect(apiMocks.del).toHaveBeenCalledWith(
        expect.stringContaining('restaurants/org_test/floor-plan/walls/wall-active'),
      );
    });
  });
});

describe('FloorPlanCanvas — édition du plan', () => {
  it('affiche le libellé personnalisé d’une table sur le canvas', async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/reservations')) return [];
      return {
        ...floorPlan,
        tables: [{ ...floorPlan.tables![0], name: 'Banquette 1' }],
      };
    });

    render(<FloorPlanCanvas orgId="org_test" mode="design" />);

    expect(
      await screen.findByRole('button', { name: 'Banquette 1 · 4 places' }),
    ).toBeInTheDocument();
  });

  it('dispose automatiquement les tables existantes au premier chargement', async () => {
    const unplacedTables = [
      {
        ...floorPlan.tables![0],
        id: 'table-unplaced-1',
        name: 'T1',
        positionX: null,
        positionY: null,
      },
      {
        ...floorPlan.tables![0],
        id: 'table-unplaced-2',
        name: 'T2',
        positionX: null,
        positionY: null,
      },
    ];
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/reservations')) return [];
      return { ...floorPlan, tables: unplacedTables, walls: [], sections: [] };
    });
    apiMocks.patch.mockImplementation(async (path: string, body: Record<string, unknown>) => {
      const tableId = path.split('/').pop();
      const table = unplacedTables.find((item) => item.id === tableId);
      if (!table) throw new Error('Fixture table missing');
      return { ...table, ...body };
    });

    render(<FloorPlanCanvas orgId="org_test" mode="design" />);

    expect(
      await screen.findByText('Disposition initiale appliquée.', { exact: false }),
    ).toBeInTheDocument();
    await waitFor(() => expect(apiMocks.patch).toHaveBeenCalledTimes(2));

    expect(screen.getByRole('button', { name: 'T1 · 4 places' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'T2 · 4 places' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Annuler' })).not.toBeDisabled();
    expect(screen.queryByText('Construisez votre plan')).not.toBeInTheDocument();
    expect(screen.queryByText('Tables à placer · 2')).not.toBeInTheDocument();
  });

  it('ne garde pas dans l’historique une pose de table dont l’enregistrement échoue', async () => {
    const placed = floorPlan.tables![0];
    const unplaced = {
      ...placed,
      id: 'table-unplaced-fail',
      name: 'T9',
      displayName: null,
      positionX: null,
      positionY: null,
    };
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/reservations')) return [];
      return { ...floorPlan, tables: [placed, unplaced], walls: [], sections: [] };
    });
    apiMocks.patch.mockRejectedValue(new Error('Serveur indisponible'));

    render(<FloorPlanCanvas orgId="org_test" mode="design" />);

    fireEvent.click(await screen.findByRole('button', { name: /T9, 4 places/ }));

    expect(await screen.findByText('Serveur indisponible')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Annuler' })).toBeDisabled();
  });

  it('affiche une table historique sans réglage de section dans l’éditeur', async () => {
    apiMocks.get.mockResolvedValue({
      ...floorPlan,
      tables: [],
      sections: [{ id: 'terrace', name: 'Terrasse', tables: [floorPlan.tables![0]] }],
    });
    render(<FloorPlanCanvas orgId="org_test" mode="design" />);
    fireEvent.click(await screen.findByRole('button', { name: 'T4 · 4 places' }));
    expect(screen.queryByRole('combobox', { name: 'Section' })).not.toBeInTheDocument();
    expect(screen.queryByText('Terrasse')).not.toBeInTheDocument();
  });

  it('crée une table métier à placer depuis la palette', async () => {
    apiMocks.post.mockImplementation(async (path: string, body: Record<string, unknown>) => {
      if (path.includes('/floor-plan/tables')) {
        return {
          id: 'table-created',
          name: 'T1',
          capacity: 4,
          minCapacity: 1,
          isActive: true,
          positionX: body.positionX,
          positionY: body.positionY,
          width: null,
          height: null,
          rotation: 0,
          shape: 'round',
        };
      }
      throw new Error(`Unexpected POST ${path}`);
    });
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/reservations')) return [];
      return { ...floorPlan, tables: [], walls: [], sections: [] };
    });

    render(<FloorPlanCanvas orgId="org_test" mode="design" />);

    expect(await screen.findByText('Aucune table configurée')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une table' }));

    await waitFor(() => {
      expect(apiMocks.post).toHaveBeenCalledWith(
        'restaurants/org_test/floor-plan/tables',
        expect.objectContaining({
          shape: 'rect',
          capacity: 4,
          name: 'T1',
          positionX: null,
          positionY: null,
        }),
      );
    });

    expect(await screen.findByText('Table T1', { selector: 'p' })).toBeInTheDocument();
    expect(await screen.findByText('Enregistré')).toBeInTheDocument();
    expect(apiMocks.post.mock.calls[0]?.[1]).toMatchObject({ id: expect.any(String) });
    expect(screen.getByText('Tables à placer · 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Table ronde/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nouvelle table' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('place une table dans la zone sans l’associer à une section et vérifie la rangée avant de la créer', async () => {
    const section = { id: 'terrace', name: 'Terrasse', position: 0, tables: [] };
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/reservations')) return [];
      return {
        ...floorPlan,
        width: 1200,
        walls: [],
        tables: [],
        sections: [section],
        zones: [
          {
            id: 'terrace-zone',
            name: 'Terrasse',
            x: 0,
            y: 0,
            width: 1200,
            height: 360,
            rotation: 0,
            sectionId: section.id,
          },
        ],
      };
    });
    apiMocks.post.mockImplementation(async (_path: string, body: Record<string, unknown>) => ({
      ...body,
      isActive: true,
    }));

    render(<FloorPlanCanvas orgId="org_test" mode="design" />);
    const zone = await screen.findByRole('button', { name: 'Terrasse' });
    fireEvent.click(zone);
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une table ici' }));
    expect(screen.getByText('Choisissez l’emplacement dans la zone.')).toBeInTheDocument();
    expect(apiMocks.post).not.toHaveBeenCalled();
    fireEvent.keyDown(zone, { key: 'Enter' });
    await screen.findByRole('button', { name: 'T1 · 4 places' });
    expect(apiMocks.post.mock.calls[0][1]).toMatchObject({
      sectionId: null,
      positionX: 528,
      positionY: 128,
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Dupliquer en rangée' })[0]);
    const dialog = screen.getByRole('dialog', { name: 'Dupliquer en rangée' });
    const count = within(dialog).getByLabelText('Nombre total de tables');
    const confirm = within(dialog).getByRole('button', { name: 'Dupliquer' });
    fireEvent.change(count, { target: { value: '8' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(count, { target: { value: '3' } });
    expect(within(dialog).getByRole('img', { name: '3 tables, dont T1' })).toBeInTheDocument();
    expect(apiMocks.post).toHaveBeenCalledTimes(1);
    fireEvent.click(confirm);
    await screen.findByRole('button', { name: 'T3 · 4 places' });
    expect(apiMocks.post.mock.calls.slice(1).map(([, body]) => body)).toMatchObject([
      { name: 'T2', sectionId: null, positionX: 704, positionY: 128 },
      { name: 'T3', sectionId: null, positionX: 880, positionY: 128 },
    ]);
  });

  it('garde l’échec visible et rejoue la création avec le même identifiant', async () => {
    const created = {
      id: 'table-created',
      name: 'T1',
      capacity: 4,
      minCapacity: 1,
      isActive: true,
      positionX: null,
      positionY: null,
      width: null,
      height: null,
      rotation: 0,
      shape: 'rect' as const,
    };
    let serverPlan: FloorPlan = { ...floorPlan, tables: [], walls: [], sections: [] };
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/reservations')) return [];
      return serverPlan;
    });
    apiMocks.post
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async (_path: string, body: Record<string, unknown>) => {
        serverPlan = { ...serverPlan, tables: [created] };
        return { ...created, positionX: body.positionX, positionY: body.positionY };
      });

    render(<FloorPlanCanvas orgId="org_test" mode="design" />);

    expect(await screen.findByText('Aucune table configurée')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une table' }));
    const retryButton = await screen.findByRole('button', { name: 'Échec · Réessayer' });
    const firstRequest = apiMocks.post.mock.calls[0][1] as Record<string, unknown>;

    fireEvent.click(retryButton);

    expect(await screen.findByText('Enregistré')).toBeInTheDocument();
    expect(screen.queryByText('Impossible de créer la table')).not.toBeInTheDocument();
    expect(apiMocks.post).toHaveBeenCalledTimes(2);
    expect((apiMocks.post.mock.calls[1][1] as Record<string, unknown>).id).toBe(firstRequest.id);
    await waitFor(() =>
      expect(
        apiMocks.get.mock.calls.filter(([path]) => path === 'restaurants/org_test/floor-plan'),
      ).toHaveLength(2),
    );
    expect(await screen.findByRole('button', { name: /T1, 4 places/ })).toBeInTheDocument();
  });

  it('garde un inspecteur discret quand rien n’est sélectionné', async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/reservations')) return [];
      return { ...floorPlan, tables: [], walls: [], sections: [] };
    });

    render(<FloorPlanCanvas orgId="org_test" mode="design" />);

    expect(await screen.findByText('Aucune table configurée')).toBeInTheDocument();
    expect(
      screen.queryByText('Sélectionnez un élément pour modifier ses propriétés.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nouvelle table' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Table' })).not.toBeInTheDocument();
  });

  it('garde les outils du plan dans un bandeau sans bouton de sauvegarde manuel', async () => {
    render(<FloorPlanCanvas orgId="org_test" mode="design" />);

    expect(await screen.findByRole('toolbar', { name: /Historique/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Enregistrer/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Enregistré')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Plan test/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Réglages de la salle' }));
    expect(
      await screen.findByRole('heading', { name: 'Paramètres de la salle' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('button', { name: /Enregistrer/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ajouter une salle' })).not.toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: /Historique/ })).toBeInTheDocument();
  });
});

describe("FloorPlanCanvas — liste d'attente Live service", () => {
  it('actualise la géométrie du plan en service toutes les 10 secondes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let serverPlan = floorPlan;
    let planReads = 0;
    let unmount: (() => void) | undefined;
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations')) return [];
      if (path.includes('/waiting-list')) return [];
      if (path.includes('/floor-plan')) {
        planReads += 1;
        return serverPlan;
      }
      return floorPlan;
    });

    try {
      ({ unmount } = render(<FloorPlanCanvas orgId="org_test" mode="service" />));
      expect(await screen.findByRole('button', { name: 'T4 · 4 places' })).toBeInTheDocument();
      await waitFor(() => expect(planReads).toBeGreaterThanOrEqual(2));

      serverPlan = {
        ...floorPlan,
        tables: [{ ...floorPlan.tables![0], name: 'T8' }],
      };
      act(() => vi.advanceTimersByTime(10_000));

      expect(await screen.findByRole('button', { name: 'T8 · 4 places' })).toBeInTheDocument();
    } finally {
      unmount?.();
      vi.useRealTimers();
    }
  });

  it('charge les entrées PENDING, les affiche dans Live service et les promeut', async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations')) return [];
      if (path.includes('/waiting-list')) return [waitingListEntry];
      return floorPlan;
    });
    apiMocks.post.mockResolvedValue({ id: 'reservation-from-waiting-list' });

    render(<FloorPlanCanvas orgId="org_test" mode="service" />);

    fireEvent.click(await screen.findByRole('button', { name: /Liste d'attente/ }));

    expect(await screen.findByText('Alice Martin')).toBeInTheDocument();
    expect(screen.getByText('Terrasse')).toBeInTheDocument();
    expect(screen.getByText('4 couverts')).toBeInTheDocument();
    expect(apiMocks.get).toHaveBeenCalledWith(
      expect.stringMatching(/restaurants\/org_test\/waiting-list\?date=.*&status=PENDING/),
      expect.any(Object),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Proposer une table' }));

    await waitFor(() => {
      expect(apiMocks.post).toHaveBeenCalledWith(
        'restaurants/org_test/waiting-list/waiting-list-1/promote',
      );
    });
  });

  it('affiche le refus de promotion dans la carte concernée', () => {
    render(
      <WaitingListPanel
        entries={[waitingListEntry]}
        isLoading={false}
        promotingEntryId={null}
        entryErrors={{ 'waiting-list-1': 'Aucune table compatible' }}
        onPromote={vi.fn()}
      />,
    );

    expect(screen.getByText('Aucune table compatible')).toBeInTheDocument();
  });
});

describe('FloorPlanCanvas — actions Live service', () => {
  it('attend le retour au premier plan avant de charger et actualiser le service', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations') || path.includes('/waiting-list')) return [];
      return floorPlan;
    });
    try {
      render(<FloorPlanCanvas orgId="org_test" mode="service" />);
      await screen.findByRole('button', { name: 'T4 · 4 places' });
      expect(
        apiMocks.get.mock.calls.some(([path]) => path.includes('/floor-plan/reservations')),
      ).toBe(false);
      hidden.mockReturnValue(false);
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      await waitFor(() =>
        expect(
          apiMocks.get.mock.calls.some(([path]) => path.includes('/floor-plan/reservations')),
        ).toBe(true),
      );
    } finally {
      hidden.mockRestore();
    }
  });
  function makeReservation(state: 'CONFIRMED' | 'SEATED'): PlanningReservation {
    const now = Date.now();
    return {
      id: `reservation-${state.toLowerCase()}`,
      tableId: 'table-t4-minimum-round',
      tableName: 'T4',
      sectionName: null,
      startsAt: new Date(now - 10 * 60_000).toISOString(),
      endsAt: new Date(now + 80 * 60_000).toISOString(),
      partySize: 4,
      customerName: 'Martin Dupont',
      state,
      seatedAt: state === 'SEATED' ? new Date(now - 10 * 60_000).toISOString() : null,
    };
  }

  it('laisse le service Essential utilisable sans charger ni ouvrir les plans avancés', async () => {
    accessMocks.allowed = false;
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations')) return [makeReservation('CONFIRMED')];
      if (path.includes('/waiting-list')) return [];
      return floorPlan;
    });
    render(<FloorPlanCanvas orgId="org_test" mode="service" />);
    fireEvent.click(await screen.findByRole('button', { name: /Martin Dupont/ }));
    expect(await screen.findByRole('button', { name: 'Installer à table' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Analyser l’impact' })).not.toBeInTheDocument();
    expect(
      apiMocks.get.mock.calls.some(([path]) => String(path).includes('delay-recoveries')),
    ).toBe(false);
    expect(
      apiMocks.get.mock.calls.some(([path]) => String(path).includes('/service-copilot/pulse')),
    ).toBe(true);
  });

  it('place les onglets du service en tête sans bandeau de pouls', async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations')) return [];
      if (path.includes('/waiting-list')) return [];
      if (path.includes('/service-copilot/pulse')) {
        return {
          date: '2026-07-22',
          generatedAt: '2026-07-22T17:30:00.000Z',
          isLiveDate: true,
          status: 'urgent',
          headline: '1 arrivée en retard à traiter',
          lateArrivals: 1,
          arrivalsToSeat: 2,
          arrivalsNext30Minutes: 3,
          seatedTables: 4,
          pendingWaitingList: 1,
          confirmedReservations: 9,
        };
      }
      return floorPlan;
    });

    render(<FloorPlanCanvas orgId="org_test" mode="service" />);

    const tablist = await screen.findByRole('region', { name: 'État du service' });
    expect(tablist).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Pouls du service' })).not.toBeInTheDocument();
    // La vue service doit utiliser la même surface que les autres rubriques
    // (arrondis + bordure + fond carte) et non l'ancien rendu à plat.
    expect(tablist.closest('.suppernote-card')).not.toBeNull();
  });

  it('ouvre la simulation depuis la barre sans lancer de placement', async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations') || path.includes('/waiting-list')) return [];
      return floorPlan;
    });

    render(<FloorPlanCanvas orgId="org_test" mode="service" floorPlanId={floorPlan.id} />);
    const bar = await screen.findByRole('region', { name: 'État du service' });
    expect(screen.queryByLabelText('Couverts')).not.toBeInTheDocument();
    fireEvent.click(within(bar).getByRole('button', { name: 'Simuler' }));
    const dialog = await screen.findByRole('dialog', { name: 'Simuler un placement' });
    expect(within(dialog).getByLabelText('Couverts')).toBeInTheDocument();
    expect(apiMocks.post).not.toHaveBeenCalled();
  });

  it('ouvre la liste d’attente depuis la barre et revient au plan', async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations') || path.includes('/waiting-list')) return [];
      return floorPlan;
    });

    render(<FloorPlanCanvas orgId="org_test" mode="service" />);
    const bar = await screen.findByRole('region', { name: 'État du service' });
    const button = within(bar).getByRole('button', { name: "Liste d'attente" });
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(bar).getByRole('button', { name: 'Retour au plan' }));
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(await screen.findByRole('button', { name: 'T4 · 4 places' })).toBeInTheDocument();
  });

  it('affiche la volumétrie du service et le taux d’occupation', async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations')) return [makeReservation('SEATED')];
      if (path.includes('/waiting-list')) return [];
      if (path.includes('/service-copilot/pulse')) {
        return {
          date: '2026-09-18',
          generatedAt: '2026-09-18T17:30:00.000Z',
          isLiveDate: true,
          status: 'calm',
          headline: 'Service sous contrôle',
          lateArrivals: 0,
          arrivalsToSeat: 0,
          arrivalsNext30Minutes: 0,
          seatedTables: 1,
          pendingWaitingList: 0,
          confirmedReservations: 1,
        };
      }
      return floorPlan;
    });

    render(<FloorPlanCanvas orgId="org_test" mode="service" />);

    const occupiedTable = await screen.findByRole('button', { name: /Martin Dupont/ });
    fireEvent.click(occupiedTable.querySelector('[role="presentation"]')!);
    expect(screen.getByText('Martin Dupont')).toBeInTheDocument();
    expect(occupiedTable).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByText('Occupée').length).toBeGreaterThanOrEqual(1);
  });

  it('compte une seule fois une table présente dans sa section et dans le plan', async () => {
    const table = { ...floorPlan.tables![0], sectionId: 'section-1' };
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations') || path.includes('/waiting-list')) return [];
      return {
        ...floorPlan,
        sections: [{ id: 'section-1', name: 'Salle', position: 0, tables: [table] }],
        tables: [table],
      };
    });

    render(<FloorPlanCanvas orgId="org_test" mode="service" />);

    const tables = await screen.findAllByRole('button', { name: 'T4 · 4 places' });
    expect(tables).toHaveLength(1);
    expect(tables[0].querySelector('.rounded-full[data-floor-top]')).toHaveStyle({
      width: '72px',
      height: '72px',
    });
    expect(tables[0]).toHaveAccessibleDescription(/Disponible/);
    expect(within(tables[0]).queryByText('Disponible')).not.toBeInTheDocument();
  });

  it('signale une date passée et permet de revenir au jour courant', async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations')) return [];
      if (path.includes('/waiting-list')) return [];
      if (path.includes('/service-copilot/pulse')) {
        return {
          date: '2026-09-18',
          generatedAt: '2026-09-18T17:30:00.000Z',
          isLiveDate: false,
          status: 'calm',
          headline: 'Service sous contrôle',
          lateArrivals: 0,
          arrivalsToSeat: 0,
          arrivalsNext30Minutes: 0,
          seatedTables: 0,
          pendingWaitingList: 0,
          confirmedReservations: 0,
        };
      }
      return floorPlan;
    });

    render(<FloorPlanCanvas orgId="org_test" mode="service" />);

    const dateInput = await screen.findByLabelText('Date du service');
    fireEvent.change(dateInput, { target: { value: '2026-01-05' } });

    expect(await screen.findByText('Archive')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Aujourd’hui' }));

    expect(await screen.findByText(/1 table libre · 4 places/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aujourd’hui' })).not.toBeInTheDocument();
  });

  it('regroupe date, fraîcheur et compteurs et propose le recadrage en service', async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations') || path.includes('/waiting-list')) return [];
      return floorPlan;
    });
    const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(500);
    const height = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(400);
    const scrollTo = vi.fn();
    const previous = Element.prototype.scrollTo;
    Element.prototype.scrollTo = scrollTo;
    try {
      render(<FloorPlanCanvas orgId="org_test" mode="service" />);
      const bar = await screen.findByRole('region', { name: 'État du service' });
      expect(within(bar).getByText('Aujourd’hui')).toBeInTheDocument();
      expect(await within(bar).findByText(/1 table libre · 4 places/)).toBeInTheDocument();
      expect(within(bar).queryByText(/Actualisé il y a/)).not.toBeInTheDocument();
      expect(within(bar).queryByRole('group', { name: 'Zoom du plan' })).not.toBeInTheDocument();
      const zoom = screen.getByRole('group', { name: 'Zoom du plan' });
      fireEvent.click(within(zoom).getByRole('button', { name: 'Ajuster le plan' }));
      await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    } finally {
      width.mockRestore();
      height.mockRestore();
      Element.prototype.scrollTo = previous;
    }
  });

  it('priorise une table encore occupée et propose une alternative pour la bonne arrivée', async () => {
    const seated = makeReservation('SEATED');
    const arriving = {
      ...makeReservation('CONFIRMED'),
      startsAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    const unassigned = {
      ...arriving,
      id: 'unassigned',
      tableId: null,
      startsAt: new Date(Date.now() + 2 * 60_000).toISOString(),
    };
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.endsWith('/suggest-table')) {
        return { suggestions: [{ tableId: 'alternative', name: 'T5', capacity: 4 }] };
      }
      if (path.includes('/floor-plan/reservations')) return [unassigned, seated, arriving];
      if (path.includes('/waiting-list')) return [];
      return floorPlan;
    });

    render(<FloorPlanCanvas orgId="org_test" mode="service" />);

    expect(await screen.findByText(/T4 encore occupée/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attribuer une table' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Voir les alternatives' }));
    expect(await screen.findByRole('button', { name: 'T5 · 4 places' })).toBeInTheDocument();
    expect(apiMocks.get).toHaveBeenCalledWith(
      'restaurants/org_test/floor-plan/reservations/reservation-confirmed/suggest-table',
    );
  });

  it('montre la salle entière quand elle reste lisible', async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations') || path.includes('/waiting-list')) return [];
      return {
        ...floorPlan,
        zones: [{ id: 'zone', name: 'Salle', x: 0, y: 0, width: 650, height: 360, rotation: 0 }],
        tables: Array.from({ length: 4 }, (_, index) => ({
          ...floorPlan.tables![0],
          id: `table-${index}`,
          name: `T${index + 1}`,
          positionX: 30 + (index % 2) * 180,
          positionY: 30 + Math.floor(index / 2) * 140,
          width: 120,
          height: 70,
          shape: 'rect',
        })),
      };
    });
    const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    const height = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(500);
    try {
      render(<FloorPlanCanvas orgId="org_test" mode="service" />);
      const stage = await screen.findByTestId('floor-plan-live-stage');
      await waitFor(() => {
        expect(parseFloat(stage.style.width)).toBeLessThanOrEqual(1200);
        expect(parseFloat(stage.style.height)).toBeLessThanOrEqual(500.01);
        expect(parseInt(screen.getByLabelText('Niveau de zoom').textContent!)).toBeGreaterThan(100);
      });
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });

  it('cadre les tables à l’ouverture et ajuste ensuite toute la zone', async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations') || path.includes('/waiting-list')) return [];
      return {
        ...floorPlan,
        width: 10000,
        zones: [
          {
            id: 'zone',
            floorPlanId: floorPlan.id,
            sectionId: null,
            name: 'Salle',
            x: 0,
            y: 0,
            width: 10000,
            height: 400,
            rotation: 0,
          },
        ],
      };
    });
    const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(500);
    const height = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(400);
    const previous = Element.prototype.scrollTo;
    const scrollTo = vi.fn();
    Element.prototype.scrollTo = scrollTo;
    try {
      render(<FloorPlanCanvas orgId="org_test" mode="service" />);
      const stage = await screen.findByTestId('floor-plan-live-stage');
      const zoom = screen.getByLabelText('Niveau de zoom');
      const focusedZoom = zoom.textContent;
      fireEvent.click(screen.getByRole('button', { name: 'Réduire le plan' }));
      expect(zoom.textContent).not.toBe(focusedZoom);
      const focusedWidth = parseFloat(stage.style.width);
      fireEvent.click(screen.getByRole('button', { name: 'Ajuster le plan' }));
      await waitFor(() => expect(parseFloat(stage.style.width)).toBeLessThan(focusedWidth));
      expect(parseFloat(stage.style.width)).toBeLessThanOrEqual(500);
      await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    } finally {
      width.mockRestore();
      height.mockRestore();
      Element.prototype.scrollTo = previous;
    }
  });

  it.each([
    [0, 150],
    [45, 110],
  ])('inclut les assises dans le cadrage initial, rotation %i°', async (rotation, maxZoom) => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations') || path.includes('/waiting-list')) return [];
      return { ...floorPlan, tables: [{ ...floorPlan.tables![0], rotation }] };
    });
    const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(200);
    const height = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(200);
    try {
      render(<FloorPlanCanvas orgId="org_test" mode="service" />);
      const zoom = await screen.findByLabelText('Niveau de zoom');
      await waitFor(() => expect(parseInt(zoom.textContent!)).toBeLessThanOrEqual(maxZoom));
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });

  it('tient compte de la hauteur réellement disponible à l’écran', async () => {
    const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(500);
    const height = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(250);
    try {
      render(<FloorPlanCanvas orgId="org_test" mode="service" />);
      const zoom = await screen.findByLabelText('Niveau de zoom');
      await waitFor(() => expect(parseInt(zoom.textContent!)).toBeLessThanOrEqual(180));
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });

  it('affiche la légende dans un menu et explique les tables attendues', async () => {
    render(<FloorPlanCanvas orgId="org_test" mode="service" />);
    const trigger = await screen.findByRole('button', { name: 'Légende des statuts' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(await screen.findByRole('menu')).toHaveTextContent('Arrivée imminente');
    expect(screen.getByRole('menu')).toHaveTextContent('Les réservations sans table affectée');
    for (const [label, color] of [
      ['Disponible', 'free'],
      ['Réservée', 'reserved'],
      ['Arrivée imminente', 'upcoming'],
      ['En retard', 'late'],
      ['Occupée', 'occupied'],
    ]) {
      expect(within(screen.getByRole('menu')).getByText(label).querySelector('span')).toHaveClass(
        `bg-floor-status-${color}`,
      );
    }
  });

  it.each([false, true])(
    'affiche l’heure imminente et annonce les états, mode compact %s',
    async (compact) => {
      mediaMocks.mobile = compact;
      mediaMocks.touch = compact;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
      try {
        const tables = Array.from({ length: 5 }, (_, index) => ({
          ...floorPlan.tables![0],
          id: `table-${index}`,
          name: `T${index + 1}`,
          positionX: 60 + index * 180,
        }));
        const reservations = [90, 15, -10, -10].map((offset, index) => ({
          ...makeReservation(index === 3 ? 'SEATED' : 'CONFIRMED'),
          id: `reservation-${index}`,
          tableId: tables[index].id,
          customerName: `Client ${index + 1}`,
          startsAt: new Date(Date.now() + offset * 60_000).toISOString(),
          endsAt: new Date(Date.now() + (offset + 120) * 60_000).toISOString(),
        }));
        apiMocks.get.mockImplementation(async (path: string) => {
          if (path.includes('/floor-plan/reservations')) return reservations;
          if (path.includes('/waiting-list')) return [];
          return { ...floorPlan, width: 1200, tables };
        });
        render(<FloorPlanCanvas orgId="org_test" mode="service" />);
        for (const [name, label] of [
          ['T1', compact ? 'Réservée' : format(new Date(reservations[0].startsAt), 'HH:mm')],
          ['T2', format(new Date(reservations[1].startsAt), 'HH:mm')],
          ['T3', compact ? 'Retard' : /^(Retard 10 min|\+10 min)$/],
          // Table ronde occupée : l'heure de fin de son créneau (10 min passées sur 120).
          ['T4', compact ? 'Occupée' : format(new Date(Date.now() + 110 * 60_000), 'HH:mm')],
        ]) {
          const table = (await screen.findByText(name)).closest('[role="button"]') as HTMLElement;
          expect(within(table).getByText(label)).toBeInTheDocument();
        }
        const arrivingTable = (await screen.findByText('T2')).closest('[role="button"]');
        expect(arrivingTable).toHaveAccessibleDescription(/Arrivée imminente/);
        const freeTable = (await screen.findByText('T5')).closest('[role="button"]')!;
        expect(freeTable).toHaveAccessibleDescription(/Disponible/);
        expect(
          within(freeTable as HTMLElement).queryByText(/Disponible|Libre/),
        ).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('propose une sortie claire quand le plan Live ne contient aucune table', async () => {
    const onRequestEdit = vi.fn();
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations')) return [];
      if (path.includes('/waiting-list')) return [];
      return { ...floorPlan, tables: [], walls: [], sections: [] };
    });

    render(<FloorPlanCanvas orgId="org_test" mode="service" onRequestEdit={onRequestEdit} />);

    expect(await screen.findByText('Aucune table dans ce plan')).toBeInTheDocument();
    expect(
      screen.getByText('Ajoutez vos tables depuis Plan visuel pour suivre le service ici.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Cliquez sur un élément de la palette, ou glissez-le ici.'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        'Sélectionnez une table pour afficher la réservation et le temps d’occupation.',
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Filtrer par serveur' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Configurer la salle' }));
    expect(onRequestEdit).toHaveBeenCalledOnce();
  });

  it.each([null, 'Léa'])(
    'masque le filtre quand toutes les tables ont la même affectation (%s)',
    async (assignedServer) => {
      apiMocks.get.mockImplementation(async (path: string) => {
        if (path.includes('/floor-plan/reservations') || path.includes('/waiting-list')) return [];
        const table = { ...floorPlan.tables![0], assignedServer };
        return {
          ...floorPlan,
          tables: [table, { ...table, id: 'table-t2', name: 'T2', positionX: 180 }],
        };
      });

      render(<FloorPlanCanvas orgId="org_test" mode="service" />);

      await screen.findByRole('button', { name: 'T2 · 4 places' });
      expect(
        screen.queryByRole('combobox', { name: 'Filtrer par serveur' }),
      ).not.toBeInTheDocument();
    },
  );

  it('propose les affectations serveur sans afficher les options vides', async () => {
    const assignedPlan: FloorPlan = {
      ...floorPlan,
      tables: [
        { ...floorPlan.tables![0], assignedServer: 'Léa' },
        {
          ...floorPlan.tables![0],
          id: 'table-t2',
          name: 'T2',
          positionX: 180,
          assignedServer: null,
        },
      ],
    };
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations')) return [];
      if (path.includes('/waiting-list')) return [];
      if (path.includes('/service-copilot/delay-recoveries')) return { recoveries: [] };
      if (path.includes('/service-copilot/pulse')) {
        return {
          date: '2026-09-18',
          generatedAt: '2026-09-18T17:30:00.000Z',
          isLiveDate: true,
          status: 'calm',
          headline: 'Service sous contrôle',
          lateArrivals: 0,
          arrivalsToSeat: 0,
          arrivalsNext30Minutes: 0,
          seatedTables: 0,
          pendingWaitingList: 0,
          confirmedReservations: 0,
        };
      }
      return assignedPlan;
    });

    render(<FloorPlanCanvas orgId="org_test" mode="service" />);

    const filter = await screen.findByRole('combobox', { name: 'Filtrer par serveur' });
    const previousScrollIntoView = Element.prototype.scrollIntoView;
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    try {
      fireEvent.click(filter);

      expect(await screen.findAllByText('Toutes les tables (2)')).not.toHaveLength(0);
      expect(screen.getAllByText('Sans serveur affecté (1)')).not.toHaveLength(0);
      expect(screen.getAllByText('Léa (1 table)')).not.toHaveLength(0);
    } finally {
      if (previousScrollIntoView) {
        Object.defineProperty(Element.prototype, 'scrollIntoView', {
          configurable: true,
          value: previousScrollIntoView,
        });
      } else {
        Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
      }
    }
  });

  it('emploie des actions métier explicites pour installer et libérer une table', async () => {
    let reservations = [makeReservation('CONFIRMED')];
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations')) return reservations;
      if (path.includes('/waiting-list')) return [];
      return floorPlan;
    });

    const { unmount } = render(<FloorPlanCanvas orgId="org_test" mode="service" />);
    fireEvent.click(await screen.findByRole('button', { name: /Martin Dupont/ }));
    expect(await screen.findByRole('button', { name: 'Installer à table' })).toBeInTheDocument();
    unmount();

    reservations = [makeReservation('SEATED')];
    render(<FloorPlanCanvas orgId="org_test" mode="service" />);
    fireEvent.click(await screen.findByRole('button', { name: /Martin Dupont/ }));
    // Même libellé sur le panneau du bureau et sur la feuille du téléphone.
    expect(await screen.findAllByRole('button', { name: 'Libérer la table' })).not.toHaveLength(0);
  });

  it('libère une table occupée par appui long, sans envoi avant la fin du délai d’annulation', async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations')) return [makeReservation('SEATED')];
      if (path.includes('/waiting-list')) return [];
      return floorPlan;
    });

    const { unmount } = render(<FloorPlanCanvas orgId="org_test" mode="service" />);
    const table = await screen.findByRole('button', { name: /Martin Dupont/ });
    const handle = table.querySelector('[role="presentation"]');
    expect(handle).not.toBeNull();
    fireEvent.pointerDown(handle!, { button: 0, clientX: 10, clientY: 10 });

    // La table s'affiche libre tout de suite, mais rien n'est encore envoyé : « Annuler » reste possible.
    await waitFor(
      () => expect(screen.queryByRole('button', { name: /Martin Dupont/ })).not.toBeInTheDocument(),
      { timeout: 2000 },
    );
    expect(apiMocks.patch).not.toHaveBeenCalledWith(
      expect.stringContaining('/state'),
      expect.anything(),
    );

    // Quitter l'écran pendant le délai envoie la libération au lieu de la perdre.
    unmount();
    expect(apiMocks.patch).toHaveBeenCalledWith(
      'restaurants/org_test/floor-plan/reservations/reservation-seated/state',
      { state: 'HONORED' },
    );
  });

  it('conserve le résumé et la légende pendant la sélection et permet de fermer la fiche', async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations') || path.includes('/waiting-list')) return [];
      return floorPlan;
    });
    render(<FloorPlanCanvas orgId="org_test" mode="service" />);

    const table = await screen.findByRole('button', { name: 'T4 · 4 places' });
    fireEvent.click(table);
    const close = screen.getByRole('button', { name: 'Fermer la fiche de la table' });
    const bar = screen.getByRole('region', { name: 'État du service' });
    expect(within(bar).getByRole('button', { name: 'Légende des statuts' })).toBeInTheDocument();
    fireEvent.click(close);
    expect(table).toHaveAttribute('aria-pressed', 'false');
    expect(
      screen.queryByRole('button', { name: 'Fermer la fiche de la table' }),
    ).not.toBeInTheDocument();
  });

  it('réserve une colonne pour garder accessible une table à droite dans une salle remplie', async () => {
    const tables = Array.from({ length: 5 }, (_, index) => ({
      ...floorPlan.tables![0],
      id: `table-${index}`,
      name: `T${index + 1}`,
      positionX: 50 + index * 160,
    }));
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations') || path.includes('/waiting-list')) return [];
      return { ...floorPlan, width: 900, tables };
    });
    render(<FloorPlanCanvas orgId="org_test" mode="service" />);
    const table = await screen.findByRole('button', { name: 'T5 · 4 places' });
    fireEvent.click(table);
    const inspector = screen
      .getByRole('button', { name: 'Fermer la fiche de la table' })
      .closest('aside');
    expect(inspector).toHaveClass('w-72', 'shrink-0');
    expect(table).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'T1 · 4 places' })).toBeInTheDocument();
  });

  describe('placer un client sans réservation', () => {
    const openForm = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'T4 · 4 places' }));
      const [button] = await screen.findAllByRole('button', {
        name: 'Walk-in',
      });
      fireEvent.click(button);
      const [form] = await screen.findAllByRole('form', {
        name: 'Placer un client sans réservation',
      });
      return form;
    };

    beforeEach(() => {
      apiMocks.get.mockImplementation(async (path: string) => {
        if (path.includes('/floor-plan/reservations')) return [];
        if (path.includes('/waiting-list')) return [];
        return floorPlan;
      });
    });

    it('ouvre le placement walk-in directement depuis une table libre', async () => {
      render(<FloorPlanCanvas orgId="org_test" mode="service" />);
      fireEvent.click(await screen.findByRole('button', { name: 'T4 · 4 places' }));
      expect(screen.getAllByRole('button', { name: 'Walk-in' }).length).toBeGreaterThan(0);
      expect(apiMocks.post).not.toHaveBeenCalled();
    });

    it('envoie 2 personnes par défaut sur une table de 4, sous le nom « Sans réservation »', async () => {
      apiMocks.post.mockResolvedValue({ id: 'seated-1' });
      render(<FloorPlanCanvas orgId="org_test" mode="service" />);

      const form = await openForm();
      expect(within(form).getByLabelText('Nombre de personnes')).toHaveValue(2);
      fireEvent.click(within(form).getByRole('button', { name: 'Placer le client' }));

      await waitFor(() =>
        expect(apiMocks.post).toHaveBeenCalledWith(
          'restaurants/org_test/floor-plan/walk-ins',
          expect.objectContaining({
            tableId: 'table-t4-minimum-round',
            partySize: 2,
            customerName: 'Sans réservation',
            idempotencyKey: expect.any(String),
          }),
        ),
      );
      expect(document.body.textContent).not.toMatch(/⚡/);
    });

    it('envoie le nombre de personnes et le nom saisis', async () => {
      apiMocks.post.mockResolvedValue({ id: 'seated-2' });
      render(<FloorPlanCanvas orgId="org_test" mode="service" />);

      const form = await openForm();
      fireEvent.change(within(form).getByLabelText('Nombre de personnes'), {
        target: { value: '4' },
      });
      fireEvent.change(within(form).getByLabelText('Nom (facultatif)'), {
        target: { value: 'Famille Durand' },
      });
      fireEvent.click(within(form).getByRole('button', { name: 'Placer le client' }));

      await waitFor(() =>
        expect(apiMocks.post).toHaveBeenCalledWith(
          'restaurants/org_test/floor-plan/walk-ins',
          expect.objectContaining({ partySize: 4, customerName: 'Famille Durand' }),
        ),
      );
    });

    it('explique qu’une table déjà occupée ne peut pas être prise', async () => {
      apiMocks.post.mockRejectedValue(
        Object.assign(new Error('Table non disponible sur ce créneau'), { status: 409 }),
      );
      render(<FloorPlanCanvas orgId="org_test" mode="service" />);

      const form = await openForm();
      fireEvent.click(within(form).getByRole('button', { name: 'Placer le client' }));

      expect(await within(form).findByRole('alert')).toHaveTextContent(
        'Cette table n’est pas disponible : elle est déjà occupée ou réservée.',
      );
      expect(within(form).getByRole('button', { name: 'Placer le client' })).toBeEnabled();
    });
  });

  it('affiche le retard vocal et son plan directement au-dessus du canevas', async () => {
    const reservation = makeReservation('CONFIRMED');
    const onInitialDelayApplied = vi.fn();
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations')) return [reservation];
      if (path.includes('/waiting-list')) return [];
      return floorPlan;
    });
    apiMocks.post.mockImplementation(async (path: string) => {
      if (path.endsWith('/service-copilot/delay-impact/revert')) {
        return {
          delayedReservationId: reservation.id,
          promotedReservationId: 'promoted-1',
          waitingListEntryId: 'waiting-list-2',
          operationId: 'delay-report-1',
        };
      }
      if (path.endsWith('/service-copilot/delay-impact/apply')) {
        return {
          delayedReservationId: reservation.id,
          promotedReservationId: 'promoted-1',
          operationId: 'delay-report-1',
        };
      }
      if (path.includes('/service-copilot/delay-impact')) {
        return {
          feasible: true,
          summary: 'Un plan sûr est disponible.',
          delayMinutes: 25,
          delayedReservation: {
            id: reservation.id,
            customerName: reservation.customerName,
            originalTableName: 'T4',
            originalStartsAt: reservation.startsAt,
            proposedStartsAt: reservation.startsAt,
          },
          alternativeTable: {
            id: 'table-12',
            name: 'T12',
            capacity: 4,
            sectionId: null,
          },
          waitingListEntry: {
            id: 'waiting-list-2',
            customerName: 'Alice Martin',
            partySize: 4,
            requestedStartsAt: reservation.startsAt,
            proposedStartsAt: reservation.startsAt,
            proposedEndsAt: reservation.endsAt,
            isAvailableNow: true,
          },
          safeguards: [],
        };
      }
      return {};
    });

    render(
      <FloorPlanCanvas
        orgId="org_test"
        mode="service"
        initialDelayImpact={{
          reservationId: reservation.id,
          delayMinutes: 25,
          delayReportId: 'delay-report-1',
        }}
        onInitialDelayApplied={onInitialDelayApplied}
      />,
    );

    expect(await screen.findByText('Martin Dupont · 4 pers. · +25 min')).toBeInTheDocument();
    expect(screen.getByLabelText('Retard annoncé en minutes')).toBeDisabled();
    expect(screen.getByText('Durée confirmée pendant l’appel client.')).toBeInTheDocument();
    expect(await screen.findByText('Disponible maintenant')).toBeInTheDocument();
    expect(screen.getByText('Liste d’attente', { selector: 'span.truncate' })).toBeInTheDocument();
    expect(screen.getByText('Alice Martin n’avait pas encore de table.')).toBeInTheDocument();
    expect(screen.getByText('T12')).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Retard signalé par téléphone' })).getByRole(
        'button',
        { name: 'Vérifier et appliquer' },
      ),
    );

    expect(
      await screen.findByText(/Aucun message n’est envoyé automatiquement/),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Alice Martin est présent\(e\) et accepte la table proposée/),
    ).toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: 'Confirmer les changements' });
    expect(confirmButton).toBeDisabled();
    fireEvent.click(
      screen.getByLabelText(/Alice Martin est présent\(e\) et accepte la table proposée/),
    );
    fireEvent.click(confirmButton);

    await waitFor(() => expect(onInitialDelayApplied).toHaveBeenCalledTimes(1));
    expect(apiMocks.post).toHaveBeenCalledWith(
      'restaurants/org_test/service-copilot/delay-impact/apply',
      expect.objectContaining({
        reservationId: reservation.id,
        delayMinutes: 25,
        waitingListAcceptanceConfirmed: true,
        delayReportId: 'delay-report-1',
        idempotencyKey: expect.any(String),
      }),
    );
    expect(await screen.findByText('Communication requise')).toBeInTheDocument();
    expect(screen.getByText(/Alice Martin : liste d’attente → T4/)).toBeInTheDocument();
    expect(screen.getByText(/Aucun message n’a été envoyé automatiquement/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Annuler ce plan' }));
    expect(await screen.findByText('Annuler ce plan ?')).toBeInTheDocument();
    expect(
      screen.getByText(/Les communications déjà effectuées ne peuvent pas être annulées/),
    ).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Annuler ce plan' }),
    );

    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(
        'restaurants/org_test/service-copilot/delay-impact/revert',
        { reservationId: reservation.id, operationId: 'delay-report-1' },
      ),
    );
    expect(await screen.findByText('Plan initial restauré')).toBeInTheDocument();
    expect(screen.getByText(/Alice Martin retourne en liste d’attente/)).toBeInTheDocument();
  });

  it('retrouve un plan appliqué après actualisation et permet de l’annuler', async () => {
    const reservation = {
      ...makeReservation('CONFIRMED'),
      tableId: 'table-12',
      tableName: 'T12',
    };
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations')) return [reservation];
      if (path.includes('/waiting-list')) return [];
      if (path.includes('/service-copilot/delay-recoveries')) {
        return {
          recoveries: [
            {
              operationId: 'persisted-operation-1',
              delayedReservationId: reservation.id,
              promotedReservationId: 'promoted-1',
              waitingListEntryId: 'waiting-1',
              delayedCustomerName: 'Martin Dupont',
              waitingCustomerName: 'Alice Martin',
              originalTableName: 'T4',
              alternativeTableName: 'T12',
              delayMinutes: 25,
              originalStartsAt: reservation.startsAt,
              appliedStartsAt: reservation.startsAt,
              appliedAt: reservation.startsAt,
              status: 'applied',
              revertible: true,
            },
          ],
        };
      }
      return floorPlan;
    });
    apiMocks.post.mockResolvedValue({
      delayedReservationId: reservation.id,
      promotedReservationId: 'promoted-1',
      waitingListEntryId: 'waiting-1',
      operationId: 'persisted-operation-1',
    });

    render(<FloorPlanCanvas orgId="org_test" mode="service" />);

    const history = await screen.findByRole('region', {
      name: 'Historique des plans de retard',
    });
    expect(within(history).getByText('Plans de retard')).toBeInTheDocument();
    expect(within(history).getByText(/Martin Dupont : T4 → T12/)).toBeInTheDocument();
    fireEvent.click(within(history).getByRole('button', { name: 'Annuler' }));
    expect(await screen.findByText('Annuler ce plan ?')).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Annuler ce plan' }),
    );

    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(
        'restaurants/org_test/service-copilot/delay-impact/revert',
        { reservationId: reservation.id, operationId: 'persisted-operation-1' },
      ),
    );
    expect(await screen.findByText('Plan initial restauré')).toBeInTheDocument();
  });

  it('explique dans l’historique pourquoi une annulation est bloquée', async () => {
    const reservation = makeReservation('CONFIRMED');
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations')) return [reservation];
      if (path.includes('/waiting-list')) return [];
      if (path.includes('/service-copilot/delay-recoveries')) {
        return {
          recoveries: [
            {
              operationId: 'blocked-operation-1',
              delayedReservationId: reservation.id,
              promotedReservationId: 'promoted-1',
              waitingListEntryId: 'waiting-1',
              delayedCustomerName: 'Martin Dupont',
              waitingCustomerName: 'Alice Martin',
              originalTableName: 'T4',
              alternativeTableName: 'T12',
              delayMinutes: 25,
              originalStartsAt: reservation.startsAt,
              appliedStartsAt: reservation.startsAt,
              appliedAt: reservation.startsAt,
              status: 'blocked',
              revertible: false,
              blockedReason: 'Le groupe promu a déjà été modifié ou installé.',
            },
          ],
        };
      }
      return floorPlan;
    });

    render(<FloorPlanCanvas orgId="org_test" mode="service" />);

    const history = await screen.findByRole('region', {
      name: 'Historique des plans de retard',
    });
    expect(within(history).getByText('À vérifier')).toBeInTheDocument();
    expect(
      within(history).getByText('Le groupe promu a déjà été modifié ou installé.'),
    ).toBeInTheDocument();
    expect(within(history).queryByRole('button', { name: 'Annuler' })).not.toBeInTheDocument();
  });

  it('invalide immédiatement un plan si la durée du retard change', async () => {
    const reservation = makeReservation('CONFIRMED');
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations')) return [reservation];
      if (path.includes('/waiting-list')) return [];
      return floorPlan;
    });
    apiMocks.post.mockResolvedValue({
      feasible: true,
      summary: 'Plan calculé pour 25 minutes.',
      delayMinutes: 25,
      alternativeTable: { id: 'table-12', name: 'T12', capacity: 4, sectionId: null },
      waitingListEntry: {
        id: 'waiting-list-2',
        customerName: 'Alice Martin',
        partySize: 4,
        requestedStartsAt: reservation.startsAt,
        proposedStartsAt: reservation.startsAt,
        proposedEndsAt: reservation.endsAt,
        isAvailableNow: true,
      },
      safeguards: [],
    });

    render(
      <FloorPlanCanvas
        orgId="org_test"
        mode="service"
        initialDelayImpact={{ reservationId: reservation.id, delayMinutes: 25 }}
      />,
    );

    expect(await screen.findByText('Plan calculé pour 25 minutes.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Retard annoncé en minutes'), {
      target: { value: '40' },
    });
    expect(screen.queryByText('Plan calculé pour 25 minutes.')).not.toBeInTheDocument();
    expect(screen.queryByText('Disponible maintenant')).not.toBeInTheDocument();
  });

  it('analyse un second retard reçu sans remonter le composant', async () => {
    const first = makeReservation('CONFIRMED');
    const second = {
      ...first,
      id: 'reservation-second',
      customerName: 'Deuxième Client',
    };
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations')) return [first, second];
      if (path.includes('/waiting-list')) return [];
      return floorPlan;
    });
    apiMocks.post.mockResolvedValue({
      feasible: false,
      summary: 'Aucun plan.',
      delayMinutes: 20,
      safeguards: [],
    });

    const { rerender } = render(
      <FloorPlanCanvas
        orgId="org_test"
        mode="service"
        initialDelayImpact={{ reservationId: first.id, delayMinutes: 20 }}
      />,
    );
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(
        'restaurants/org_test/service-copilot/delay-impact',
        { reservationId: first.id, delayMinutes: 20 },
      ),
    );

    rerender(
      <FloorPlanCanvas
        orgId="org_test"
        mode="service"
        initialDelayImpact={{ reservationId: second.id, delayMinutes: 30 }}
      />,
    );
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(
        'restaurants/org_test/service-copilot/delay-impact',
        { reservationId: second.id, delayMinutes: 30 },
      ),
    );
  });

  it('explique clairement quand la réservation signalée est absente de la date', async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.includes('/floor-plan/reservations')) return [];
      if (path.includes('/waiting-list')) return [];
      return floorPlan;
    });

    render(
      <FloorPlanCanvas
        orgId="org_test"
        mode="service"
        initialDelayImpact={{ reservationId: 'missing', delayMinutes: 20 }}
      />,
    );

    expect(
      await screen.findByText(/La réservation signalée n’est pas visible pour cette date/),
    ).toBeInTheDocument();
    expect(apiMocks.post).not.toHaveBeenCalled();
  });
});

describe('StatsPanel — alertes', () => {
  const liveDate = '2025-06-10';
  const allTables = floorPlan.tables as unknown as Parameters<typeof StatsPanel>[0]['allTables'];

  function renderStats(reservations: PlanningReservation[]) {
    return render(
      <StatsPanel
        reservations={reservations}
        allTables={allTables}
        tableStatuses={new Map() as Parameters<typeof StatsPanel>[0]['tableStatuses']}
        liveDate={liveDate}
      />,
    );
  }

  it('précise le nombre de réservations qui arrivent au début du créneau', () => {
    const reservation: PlanningReservation = {
      id: 'res-1',
      tableId: 'table-t4-minimum-round',
      tableName: 'T4',
      sectionName: null,
      startsAt: '2025-06-10T19:00:00',
      endsAt: '2025-06-10T20:00:00',
      partySize: 4,
      customerName: null,
      state: 'CONFIRMED',
      seatedAt: null,
    };
    renderStats([reservation, { ...reservation, id: 'res-2', partySize: 3 }]);

    expect(screen.getByText('2 arrivées à 19:00')).toBeInTheDocument();
    expect(screen.getAllByText('7 couverts')[0]).toHaveClass('whitespace-nowrap');
    expect(screen.queryByText('+2')).not.toBeInTheDocument();
  });

  it('affiche une alerte pour une réservation legacy sans tableId', () => {
    const reservations: PlanningReservation[] = [
      {
        id: 'res-legacy',
        tableId: null,
        tableName: null,
        sectionName: null,
        startsAt: '2025-06-10T18:00:00',
        endsAt: '2025-06-10T19:00:00',
        partySize: 4,
        customerName: 'Jean Dupont',
        state: 'CONFIRMED',
        seatedAt: null,
      },
    ];

    renderStats(reservations);

    expect(screen.getByText('1 réservation sans table')).toBeInTheDocument();
    expect(screen.getByText(/Jean Dupont/)).toBeInTheDocument();
  });

  it('affiche une alerte de surcapacité quand les couverts dépassent la capacité totale', () => {
    const reservations: PlanningReservation[] = [
      {
        id: 'res-big',
        tableId: 'table-t4-minimum-round',
        tableName: 'T4',
        sectionName: null,
        startsAt: '2025-06-10T19:00:00',
        endsAt: '2025-06-10T19:15:00',
        partySize: 6,
        customerName: 'Marie Martin',
        state: 'CONFIRMED',
        seatedAt: null,
      },
    ];

    renderStats(reservations);

    expect(screen.getByText('Surcapacité détectée')).toBeInTheDocument();
    expect(screen.getAllByText('19:00')).toHaveLength(2);
    expect(screen.getByText('6 / 4')).toBeInTheDocument();
  });

  it("ne déclenche pas l'alerte legacy sans tableId pour une réservation CANCELLED", () => {
    const reservations: PlanningReservation[] = [
      {
        id: 'res-cancelled',
        tableId: null,
        tableName: null,
        sectionName: null,
        startsAt: '2025-06-10T18:00:00',
        endsAt: '2025-06-10T19:00:00',
        partySize: 4,
        customerName: 'Alice Cancel',
        state: 'CANCELLED',
        seatedAt: null,
      },
    ];

    renderStats(reservations);

    expect(screen.queryByText(/réservation sans table/)).not.toBeInTheDocument();
    expect(screen.getByText('Aucune alerte.')).toBeInTheDocument();
  });

  it("ne déclenche pas l'alerte legacy sans tableId pour une réservation NO_SHOW", () => {
    const reservations: PlanningReservation[] = [
      {
        id: 'res-no-show',
        tableId: null,
        tableName: null,
        sectionName: null,
        startsAt: '2025-06-10T18:00:00',
        endsAt: '2025-06-10T19:00:00',
        partySize: 4,
        customerName: 'Bob NoShow',
        state: 'NO_SHOW',
        seatedAt: null,
      },
    ];

    renderStats(reservations);

    expect(screen.queryByText(/réservation sans table/)).not.toBeInTheDocument();
    expect(screen.getByText('Aucune alerte.')).toBeInTheDocument();
  });

  it('ne compte pas une réservation CANCELLED dans la surcapacité', () => {
    const reservations: PlanningReservation[] = [
      {
        id: 'res-cancelled-big',
        tableId: 'table-t4-minimum-round',
        tableName: 'T4',
        sectionName: null,
        startsAt: '2025-06-10T19:00:00',
        endsAt: '2025-06-10T19:15:00',
        partySize: 6,
        customerName: 'Marie Annulée',
        state: 'CANCELLED',
        seatedAt: null,
      },
    ];

    renderStats(reservations);

    expect(screen.queryByText('Surcapacité détectée')).not.toBeInTheDocument();
    expect(screen.getByText('Aucune alerte.')).toBeInTheDocument();
  });

  it('affiche le texte pluriel pour plusieurs réservations legacy sans tableId', () => {
    const reservations: PlanningReservation[] = [
      {
        id: 'res-legacy-1',
        tableId: null,
        tableName: null,
        sectionName: null,
        startsAt: '2025-06-10T18:00:00',
        endsAt: '2025-06-10T18:30:00',
        partySize: 1,
        customerName: 'Alice One',
        state: 'CONFIRMED',
        seatedAt: null,
      },
      {
        id: 'res-legacy-2',
        tableId: null,
        tableName: null,
        sectionName: null,
        startsAt: '2025-06-10T20:00:00',
        endsAt: '2025-06-10T20:30:00',
        partySize: 1,
        customerName: 'Bob Two',
        state: 'CONFIRMED',
        seatedAt: null,
      },
    ];

    renderStats(reservations);

    expect(screen.getByText('2 réservations sans table')).toBeInTheDocument();
    expect(screen.getByText(/Alice One/)).toBeInTheDocument();
    expect(screen.getByText(/Bob Two/)).toBeInTheDocument();
  });
});

describe('FloorPlanCanvas — cadrage tactile et gestes', () => {
  it('cadre le plan dans la fenêtre visible sans descendre sous le plancher tactile', () => {
    // Salle 1400 × 900 dans la fenêtre d'un iPhone 13 : le cadrage strict
    // donnerait 0,26, soit des tables plus petites que la cible tactile.
    expect(
      computeFitZoom({
        viewportWidth: 358,
        viewportHeight: 420,
        canvasWidth: 1400,
        canvasHeight: 900,
        minZoom: 0.3,
        floor: 0.45,
      }),
    ).toBeCloseTo(0.45, 5);

    // Un petit plan tient entièrement : le plancher ne le dégrade pas.
    expect(
      computeFitZoom({
        viewportWidth: 358,
        viewportHeight: 420,
        canvasWidth: 640,
        canvasHeight: 480,
        minZoom: 0.3,
        floor: 0.45,
      }),
    ).toBeCloseTo(358 / 640, 5);
  });

  it('borne le zoom et refuse un cadrage sur une fenêtre non mesurée', () => {
    expect(clampZoom(0.05, 0.3)).toBe(0.3);
    expect(clampZoom(4, 0.3)).toBe(2);
    expect(
      computeFitZoom({
        viewportWidth: 0,
        viewportHeight: 0,
        canvasWidth: 1400,
        canvasHeight: 900,
        minZoom: 0.3,
      }),
    ).toBe(0.3);
  });

  it('cadre les zones et les tables entières en Live', () => {
    expect(
      computeLiveContentBounds(
        [{ x: 100, y: 120, width: 500, height: 300, rotation: 0 }],
        [{ positionX: 180, positionY: 180, width: 64, height: 64, rotation: 0 }],
        1400,
        900,
      ),
    ).toEqual({ x: 76, y: 96, width: 548, height: 348 });
    expect(
      computeLiveContentBounds(
        [],
        [{ positionX: 0, positionY: 0, width: 64, height: 64 }],
        700,
        420,
      ),
    ).toEqual({ x: -24, y: -24, width: 112, height: 112 });
  });

  it('inclut les repères fixes de la salle dans le cadrage Live', () => {
    expect(computeLiveContentBounds([], [], 700, 420, [activeWall])).toEqual({
      x: 276,
      y: 256,
      width: 204,
      height: 48,
    });
  });

  it('centre la zone des tables dans la fenêtre', () => {
    expect(
      computeFocusScroll({
        viewportWidth: 358,
        viewportHeight: 420,
        region: { x: 400, y: 300, width: 400, height: 300 },
        zoom: 1,
      }),
    ).toEqual({ left: 421, top: 240 });

    // Zone déjà visible : le défilement reste borné à zéro.
    expect(
      computeFocusScroll({
        viewportWidth: 358,
        viewportHeight: 420,
        region: { x: 52, y: 152, width: 524, height: 324 },
        zoom: 0.45,
      }),
    ).toEqual({ left: 0, top: 0 });
  });

  it('garde le point touché immobile pendant un changement d’échelle', () => {
    const anchor = computeZoomAnchorScroll({
      scrollLeft: 100,
      scrollTop: 50,
      offsetX: 40,
      offsetY: 30,
      zoom: 1,
      nextZoom: 2,
    });

    // Le point du plan sous le doigt (140, 80 en coordonnées plan) reste
    // sous le doigt : (scroll + offset) / zoom est invariant.
    expect((anchor.left + 40) / 2).toBeCloseTo(140, 5);
    expect((anchor.top + 30) / 2).toBeCloseTo(80, 5);
  });

  describe('FloorPlanCanvas — vue service sur téléphone', () => {
    function calmPulse(overrides: Partial<Record<string, number>> = {}) {
      return {
        date: '2026-09-18',
        generatedAt: '2026-09-18T17:30:00.000Z',
        isLiveDate: true,
        status: 'calm' as const,
        headline: 'Service sous contrôle',
        lateArrivals: 0,
        arrivalsToSeat: 0,
        arrivalsNext30Minutes: 0,
        seatedTables: 0,
        pendingWaitingList: 0,
        confirmedReservations: 0,
        ...overrides,
      };
    }

    function mockServicePulse(pulse: ReturnType<typeof calmPulse>, reservations: unknown[]) {
      apiMocks.get.mockImplementation(async (path: string) => {
        if (path.includes('/floor-plan/reservations')) return reservations;
        if (path.includes('/waiting-list')) return [];
        if (path.includes('/service-copilot/delay-recoveries')) return { recoveries: [] };
        if (path.includes('/service-copilot/pulse')) return pulse;
        return floorPlan;
      });
    }

    it('réduit le cockpit à une ligne et cadre le plan quand le service est vide', async () => {
      mediaMocks.mobile = true;
      mediaMocks.touch = true;
      mediaMocks.coarse = true;
      mockServicePulse(calmPulse(), []);

      // Fenêtre utile d'un iPhone 13 dans le plan de salle.
      const widthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(358);
      const heightSpy = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(420);
      try {
        render(<FloorPlanCanvas orgId="org_test" mode="service" />);

        // La navigation remplace désormais le bandeau d'état compact.
        expect(await screen.findByRole('region', { name: 'État du service' })).toBeInTheDocument();
        expect(screen.queryByRole('status', { name: 'Pouls du service' })).not.toBeInTheDocument();
        // Ni volumétrie à zéro ni jauge ne mangent la hauteur utile du plan.
        expect(screen.queryByText(/couverts prévus/)).not.toBeInTheDocument();
        expect(
          screen.queryByRole('progressbar', { name: /Taux d’occupation/ }),
        ).not.toBeInTheDocument();

        // Le plan s'ouvre cadré sur la zone des tables, sans exposer de
        // contrôle de zoom au service : Live est une vue finalisée.
        expect(await screen.findByRole('button', { name: 'T4 · 4 places' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Zoom arrière' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Zoom avant' })).not.toBeInTheDocument();
        expect(parseFloat(screen.getByTestId('floor-plan-live-stage').style.width)).toBeGreaterThan(
          0,
        );

        // Le canvas recouvre l'espaceur qui fournit l'aire de défilement. S'il
        // n'est pas ancré en haut à gauche, sa position statique le place après
        // l'espaceur et crée précisément le grand vide vu au-dessus des tables.
        const table = screen.getByRole('button', { name: 'T4 · 4 places' });
        expect(table.closest('.origin-top-left')).toHaveClass('left-0', 'top-0');
      } finally {
        widthSpy.mockRestore();
        heightSpy.mockRestore();
      }
    });

    it('garde le cockpit complet dès qu’une action est en attente', async () => {
      mediaMocks.mobile = true;
      mediaMocks.touch = true;
      mockServicePulse(calmPulse({ pendingWaitingList: 2 }), []);

      render(<FloorPlanCanvas orgId="org_test" mode="service" />);

      expect(await screen.findByRole('region', { name: 'État du service' })).toBeInTheDocument();
      expect(
        screen.queryByText('Service en direct · Aucune réservation aujourd’hui'),
      ).not.toBeInTheDocument();
    });

    it('recadre chaque plan au premier affichage', async () => {
      mediaMocks.mobile = true;
      mediaMocks.touch = true;
      mediaMocks.coarse = true;
      let activePlan = floorPlan;
      apiMocks.get.mockImplementation(async (path: string) => {
        if (path.includes('/floor-plan/reservations')) return [];
        if (path.includes('/waiting-list')) return [];
        if (path.includes('/service-copilot/delay-recoveries')) return { recoveries: [] };
        if (path.includes('/service-copilot/pulse')) return calmPulse();
        return activePlan;
      });

      const widthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(358);
      const heightSpy = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(420);
      try {
        const { rerender } = render(<FloorPlanCanvas orgId="org_test" mode="service" />);

        expect(await screen.findByRole('button', { name: 'T4 · 4 places' })).toBeInTheDocument();
        const initialStageWidth = screen.getByTestId('floor-plan-live-stage').style.width;
        activePlan = { ...floorPlan, id: 'floor-plan-terrace', name: 'Terrasse' };
        rerender(
          <FloorPlanCanvas orgId="org_test" mode="service" floorPlanId="floor-plan-terrace" />,
        );

        expect(await screen.findByRole('button', { name: 'T4 · 4 places' })).toBeInTheDocument();
        await waitFor(() =>
          expect(screen.getByTestId('floor-plan-live-stage').style.width).toBe(initialStageWidth),
        );
      } finally {
        widthSpy.mockRestore();
        heightSpy.mockRestore();
      }
    });
  });

  it('centre le plan sans jamais produire de défilement négatif', () => {
    expect(
      computeCenterScroll({
        viewportWidth: 400,
        viewportHeight: 300,
        canvasWidth: 1400,
        canvasHeight: 900,
        zoom: 0.5,
      }),
    ).toEqual({ left: 150, top: 75 });
    expect(
      computeCenterScroll({
        viewportWidth: 800,
        viewportHeight: 600,
        canvasWidth: 700,
        canvasHeight: 420,
        zoom: 1,
      }),
    ).toEqual({ left: 0, top: 0 });
  });

  it('reconnaît un double-tap proche dans le temps et l’espace', () => {
    const first = { time: 1000, x: 40, y: 60 };
    expect(isDoubleTap(null, first)).toBe(false);
    expect(isDoubleTap(first, { time: 1200, x: 50, y: 66 })).toBe(true);
    expect(isDoubleTap(first, { time: 1500, x: 50, y: 66 })).toBe(false);
    expect(isDoubleTap(first, { time: 1200, x: 140, y: 66 })).toBe(false);
  });
});
