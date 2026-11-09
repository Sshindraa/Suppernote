'use client';

import { useServiceCopilotAccess } from '@/lib/use-service-copilot-access';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { useApi } from '@/lib/api';
import {
  getErrorMessage,
  type FloorPlan,
  type FloorPlanTable,
  type FloorPlanWall,
  type FloorPlanZone,
  type FloorPlanTableCombination,
  type PlanningReservation,
  type ServiceCopilotDelayImpact,
  type ServiceCopilotDelayRecoveryHistoryItem,
  type ServiceCopilotDelayRecoveryHistoryResponse,
  type ServiceCopilotPulse,
  type ServiceCommunicationDraft,
  type ServiceCommunicationDraftsResponse,
  type TableShape,
  type WaitingListEntry,
  type WallType,
} from '@/types/api';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { getTableStatus, type TableStatus } from './table-status';
import { format, parseISO, differenceInMinutes, formatDistanceToNow, addDays } from 'date-fns';
import { fr } from 'date-fns/locale';
import {
  AlertCircle,
  ZoomIn,
  ZoomOut,
  LocateFixed,
  Grid2x2,
  Magnet,
  Settings2,
  Maximize2,
  Move,
  Copy,
  Lock,
  Unlock,
  Clock3,
  CalendarDays,
  AlertTriangle,
  CircleCheck,
  CircleHelp,
  UserRound,
  UserX,
  Users,
  Armchair,
  ListOrdered,
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  Circle,
  Square,
  Minus,
  DoorOpen,
  Wine,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyEnd,
  RotateCw,
  Undo2,
  Redo2,
  Grip,
  Phone,
  X,
  ArrowRight,
  type LucideIcon,
} from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataFetchError } from '@/components/DataFetchError';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DragMoveEvent,
  DragOverlay,
  useDraggable,
  useDroppable,
} from '@dnd-kit/core';
import { useUndoHistory } from './useUndoHistory';
import { PlanWriteQueue, type PlanWriteStatus } from './plan-write-queue';
import { ServiceCopilotSimulator } from './ServiceCopilotSimulator';
import { WALK_IN_DEFAULT_NAME, WalkInPlacement, walkInErrorMessage } from './WalkInPlacement';
import { useIsMobile, useMediaQuery } from '@/lib/useMediaQuery';
import { ServiceCardBadges, useServiceCards } from '@/components/reservation/service-card-badges';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const DEFAULT_CANVAS_WIDTH = 1400;
const DEFAULT_CANVAS_HEIGHT = 900;

const GRID_SIZE = 16;
// L’échelle physique reste un détail d’implémentation : 100 px représentent
// 1 mètre dans le plan. Les dimensions affichées aux restaurateurs sont donc
// toujours en mètres, tandis que l’API conserve ses coordonnées en pixels.
const CANVAS_PIXELS_PER_METER = 100;
const MIN_ROOM_DIMENSION_METERS = 2;
const MAX_ROOM_DIMENSION_METERS = 100;
const MIN_ZOOM = 0.5;
// Sur téléphone et tablette, 50 % ne suffisent pas à cadrer une salle de 14 m :
// l'échelle minimale descend plus bas et le plan s'ouvre ajusté à sa fenêtre.
const MIN_ZOOM_TOUCH = 0.3;
// Plancher du cadrage automatique : en dessous, une table devient plus petite
// que la cible tactile de 44 px et le plan n'est plus manipulable au doigt.
const TOUCH_FIT_FLOOR = 0.45;
const MAX_ZOOM = 2.0;
const ZOOM_STEP = 0.1;

function getPlanWriteKey(path: string): string | null {
  const parts = path.split('?')[0].split('/');
  const planIndex = parts.findIndex((part) => part === 'floor-plan' || part === 'floor-plans');
  if (planIndex < 0) return null;
  if (parts[planIndex] === 'floor-plans') {
    return parts[planIndex + 1] ? `plan:${parts[planIndex + 1]}` : 'plan:default';
  }

  const collection = parts[planIndex + 1];
  if (!collection) return 'plan:default';
  if (!['tables', 'walls', 'zones', 'sections', 'table-combinations'].includes(collection)) {
    return null;
  }
  return `${collection}:${parts[planIndex + 2] ?? 'collection'}`;
}

function withPlanCreateId(path: string, body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const parts = path.split('?')[0].split('/');
  const planIndex = parts.findIndex((part) => part === 'floor-plan');
  const collection = parts[planIndex + 1];
  if (planIndex < 0 || parts[planIndex + 2] || !['tables', 'walls', 'zones'].includes(collection)) {
    return body;
  }
  const payload = body as Record<string, unknown>;
  return { ...payload, id: payload.id ?? crypto.randomUUID() };
}

function planEntityExists(plan: FloorPlan, path: string): boolean | null {
  const parts = path.split('?')[0].split('/');
  const planIndex = parts.findIndex((part) => part === 'floor-plan' || part === 'floor-plans');
  const collection = parts[planIndex + 1];
  const id = parts[planIndex + 2];
  if (!id) return null;

  switch (collection) {
    case 'tables':
      return [...(plan.tables ?? []), ...plan.sections.flatMap((section) => section.tables)].some(
        (table) => table.id === id,
      );
    case 'walls':
      return (plan.walls ?? []).some((wall) => wall.id === id);
    case 'zones':
      return (plan.zones ?? []).some((zone) => zone.id === id);
    case 'sections':
      return plan.sections.some((section) => section.id === id);
    case 'table-combinations':
      return (plan.tableCombinations ?? []).some((combination) => combination.id === id);
    default:
      return null;
  }
}

/** Borne une échelle de zoom entre la limite du support et le maximum produit. */
export function clampZoom(value: number, minZoom: number = MIN_ZOOM, maxZoom = MAX_ZOOM) {
  return Math.min(maxZoom, Math.max(minZoom, value));
}

/**
 * Échelle qui cadre le plan dans la fenêtre visible. `floor` empêche un
 * dézoom total sur téléphone : un plan entièrement visible mais illisible ne
 * sert personne.
 */
export function computeFitZoom({
  viewportWidth,
  viewportHeight,
  canvasWidth,
  canvasHeight,
  minZoom = MIN_ZOOM,
  maxZoom = MAX_ZOOM,
  floor = 1,
}: {
  viewportWidth: number;
  viewportHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  minZoom?: number;
  maxZoom?: number;
  floor?: number;
}) {
  if (viewportWidth <= 0 || viewportHeight <= 0 || canvasWidth <= 0 || canvasHeight <= 0) {
    return minZoom;
  }
  const fit = Math.min(viewportWidth / canvasWidth, viewportHeight / canvasHeight);
  return clampZoom(Math.max(fit, floor), minZoom, maxZoom);
}

/**
 * Défilement à appliquer pour garder immobile, pendant un changement
 * d'échelle, le point du plan situé sous le doigt (ou le curseur).
 */
export function computeZoomAnchorScroll({
  scrollLeft,
  scrollTop,
  offsetX,
  offsetY,
  zoom,
  nextZoom,
}: {
  scrollLeft: number;
  scrollTop: number;
  offsetX: number;
  offsetY: number;
  zoom: number;
  nextZoom: number;
}) {
  const safeZoom = zoom > 0 ? zoom : 1;
  const worldX = (scrollLeft + offsetX) / safeZoom;
  const worldY = (scrollTop + offsetY) / safeZoom;
  return {
    left: Math.max(0, worldX * nextZoom - offsetX),
    top: Math.max(0, worldY * nextZoom - offsetY),
  };
}

/** Défilement qui centre le plan dans la fenêtre visible. */
export function computeCenterScroll({
  viewportWidth,
  viewportHeight,
  canvasWidth,
  canvasHeight,
  zoom,
}: {
  viewportWidth: number;
  viewportHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  zoom: number;
}) {
  return {
    left: Math.max(0, (canvasWidth * zoom - viewportWidth) / 2),
    top: Math.max(0, (canvasHeight * zoom - viewportHeight) / 2),
  };
}

/** Marge (coordonnées plan) ajoutée autour des tables au cadrage d'ouverture. */
export const CONTENT_FIT_PADDING = 48;
// Les cartes et leurs chaises peuvent dépasser les dimensions métier des tables.
export const LIVE_CONTENT_FIT_PADDING = 24;

export type ContentBounds = { x: number; y: number; width: number; height: number };

/**
 * Rectangle englobant les tables posées, en coordonnées plan. Renvoie `null`
 * quand aucune table n'est posée : le cadrage retombe alors sur le plan entier.
 * Cadrer le canvas entier ne montre en effet que du vide quand les tables
 * n'occupent qu'un coin de la salle.
 */
export function computeContentBounds(
  tables: Array<{
    positionX: number | null;
    positionY: number | null;
    width?: number | null;
    height?: number | null;
    shape?: TableShape | null;
    rotation?: number | null;
  }>,
  canvasWidth: number,
  canvasHeight: number,
): ContentBounds | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const table of tables) {
    if (table.positionX === null || table.positionY === null) continue;
    const size = getTableSize(table);
    const angle = ((table.rotation ?? 0) * Math.PI) / 180;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    // La rotation pivote autour du centre de la carte : l'empreinte au sol est
    // la boîte englobante du rectangle tourné.
    const boundingWidth = size.width * cos + size.height * sin;
    const boundingHeight = size.width * sin + size.height * cos;
    const centerX = table.positionX + size.width / 2;
    const centerY = table.positionY + size.height / 2;
    minX = Math.min(minX, centerX - boundingWidth / 2);
    minY = Math.min(minY, centerY - boundingHeight / 2);
    maxX = Math.max(maxX, centerX + boundingWidth / 2);
    maxY = Math.max(maxY, centerY + boundingHeight / 2);
  }
  if (minX === Number.POSITIVE_INFINITY || canvasWidth <= 0 || canvasHeight <= 0) return null;
  const x = Math.max(0, minX - CONTENT_FIT_PADDING);
  const y = Math.max(0, minY - CONTENT_FIT_PADDING);
  return {
    x,
    y,
    width: Math.max(1, Math.min(canvasWidth - x, maxX + CONTENT_FIT_PADDING - x)),
    height: Math.max(1, Math.min(canvasHeight - y, maxY + CONTENT_FIT_PADDING - y)),
  };
}

/** Cadre les éléments visibles du plan avec une marge autour de leur dessin. */
export function computeLiveContentBounds(
  zones: Array<Pick<FloorPlanZone, 'x' | 'y' | 'width' | 'height' | 'rotation'>>,
  tables: Array<{
    positionX: number | null;
    positionY: number | null;
    width?: number | null;
    height?: number | null;
    shape?: TableShape | null;
    rotation?: number | null;
  }>,
  canvasWidth: number,
  canvasHeight: number,
  walls: Array<Pick<FloorPlanWall, 'x1' | 'y1' | 'x2' | 'y2'>> = [],
): ContentBounds | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const includeRotatedRectangle = (
    x: number,
    y: number,
    width: number,
    height: number,
    rotation: number,
  ) => {
    const angle = (rotation * Math.PI) / 180;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    const boundingWidth = width * cos + height * sin;
    const boundingHeight = width * sin + height * cos;
    const centerX = x + width / 2;
    const centerY = y + height / 2;
    minX = Math.min(minX, centerX - boundingWidth / 2);
    minY = Math.min(minY, centerY - boundingHeight / 2);
    maxX = Math.max(maxX, centerX + boundingWidth / 2);
    maxY = Math.max(maxY, centerY + boundingHeight / 2);
  };

  const positionedTables = tables.filter(
    (table) => table.positionX !== null && table.positionY !== null,
  );
  for (const table of positionedTables) {
    if (table.positionX === null || table.positionY === null) continue;
    const size = getTableSize(table);
    includeRotatedRectangle(
      table.positionX,
      table.positionY,
      size.width,
      size.height,
      table.rotation ?? 0,
    );
  }
  for (const zone of zones) {
    includeRotatedRectangle(zone.x, zone.y, zone.width, zone.height, zone.rotation ?? 0);
  }
  for (const wall of walls) {
    minX = Math.min(minX, wall.x1, wall.x2);
    minY = Math.min(minY, wall.y1, wall.y2);
    maxX = Math.max(maxX, wall.x1, wall.x2);
    maxY = Math.max(maxY, wall.y1, wall.y2);
  }

  if (minX === Number.POSITIVE_INFINITY || canvasWidth <= 0 || canvasHeight <= 0) return null;
  const x = minX - LIVE_CONTENT_FIT_PADDING;
  const y = minY - LIVE_CONTENT_FIT_PADDING;
  return {
    x,
    y,
    width: Math.max(1, maxX + LIVE_CONTENT_FIT_PADDING - x),
    height: Math.max(1, maxY + LIVE_CONTENT_FIT_PADDING - y),
  };
}

/** Défilement qui centre une zone du plan (ex. les tables) dans la fenêtre. */
export function computeFocusScroll({
  viewportWidth,
  viewportHeight,
  region,
  zoom,
}: {
  viewportWidth: number;
  viewportHeight: number;
  region: ContentBounds;
  zoom: number;
}) {
  return {
    left: Math.max(0, (region.x + region.width / 2) * zoom - viewportWidth / 2),
    top: Math.max(0, (region.y + region.height / 2) * zoom - viewportHeight / 2),
  };
}

/** Deux contacts rapprochés dans le temps et l'espace forment un double-tap. */
export function isDoubleTap(
  previous: { time: number; x: number; y: number } | null,
  next: { time: number; x: number; y: number },
  maxDelay = 320,
  maxDistance = 32,
) {
  if (!previous) return false;
  const elapsed = next.time - previous.time;
  const distance = Math.hypot(next.x - previous.x, next.y - previous.y);
  return elapsed >= 0 && elapsed <= maxDelay && distance <= maxDistance;
}
const WALL_SNAP_DISTANCE = 40; // pixels in canvas coordinates
const WALL_LENGTH_MATCH_DISTANCE = 24; // pixels in canvas coordinates
const WALL_ALIGN_GUIDE_DISTANCE = 24; // pixels in canvas coordinates
const WALL_PERPENDICULAR_DOT_TOLERANCE = 0.08;

function formatRoomMeters(pixels: number): string {
  return (pixels / CANVAS_PIXELS_PER_METER).toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function parseRoomMeters(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const meters = Number(normalized);
  if (
    !Number.isFinite(meters) ||
    meters < MIN_ROOM_DIMENSION_METERS ||
    meters > MAX_ROOM_DIMENSION_METERS
  ) {
    return null;
  }
  return meters;
}

type WaitingListApiEntry = WaitingListEntry & {
  preferredSection?: { name: string } | null;
};

type DelayRecoveryApiResult = {
  delayedReservationId: string;
  promotedReservationId: string;
  operationId: string;
  idempotent?: boolean;
};

function mapWaitingListEntries(data: unknown[]): WaitingListEntry[] {
  return data.map((item) => {
    const entry = item as WaitingListApiEntry;
    return {
      ...entry,
      preferredSectionName: entry.preferredSectionName ?? entry.preferredSection?.name ?? null,
    };
  });
}

const TABLE_BORDER_WIDTH = 2;
const TABLE_CONTENT_PADDING = 8;
const CHAIR_SIZE = 12;
const CHAIR_GAP = 4;
const ROUND_TABLE_VISUAL_GAP = 12;
const MAXIMUM_CHAIR_COUNT = 16;
const MINIMUM_TABLE_DIMENSION = TABLE_CONTENT_PADDING * 2 + CHAIR_SIZE * 4;

export const TABLE_LAYOUT = {
  borderWidth: TABLE_BORDER_WIDTH,
  contentPadding: TABLE_CONTENT_PADDING,
  chairSize: CHAIR_SIZE,
  chairGap: CHAIR_GAP,
  roundTableVisualGap: ROUND_TABLE_VISUAL_GAP,
  maximumChairCount: MAXIMUM_CHAIR_COUNT,
  minimumDimension: MINIMUM_TABLE_DIMENSION,
} as const;

const ZONE_MIN_WIDTH = 128;
const ZONE_MIN_HEIGHT = 80;
const TABLE_CARD_MIN_WIDTH = 132;
const TABLE_CARD_MIN_HEIGHT = 66;
const TABLE_CARD_SEAT_HEIGHT = 32;
function getTableBodyGeometry(width: number, height: number, round: boolean) {
  const bodyWidth = round
    ? Math.max(Math.min(width, height), 72)
    : Math.max(width, TABLE_CARD_MIN_WIDTH);
  const bodyHeight = round ? bodyWidth : Math.max(TABLE_CARD_MIN_HEIGHT, Math.round(bodyWidth / 2));
  return {
    bodyWidth,
    bodyHeight,
    top: round
      ? Math.round((height - bodyHeight) / 2)
      : Math.max(8, Math.round((height - (bodyHeight + TABLE_CARD_SEAT_HEIGHT)) / 2)),
  };
}

/** Proposition d'allocation explicable renvoyée par l'API (Phase 5). */
type TableSuggestion = {
  tableId: string;
  name: string;
  capacity: number;
  sectionId: string | null;
  score: number;
  reasons: string[];
};

type TableGeometry = Pick<
  FloorPlanTable,
  'id' | 'positionX' | 'positionY' | 'width' | 'height' | 'rotation'
>;

type WallGeometry = Pick<FloorPlanWall, 'id' | 'x1' | 'y1' | 'x2' | 'y2'>;

type ZoneGeometry = Pick<FloorPlanZone, 'id' | 'x' | 'y' | 'width' | 'height' | 'rotation'>;

/** Snapshot atomique d'une ou plusieurs mutations strictement géométriques. */
type GeometrySnapshot = {
  tables: TableGeometry[];
  walls: WallGeometry[];
  zones?: ZoneGeometry[];
};

function snapshotTableGeometry(table: FloorPlanTable): TableGeometry {
  return {
    id: table.id,
    positionX: table.positionX,
    positionY: table.positionY,
    width: table.width,
    height: table.height,
    rotation: table.rotation,
  };
}

function snapshotWallGeometry(wall: FloorPlanWall): WallGeometry {
  return {
    id: wall.id,
    x1: wall.x1,
    y1: wall.y1,
    x2: wall.x2,
    y2: wall.y2,
  };
}

function snapshotZoneGeometry(zone: FloorPlanZone): ZoneGeometry {
  return {
    id: zone.id,
    x: zone.x,
    y: zone.y,
    width: zone.width,
    height: zone.height,
    rotation: zone.rotation,
  };
}

type WallLengthGuide = {
  activeWallId: string;
  referenceWallId: string;
  activeWall: FloorPlanWall;
  referenceWall: FloorPlanWall;
  length: number;
  labelX: number;
  labelY: number;
};

type WallResizeAlignGuide = {
  axis: 'x' | 'y';
  value: number;
};

function getWallLength(wall: Pick<FloorPlanWall, 'x1' | 'y1' | 'x2' | 'y2'>): number {
  return Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
}

function getWallMidpoint(wall: Pick<FloorPlanWall, 'x1' | 'y1' | 'x2' | 'y2'>): {
  x: number;
  y: number;
} {
  return { x: (wall.x1 + wall.x2) / 2, y: (wall.y1 + wall.y2) / 2 };
}

function areWallsPerpendicular(
  a: Pick<FloorPlanWall, 'x1' | 'y1' | 'x2' | 'y2'>,
  b: Pick<FloorPlanWall, 'x1' | 'y1' | 'x2' | 'y2'>,
): boolean {
  const ax = a.x2 - a.x1;
  const ay = a.y2 - a.y1;
  const bx = b.x2 - b.x1;
  const by = b.y2 - b.y1;
  const aLength = Math.hypot(ax, ay);
  const bLength = Math.hypot(bx, by);
  if (aLength < 1 || bLength < 1) return false;
  const normalizedDot = Math.abs((ax * bx + ay * by) / (aLength * bLength));
  return normalizedDot <= WALL_PERPENDICULAR_DOT_TOLERANCE;
}

function formatWallLength(length: number): string {
  return `${Math.round(length)} px`;
}

type CanvasTable = FloorPlanTable & {
  sectionName?: string | null;
  displayName?: string;
};

type TableForm = {
  name: string;
  capacity: string;
  minCapacity: string;
  shape: TableShape;
  isActive: boolean;
};

type DragStartInfo = {
  tableId: string;
  originalX: number;
  originalY: number;
  width: number;
  height: number;
  table: CanvasTable;
  moveId?: number;
  mutationVersion?: number;
};

type PaletteWallType = 'wall' | 'door' | 'bar';

type PaletteItemData =
  | { kind: 'table'; shape: TableShape; capacity: number }
  | { kind: 'placeTable'; table: CanvasTable }
  | { kind: 'wall'; type: PaletteWallType }
  | { kind: 'zone' };

type ActiveDragData =
  | PaletteItemData
  | { kind: 'existingTable'; table: CanvasTable }
  | { kind: 'reservation'; reservation: PlanningReservation; fromTableId: string };

export function getSafeTableDimensions(
  width: number,
  height: number,
): {
  width: number;
  height: number;
} {
  return {
    width: Math.max(TABLE_LAYOUT.minimumDimension, width),
    height: Math.max(TABLE_LAYOUT.minimumDimension, height),
  };
}

function getTableSize(table: {
  capacity?: number | null;
  shape?: TableShape | null;
  width?: number | null;
  height?: number | null;
  rotation?: number | null;
}): {
  width: number;
  height: number;
  rotation: number;
} {
  const shape = table.shape ?? 'rect';
  // La capacité est une donnée métier, pas une approximation de l'encombrement.
  // Une table reçoit une taille visuelle stable par défaut et peut ensuite être
  // redimensionnée directement sur le canvas.
  const legacyWidth = shape === 'round' ? 128 : 144;
  const legacyHeight = shape === 'round' ? 128 : 104;
  const dimensions = getSafeTableDimensions(
    table.width ?? legacyWidth,
    table.height ?? legacyHeight,
  );
  return {
    ...dimensions,
    rotation: table.rotation ?? 0,
  };
}

function tableFitsInZone(
  table: Pick<
    FloorPlanTable,
    'positionX' | 'positionY' | 'width' | 'height' | 'rotation' | 'shape'
  >,
  zone: FloorPlanZone,
) {
  if (table.positionX === null || table.positionY === null) return false;
  const { width, height, rotation } = getTableSize(table);
  const tableCenterX = table.positionX + width / 2;
  const tableCenterY = table.positionY + height / 2;
  const zoneRotation = ((zone.rotation ?? 0) * Math.PI) / 180;
  const dx = tableCenterX - (zone.x + zone.width / 2);
  const dy = tableCenterY - (zone.y + zone.height / 2);
  const localX = dx * Math.cos(zoneRotation) + dy * Math.sin(zoneRotation) + zone.width / 2;
  const localY = -dx * Math.sin(zoneRotation) + dy * Math.cos(zoneRotation) + zone.height / 2;
  const relativeRotation = ((rotation - (zone.rotation ?? 0)) * Math.PI) / 180;
  const halfWidth =
    (Math.abs(Math.cos(relativeRotation)) * width + Math.abs(Math.sin(relativeRotation)) * height) /
    2;
  const halfHeight =
    (Math.abs(Math.sin(relativeRotation)) * width + Math.abs(Math.cos(relativeRotation)) * height) /
    2;
  const clearMargin = 8;
  return (
    localX - halfWidth >= clearMargin &&
    localX + halfWidth <= zone.width - clearMargin &&
    localY - halfHeight >= clearMargin &&
    localY + halfHeight <= zone.height - clearMargin
  );
}

const statusClasses: Record<TableStatus, string> = {
  free: 'bg-card border-border text-foreground',
  reserved: 'bg-ring/10 border-ring/60 text-foreground shadow-sm',
  upcoming: 'bg-warning/10 border-warning/70 text-foreground shadow-sm',
  late: 'bg-destructive/10 border-destructive text-foreground shadow-sm',
  occupied: 'bg-primary/15 border-primary text-foreground shadow-sm',
  inactive: 'bg-muted border-border text-muted-foreground opacity-60',
};

const statusMeta: Record<TableStatus, { label: string; icon: LucideIcon }> = {
  free: { label: 'Disponible', icon: CircleCheck },
  reserved: { label: 'Réservée', icon: CalendarDays },
  upcoming: { label: 'Arrivée imminente', icon: Clock3 },
  late: { label: 'En retard', icon: AlertTriangle },
  occupied: { label: 'Occupée', icon: Users },
  inactive: { label: 'Inactive', icon: Lock },
};

const statusDotClasses: Record<TableStatus, string> = {
  free: 'bg-floor-status-free',
  reserved: 'bg-floor-status-reserved',
  upcoming: 'bg-floor-status-upcoming',
  late: 'bg-floor-status-late',
  occupied: 'bg-floor-status-occupied',
  inactive: 'bg-floor-table-muted/80',
};

function getServiceHeader(tables: CanvasTable[], reservations: PlanningReservation[], now: Date) {
  const seatedTableIds = new Set(
    reservations.filter((r) => r.state === 'SEATED').map((r) => r.tableId),
  );
  const planTableIds = new Set(tables.map((table) => table.id));
  const arrivals = reservations
    .filter((r) => {
      const untilArrival = Date.parse(r.startsAt) - now.getTime();
      return (
        ['PENDING', 'CONFIRMED'].includes(r.state) &&
        (!r.tableId || planTableIds.has(r.tableId)) &&
        untilArrival >= 0 &&
        untilArrival <= 15 * 60_000
      );
    })
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const blocked = arrivals.find((r) => r.tableId && seatedTableIds.has(r.tableId));
  const target = blocked ?? arrivals.find((r) => !r.tableId);
  if (target) {
    const minutes = Math.ceil((Date.parse(target.startsAt) - now.getTime()) / 60_000);
    const timing = minutes <= 1 ? 'Arrivée imminente' : `Arrivée dans ${minutes} min`;
    const table = tables.find((item) => item.id === target.tableId);
    const tableName = table?.displayName ?? table?.name;
    return {
      text: blocked
        ? `${tableName ? `${tableName} encore occupée` : 'Table encore occupée'} · ${timing}`
        : `${timing} · ${target.partySize} couverts sans table`,
      blocked: Boolean(blocked),
      target,
    };
  }

  if (arrivals.length) {
    return {
      text: `${arrivals.length} ${arrivals.length === 1 ? 'arrivée prévue' : 'arrivées prévues'} dans les 15 min`,
    };
  }

  const free = tables.filter(
    (table) =>
      !seatedTableIds.has(table.id) && getTableStatus(table, reservations, now).status === 'free',
  );
  const inService = tables.some((table) => seatedTableIds.has(table.id));
  const seats = free.reduce((total, table) => total + table.capacity, 0);
  return {
    text: !tables.length
      ? 'Aucune table sur ce plan'
      : !free.length
        ? 'Aucune table libre'
        : `${inService ? 'Service en cours · ' : ''}${free.length} ${free.length === 1 ? 'table libre' : 'tables libres'} · ${seats} ${seats === 1 ? 'place' : 'places'}`,
  };
}

function formatReservationBadge(reservation: PlanningReservation): string {
  if (!reservation.startsAt) return 'Réservation';
  const start = parseISO(reservation.startsAt);
  return `${reservation.customerName || 'Sans nom'} · ${reservation.partySize} · ${format(start, 'HH:mm', { locale: fr })}`;
}

function formatCustomerName(name: string | null): string {
  return name?.trim().split(/\s+/)[0] || 'Client';
}

function formatServiceTiming(
  reservation: PlanningReservation,
  status: TableStatus,
  now: Date,
): string {
  const startsAt = parseISO(reservation.startsAt);
  const minutes = Math.abs(differenceInMinutes(startsAt, now));
  if (status === 'occupied') {
    return `Occupée depuis ${minutes} min`;
  }
  const diff = differenceInMinutes(startsAt, now);
  if (diff < 0) return `En retard de ${Math.abs(diff)} min`;
  if (diff === 0) return 'Arrivée maintenant';
  return `Arrivée dans ${diff} min`;
}

function findNextPosition(
  width: number,
  height: number,
  existing: CanvasTable[],
  maxWidth: number,
  maxHeight: number,
  rotation = 0,
  shape: TableShape = 'rect',
): { x: number; y: number } | null {
  const startX = 32;
  const startY = 32;
  const step = GRID_SIZE;

  for (let y = startY; y <= maxHeight - height; y += step) {
    for (let x = startX; x <= maxWidth - width; x += step) {
      const hasOverlap = tablePlatesOverlapAtPosition({
        x,
        y,
        width,
        height,
        rotation,
        shape,
        tables: existing,
      });
      if (!hasOverlap) {
        return { x: Math.round(x), y: Math.round(y) };
      }
    }
  }

  return null;
}

const TABLE_ALIGN_GUIDE_DISTANCE = 10;
const TABLE_DUPLICATE_GAP = 16;

export type TableAlignmentGuide = {
  axis: 'x' | 'y';
  /** Coordonnée de l'axe de référence, dans l'espace du plan. */
  value: number;
  /** Position de départ à appliquer à la table déplacée pour l'aligner. */
  position: number;
  distance: number;
};

export type TableAlignmentGuides = {
  x: TableAlignmentGuide | null;
  y: TableAlignmentGuide | null;
};

const emptyTableAlignmentGuides = (): TableAlignmentGuides => ({ x: null, y: null });

/**
 * Cherche les axes de bord et de centre les plus proches d'une table déjà
 * placée. Les coordonnées renvoyées sont indépendantes du zoom : elles sont
 * donc réutilisables pendant le drag et au moment de la persistance finale.
 */
export function getTableAlignmentGuides({
  x,
  y,
  width,
  height,
  tables,
  excludedTableId,
  threshold = TABLE_ALIGN_GUIDE_DISTANCE,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  tables: CanvasTable[];
  excludedTableId?: string;
  threshold?: number;
}): TableAlignmentGuides {
  const guides = emptyTableAlignmentGuides();
  const movingAxes = {
    x: [
      { value: x, offset: 0 },
      { value: x + width / 2, offset: width / 2 },
      { value: x + width, offset: width },
    ],
    y: [
      { value: y, offset: 0 },
      { value: y + height / 2, offset: height / 2 },
      { value: y + height, offset: height },
    ],
  };

  for (const table of tables) {
    if (table.id === excludedTableId || table.positionX === null || table.positionY === null) {
      continue;
    }
    const size = getTableSize(table);
    const referenceAxes = {
      x: [table.positionX, table.positionX + size.width / 2, table.positionX + size.width],
      y: [table.positionY, table.positionY + size.height / 2, table.positionY + size.height],
    };

    for (const axis of ['x', 'y'] as const) {
      for (const movingAxis of movingAxes[axis]) {
        for (const referenceValue of referenceAxes[axis]) {
          const distance = Math.abs(movingAxis.value - referenceValue);
          const current = guides[axis];
          if (distance <= threshold && (!current || distance < current.distance)) {
            guides[axis] = {
              axis,
              value: referenceValue,
              position: Math.round(referenceValue - movingAxis.offset),
              distance,
            };
          }
        }
      }
    }
  }

  return guides;
}

function getTablePlate(
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: number,
  shape: TableShape | null,
) {
  const round = shape === 'round';
  const { bodyWidth, bodyHeight, top } = getTableBodyGeometry(width, height, round);
  const left = Math.round((width - bodyWidth) / 2);
  const radians = (rotation * Math.PI) / 180;
  const localX = left + bodyWidth / 2 - width / 2;
  const localY = top + bodyHeight / 2 - height / 2;

  return {
    x: x + width / 2 + localX * Math.cos(radians) - localY * Math.sin(radians),
    y: y + height / 2 + localX * Math.sin(radians) + localY * Math.cos(radians),
    halfWidth: bodyWidth / 2,
    halfHeight: bodyHeight / 2,
    radians,
    round,
  };
}

function circleOverlapsTablePlate(
  circle: { x: number; y: number; radius: number },
  rectangle: ReturnType<typeof getTablePlate>,
) {
  if (rectangle.round) {
    return (
      (circle.x - rectangle.x) ** 2 + (circle.y - rectangle.y) ** 2 <
      (circle.radius + rectangle.halfWidth) ** 2
    );
  }
  const dx = circle.x - rectangle.x;
  const dy = circle.y - rectangle.y;
  const localX = dx * Math.cos(rectangle.radians) + dy * Math.sin(rectangle.radians);
  const localY = -dx * Math.sin(rectangle.radians) + dy * Math.cos(rectangle.radians);
  const closestX = Math.max(-rectangle.halfWidth, Math.min(rectangle.halfWidth, localX));
  const closestY = Math.max(-rectangle.halfHeight, Math.min(rectangle.halfHeight, localY));
  return (localX - closestX) ** 2 + (localY - closestY) ** 2 < circle.radius ** 2;
}

function findOverlappingTablePlate({
  x,
  y,
  width,
  height,
  rotation = 0,
  shape = 'rect',
  tables,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  shape?: TableShape | null;
  tables: CanvasTable[];
}) {
  const candidate = getTablePlate(x, y, width, height, rotation, shape);

  return tables.find((table) => {
    if (table.positionX === null || table.positionY === null) return false;
    const { width: tableWidth, height: tableHeight, rotation: tableRotation } = getTableSize(table);
    const other = getTablePlate(
      table.positionX,
      table.positionY,
      tableWidth,
      tableHeight,
      tableRotation,
      table.shape,
    );

    if (candidate.round && other.round) {
      const radius =
        Math.min(candidate.halfWidth, candidate.halfHeight) +
        Math.min(other.halfWidth, other.halfHeight);
      return (other.x - candidate.x) ** 2 + (other.y - candidate.y) ** 2 < radius ** 2;
    }

    if (candidate.round || other.round) {
      const circle = candidate.round ? candidate : other;
      const rectangle = candidate.round ? other : candidate;
      return circleOverlapsTablePlate(
        { x: circle.x, y: circle.y, radius: circle.halfWidth },
        rectangle,
      );
    }

    const axes: Array<[number, number]> = [
      [Math.cos(candidate.radians), Math.sin(candidate.radians)],
      [-Math.sin(candidate.radians), Math.cos(candidate.radians)],
      [Math.cos(other.radians), Math.sin(other.radians)],
      [-Math.sin(other.radians), Math.cos(other.radians)],
    ];

    return axes.every(([axisX, axisY]) => {
      const candidateRadius =
        candidate.halfWidth *
          Math.abs(axisX * Math.cos(candidate.radians) + axisY * Math.sin(candidate.radians)) +
        candidate.halfHeight *
          Math.abs(-axisX * Math.sin(candidate.radians) + axisY * Math.cos(candidate.radians));
      const otherRadius =
        other.halfWidth *
          Math.abs(axisX * Math.cos(other.radians) + axisY * Math.sin(other.radians)) +
        other.halfHeight *
          Math.abs(-axisX * Math.sin(other.radians) + axisY * Math.cos(other.radians));
      return (
        Math.abs((other.x - candidate.x) * axisX + (other.y - candidate.y) * axisY) <
        candidateRadius + otherRadius
      );
    });
  });
}

export function tablePlatesOverlapAtPosition(
  candidate: Parameters<typeof findOverlappingTablePlate>[0],
) {
  return Boolean(findOverlappingTablePlate(candidate));
}

/** Cherche la place libre la plus proche du point proposé, sans sortir du plan. */
export function findNearbyFreeTablePosition(
  table: CanvasTable,
  tables: CanvasTable[],
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } | null {
  const { width, height, rotation } = getTableSize(table);
  const originX = table.positionX ?? TABLE_DUPLICATE_GAP;
  const originY = table.positionY ?? TABLE_DUPLICATE_GAP;
  const positionedTables = tables.filter(
    (candidate) => candidate.positionX !== null && candidate.positionY !== null,
  );

  const canPlace = (x: number, y: number) =>
    x >= 0 &&
    y >= 0 &&
    x + width <= canvasWidth &&
    y + height <= canvasHeight &&
    !tablePlatesOverlapAtPosition({
      x,
      y,
      width,
      height,
      rotation,
      shape: table.shape,
      tables: positionedTables,
    });

  const normalise = (value: number) => Math.round(value / GRID_SIZE) * GRID_SIZE;
  const directCandidates = [
    { x: originX + width + TABLE_DUPLICATE_GAP, y: originY },
    { x: originX, y: originY + height + TABLE_DUPLICATE_GAP },
    { x: originX - width - TABLE_DUPLICATE_GAP, y: originY },
    { x: originX, y: originY - height - TABLE_DUPLICATE_GAP },
    { x: originX + width + TABLE_DUPLICATE_GAP, y: originY + height + TABLE_DUPLICATE_GAP },
    { x: originX - width - TABLE_DUPLICATE_GAP, y: originY + height + TABLE_DUPLICATE_GAP },
    { x: originX + width + TABLE_DUPLICATE_GAP, y: originY - height - TABLE_DUPLICATE_GAP },
    { x: originX - width - TABLE_DUPLICATE_GAP, y: originY - height - TABLE_DUPLICATE_GAP },
  ];

  for (const candidate of directCandidates) {
    const x = normalise(candidate.x);
    const y = normalise(candidate.y);
    if (canPlace(x, y)) return { x, y };
  }

  const maxRadius = Math.ceil(Math.max(canvasWidth, canvasHeight) / GRID_SIZE);
  for (let radius = 1; radius <= maxRadius; radius++) {
    const candidates: Array<{ x: number; y: number }> = [];
    for (let delta = -radius; delta <= radius; delta++) {
      candidates.push(
        { x: normalise(originX + radius * GRID_SIZE), y: normalise(originY + delta * GRID_SIZE) },
        { x: normalise(originX - radius * GRID_SIZE), y: normalise(originY + delta * GRID_SIZE) },
      );
    }
    for (let delta = -radius + 1; delta < radius; delta++) {
      candidates.push(
        { x: normalise(originX + delta * GRID_SIZE), y: normalise(originY + radius * GRID_SIZE) },
        { x: normalise(originX + delta * GRID_SIZE), y: normalise(originY - radius * GRID_SIZE) },
      );
    }
    const valid = candidates.find((candidate) => canPlace(candidate.x, candidate.y));
    if (valid) return valid;
  }

  return null;
}

function getNextTableName(tables: CanvasTable[]): string {
  const highestNumber = tables.reduce((max, table) => {
    const match = table.name.match(/^T0*(\d+)$/i);
    return Math.max(max, match ? Number(match[1]) : 0);
  }, 0);
  return `T${highestNumber + 1}`;
}

type ChairPosition = {
  left: number;
  top: number;
  rotation?: number;
};

type ChairLayoutInput = {
  width: number;
  height: number;
  capacity?: number | null;
  shape?: TableShape | null;
};

export function getChairPositions({
  width: unsafeWidth,
  height: unsafeHeight,
  capacity,
  shape = 'rect',
}: ChairLayoutInput): ChairPosition[] {
  const { width, height } = getSafeTableDimensions(unsafeWidth, unsafeHeight);
  const chairCount = Math.min(capacity ?? 1, TABLE_LAYOUT.maximumChairCount);
  const halfChairSize = TABLE_LAYOUT.chairSize / 2;
  // TableCard uses `border-2` with `box-border`, so absolute children are
  // positioned relative to the padding box. We must offset by the 2px border.
  const { borderWidth, chairGap, chairSize, roundTableVisualGap } = TABLE_LAYOUT;
  const chairs: ChairPosition[] = [];

  if (shape === 'round') {
    const centerX = width / 2 - borderWidth;
    const centerY = height / 2 - borderWidth;
    const chairClearance = roundTableVisualGap + (chairSize / 2) * Math.SQRT2;
    const radiusX = width / 2 + chairClearance;
    const radiusY = height / 2 + chairClearance;
    for (let i = 0; i < chairCount; i++) {
      const angle = (i / chairCount) * 2 * Math.PI - Math.PI / 2;
      const rotation = ((angle + Math.PI / 2) * 180) / Math.PI;
      chairs.push({
        left: centerX + radiusX * Math.cos(angle) - halfChairSize,
        top: centerY + radiusY * Math.sin(angle) - halfChairSize,
        rotation,
      });
    }
    return chairs;
  }

  const perimeter = 2 * (width + height);
  let topCount = Math.max(0, Math.round((chairCount * width) / perimeter));
  let bottomCount = topCount;
  let leftCount = Math.max(0, Math.round((chairCount * height) / perimeter));
  let rightCount = leftCount;
  const total = topCount + bottomCount + leftCount + rightCount;

  const adjust = (remaining: number) => {
    while (remaining !== 0) {
      if (remaining > 0) {
        if (width >= height) {
          topCount++;
          if (--remaining === 0) break;
          bottomCount++;
          remaining--;
        } else {
          leftCount++;
          if (--remaining === 0) break;
          rightCount++;
          remaining--;
        }
      } else if (width >= height) {
        if (leftCount > 0) {
          leftCount--;
        } else if (rightCount > 0) {
          rightCount--;
        } else if (topCount > 1) {
          topCount--;
        } else if (bottomCount > 1) {
          bottomCount--;
        } else {
          break;
        }
        remaining++;
      } else {
        if (topCount > 0) {
          topCount--;
        } else if (bottomCount > 0) {
          bottomCount--;
        } else if (leftCount > 1) {
          leftCount--;
        } else if (rightCount > 1) {
          rightCount--;
        } else {
          break;
        }
        remaining++;
      }
    }
  };

  adjust(chairCount - total);

  const place = (count: number, length: number, side: 'top' | 'bottom' | 'left' | 'right') => {
    if (count <= 0) return;
    const spacing = length / (count + 1);
    for (let i = 1; i <= count; i++) {
      const position = i * spacing;
      if (side === 'top') {
        chairs.push({
          left: position - halfChairSize - borderWidth,
          top: -(chairSize + chairGap + borderWidth),
          rotation: 0,
        });
      } else if (side === 'bottom') {
        chairs.push({
          left: position - halfChairSize - borderWidth,
          top: height - borderWidth + chairGap,
          rotation: 180,
        });
      } else if (side === 'left') {
        chairs.push({
          left: -(chairSize + chairGap + borderWidth),
          top: position - halfChairSize - borderWidth,
          rotation: 270,
        });
      } else {
        chairs.push({
          left: width - borderWidth + chairGap,
          top: position - halfChairSize - borderWidth,
          rotation: 90,
        });
      }
    }
  };

  place(topCount, width, 'top');
  place(bottomCount, width, 'bottom');
  place(leftCount, height, 'left');
  place(rightCount, height, 'right');

  return chairs;
}

function replaceTable(floorPlan: FloorPlan, updated: FloorPlanTable): FloorPlan {
  const id = updated.id;
  const targetSectionId = updated.sectionId ?? null;
  let placed = false;

  const sections = floorPlan.sections.map((section) => {
    const tables = section.tables.filter((t) => t.id !== id);
    if (section.id === targetSectionId) {
      placed = true;
      return {
        ...section,
        tables: [
          ...tables,
          { ...updated, sectionId: section.id, sectionName: section.name } as FloorPlanTable,
        ],
      };
    }
    return { ...section, tables };
  });

  const topTables = (floorPlan.tables ?? []).filter((t) => t.id !== id);
  if (targetSectionId === null || targetSectionId === undefined) {
    return { ...floorPlan, sections, tables: [...topTables, updated] };
  }

  return { ...floorPlan, sections, tables: topTables };
}

function removeTable(floorPlan: FloorPlan, tableId: string): FloorPlan {
  return {
    ...floorPlan,
    sections: floorPlan.sections.map((section) => ({
      ...section,
      tables: section.tables.filter((t) => t.id !== tableId),
    })),
    tables: (floorPlan.tables ?? []).filter((t) => t.id !== tableId),
  };
}

function replaceTablePosition(
  floorPlan: FloorPlan,
  tableId: string,
  positionX: number | null,
  positionY: number | null,
): FloorPlan {
  return {
    ...floorPlan,
    sections: floorPlan.sections.map((section) => ({
      ...section,
      tables: section.tables.map((t) => (t.id === tableId ? { ...t, positionX, positionY } : t)),
    })),
    tables: (floorPlan.tables ?? []).map((t) =>
      t.id === tableId ? { ...t, positionX, positionY } : t,
    ),
  };
}

function replaceZone(floorPlan: FloorPlan, updated: FloorPlanZone): FloorPlan {
  const previous = (floorPlan.zones ?? []).find((zone) => zone.id === updated.id);
  const sectionChanged = previous && previous.sectionId !== updated.sectionId;
  const linkedSection =
    updated.section ??
    (sectionChanged
      ? (floorPlan.sections.find((section) => section.id === updated.sectionId) ?? null)
      : previous?.section);
  return {
    ...floorPlan,
    zones: (floorPlan.zones ?? []).map((zone) =>
      zone.id === updated.id
        ? {
            ...zone,
            ...updated,
            section: linkedSection,
            sectionName:
              updated.sectionName ??
              linkedSection?.name ??
              (sectionChanged ? null : zone.sectionName),
          }
        : zone,
    ),
  };
}

function removeZone(floorPlan: FloorPlan, zoneId: string): FloorPlan {
  return {
    ...floorPlan,
    zones: (floorPlan.zones ?? []).filter((zone) => zone.id !== zoneId),
  };
}

function getNextZoneName(zones: FloorPlanZone[]): string {
  const used = new Set(
    zones
      .map((zone) => zone.name.match(/^zone\s+(\d+)$/i)?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number),
  );
  let next = 1;
  while (used.has(next)) next += 1;
  return `Zone ${next}`;
}

function findNextZonePosition(
  width: number,
  height: number,
  zones: FloorPlanZone[],
  maxWidth: number,
  maxHeight: number,
): { x: number; y: number } {
  const step = GRID_SIZE * 2;
  for (let y = 32; y <= maxHeight - height; y += step) {
    for (let x = 32; x <= maxWidth - width; x += step) {
      const overlaps = zones.some(
        (zone) =>
          x < zone.x + zone.width &&
          x + width > zone.x &&
          y < zone.y + zone.height &&
          y + height > zone.y,
      );
      if (!overlaps) return { x, y };
    }
  }
  return {
    x: Math.max(0, Math.round((maxWidth - width) / 2)),
    y: Math.max(0, Math.round((maxHeight - height) / 2)),
  };
}

const wallStrokeConfig: Record<
  WallType,
  { stroke: string; strokeWidth: number; strokeDasharray?: string }
> = {
  wall: { stroke: 'hsl(var(--foreground))', strokeWidth: 4 },
  door: { stroke: 'hsl(var(--primary))', strokeWidth: 3 },
  window: { stroke: 'hsl(var(--accent))', strokeWidth: 3, strokeDasharray: '8 4' },
  bar: { stroke: 'hsl(var(--destructive))', strokeWidth: 6 },
  plant: { stroke: 'hsl(var(--muted-foreground))', strokeWidth: 2, strokeDasharray: '2 2' },
};

type WallSegmentProps = {
  wall: FloorPlanWall;
  onClick?: () => void;
  isSelected?: boolean;
  editable?: boolean;
  locked?: boolean;
  onPointerDownMove?: (e: React.PointerEvent) => void;
  onPointerDownStart?: (e: React.PointerEvent) => void;
  onPointerDownEnd?: (e: React.PointerEvent) => void;
};

function WallSegment({
  wall,
  onClick,
  isSelected,
  editable = true,
  locked = false,
  onPointerDownMove,
  onPointerDownStart,
  onPointerDownEnd,
}: WallSegmentProps) {
  const { stroke, strokeWidth, strokeDasharray } = wallStrokeConfig[wall.type];

  return (
    <g
      className={cn(
        'transition-all duration-200',
        onClick && editable && !locked && 'cursor-pointer',
      )}
      onClick={(e) => {
        if (!onClick) return;
        e.stopPropagation();
        onClick();
      }}
    >
      <line
        x1={wall.x1}
        y1={wall.y1}
        x2={wall.x2}
        y2={wall.y2}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={strokeDasharray}
        strokeLinecap="square"
        className={cn(
          'transition-all duration-200',
          isSelected && 'stroke-ring stroke-[6]',
          isSelected && 'pointer-events-none',
        )}
      />
      {isSelected && editable && !locked ? (
        <>
          {/* Thicker invisible line for easier drag of the whole wall */}
          <line
            x1={wall.x1}
            y1={wall.y1}
            x2={wall.x2}
            y2={wall.y2}
            stroke="transparent"
            strokeWidth={20}
            style={{ cursor: 'move' }}
            onPointerDown={onPointerDownMove}
          />
          {/* Endpoint handles */}
          <circle
            cx={wall.x1}
            cy={wall.y1}
            r={8}
            fill="hsl(var(--ring))"
            stroke="white"
            strokeWidth={2}
            style={{ cursor: 'grab' }}
            onPointerDown={onPointerDownStart}
          />
          <circle
            cx={wall.x2}
            cy={wall.y2}
            r={8}
            fill="hsl(var(--ring))"
            stroke="white"
            strokeWidth={2}
            style={{ cursor: 'grab' }}
            onPointerDown={onPointerDownEnd}
          />
        </>
      ) : null}
    </g>
  );
}

function getRenderedTableChairs(table: CanvasTable, width: number, height: number) {
  const round = table.shape === 'round';
  const { bodyWidth, bodyHeight, top } = getTableBodyGeometry(width, height, round);
  const left = Math.round((width - bodyWidth) / 2);
  // shortcut: au-delà de huit places, masquer les chaises jusqu’à pouvoir toutes les représenter.
  const count = table.capacity <= 8 ? Math.max(0, table.capacity) : 0;
  const chairWidth = Math.min(
    36,
    (Math.max(width, TABLE_CARD_MIN_WIDTH) - 8) / (Math.ceil(count / 2) + 1),
  );
  return Array.from({ length: count }, (_, index) => {
    if (round) {
      const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
      return {
        x: left + (bodyWidth / 2) * (1 + Math.cos(angle)),
        y: top + (bodyHeight / 2) * (1 + Math.sin(angle)),
        width: chairWidth,
        rotation: (angle * 180) / Math.PI + 90,
      };
    }
    const rowCount = index % 2 === 0 ? Math.ceil(count / 2) : Math.floor(count / 2);
    return {
      x: left + (bodyWidth * (Math.floor(index / 2) + 1)) / (rowCount + 1),
      y: top + (index % 2) * bodyHeight,
      width: chairWidth,
      rotation: 0,
    };
  });
}

export function findOverlappingTableChairs(
  table: CanvasTable,
  tables: CanvasTable[],
  { plateOnly = false } = {},
) {
  const getChairsOnPlan = (table: CanvasTable) => {
    if (table.positionX === null || table.positionY === null) return [];
    const { positionX, positionY } = table;
    const { width, height, rotation } = getTableSize(table);
    const angle = (rotation * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return getRenderedTableChairs(table, width, height).map((chair) => {
      const x = chair.x - width / 2;
      const y = chair.y - height / 2;
      return {
        x: positionX + width / 2 + x * cos - y * sin,
        y: positionY + height / 2 + x * sin + y * cos,
        // shortcut: tester le cœur circulaire des chaises ; affiner si les contacts de bord doivent être signalés.
        radius: Math.min(chair.width, TABLE_CARD_SEAT_HEIGHT) / 2,
      };
    });
  };
  if (table.positionX === null || table.positionY === null) return;
  const size = getTableSize(table);
  const plate = getTablePlate(
    table.positionX,
    table.positionY,
    size.width,
    size.height,
    size.rotation,
    table.shape,
  );
  const movingChairs = getChairsOnPlan(table);
  return tables.find((other) => {
    if (other.id === table.id || other.positionX === null || other.positionY === null) return false;
    const size = getTableSize(other);
    const otherPlate = getTablePlate(
      other.positionX,
      other.positionY,
      size.width,
      size.height,
      size.rotation,
      other.shape,
    );
    return (
      movingChairs.some((chair) => circleOverlapsTablePlate(chair, otherPlate)) ||
      getChairsOnPlan(other).some(
        (chair) =>
          circleOverlapsTablePlate(chair, plate) ||
          (!plateOnly &&
            movingChairs.some(
              (moving) =>
                (chair.x - moving.x) ** 2 + (chair.y - moving.y) ** 2 <
                (chair.radius + moving.radius) ** 2,
            )),
      )
    );
  });
}

export function nudgeTableClearOfChairs(
  table: CanvasTable,
  neighbours: CanvasTable[],
  canvasWidth: number,
  canvasHeight: number,
) {
  if (table.positionX === null || table.positionY === null) return;
  const { positionX, positionY } = table;
  const size = getTableSize(table);
  // shortcut: huit directions sur deux carreaux ; affiner si les plans serrés nécessitent une recherche continue.
  for (let radius = 4; radius <= 2 * GRID_SIZE; radius += 4) {
    for (let direction = 0; direction < 8; direction++) {
      const angle = (direction * Math.PI) / 4;
      const x = positionX + Math.round(radius * Math.cos(angle));
      const y = positionY + Math.round(radius * Math.sin(angle));
      if (x < 0 || y < 0 || x + size.width > canvasWidth || y + size.height > canvasHeight)
        continue;
      if (
        !findOverlappingTablePlate({ ...size, x, y, shape: table.shape, tables: neighbours }) &&
        !findOverlappingTableChairs({ ...table, positionX: x, positionY: y }, neighbours, {
          plateOnly: true,
        })
      )
        return { positionX: x, positionY: y };
    }
  }
}

type TableCardProps = {
  table: CanvasTable;
  invalidPlacement?: boolean;
  status?: { status: TableStatus; reservation: PlanningReservation | null };
  onClick?: (e?: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  dragRef?: React.Ref<HTMLDivElement>;
  dragProps?: React.HTMLAttributes<HTMLDivElement>;
  isOverlay?: boolean;
  isSelected?: boolean;
  onResizeStart?: (e: React.PointerEvent) => void;
  onRotateStart?: (e: React.PointerEvent) => void;
  style?: React.CSSProperties;
  className?: string;
  zoom?: number;
  draggableReservation?: boolean;
  isCombinable?: boolean;
  assignmentCandidate?: boolean;
  editable?: boolean;
  /** Rendu tactile : nom et point d'état seuls, sans libellé ni client. */
  compact?: boolean;
};

function TableCard({
  table,
  invalidPlacement = false,
  status,
  onClick,
  onDoubleClick,
  dragRef,
  dragProps,
  isOverlay,
  isSelected,
  onResizeStart,
  onRotateStart,
  style,
  className,
  zoom = 1,
  draggableReservation,
  isCombinable = false,
  assignmentCandidate = false,
  editable = true,
  compact = false,
}: TableCardProps) {
  const { width, height, rotation } = getTableSize(table);
  const displayName = table.displayName ?? table.name;
  const title = status?.reservation
    ? formatReservationBadge(status.reservation)
    : `${displayName} · ${table.capacity} places`;

  // Keep one visual language for tables in both modes. The editor and Live
  // still provide different interactions, but the table itself should remain
  // recognisable when moving between them.
  const liveStatusLabel = status ? statusMeta[status.status].label : null;
  const liveRailClass = status ? statusDotClasses[status.status] : 'bg-floor-table-accent';
  const liveStatusTextClass =
    status?.status === 'occupied'
      ? 'text-floor-table-accent'
      : status?.status === 'late'
        ? 'text-destructive'
        : status?.status === 'upcoming'
          ? 'text-warning'
          : status?.status === 'reserved'
            ? 'text-brand'
            : status?.status === 'free'
              ? 'text-floor-table-text'
              : 'text-floor-table-muted';
  const isRound = table.shape === 'round';
  const {
    bodyWidth: liveBodyWidth,
    bodyHeight: liveBodyHeight,
    top: liveBodyTop,
  } = getTableBodyGeometry(width, height, isRound);
  const liveBodyLeft = Math.round((width - liveBodyWidth) / 2);
  const chairs = getRenderedTableChairs(table, width, height);
  const arrival = status?.status === 'upcoming' ? status.reservation?.startsAt : undefined;
  const arrivalTime = arrival ? format(parseISO(arrival), 'HH:mm', { locale: fr }) : null;
  const statusLabel = compact && status?.status === 'late' ? 'Retard' : liveStatusLabel;

  return (
    <div
      ref={dragRef}
      className={cn(
        'group/table relative box-border min-w-0 min-h-0 select-none outline-none',
        'overflow-visible',
        !isOverlay && 'absolute',
        className,
      )}
      style={{
        width,
        height,
        ...style,
        transform: style?.transform
          ? `${style.transform} rotate(${rotation}deg)`
          : `rotate(${rotation}deg)`,
        transformOrigin: style?.transformOrigin ?? 'center',
      }}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={title}
      aria-description={`${displayName} · ${table.capacity} places${status ? ` · ${statusMeta[status.status].label}` : ''}${assignmentCandidate ? ' · Table proposée pour la réservation sélectionnée' : ''}${isCombinable ? ' · Peut être combinée avec d’autres tables' : ''}`}
      aria-pressed={onClick ? isSelected : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick?.();
      }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && onClick) {
          e.preventDefault();
          onClick?.();
        }
      }}
      title={`${displayName} · ${table.capacity} places${liveStatusLabel ? ` · ${liveStatusLabel}` : ''}${arrivalTime ? ` à ${arrivalTime}` : ''}`}
      {...dragProps}
    >
      <>
        {chairs.map((chair, index) => (
          <span
            key={index}
            className="absolute z-0 rounded-full border-2 border-floor-table-muted/50 bg-floor-table-chair shadow-sm"
            style={{
              left: chair.x - chair.width / 2,
              top: chair.y - TABLE_CARD_SEAT_HEIGHT / 2,
              width: chair.width,
              height: TABLE_CARD_SEAT_HEIGHT,
              transform: `rotate(${chair.rotation}deg)`,
            }}
            aria-hidden="true"
          />
        ))}
        <div
          className={cn(
            'absolute z-10 overflow-hidden border border-floor-table-muted/15 bg-floor-table-surface shadow-sm',
            isRound ? 'rounded-full' : 'rounded-[0.6rem]',
            'transition-[border-color,box-shadow] duration-200 group-focus-visible/table:ring-2 group-focus-visible/table:ring-primary group-focus-visible/table:ring-offset-2 group-focus-visible/table:ring-offset-background',
            invalidPlacement && 'border-destructive bg-destructive/25 ring-2 ring-destructive',
            assignmentCandidate &&
              !isOverlay &&
              'border-success/70 ring-2 ring-success/50 ring-offset-2 ring-offset-background',
            isSelected &&
              !isOverlay &&
              'border-primary ring-2 ring-primary ring-offset-2 ring-offset-background',
          )}
          style={{
            height: liveBodyHeight,
            left: liveBodyLeft,
            top: liveBodyTop,
            width: liveBodyWidth,
          }}
        >
          <span
            className={cn('absolute inset-y-0 right-0', isRound ? 'w-2' : 'w-3', liveRailClass)}
            aria-hidden="true"
            title={liveStatusLabel ?? undefined}
          />
          <div
            className={cn(
              'absolute inset-0 flex flex-col',
              isRound
                ? 'items-center justify-center gap-1 px-3 text-center'
                : compact
                  ? 'items-start justify-between px-2 py-1.5 pr-3 text-left'
                  : 'items-start justify-between px-3 py-2 pr-5 text-left',
            )}
          >
            <p className="max-w-full truncate pr-2 text-[13px] font-bold leading-none text-floor-table-text">
              {displayName}
            </p>
            <p className="max-w-full truncate text-[11px] font-medium leading-none text-floor-table-text/90">
              {table.capacity} places
            </p>
            {status ? (
              <div
                aria-hidden="true"
                className={cn(
                  'flex min-w-0 max-w-full items-center gap-1 text-[11px] font-medium leading-tight',
                  liveStatusTextClass,
                )}
              >
                {status.status === 'free' ? (
                  <CircleCheck size={12} className="shrink-0 text-success" />
                ) : arrival && arrivalTime ? (
                  <>
                    <Clock3 size={11} className="shrink-0" />
                    <time dateTime={arrival} className="tabular-nums">
                      {arrivalTime}
                    </time>
                  </>
                ) : (
                  <span className="truncate">{statusLabel}</span>
                )}
              </div>
            ) : null}
          </div>
          {status?.reservation && !isOverlay ? (
            <DraggableReservation
              reservation={status.reservation}
              fromTableId={table.id}
              disabled={!draggableReservation}
            />
          ) : null}
        </div>
      </>
      {isSelected && editable && !isOverlay && onResizeStart ? (
        <div
          className="absolute -bottom-1.5 -right-1.5 z-30 size-3 cursor-nwse-resize rounded-full border-2 border-floor-table-surface bg-floor-table-accent shadow-md"
          onPointerDown={(e) => {
            e.stopPropagation();
            onResizeStart(e as unknown as React.PointerEvent);
          }}
          title="Redimensionner"
        />
      ) : null}
      {isSelected && editable && !isOverlay && onRotateStart ? (
        <div
          className="absolute -top-2.5 left-1/2 z-30 flex size-5 -translate-x-1/2 cursor-grab items-center justify-center rounded-full border-2 border-floor-table-accent bg-floor-table-surface text-floor-table-accent shadow-md"
          onPointerDown={(e) => {
            e.stopPropagation();
            onRotateStart(e as unknown as React.PointerEvent);
          }}
          title="Tourner"
        >
          <RotateCw size={10} />
        </div>
      ) : null}
    </div>
  );
}

function DraggableReservation({
  reservation,
  fromTableId,
  disabled = false,
}: {
  reservation: PlanningReservation;
  fromTableId: string;
  disabled?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `reservation-${reservation.id}`,
    data: { kind: 'reservation', reservation, fromTableId } as ActiveDragData,
    disabled,
  });

  const { onPointerDown, ...otherListeners } = listeners ?? {};

  return (
    <div
      ref={setNodeRef}
      {...otherListeners}
      {...attributes}
      role="presentation"
      tabIndex={-1}
      aria-hidden="true"
      onPointerDown={(e) => {
        onPointerDown?.(e);
        e.stopPropagation();
      }}
      className={cn(
        'absolute inset-0 z-20 cursor-grab rounded-[inherit] active:cursor-grabbing',
        isDragging && 'opacity-0',
      )}
      aria-label={formatReservationBadge(reservation)}
    >
      <span className="sr-only">{formatReservationBadge(reservation)}</span>
    </div>
  );
}

function ZoneCard({
  zone,
  isSelected,
  editable,
  placingTable,
  onClick,
  onPointerDown,
  onResizeStart,
}: {
  zone: FloorPlanZone;
  isSelected?: boolean;
  editable?: boolean;
  placingTable?: boolean;
  onClick: (event?: React.MouseEvent<HTMLDivElement>) => void;
  onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onResizeStart?: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      id={`floor-plan-zone-${zone.id}`}
      className={cn(
        'absolute flex flex-col items-center justify-center rounded-xl border border-primary/25 bg-primary/5 px-3 text-center text-muted-foreground transition-[border,background,box-shadow] duration-200',
        editable && 'cursor-move hover:border-primary/50 hover:bg-primary/10',
        placingTable && 'cursor-crosshair',
        isSelected && 'border-primary bg-primary/10 ring-2 ring-primary/40 ring-offset-1',
      )}
      style={{
        left: zone.x,
        top: zone.y,
        width: zone.width,
        height: zone.height,
        transform: `rotate(${zone.rotation}deg)`,
        zIndex: 1,
      }}
      role="button"
      tabIndex={0}
      aria-label={`${zone.name}${!editable && zone.sectionName ? ` · ${zone.sectionName}` : ''}`}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown?.(event);
      }}
      onClick={(event) => {
        event.stopPropagation();
        onClick(event);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
    >
      <span className="text-xs font-semibold uppercase tracking-[0.14em]">{zone.name}</span>
      {!editable && zone.sectionName ? (
        <span className="mt-1 text-[10px]">{zone.sectionName}</span>
      ) : null}
      {isSelected && editable && !placingTable && onResizeStart ? (
        <div
          className="absolute -bottom-1.5 -right-1.5 z-30 h-3.5 w-3.5 cursor-nwse-resize rounded-sm border border-background bg-primary shadow-sm"
          onPointerDown={(event) => {
            event.stopPropagation();
            event.preventDefault();
            onResizeStart(event);
          }}
          title="Redimensionner la zone"
          aria-label="Redimensionner la zone"
          role="button"
        />
      ) : null}
    </div>
  );
}

type DraggableTableProps = {
  table: CanvasTable;
  invalidPlacement?: boolean;
  status?: { status: TableStatus; reservation: PlanningReservation | null };
  isSelected?: boolean;
  onClick: (e?: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  onResizeStart?: (e: React.PointerEvent) => void;
  onRotateStart?: (e: React.PointerEvent) => void;
  style?: React.CSSProperties;
  draggable?: boolean;
  droppable?: boolean;
  draggableReservation?: boolean;
  zoom?: number;
  isCombinable?: boolean;
  assignmentCandidate?: boolean;
  editable?: boolean;
  /** Carte tactile compacte (téléphone) : nom + point d'état seulement. */
  compact?: boolean;
};

function DraggableTable({
  table,
  invalidPlacement,
  status,
  isSelected,
  onClick,
  onDoubleClick,
  onResizeStart,
  onRotateStart,
  style,
  draggable = true,
  droppable = false,
  draggableReservation,
  zoom = 1,
  isCombinable = false,
  assignmentCandidate = false,
  editable = true,
  compact = false,
}: DraggableTableProps) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragNodeRef,
  } = useDraggable({
    id: table.id,
    data: { table },
    disabled: !draggable,
  });

  const { setNodeRef: setDropNodeRef, isOver } = useDroppable({
    id: table.id,
    data: { table },
    disabled: !droppable,
  });

  const setNodeRef = useCallback(
    (node: HTMLDivElement | null) => {
      setDragNodeRef(node);
      setDropNodeRef(node);
    },
    [setDragNodeRef, setDropNodeRef],
  );

  return (
    <TableCard
      table={table}
      invalidPlacement={invalidPlacement}
      status={status}
      isSelected={isSelected}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onResizeStart={onResizeStart}
      onRotateStart={onRotateStart}
      dragRef={setNodeRef}
      dragProps={draggable ? { ...attributes, ...listeners } : undefined}
      draggableReservation={draggableReservation}
      isCombinable={isCombinable}
      assignmentCandidate={assignmentCandidate}
      editable={editable}
      compact={compact}
      className={cn(
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
        droppable && isOver && 'ring-2 ring-primary ring-offset-1',
      )}
      style={style}
      zoom={zoom}
    />
  );
}

type PaletteItemCardProps = {
  id: string;
  icon: React.ReactNode;
  label: string;
  shortLabel?: string;
  data: PaletteItemData;
  onQuickAdd?: (data: PaletteItemData) => void;
};

function PaletteItemCard({ id, icon, label, shortLabel, data, onQuickAdd }: PaletteItemCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    data: data as Record<string, unknown>,
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      title={`${label} — glissez vers le plan, ou cliquez pour ajouter`}
      aria-label={`${label} — glissez vers le plan, ou cliquez pour ajouter`}
      onClick={() => onQuickAdd?.(data)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onQuickAdd?.(data);
        }
      }}
      className={cn(
        'flex cursor-grab select-none items-center gap-2 rounded-md border border-border bg-background px-2 py-2 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing lg:min-h-9 lg:w-full lg:gap-1 lg:px-1 lg:py-1',
        isDragging && 'opacity-0',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 text-xs font-medium text-foreground lg:whitespace-normal lg:text-center lg:text-[10px] lg:leading-tight">
        <span className="lg:hidden">{label}</span>
        <span className="hidden lg:inline">{shortLabel}</span>
      </span>
    </div>
  );
}

function PaletteExistingTableCard({
  table,
  onPlace,
}: {
  table: CanvasTable;
  onPlace: (table: CanvasTable) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-table-${table.id}`,
    data: { kind: 'placeTable', table } as Record<string, unknown>,
  });
  const displayName = table.displayName ?? table.name;

  return (
    <div
      id={`palette-table-${table.id}`}
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      title={`${displayName} · ${table.capacity} places — glissez vers le plan`}
      aria-label={`${displayName}, ${table.capacity} places — glissez vers le plan`}
      onClick={() => onPlace(table)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onPlace(table);
        }
      }}
      className={cn(
        'flex cursor-grab select-none items-center gap-2 rounded-md border border-border bg-background px-2.5 py-2 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing',
        isDragging && 'opacity-0',
      )}
    >
      <Grip size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-foreground">{displayName}</span>
        <span className="block truncate text-[10px] text-muted-foreground">
          {table.capacity} places
        </span>
      </span>
    </div>
  );
}

type WaitingListPanelProps = {
  entries: WaitingListEntry[];
  isLoading: boolean;
  promotingEntryId: string | null;
  entryErrors: Record<string, string>;
  onPromote: (entryId: string) => void;
};

export function WaitingListPanel({
  entries,
  isLoading,
  promotingEntryId,
  entryErrors,
  onPromote,
}: WaitingListPanelProps) {
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <ListOrdered size={18} className="text-primary" />
            <h3 className="text-base font-semibold">Liste d&apos;attente</h3>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Les demandes en attente se rafraîchissent avec le plan de salle.
          </p>
        </div>
        <Badge variant="outline">{entries.length} en attente</Badge>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((item) => (
            <Skeleton key={item} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/30 p-6 text-center">
          <ListOrdered size={40} className="mb-3 text-muted-foreground/40" />
          <p className="text-sm font-medium">Aucune demande en attente</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Les demandes apparaîtront ici lorsqu&apos;un créneau est complet.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => {
            const customerName =
              `${entry.customerFirstName} ${entry.customerLastName ?? ''}`.trim();
            const slotTime = format(parseISO(entry.slotStart), 'HH:mm', { locale: fr });

            return (
              <article
                key={entry.id}
                className="rounded-xl border border-border bg-card p-4 transition-all duration-200 hover:border-primary/30"
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">#{entry.position}</Badge>
                      <p className="truncate font-medium">{customerName}</p>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <Users size={15} /> {entry.partySize} couvert
                        {entry.partySize > 1 ? 's' : ''}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Clock3 size={15} /> {slotTime}
                      </span>
                      <span>{entry.preferredSectionName || 'Sans préférence de section'}</span>
                    </div>
                  </div>
                  <div className="shrink-0">
                    <Button
                      size="sm"
                      disabled={promotingEntryId === entry.id}
                      onClick={() => onPromote(entry.id)}
                    >
                      {promotingEntryId === entry.id ? 'Proposition...' : 'Proposer une table'}
                    </Button>
                    {entryErrors[entry.id] ? (
                      <p className="mt-2 text-right text-xs text-destructive">
                        {entryErrors[entry.id]}
                      </p>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FloorPlanPalette({
  tablesToPlace,
  totalTables,
  onPlaceTable,
  onCreateTable,
  onAutoLayout,
  autoLayoutLoading,
  onQuickAdd,
}: {
  tablesToPlace: CanvasTable[];
  totalTables: number;
  onPlaceTable: (table: CanvasTable) => void;
  onCreateTable: () => void;
  onAutoLayout: () => void;
  autoLayoutLoading: boolean;
  onQuickAdd: (data: PaletteItemData) => void;
}) {
  return (
    <div className="flex max-h-32 w-full min-w-0 flex-row gap-3 overflow-x-auto overflow-y-hidden border-t border-border bg-card p-2.5 lg:order-1 lg:h-full lg:max-h-none lg:w-36 lg:min-w-36 lg:flex-col lg:items-center lg:gap-2 lg:overflow-y-auto lg:border-r lg:border-t-0 lg:p-2">
      <div className="min-w-36 flex-1 lg:w-full lg:min-w-0 lg:flex-none">
        <h4 className="mb-1.5 hidden text-center text-[9px] font-semibold uppercase tracking-wider text-muted-foreground lg:block">
          Tables à placer · {tablesToPlace.length}
        </h4>
        <div className="flex flex-col gap-2">
          {tablesToPlace.length > 0 ? (
            tablesToPlace.map((table) => (
              <PaletteExistingTableCard key={table.id} table={table} onPlace={onPlaceTable} />
            ))
          ) : (
            <p className="px-1 text-[10px] leading-tight text-muted-foreground">
              {totalTables === 0 ? 'Aucune table configurée.' : 'Toutes les tables sont placées.'}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-full justify-center gap-1 px-2 text-[11px] transition-all duration-200"
            onClick={onCreateTable}
          >
            <Plus size={13} />
            <span>Ajouter une table</span>
          </Button>
          {tablesToPlace.length > 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-full px-1 text-[10px] text-muted-foreground transition-all duration-200 hover:text-foreground"
              onClick={onAutoLayout}
              disabled={autoLayoutLoading}
            >
              {autoLayoutLoading ? 'Placement…' : 'Disposition automatique'}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="w-full lg:w-full">
        <h4 className="mb-1.5 hidden text-center text-[9px] font-semibold uppercase tracking-wider text-muted-foreground lg:block">
          Aménagement
        </h4>
        <div className="flex flex-col gap-2">
          <PaletteItemCard
            id="palette-zone"
            icon={<Square size={18} className="text-muted-foreground" />}
            label="Zone"
            shortLabel="Zone"
            onQuickAdd={onQuickAdd}
            data={{ kind: 'zone' }}
          />
          <PaletteItemCard
            id="palette-wall"
            icon={<Minus size={18} className="text-muted-foreground" />}
            label="Mur"
            shortLabel="Mur"
            onQuickAdd={onQuickAdd}
            data={{ kind: 'wall', type: 'wall' }}
          />
          <PaletteItemCard
            id="palette-door"
            icon={<DoorOpen size={18} className="text-muted-foreground" />}
            label="Porte"
            shortLabel="Porte"
            onQuickAdd={onQuickAdd}
            data={{ kind: 'wall', type: 'door' }}
          />
          <PaletteItemCard
            id="palette-bar"
            icon={<Wine size={18} className="text-muted-foreground" />}
            label="Bar"
            shortLabel="Bar"
            onQuickAdd={onQuickAdd}
            data={{ kind: 'wall', type: 'bar' }}
          />
        </div>
      </div>
    </div>
  );
}

function NewTableOverlay({
  shape,
  capacity,
  zoom,
  invalidPlacement,
}: {
  shape: TableShape;
  capacity: number;
  zoom: number;
  invalidPlacement?: boolean;
}) {
  const table = useMemo<CanvasTable>(
    () => ({
      id: 'palette-new-table',
      name: 'Table',
      capacity,
      minCapacity: 1,
      isActive: true,
      positionX: 0,
      positionY: 0,
      width: null,
      height: null,
      rotation: 0,
      shape,
      sectionName: null,
    }),
    [capacity, shape],
  );
  const { width, height } = getTableSize(table);

  return (
    <TableCard
      table={table}
      invalidPlacement={invalidPlacement}
      isOverlay
      style={{
        transform: `scale(${zoom})`,
        transformOrigin: 'top left',
      }}
    />
  );
}

function NewWallOverlay({ type, zoom }: { type: PaletteWallType; zoom: number }) {
  const wallLengths: Record<PaletteWallType, number> = { wall: 120, door: 80, bar: 120 };
  const length = wallLengths[type];
  const previewHeight = 12;
  const { stroke, strokeWidth, strokeDasharray } = wallStrokeConfig[type];

  return (
    <svg
      width={length}
      height={previewHeight}
      style={{
        transform: `scale(${zoom})`,
        transformOrigin: 'top left',
        overflow: 'visible',
      }}
    >
      <line
        x1={0}
        y1={previewHeight / 2}
        x2={length}
        y2={previewHeight / 2}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={strokeDasharray}
      />
    </svg>
  );
}

export function FloorPlanCanvas({
  orgId,
  mode = 'design',
  floorPlanId,
  initialDelayImpact,
  onInitialDelayApplied,
  onRequestEdit,
  planOptions,
  onSelectPlan,
}: {
  orgId: string;
  mode?: 'service' | 'design';
  floorPlanId?: string;
  initialDelayImpact?: {
    reservationId: string;
    delayMinutes: number;
    delayReportId?: string;
    serviceDate?: string;
  } | null;
  onInitialDelayApplied?: () => void;
  onRequestEdit?: () => void;
  planOptions?: Array<{ id: string; name: string }>;
  onSelectPlan?: (id: string) => void;
}) {
  const api = useApi();
  const { get } = api;
  const apiRef = useRef(api);
  apiRef.current = api;
  const { allowed: copilotAllowed } = useServiceCopilotAccess(mode === 'service', orgId);
  const [floorPlan, setFloorPlan] = useState<FloorPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [planWriteStatus, setPlanWriteStatus] = useState<PlanWriteStatus>(null);
  const [retryingPlanWrites, setRetryingPlanWrites] = useState(false);
  const planWriteQueueRef = useRef<PlanWriteQueue | null>(null);
  if (!planWriteQueueRef.current) {
    planWriteQueueRef.current = new PlanWriteQueue(setPlanWriteStatus);
  }
  const retryingPlanWritesRef = useRef(false);
  const getRef = useRef(get);
  getRef.current = get;
  const enqueuePlanWrite = useCallback(
    <T = unknown,>(path: string, run: () => Promise<T>, retry: () => Promise<T> = run) => {
      const key = mode === 'service' ? null : getPlanWriteKey(path);
      return key ? planWriteQueueRef.current!.enqueue(key, run, retry) : run();
    },
    [mode],
  );
  const post = useCallback(
    <T = unknown,>(path: string, body?: unknown) => {
      const payload = withPlanCreateId(path, body);
      const run = () =>
        payload === undefined
          ? apiRef.current.post<T>(path)
          : apiRef.current.post<T>(path, payload);
      return enqueuePlanWrite(path, run);
    },
    [enqueuePlanWrite],
  );
  const patch = useCallback(
    <T = unknown,>(path: string, body?: unknown) => {
      const run = () => apiRef.current.patch<T>(path, body);
      return enqueuePlanWrite(path, run);
    },
    [enqueuePlanWrite],
  );
  const del = useCallback(
    <T = unknown,>(path: string) => {
      const run = () => apiRef.current.del<T>(path);
      const retry = async () => {
        const planPath = floorPlanId
          ? `restaurants/${orgId}/floor-plans/${floorPlanId}`
          : `restaurants/${orgId}/floor-plan`;
        const plan = await apiRef.current.get<FloorPlan>(planPath);
        if (planEntityExists(plan, path) === false) return undefined as T;
        return run();
      };
      return enqueuePlanWrite(path, run, retry);
    },
    [enqueuePlanWrite, floorPlanId, orgId],
  );
  const patchRef = useRef(patch);
  patchRef.current = patch;
  const postRef = useRef(post);
  postRef.current = post;
  const refreshPlanAfterRetry = useCallback(async () => {
    const path = floorPlanId
      ? `restaurants/${orgId}/floor-plans/${floorPlanId}`
      : `restaurants/${orgId}/floor-plan`;
    try {
      setFloorPlan(await apiRef.current.get<FloorPlan>(path));
      setPlanLoadError('');
      setError('');
    } catch (err) {
      setError(getErrorMessage(err, 'Impossible de synchroniser le plan après la reprise.'));
    }
  }, [floorPlanId, orgId]);
  const retryPlanWrites = useCallback(async () => {
    if (retryingPlanWritesRef.current) return;
    retryingPlanWritesRef.current = true;
    setRetryingPlanWrites(true);
    try {
      const writesRecovered = await planWriteQueueRef.current?.retryFailed();
      if (writesRecovered) await refreshPlanAfterRetry();
    } finally {
      retryingPlanWritesRef.current = false;
      setRetryingPlanWrites(false);
    }
  }, [refreshPlanAfterRetry]);

  // Erreurs par source : le rafraîchissement automatique (10 s) ne doit pas effacer l'échec d'une action,
  // et l'échec du chargement du plan ne doit jamais se lire « Aucune table dans ce plan ».
  const [planLoadError, setPlanLoadError] = useState('');
  const [reservationsError, setReservationsError] = useState('');

  // Historique undo/redo des mutations de géométrie (édition uniquement).
  // Une seule pile unifiée tables + murs : ⌘Z défait exactement la dernière
  // mutation, quel que soit l'objet ou le nombre de tables concernées.
  const {
    record: recordGeometry,
    undo: undoGeometrySnapshot,
    redo: redoGeometrySnapshot,
    canUndo,
    canRedo,
    reset: resetGeometryHistory,
  } = useUndoHistory<GeometrySnapshot>();

  const [zoom, setZoom] = useState(1);
  // Dernière échelle appliquée, lue par les gestes natifs (pincement) qui ne
  // re-rendent pas à chaque déplacement de doigt.
  const zoomRef = useRef(zoom);
  // Dernière échelle de cadrage calculée : elle sert de plancher au zoom
  // manuel (dézoomer sous le niveau « la salle entière tient » ne montre
  // que du vide autour du plan).
  const fitZoomRef = useRef(0);
  zoomRef.current = zoom;
  // Un zoom choisi par le restaurateur n'est plus écrasé par le cadrage auto.
  const userAdjustedZoomRef = useRef(false);
  // Chaque plan reçoit son cadrage d'ouverture une seule fois. Cette identité
  // évite de réutiliser le zoom ou le défilement d'une autre salle et permet de
  // réparer un ancien cadrage conservé pendant un rafraîchissement à chaud.
  const autoFittedPlanIdRef = useRef<string | null>(null);
  // Zone occupée par les tables posées : sert au cadrage d'ouverture et au
  // recentrage. Lue via une ref pour que le déplacement d'une table pendant
  // l'édition ne déclenche pas de recadrage automatique.
  const contentBoundsRef = useRef<ContentBounds | null>(null);
  const tableBoundsRef = useRef<ContentBounds | null>(null);
  // Repère d'édition : masqué par défaut en service pour garder la salle lisible
  // pendant le coup de feu (le bouton et la touche « G » restent disponibles).
  const [gridVisible, setGridVisible] = useState(mode !== 'service');
  const [snap, setSnap] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const live = mode === 'service';
  // Cadres tactiles : sur téléphone et tablette, le plan est la surface
  // principale. On y adapte l'échelle minimale, le cadrage d'ouverture, les
  // gestes et la taille des cartes de table.
  const touchCanvasLayout = useMediaQuery('(max-width: 1023px)');
  const compactTableCards = useIsMobile();
  const coarsePointer = useMediaQuery('(pointer: coarse)');
  const [liveDate, setLiveDate] = useState<string>(format(new Date(), 'yyyy-MM-dd'));
  const serviceToday = format(new Date(), 'yyyy-MM-dd');
  const serviceIsToday = liveDate === serviceToday;
  const [serviceTab, setServiceTab] = useState<'plan' | 'waiting-list'>('plan');
  const [selectedServerFilter, setSelectedServerFilter] = useState<string | null>(null);
  const liveDateRef = useRef(liveDate);
  liveDateRef.current = liveDate;
  const [reservations, setReservations] = useState<PlanningReservation[]>([]);
  // Fiche de service (habitué, allergie, occasion, absences) : une seule lecture pour tout le service.
  const serviceCards = useServiceCards(
    live ? reservations.map((reservation) => reservation.id) : [],
  );
  const [waitingList, setWaitingList] = useState<WaitingListEntry[]>([]);
  const [waitingListLoading, setWaitingListLoading] = useState(false);
  const [promotingWaitingListEntryId, setPromotingWaitingListEntryId] = useState<string | null>(
    null,
  );
  const [waitingListEntryErrors, setWaitingListEntryErrors] = useState<Record<string, string>>({});
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [loadedLiveDate, setLoadedLiveDate] = useState<string | null>(null);
  const waitingListCount =
    loadedLiveDate === liveDate && !waitingListLoading
      ? waitingList.filter((entry) => entry.status === 'PENDING').length
      : 0;
  const [selectedServiceTableId, setSelectedServiceTableId] = useState<string | null>(null);
  const [unassignedPanelOpen, setUnassignedPanelOpen] = useState(false);
  const [unassignedPlacement, setUnassignedPlacement] = useState<{
    reservationId: string | null;
    suggestions: TableSuggestion[];
    targetTableId: string | null;
    message: string | null;
    loading: boolean;
  }>({
    reservationId: null,
    suggestions: [],
    targetTableId: null,
    message: null,
    loading: false,
  });
  const [mobileServiceDetailsOpen, setMobileServiceDetailsOpen] = useState(false);
  const [updatingReservationStateId, setUpdatingReservationStateId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<TableSuggestion[]>([]);
  const [headerAssignment, setHeaderAssignment] = useState<{
    reservation: PlanningReservation;
    suggestions?: TableSuggestion[];
    message?: string;
    saving?: boolean;
  } | null>(null);
  const [delayMinutes, setDelayMinutes] = useState(20);
  const [delayImpact, setDelayImpact] = useState<ServiceCopilotDelayImpact | null>(null);
  const [delayImpactReservationId, setDelayImpactReservationId] = useState<string | null>(null);
  const [delayImpactLoading, setDelayImpactLoading] = useState(false);
  const [communicationDrafts, setCommunicationDrafts] = useState<ServiceCommunicationDraft[]>([]);
  const [communicationDraftsLoading, setCommunicationDraftsLoading] = useState(false);
  const [delayRecoveryConfirmOpen, setDelayRecoveryConfirmOpen] = useState(false);
  const [applyingDelayRecovery, setApplyingDelayRecovery] = useState(false);
  const applyingDelayRecoveryRef = useRef(false);
  const [delayRecoveryRevertConfirmOpen, setDelayRecoveryRevertConfirmOpen] = useState(false);
  const [revertingDelayRecovery, setRevertingDelayRecovery] = useState(false);
  const revertingDelayRecoveryRef = useRef(false);
  const [reportedDelayBannerDismissed, setReportedDelayBannerDismissed] = useState(false);
  const [delayRecoveryApplied, setDelayRecoveryApplied] = useState(false);
  const [delayRecoveryReverted, setDelayRecoveryReverted] = useState(false);
  const [delayRecoveries, setDelayRecoveries] = useState<ServiceCopilotDelayRecoveryHistoryItem[]>(
    [],
  );
  const [servicePulse, setServicePulse] = useState<ServiceCopilotPulse | null>(null);
  const [delayRecoveryIdempotencyKey, setDelayRecoveryIdempotencyKey] = useState<string | null>(
    null,
  );
  const [waitingListAcceptanceConfirmed, setWaitingListAcceptanceConfirmed] = useState(false);
  const [reportedDelayLookupError, setReportedDelayLookupError] = useState('');
  const [appliedDelayRecovery, setAppliedDelayRecovery] = useState<{
    delayedReservationId: string;
    promotedReservationId: string;
    operationId: string;
    delayedCustomerName: string;
    delayedOriginalTableName: string;
    delayedAlternativeTableName: string;
    waitingCustomerName: string;
    waitingTableName: string;
  } | null>(null);
  useEffect(() => {
    setDelayImpact(null);
    setDelayRecoveries([]);
    setCommunicationDrafts([]);
    setAppliedDelayRecovery(null);
    setDelayRecoveryApplied(false);
    setDelayRecoveryReverted(false);
  }, [orgId, copilotAllowed]);

  const lastInitialDelayImpactRef = useRef(initialDelayImpact);
  if (initialDelayImpact) lastInitialDelayImpactRef.current = initialDelayImpact;
  const displayedInitialDelayImpact = copilotAllowed
    ? (initialDelayImpact ?? (appliedDelayRecovery ? lastInitialDelayImpactRef.current : null))
    : null;
  const initialDelayHandledRef = useRef<string | null>(null);
  const [lockedWallIds, setLockedWallIds] = useState<Set<string>>(() => new Set());

  const [selectedTableIds, setSelectedTableIds] = useState<Set<string>>(() => new Set());
  const [lastSelectedTableId, setLastSelectedTableId] = useState<string | null>(null);
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false);
  const [duplicateForm, setDuplicateForm] = useState({
    count: 3,
    spacing: 32,
  });
  const [resizeTableId, setResizeTableId] = useState<string | null>(null);
  const resizeStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    width: number;
    height: number;
    currentWidth?: number;
    currentHeight?: number;
    beforeTable?: FloorPlanTable;
  } | null>(null);
  const [rotateTableId, setRotateTableId] = useState<string | null>(null);
  const rotateStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    startRotation: number;
    centerX: number;
    centerY: number;
    currentRotation?: number;
    beforeTable?: FloorPlanTable;
  } | null>(null);

  const [activeDragData, setActiveDragData] = useState<ActiveDragData | null>(null);
  const [dragStart, setDragStart] = useState<DragStartInfo | null>(null);
  const [tableDragPreview, setTableDragPreview] = useState<{
    positionX: number;
    positionY: number;
    blocker?: CanvasTable;
    chairConflict?: CanvasTable;
  } | null>(null);
  const [tableDropOverlapping, setTableDropOverlapping] = useState(false);
  const [autoLayoutLoading, setAutoLayoutLoading] = useState(false);
  const [autoLayoutNotice, setAutoLayoutNotice] = useState(false);
  // Le placement initial ne doit être proposé qu'une seule fois pour un plan
  // fraîchement chargé. On ne le déclenche pas après la création manuelle d'une
  // table, ni après l'actualisation d'un plan déjà configuré.
  const autoLayoutCandidateRef = useRef<string | null>(null);
  const justDraggedRef = useRef(false);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const tableMoveIdRef = useRef(0);
  const tableMutationVersionRef = useRef(new Map<string, number>());
  const wallMutationVersionRef = useRef(new Map<string, number>());
  const canvasRef = useRef<HTMLDivElement>(null);
  const canvasViewportRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTable, setEditingTable] = useState<CanvasTable | null>(null);
  const [bulkCreateDialogOpen, setBulkCreateDialogOpen] = useState(false);
  const [bulkCreateLoading, setBulkCreateLoading] = useState(false);
  const [bulkCreateForm, setBulkCreateForm] = useState({
    count: '5',
    capacity: '4',
  });
  const [form, setForm] = useState<TableForm>({
    name: '',
    capacity: '4',
    minCapacity: '1',
    shape: 'rect',
    isActive: true,
  });

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingDeleteTableId, setPendingDeleteTableId] = useState<string | null>(null);
  const [multiDeleteConfirmOpen, setMultiDeleteConfirmOpen] = useState(false);

  const [selectedWallId, setSelectedWallId] = useState<string | null>(null);
  const [tablePlacementZoneId, setTablePlacementZoneId] = useState<string | null>(null);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [zoneDragStart, setZoneDragStart] = useState<{
    zone: FloorPlanZone;
    pointerX: number;
    pointerY: number;
  } | null>(null);
  const [resizeZoneId, setResizeZoneId] = useState<string | null>(null);
  const resizeZoneStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    width: number;
    height: number;
    currentWidth?: number;
    currentHeight?: number;
  } | null>(null);
  const zoneJustDraggedRef = useRef(false);
  const [wallDragMode, setWallDragMode] = useState<'move' | 'resize-start' | 'resize-end' | null>(
    null,
  );
  const [wallDragStart, setWallDragStart] = useState<{
    pointerX: number;
    pointerY: number;
    wall: FloorPlanWall;
  } | null>(null);
  const wallJustDraggedRef = useRef(false);
  const wallDragCurrentRef = useRef<FloorPlanWall | null>(null);
  // Guide d'alignement mur : pendant un drag de mur depuis la palette, si un mur
  // existant de meme orientation a son axe aligne (<seuil), on stocke l'axe guide
  // pour afficher un trait pointille pleine hauteur/largeur (style Canva).
  const [wallAlignGuide, setWallAlignGuide] = useState<{ axis: 'x' | 'y'; value: number } | null>(
    null,
  );
  // Guides de table (bords et centres) visibles pendant le déplacement : ils
  // rendent le magnétisme compréhensible au lieu de laisser un déplacement
  // sembler arbitraire.
  const [tableAlignGuides, setTableAlignGuides] =
    useState<TableAlignmentGuides>(emptyTableAlignmentGuides);
  const [wallLengthGuide, setWallLengthGuide] = useState<WallLengthGuide | null>(null);
  const [wallResizeAlignGuide, setWallResizeAlignGuide] = useState<WallResizeAlignGuide | null>(
    null,
  );
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [floorSettings, setFloorSettings] = useState({
    name: '',
    widthMeters: formatRoomMeters(DEFAULT_CANVAS_WIDTH),
    lengthMeters: formatRoomMeters(DEFAULT_CANVAS_HEIGHT),
  });
  const [settingsError, setSettingsError] = useState('');

  const canvasWidth = floorPlan?.width ?? DEFAULT_CANVAS_WIDTH;
  const canvasHeight = floorPlan?.height ?? DEFAULT_CANVAS_HEIGHT;

  // Sur écran tactile, un glissement d'un doigt doit faire défiler le plan :
  // déplacer une table demande donc une pression maintenue. À la souris, on
  // conserve le seuil historique de 3 px.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: coarsePointer ? { delay: 260, tolerance: 8 } : { distance: 3 },
    }),
  );

  const minZoom = touchCanvasLayout ? MIN_ZOOM_TOUCH : MIN_ZOOM;

  /**
   * Cadre le plan dans la fenêtre visible : la zone réellement occupée par les
   * tables quand il y en a (sinon le plan entier, comportement historique), et
   * renvoie l'échelle appliquée ainsi que le défilement qui centre la zone,
   * pour pouvoir enchaîner le cadrage sans attendre le prochain rendu.
   */
  const fitCanvasToViewport = useCallback(
    (focusTables = false) => {
      const viewport = canvasViewportRef.current;
      if (!viewport) return null;
      const viewportWidth = viewport.clientWidth;
      const viewportHeight = viewport.clientHeight;
      if (viewportWidth < 40 || viewportHeight < 40) return null;
      const fitMinimum = 0.01;
      const fitFloor = touchCanvasLayout ? TOUCH_FIT_FLOOR : fitMinimum;
      // Plancher du dézoom manuel : cadrer le plan entier.
      const fullCanvasZoom = computeFitZoom({
        viewportWidth,
        viewportHeight,
        canvasWidth,
        canvasHeight,
        minZoom: fitMinimum,
        floor: fitFloor,
      });
      const stageBounds = contentBoundsRef.current;
      let bounds = focusTables ? (tableBoundsRef.current ?? stageBounds) : stageBounds;
      if (focusTables && bounds && stageBounds) {
        const roomZoom = Math.min(
          viewportWidth / stageBounds.width,
          viewportHeight / stageBounds.height,
        );
        const tableZoom = Math.min(viewportWidth / bounds.width, viewportHeight / bounds.height);
        // shortcut: seuil empirique de moitié ; ajuster si des plans réels restent illisibles.
        if (roomZoom >= tableZoom / 2) bounds = stageBounds;
      }
      let nextZoom = fullCanvasZoom;
      if (bounds) {
        const contentZoom = computeFitZoom({
          viewportWidth,
          viewportHeight,
          canvasWidth: bounds.width,
          canvasHeight: bounds.height,
          minZoom: fitMinimum,
          floor: fitFloor,
        });
        nextZoom = clampZoom(Math.min(contentZoom, MAX_ZOOM), fitMinimum, MAX_ZOOM);
      }
      const scroll =
        live && serviceTab === 'plan' && bounds && stageBounds
          ? {
              left: Math.max(
                0,
                (bounds.x - stageBounds.x + bounds.width / 2) * nextZoom - viewportWidth / 2,
              ),
              top: Math.max(
                0,
                (bounds.y - stageBounds.y + bounds.height / 2) * nextZoom - viewportHeight / 2,
              ),
            }
          : computeFocusScroll({
              viewportWidth,
              viewportHeight,
              region: bounds ?? { x: 0, y: 0, width: canvasWidth, height: canvasHeight },
              zoom: nextZoom,
            });
      zoomRef.current = nextZoom;
      fitZoomRef.current = live && !focusTables ? nextZoom : fullCanvasZoom;
      setZoom(nextZoom);
      return { zoom: nextZoom, scroll };
    },
    [canvasHeight, canvasWidth, live, serviceTab, touchCanvasLayout],
  );

  /**
   * Plancher du zoom manuel sur écran tactile : quand le plan tient déjà
   * entièrement à l'échelle de cadrage, dézoomer davantage ne montre que du
   * vide autour de la salle. Si le cadrage a été plafonné par le plancher
   * tactile (plan plus grand que la fenêtre), on garde la marge MIN_ZOOM_TOUCH.
   */
  const manualMinZoom = useCallback(() => {
    if (live) return Math.min(touchCanvasLayout ? MIN_ZOOM_TOUCH : MIN_ZOOM, fitZoomRef.current);
    if (!touchCanvasLayout) return MIN_ZOOM;
    const fit = fitZoomRef.current;
    return fit >= TOUCH_FIT_FLOOR ? fit : MIN_ZOOM_TOUCH;
  }, [live, touchCanvasLayout]);

  /** Zoom manuel : il ne doit plus être écrasé par le cadrage automatique. */
  function changeZoom(delta: number) {
    userAdjustedZoomRef.current = true;
    setZoom((current) => clampZoom(Math.round((current + delta) * 100) / 100, manualMinZoom()));
  }

  /** Replace le plan à l'échelle de cadrage et le centre (double-tap, bouton). */
  function resetView() {
    const viewport = canvasViewportRef.current;
    if (!viewport) return;
    userAdjustedZoomRef.current = false;
    const fit = fitCanvasToViewport();
    const scroll = fit?.scroll ?? {
      ...computeCenterScroll({
        viewportWidth: viewport.clientWidth,
        viewportHeight: viewport.clientHeight,
        canvasWidth,
        canvasHeight,
        zoom: zoomRef.current,
      }),
    };
    window.requestAnimationFrame(() => {
      viewport.scrollTo({ ...scroll, behavior: 'smooth' });
    });
  }

  const resetViewRef = useRef(resetView);
  resetViewRef.current = resetView;

  // Même périmètre de cadrage en édition et en service pour garder une échelle
  // cohérente quand on passe d'une vue à l'autre.
  useIsomorphicLayoutEffect(() => {
    if (loading || error) return;
    if (serviceTab !== 'plan') return;
    const planId = floorPlan?.id;
    if (!planId || autoFittedPlanIdRef.current === planId) return;
    const viewport = canvasViewportRef.current;
    userAdjustedZoomRef.current = false;
    let retryFrame: number | null = null;
    const applyInitialFit = () => {
      const fit = fitCanvasToViewport(true);
      if (!viewport || !fit) {
        // Le premier frame peut précéder la mesure finale du panneau sur
        // Safari. Un second essai suffit sans installer d'observateur durable.
        retryFrame = window.requestAnimationFrame(() => {
          const retryFit = fitCanvasToViewport(true);
          if (!viewport || !retryFit) return;
          viewport.scrollLeft = retryFit.scroll.left;
          viewport.scrollTop = retryFit.scroll.top;
          autoFittedPlanIdRef.current = planId;
        });
        return;
      }
      autoFittedPlanIdRef.current = planId;
      retryFrame = window.requestAnimationFrame(() => {
        viewport.scrollLeft = fit.scroll.left;
        viewport.scrollTop = fit.scroll.top;
      });
    };
    applyInitialFit();
    return () => {
      if (retryFrame !== null) window.cancelAnimationFrame(retryFrame);
    };
  }, [loading, error, serviceTab, floorPlan?.id, fitCanvasToViewport]);

  const dockedServiceInspectorOpen =
    live && !touchCanvasLayout && (selectedServiceTableId !== null || unassignedPanelOpen);
  useIsomorphicLayoutEffect(() => {
    if (dockedServiceInspectorOpen) userAdjustedZoomRef.current = false;
  }, [dockedServiceInspectorOpen]);

  useIsomorphicLayoutEffect(() => {
    if (!live || serviceTab !== 'plan') return;
    const viewport = canvasViewportRef.current;
    if (!viewport) return;

    const fitToSize = () => {
      if (userAdjustedZoomRef.current) return;
      const fit = fitCanvasToViewport(true);
      if (!fit) return;
      window.requestAnimationFrame(() => {
        viewport.scrollLeft = fit.scroll.left;
        viewport.scrollTop = fit.scroll.top;
      });
    };

    fitToSize();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fitToSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [
    fitCanvasToViewport,
    live,
    loading,
    dockedServiceInspectorOpen,
    selectedServiceTableId,
    unassignedPanelOpen,
    serviceTab,
  ]);

  // Gestes du plan : pincer pour zoomer, double-tap pour recadrer. Le
  // défilement à un doigt reste natif (voir `touch-action` sur la fenêtre).
  useEffect(() => {
    const viewport = canvasViewportRef.current;
    // Live est une vue finalisée : pas de zoom local ni de double-tap qui
    // permettrait de sortir du cadrage utile. Le défilement natif reste
    // disponible lorsque la zone est plus large que la fenêtre.
    if (!viewport || (live && serviceTab === 'plan')) return;

    let pinchStart: { distance: number; zoom: number } | null = null;
    let lastTap: { time: number; x: number; y: number } | null = null;

    function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }) {
      return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function applyZoomAtPoint(nextZoom: number, clientX: number, clientY: number) {
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const offsetX = clientX - rect.left;
      const offsetY = clientY - rect.top;
      const currentZoom = zoomRef.current;
      if (Math.abs(nextZoom - currentZoom) < 0.005) return;
      const nextScroll = computeZoomAnchorScroll({
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
        offsetX,
        offsetY,
        zoom: currentZoom,
        nextZoom,
      });
      userAdjustedZoomRef.current = true;
      zoomRef.current = nextZoom;
      setZoom(nextZoom);
      // La surface de défilement suit l'échelle : on repositionne le point
      // touché une fois le rendu appliqué.
      window.requestAnimationFrame(() => {
        viewport.scrollLeft = nextScroll.left;
        viewport.scrollTop = nextScroll.top;
      });
    }

    function handleTouchStart(event: TouchEvent) {
      const touches = Array.from(event.touches).map((touch) => ({
        x: touch.clientX,
        y: touch.clientY,
      }));
      if (touches.length >= 2) {
        pinchStart = {
          distance: distanceBetween(touches[0], touches[1]),
          zoom: zoomRef.current,
        };
        lastTap = null;
        return;
      }
      if (touches.length !== 1) return;
      const target = event.target as HTMLElement | null;
      // Un appui sur une table ou un bouton garde son action : pas de recadrage.
      if (target?.closest('[role="button"], button, a, input, select')) {
        lastTap = null;
        return;
      }
      const tap = { time: event.timeStamp, x: touches[0].x, y: touches[0].y };
      if (isDoubleTap(lastTap, tap)) {
        lastTap = null;
        resetViewRef.current();
        return;
      }
      lastTap = tap;
    }

    function handleTouchMove(event: TouchEvent) {
      if (!pinchStart || event.touches.length < 2) return;
      const touches = Array.from(event.touches).map((touch) => ({
        x: touch.clientX,
        y: touch.clientY,
      }));
      // Le pincement pilote le plan, pas la page : sans cela Safari zoome la vue.
      if (event.cancelable) event.preventDefault();
      if (pinchStart.distance < 8) return;
      const ratio = distanceBetween(touches[0], touches[1]) / pinchStart.distance;
      applyZoomAtPoint(
        clampZoom(pinchStart.zoom * ratio, manualMinZoom()),
        (touches[0].x + touches[1].x) / 2,
        (touches[0].y + touches[1].y) / 2,
      );
    }

    function handleTouchEnd(event: TouchEvent) {
      if (event.touches.length < 2) pinchStart = null;
    }

    function handleWheel(event: WheelEvent) {
      // Pincement sur pavé tactile (Ctrl + molette). Le zoom navigateur reste
      // disponible ailleurs dans la page.
      if (!event.ctrlKey) return;
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0025);
      applyZoomAtPoint(clampZoom(zoomRef.current * factor, minZoom), event.clientX, event.clientY);
    }

    function handleDoubleClick(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[role="button"], button, a, input, select')) return;
      resetViewRef.current();
    }

    viewport.addEventListener('touchstart', handleTouchStart, { passive: true });
    viewport.addEventListener('touchmove', handleTouchMove, { passive: false });
    viewport.addEventListener('touchend', handleTouchEnd, { passive: true });
    viewport.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    viewport.addEventListener('dblclick', handleDoubleClick);
    return () => {
      viewport.removeEventListener('touchstart', handleTouchStart);
      viewport.removeEventListener('touchmove', handleTouchMove);
      viewport.removeEventListener('touchend', handleTouchEnd);
      viewport.removeEventListener('touchcancel', handleTouchEnd);
      viewport.removeEventListener('wheel', handleWheel);
      viewport.removeEventListener('dblclick', handleDoubleClick);
    };
  }, [loading, live, manualMinZoom, minZoom, serviceTab]);

  const loadFloorPlan = useCallback(async () => {
    setLoading(true);
    setPlanLoadError('');
    try {
      const path = floorPlanId
        ? `restaurants/${orgId}/floor-plans/${floorPlanId}`
        : `restaurants/${orgId}/floor-plan`;
      const data = await getRef.current<FloorPlan>(path);
      const loadedTables = [
        ...data.sections.flatMap((section) => section.tables),
        ...(data.tables ?? []),
      ];
      const allLoadedTablesAreUnplaced =
        loadedTables.length > 0 &&
        loadedTables.every((table) => table.positionX === null || table.positionY === null);
      autoLayoutCandidateRef.current = !live && allLoadedTablesAreUnplaced ? data.id : null;
      setAutoLayoutNotice(false);
      // purge tout historique et version obsolète avant de remplacer le plan —
      // les snapshots référencent les objets de l'ancien chargement
      resetGeometryHistory();
      tableMutationVersionRef.current.clear();
      wallMutationVersionRef.current.clear();
      setFloorPlan(data);
    } catch (err) {
      setPlanLoadError(getErrorMessage(err, 'Impossible de charger le plan de salle.'));
    } finally {
      setLoading(false);
    }
  }, [orgId, floorPlanId, live, resetGeometryHistory]);

  const pollAbortRef = useRef<AbortController | null>(null);
  const pollInFlightRef = useRef(false);

  const loadReservations = useCallback(
    async ({ force }: { force?: boolean } = {}) => {
      if (!live) return;
      if (pollInFlightRef.current && !force) return;
      if (force) {
        pollAbortRef.current?.abort();
      }
      const controller = new AbortController();
      pollAbortRef.current = controller;
      pollInFlightRef.current = true;
      try {
        const query = floorPlanId
          ? `date=${liveDate}&floorPlanId=${floorPlanId}`
          : `date=${liveDate}`;
        setWaitingListLoading(true);
        const planPath = floorPlanId
          ? `restaurants/${orgId}/floor-plans/${floorPlanId}`
          : `restaurants/${orgId}/floor-plan`;
        const [
          reservationsResult,
          waitingListResult,
          delayRecoveriesResult,
          pulseResult,
          planResult,
        ] = await Promise.allSettled([
          getRef.current<PlanningReservation[]>(
            `restaurants/${orgId}/floor-plan/reservations?${query}`,
            {
              signal: controller.signal,
            },
          ),
          getRef.current<unknown[]>(
            `restaurants/${orgId}/waiting-list?date=${liveDate}&status=PENDING`,
            { signal: controller.signal },
          ),
          copilotAllowed
            ? getRef.current<ServiceCopilotDelayRecoveryHistoryResponse>(
                `restaurants/${orgId}/service-copilot/delay-recoveries?date=${liveDate}&limit=10`,
                { signal: controller.signal },
              )
            : Promise.resolve({ recoveries: [] }),
          getRef.current<ServiceCopilotPulse>(
            `restaurants/${orgId}/service-copilot/pulse?date=${liveDate}`,
            { signal: controller.signal },
          ),
          getRef.current<FloorPlan>(planPath, { signal: controller.signal }),
        ]);
        if (pollAbortRef.current !== controller) return;
        if (liveDateRef.current !== liveDate) return;
        if (planResult.status === 'fulfilled') {
          setFloorPlan(planResult.value);
          setPlanLoadError('');
        }
        if (reservationsResult.status === 'rejected') throw reservationsResult.reason;
        let secondaryError = '';
        setReservations(reservationsResult.value);
        if (waitingListResult.status === 'fulfilled') {
          setWaitingList(
            mapWaitingListEntries(
              Array.isArray(waitingListResult.value) ? waitingListResult.value : [],
            ),
          );
        } else {
          setWaitingList([]);
          secondaryError = getErrorMessage(
            waitingListResult.reason,
            "Impossible de charger la liste d'attente",
          );
        }
        if (delayRecoveriesResult.status === 'fulfilled') {
          setDelayRecoveries(
            Array.isArray(delayRecoveriesResult.value.recoveries)
              ? delayRecoveriesResult.value.recoveries
              : [],
          );
        } else {
          secondaryError = getErrorMessage(
            delayRecoveriesResult.reason,
            'Impossible de charger l’historique des plans',
          );
        }
        if (pulseResult.status === 'fulfilled') {
          setServicePulse(pulseResult.value);
        } else {
          // Le plan et les actions restent utilisables si le résumé secondaire
          // est temporairement indisponible.
          setServicePulse(null);
        }
        setReservationsError(secondaryError);
        setLastUpdatedAt(Date.now());
        setLoadedLiveDate(liveDate);
      } catch (err) {
        if (pollAbortRef.current !== controller) return;
        if (controller.signal.aborted) return;
        setReservationsError(getErrorMessage(err, 'Impossible de charger les réservations'));
      } finally {
        if (pollAbortRef.current === controller) {
          setWaitingListLoading(false);
        }
        if (pollAbortRef.current === controller) {
          pollInFlightRef.current = false;
        }
      }
    },
    [copilotAllowed, orgId, live, liveDate, floorPlanId],
  );

  const updateReservationState = useCallback(
    async (reservationId: string, state: 'SEATED' | 'HONORED') => {
      if (!orgId) return;
      setUpdatingReservationStateId(reservationId);
      try {
        await patchRef.current<void>(
          `restaurants/${orgId}/floor-plan/reservations/${reservationId}/state`,
          { state },
        );
        setReservations((prev) => prev.map((r) => (r.id === reservationId ? { ...r, state } : r)));
        await loadReservations({ force: true });
      } catch (err) {
        setError(getErrorMessage(err, 'Impossible de mettre à jour le statut'));
      } finally {
        setUpdatingReservationStateId(null);
      }
    },
    [orgId, loadReservations],
  );

  // Place un client sans réservation. Rejette avec un message clair : le formulaire de la table
  // l'affiche, il n'y a donc pas de bandeau d'erreur global ici.
  const createWalkIn = useCallback(
    async (tableId: string, partySize: number, customerName?: string): Promise<void> => {
      if (!orgId) return;
      const table = floorPlan?.tables?.find((t) => t.id === tableId);
      const resolvedCustomerName = customerName?.trim() || WALK_IN_DEFAULT_NAME;
      let created: { id: string };
      try {
        created = await postRef.current<{ id: string }>(
          `restaurants/${orgId}/floor-plan/walk-ins`,
          {
            tableId,
            partySize,
            customerName: resolvedCustomerName,
            idempotencyKey: crypto.randomUUID(),
          },
        );
      } catch (err) {
        throw new Error(walkInErrorMessage(err));
      }
      const now = new Date().toISOString();
      setReservations((prev) => [
        ...prev,
        {
          id: created.id,
          tableId,
          tableName: table?.name ?? null,
          sectionName: table?.sectionName ?? null,
          startsAt: now,
          endsAt: now,
          partySize,
          customerName: resolvedCustomerName,
          state: 'SEATED',
          seatedAt: now,
        },
      ]);
      await loadReservations({ force: true });
    },
    [orgId, floorPlan?.tables, loadReservations],
  );

  const promoteWaitingListEntry = useCallback(
    async (entryId: string) => {
      if (!orgId) return;
      setPromotingWaitingListEntryId(entryId);
      setWaitingListEntryErrors((prev) => {
        const next = { ...prev };
        delete next[entryId];
        return next;
      });
      try {
        await postRef.current(`restaurants/${orgId}/waiting-list/${entryId}/promote`);
        await loadReservations({ force: true });
      } catch (err) {
        const message = getErrorMessage(err, 'Impossible de proposer une table');
        if (message === 'no_compatible_table' || message.includes('no_compatible_table')) {
          setWaitingListEntryErrors((prev) => ({ ...prev, [entryId]: 'Aucune table compatible' }));
        } else {
          setError(message);
        }
      } finally {
        setPromotingWaitingListEntryId(null);
      }
    },
    [orgId, loadReservations],
  );

  async function openHeaderAssignment(reservation: PlanningReservation) {
    const request = { reservation };
    setHeaderAssignment(request);
    try {
      const result = await getRef.current<{ suggestions?: TableSuggestion[]; reason?: string }>(
        `restaurants/${orgId}/floor-plan/reservations/${reservation.id}/suggest-table`,
      );
      const available = (result.suggestions ?? []).filter(
        (table) => !reservations.some((r) => r.state === 'SEATED' && r.tableId === table.tableId),
      );
      setHeaderAssignment((current) =>
        current === request
          ? {
              reservation,
              suggestions: available,
              message: available.length ? undefined : 'Aucune table disponible',
            }
          : current,
      );
    } catch (err) {
      setHeaderAssignment((current) =>
        current === request
          ? { reservation, message: getErrorMessage(err, 'Impossible de suggérer une table') }
          : current,
      );
    }
  }

  const suggestTable = useCallback(
    async (reservationId: string) => {
      if (!orgId) return;
      setSuggestions([]);
      try {
        const query = floorPlanId ? `?floorPlanId=${floorPlanId}` : '';
        const res = await getRef.current<{ suggestions?: TableSuggestion[]; reason?: string }>(
          `restaurants/${orgId}/floor-plan/reservations/${reservationId}/suggest-table${query}`,
        );
        const list = res.suggestions ?? [];
        if (list.length > 0) setSuggestions(list);
        else setError(res.reason || 'Aucune table disponible');
      } catch (err) {
        setError(getErrorMessage(err, 'Impossible de suggérer une table'));
      }
    },
    [orgId, floorPlanId],
  );

  const simulateDelayImpact = useCallback(
    async (reservationId: string) => {
      if (!orgId || !copilotAllowed) return;
      setDelayImpactLoading(true);
      setDelayImpact(null);
      setCommunicationDrafts([]);
      setWaitingListAcceptanceConfirmed(false);
      setDelayRecoveryApplied(false);
      setDelayRecoveryReverted(false);
      setAppliedDelayRecovery(null);
      lastInitialDelayImpactRef.current = { reservationId, delayMinutes };
      setDelayRecoveryIdempotencyKey(crypto.randomUUID());
      setDelayImpactReservationId(reservationId);
      try {
        const result = await postRef.current<ServiceCopilotDelayImpact>(
          `restaurants/${orgId}/service-copilot/delay-impact`,
          { reservationId, delayMinutes },
        );
        setDelayImpact(result);
      } catch (err) {
        setError(getErrorMessage(err, 'Impossible d’analyser ce retard'));
      } finally {
        setDelayImpactLoading(false);
      }
    },
    [orgId, delayMinutes, copilotAllowed],
  );

  const updateDelayMinutes = useCallback(
    (nextDelayMinutes: number) => {
      const normalized = Math.min(180, Math.max(5, nextDelayMinutes || 5));
      setDelayMinutes(normalized);
      if (delayImpact && normalized !== delayImpact.delayMinutes) {
        setDelayImpact(null);
        setCommunicationDrafts([]);
        setWaitingListAcceptanceConfirmed(false);
        setDelayRecoveryIdempotencyKey(null);
      }
    },
    [delayImpact],
  );

  useEffect(() => {
    if (live && initialDelayImpact?.serviceDate && initialDelayImpact.serviceDate !== liveDate) {
      setLiveDate(initialDelayImpact.serviceDate);
    }
  }, [initialDelayImpact?.serviceDate, live, liveDate]);

  useEffect(() => {
    if (!copilotAllowed || !live || !initialDelayImpact) {
      initialDelayHandledRef.current = null;
      setReportedDelayLookupError('');
      return;
    }
    if (initialDelayImpact.serviceDate && initialDelayImpact.serviceDate !== liveDate) return;
    const handledKey = `${initialDelayImpact.reservationId}:${initialDelayImpact.delayMinutes}:${initialDelayImpact.delayReportId ?? 'manual'}`;
    if (initialDelayHandledRef.current === handledKey) return;
    const reservation = reservations.find((item) => item.id === initialDelayImpact.reservationId);
    if (!reservation) {
      if (lastUpdatedAt && loadedLiveDate === liveDate) {
        setReportedDelayLookupError(
          'La réservation signalée n’est pas visible pour cette date. Vérifiez la date du service.',
        );
      }
      return;
    }
    if (!reservation.tableId) {
      setReportedDelayLookupError(
        'Cette réservation n’a pas de table initiale : aucun déplacement automatique n’est possible.',
      );
      initialDelayHandledRef.current = handledKey;
      return;
    }
    initialDelayHandledRef.current = handledKey;
    setDelayMinutes(initialDelayImpact.delayMinutes);
    setReportedDelayBannerDismissed(false);
    setDelayRecoveryApplied(false);
    setDelayRecoveryReverted(false);
    setAppliedDelayRecovery(null);
    setWaitingListAcceptanceConfirmed(false);
    setCommunicationDrafts([]);
    setReportedDelayLookupError('');
    setDelayRecoveryIdempotencyKey(crypto.randomUUID());
    setSelectedServiceTableId(reservation.tableId);
    void (async () => {
      setDelayImpactLoading(true);
      setDelayImpactReservationId(reservation.id);
      try {
        const result = await postRef.current<ServiceCopilotDelayImpact>(
          `restaurants/${orgId}/service-copilot/delay-impact`,
          { reservationId: reservation.id, delayMinutes: initialDelayImpact.delayMinutes },
        );
        setDelayImpact(result);
      } catch (err) {
        setError(getErrorMessage(err, 'Impossible d’analyser ce retard'));
      } finally {
        setDelayImpactLoading(false);
      }
    })();
  }, [
    copilotAllowed,
    initialDelayImpact,
    lastUpdatedAt,
    live,
    liveDate,
    loadedLiveDate,
    orgId,
    reservations,
  ]);

  const applyDelayRecovery = useCallback(async () => {
    if (applyingDelayRecoveryRef.current) return;
    if (
      !orgId ||
      !copilotAllowed ||
      !delayImpact ||
      !delayImpact.feasible ||
      !delayImpactReservationId ||
      !delayImpact.alternativeTable ||
      !delayImpact.waitingListEntry
    ) {
      return;
    }
    applyingDelayRecoveryRef.current = true;
    setApplyingDelayRecovery(true);
    try {
      const result = await postRef.current<DelayRecoveryApiResult>(
        `restaurants/${orgId}/service-copilot/delay-impact/apply`,
        {
          reservationId: delayImpactReservationId,
          delayMinutes: delayImpact.delayMinutes,
          alternativeTableId: delayImpact.alternativeTable.id,
          waitingListEntryId: delayImpact.waitingListEntry.id,
          waitingListAcceptanceConfirmed,
          delayReportId: initialDelayImpact?.delayReportId,
          idempotencyKey: delayRecoveryIdempotencyKey ?? crypto.randomUUID(),
        },
      );
      setAppliedDelayRecovery({
        delayedReservationId: result.delayedReservationId,
        promotedReservationId: result.promotedReservationId,
        operationId: result.operationId,
        delayedCustomerName: delayImpact.delayedReservation?.customerName || 'Client',
        delayedOriginalTableName:
          delayImpact.delayedReservation?.originalTableName || 'Table initiale',
        delayedAlternativeTableName: delayImpact.alternativeTable.name,
        waitingCustomerName: delayImpact.waitingListEntry.customerName,
        waitingTableName: delayImpact.delayedReservation?.originalTableName || 'Table libérée',
      });
      setDelayRecoveryConfirmOpen(false);
      setDelayImpact(null);
      setCommunicationDrafts([]);
      setDelayRecoveryApplied(true);
      setDelayRecoveryReverted(false);
      onInitialDelayApplied?.();
      await loadReservations({ force: true });
    } catch (err) {
      setDelayRecoveryConfirmOpen(false);
      setError(getErrorMessage(err, 'Le plan a changé ; relancez l’analyse avant de confirmer.'));
    } finally {
      applyingDelayRecoveryRef.current = false;
      setApplyingDelayRecovery(false);
    }
  }, [
    orgId,
    copilotAllowed,
    delayImpact,
    delayImpactReservationId,
    waitingListAcceptanceConfirmed,
    initialDelayImpact?.delayReportId,
    delayRecoveryIdempotencyKey,
    onInitialDelayApplied,
    loadReservations,
  ]);

  const revertDelayRecovery = useCallback(async () => {
    if (!copilotAllowed || revertingDelayRecoveryRef.current || !orgId || !appliedDelayRecovery)
      return;
    revertingDelayRecoveryRef.current = true;
    setRevertingDelayRecovery(true);
    try {
      await postRef.current(`restaurants/${orgId}/service-copilot/delay-impact/revert`, {
        reservationId: appliedDelayRecovery.delayedReservationId,
        operationId: appliedDelayRecovery.operationId,
      });
      setDelayRecoveryRevertConfirmOpen(false);
      setDelayRecoveryReverted(true);
      await loadReservations({ force: true });
    } catch (err) {
      setDelayRecoveryRevertConfirmOpen(false);
      setError(
        getErrorMessage(
          err,
          'Le service a évolué depuis l’application. Corrigez la situation manuellement.',
        ),
      );
    } finally {
      revertingDelayRecoveryRef.current = false;
      setRevertingDelayRecovery(false);
    }
  }, [copilotAllowed, orgId, appliedDelayRecovery, loadReservations]);

  const openPersistedRecoveryRevert = useCallback(
    (recovery: ServiceCopilotDelayRecoveryHistoryItem) => {
      if (!recovery.revertible) return;
      lastInitialDelayImpactRef.current = {
        reservationId: recovery.delayedReservationId,
        delayMinutes: recovery.delayMinutes,
      };
      setAppliedDelayRecovery({
        delayedReservationId: recovery.delayedReservationId,
        promotedReservationId: recovery.promotedReservationId,
        operationId: recovery.operationId,
        delayedCustomerName: recovery.delayedCustomerName,
        delayedOriginalTableName: recovery.originalTableName,
        delayedAlternativeTableName: recovery.alternativeTableName,
        waitingCustomerName: recovery.waitingCustomerName,
        waitingTableName: recovery.originalTableName,
      });
      setDelayRecoveryApplied(true);
      setDelayRecoveryReverted(false);
      setReportedDelayBannerDismissed(false);
      setDelayRecoveryRevertConfirmOpen(true);
    },
    [],
  );

  const loadCommunicationDrafts = useCallback(async () => {
    if (!orgId || !delayImpactReservationId || !delayImpact?.feasible) return;
    setCommunicationDraftsLoading(true);
    try {
      const result = await postRef.current<ServiceCommunicationDraftsResponse>(
        `restaurants/${orgId}/service-copilot/delay-impact/drafts`,
        { reservationId: delayImpactReservationId, delayMinutes: delayImpact.delayMinutes },
      );
      const planChanged =
        result.impact.alternativeTable?.id !== delayImpact.alternativeTable?.id ||
        result.impact.waitingListEntry?.id !== delayImpact.waitingListEntry?.id;
      setDelayImpact(result.impact);
      setCommunicationDrafts(result.drafts);
      if (planChanged) {
        setWaitingListAcceptanceConfirmed(false);
        setError('Le plan a évolué pendant la préparation des messages. Vérifiez-le à nouveau.');
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Impossible de préparer les brouillons'));
    } finally {
      setCommunicationDraftsLoading(false);
    }
  }, [orgId, delayImpact, delayImpactReservationId]);

  const assignTable = useCallback(
    async (reservationId: string, tableId: string) => {
      if (!orgId) return;
      try {
        await patchRef.current<void>(
          `restaurants/${orgId}/floor-plan/reservations/${reservationId}/assign-table`,
          { tableId },
        );
        setReservations((prev) =>
          prev.map((r) => (r.id === reservationId ? { ...r, tableId } : r)),
        );
        setSuggestions([]);
        await loadReservations({ force: true });
        return true;
      } catch (err) {
        setError(getErrorMessage(err, 'Impossible d’assigner la table'));
        return false;
      }
    },
    [orgId, loadReservations],
  );

  useEffect(() => {
    if (!orgId) return;
    loadFloorPlan();
  }, [orgId, loadFloorPlan]);

  useEffect(() => {
    if (!orgId || !live) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (timer) return;
      timer = setInterval(() => {
        loadReservations();
      }, 10000);
    };
    const stopPolling = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        loadReservations({ force: true });
        startPolling();
      }
    };

    if (!document.hidden) {
      loadReservations({ force: true });
      startPolling();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      pollAbortRef.current?.abort();
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [orgId, live, liveDate, loadReservations]);

  const allTables = useMemo<CanvasTable[]>(() => {
    if (!floorPlan) return [];
    const sectionTables = floorPlan.sections.flatMap((section) =>
      section.tables.map((table) => ({
        ...table,
        sectionId: section.id,
        sectionName: section.name,
      })),
    );
    const topTables = (floorPlan.tables ?? []).map((table) => ({
      ...table,
      sectionName: table.sectionName ?? null,
    }));
    const sectionTableIds = new Set(sectionTables.map((table) => table.id));
    const combined = [
      ...sectionTables,
      ...topTables.filter((table) => !sectionTableIds.has(table.id)),
    ];
    const usedNumbers = new Set(
      combined
        .map((table) => Number(table.name.match(/^T0*(\d+)$/i)?.[1] ?? 0))
        .filter((number) => number > 0),
    );
    let nextNumber = 1;

    return combined.map((table) => {
      const tableName = table.name.trim();
      const existingNumber = Number(table.name.match(/^T0*(\d+)$/i)?.[1] ?? 0);
      if (existingNumber > 0) return { ...table, displayName: `T${existingNumber}` };
      if (tableName) return { ...table, displayName: tableName };
      while (usedNumbers.has(nextNumber)) nextNumber += 1;
      const displayName = `T${nextNumber}`;
      usedNumbers.add(nextNumber);
      nextNumber += 1;
      return { ...table, displayName };
    });
  }, [floorPlan]);

  const placedTables = useMemo(
    () => allTables.filter((table) => table.positionX !== null && table.positionY !== null),
    [allTables],
  );
  const tableVisualBounds = useMemo(() => {
    return placedTables.map((table) => {
      const { width, height, rotation } = getTableSize(table);
      const round = table.shape === 'round';
      const { bodyWidth, bodyHeight, top } = getTableBodyGeometry(width, height, round);
      const offsetY = top + bodyHeight / 2 - height / 2;
      const angle = (rotation * Math.PI) / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const centerX = table.positionX! + width / 2 - offsetY * sin;
      const centerY = table.positionY! + height / 2 + offsetY * cos;
      const outerWidth = bodyWidth + (round ? 36 : 0);
      const outerHeight = bodyHeight + (round ? 36 : TABLE_CARD_SEAT_HEIGHT);
      const halfWidth = (outerWidth * Math.abs(cos) + outerHeight * Math.abs(sin)) / 2;
      const halfHeight = (outerWidth * Math.abs(sin) + outerHeight * Math.abs(cos)) / 2;
      return {
        left: centerX - halfWidth,
        right: centerX + halfWidth,
        top: centerY - halfHeight,
        bottom: centerY + halfHeight,
      };
    });
  }, [placedTables]);
  const tableFocusBounds = useMemo<ContentBounds | null>(() => {
    if (tableVisualBounds.length === 0) return null;
    const left = Math.min(...tableVisualBounds.map((item) => item.left)) - 16;
    const top = Math.min(...tableVisualBounds.map((item) => item.top)) - 16;
    const right = Math.max(...tableVisualBounds.map((item) => item.right)) + 16;
    const bottom = Math.max(...tableVisualBounds.map((item) => item.bottom)) + 16;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }, [tableVisualBounds]);
  const tablesToPlace = useMemo(
    () => allTables.filter((table) => table.positionX === null || table.positionY === null),
    [allTables],
  );
  const zones = useMemo<FloorPlanZone[]>(
    () =>
      (floorPlan?.zones ?? []).map((zone) => ({
        ...zone,
        sectionName: zone.sectionName ?? zone.section?.name ?? null,
      })),
    [floorPlan?.zones],
  );
  const contentBounds = useMemo(() => {
    const bounds = computeLiveContentBounds(
      zones,
      placedTables,
      canvasWidth,
      canvasHeight,
      floorPlan?.walls,
    );
    if (!bounds || !tableFocusBounds) return bounds;
    const x = Math.min(bounds.x, tableFocusBounds.x);
    const y = Math.min(bounds.y, tableFocusBounds.y);
    return {
      x,
      y,
      width: Math.max(bounds.x + bounds.width, tableFocusBounds.x + tableFocusBounds.width) - x,
      height: Math.max(bounds.y + bounds.height, tableFocusBounds.y + tableFocusBounds.height) - y,
    };
  }, [canvasHeight, canvasWidth, floorPlan?.walls, placedTables, tableFocusBounds, zones]);
  // Mise à jour pendant le rendu (convention du fichier, cf. zoomRef) : la
  // lecture par ref dans le cadrage évite tout recadrage automatique quand le
  // restaurateur déplace ou redimensionne une table.
  contentBoundsRef.current = contentBounds;
  tableBoundsRef.current = tableFocusBounds;
  const tableCombinations = useMemo<FloorPlanTableCombination[]>(
    () => floorPlan?.tableCombinations ?? [],
    [floorPlan?.tableCombinations],
  );
  const combinableTableIds = useMemo(
    () =>
      new Set(
        tableCombinations.flatMap((combination) => combination.members.map((m) => m.tableId)),
      ),
    [tableCombinations],
  );
  const selectedZone = selectedZoneId
    ? (zones.find((zone) => zone.id === selectedZoneId) ?? null)
    : null;
  const tableStatuses = useMemo(() => {
    const map = new Map<string, { status: TableStatus; reservation: PlanningReservation | null }>();
    if (!live) return map;
    const now = new Date();
    for (const table of allTables) {
      map.set(table.id, getTableStatus(table, reservations, now));
    }
    return map;
  }, [live, allTables, reservations]);

  const serverSummary = useMemo(() => {
    const counts = new Map<string, number>();
    let unassigned = 0;

    for (const table of placedTables) {
      const server = table.assignedServer?.trim();
      if (!server) {
        unassigned += 1;
        continue;
      }
      counts.set(server, (counts.get(server) ?? 0) + 1);
    }

    return {
      counts,
      servers: Array.from(counts.keys()).sort((a, b) => a.localeCompare(b, 'fr')),
      unassigned,
    };
  }, [placedTables]);

  const allServers = serverSummary.servers;
  const serverTableCounts = serverSummary.counts;
  const unassignedCount = serverSummary.unassigned;
  const hasServerFilter = allServers.length + Number(unassignedCount > 0) > 1;

  useEffect(() => {
    if (!hasServerFilter || (selectedServerFilter === '_unassigned_' && unassignedCount === 0)) {
      setSelectedServerFilter(null);
      return;
    }
    if (
      selectedServerFilter &&
      selectedServerFilter !== '_unassigned_' &&
      !serverTableCounts.has(selectedServerFilter)
    ) {
      setSelectedServerFilter(null);
    }
  }, [hasServerFilter, selectedServerFilter, serverTableCounts, unassignedCount]);

  const selectedWall = useMemo(
    () => (floorPlan?.walls ?? []).find((wall) => wall.id === selectedWallId) ?? null,
    [floorPlan?.walls, selectedWallId],
  );

  const selectedTables = useMemo(
    () => allTables.filter((table) => selectedTableIds.has(table.id)),
    [allTables, selectedTableIds],
  );

  const selectedTable = useMemo(
    () => (selectedTableIds.size === 1 ? (selectedTables[0] ?? null) : null),
    [selectedTables, selectedTableIds.size],
  );

  const selectedServiceTable = useMemo(
    () => allTables.find((table) => table.id === selectedServiceTableId) ?? null,
    [allTables, selectedServiceTableId],
  );
  const reportedDelayReservation = useMemo(
    () =>
      displayedInitialDelayImpact
        ? (reservations.find(
            (reservation) => reservation.id === displayedInitialDelayImpact.reservationId,
          ) ?? null)
        : null,
    [displayedInitialDelayImpact, reservations],
  );
  const reportedDelayOriginalTableId = delayImpact ? reportedDelayReservation?.tableId : null;
  const reportedDelayAlternativeTableId = delayImpact?.alternativeTable?.id ?? null;

  function centerCanvas() {
    const viewport = canvasViewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({
      left: Math.max(0, (canvasWidth * zoom - viewport.clientWidth) / 2),
      top: Math.max(0, (canvasHeight * zoom - viewport.clientHeight) / 2),
      behavior: 'smooth',
    });
  }

  function openRoomSettings() {
    setFloorSettings({
      name: floorPlan?.name ?? '',
      widthMeters: formatRoomMeters(floorPlan?.width ?? DEFAULT_CANVAS_WIDTH),
      lengthMeters: formatRoomMeters(floorPlan?.height ?? DEFAULT_CANVAS_HEIGHT),
    });
    setSettingsError('');
    setSettingsDialogOpen(true);
  }

  function focusTablesToPlace() {
    const firstTableId = tablesToPlace[0]?.id;
    if (!firstTableId) return;
    document.getElementById(`palette-table-${firstTableId}`)?.focus();
  }

  async function placeExistingTable(table: CanvasTable) {
    if (!orgId || live) return;
    const { width, height } = getTableSize(table);
    const position = findNextPosition(
      width,
      height,
      placedTables,
      canvasWidth,
      canvasHeight,
      getTableSize(table).rotation,
      table.shape ?? 'rect',
    );
    if (!position) {
      setError('Aucune place libre pour placer cette table.');
      return;
    }
    const { x, y } = position;
    const before = snapshotTableGeometry(table);
    const after = snapshotTableGeometry({ ...table, positionX: x, positionY: y });
    recordGeometry({
      before: { tables: [before], walls: [] },
      after: { tables: [after], walls: [] },
    });
    setSelectedTableIds(new Set([table.id]));
    setLastSelectedTableId(table.id);
    setSelectedWallId(null);
    setFloorPlan((prev) => (prev ? replaceTablePosition(prev, table.id, x, y) : prev));

    try {
      setError('');
      const updated = await patch<FloorPlanTable>(
        `restaurants/${orgId}/floor-plan/tables/${table.id}`,
        {
          positionX: x,
          positionY: y,
          ...(floorPlanId ? { floorPlanId } : {}),
        },
      );
      setFloorPlan((prev) =>
        prev
          ? replaceTablePosition(prev, table.id, updated.positionX ?? x, updated.positionY ?? y)
          : prev,
      );
    } catch (err) {
      setError(getErrorMessage(err, 'Impossible de placer la table'));
      setFloorPlan((prev) =>
        prev ? replaceTablePosition(prev, table.id, table.positionX, table.positionY) : prev,
      );
    }
  }

  async function createTable(placement?: { x: number; y: number }) {
    if (!orgId || live) return;
    const name = getNextTableName(allTables);
    try {
      setError('');
      const created = await post<FloorPlanTable>(`restaurants/${orgId}/floor-plan/tables`, {
        sectionId: null,
        minCapacity: 1,
        positionX: placement?.x ?? null,
        positionY: placement?.y ?? null,
        capacity: 4,
        shape: 'rect',
        name,
        ...(floorPlanId ? { floorPlanId } : {}),
      });
      setFloorPlan((prev) => (prev ? replaceTable(prev, created) : prev));
      setSelectedTableIds(new Set([created.id]));
      setLastSelectedTableId(created.id);
      setSelectedWallId(null);
      setSelectedZoneId(null);
      if (placement) return;
      window.setTimeout(() => document.getElementById(`palette-table-${created.id}`)?.focus(), 0);
    } catch (err) {
      setError(getErrorMessage(err, 'Impossible de créer la table'));
    }
  }

  function placeNewTableInZone(zone: FloorPlanZone, event?: React.MouseEvent<HTMLDivElement>) {
    const canvas = canvasRef.current?.getBoundingClientRect();
    if (!canvas) return;
    const { width, height } = getTableSize({ shape: 'rect' });
    const mouse = event && event.detail > 0;
    const x = Math.round(
      (mouse ? (event.clientX - canvas.left) / zoom : zone.x + zone.width / 2) - width / 2,
    );
    const y = Math.round(
      (mouse ? (event.clientY - canvas.top) / zoom : zone.y + zone.height / 2) - height / 2,
    );
    const table = {
      positionX: x,
      positionY: y,
      width,
      height,
      rotation: 0,
      shape: 'rect',
    } as const;
    if (
      x < 0 ||
      y < 0 ||
      x + width > canvasWidth ||
      y + height > canvasHeight ||
      !tableFitsInZone(table, zone) ||
      tablePlatesOverlapAtPosition({ x, y, width, height, tables: placedTables })
    ) {
      toast.error('Choisissez un emplacement libre à l’intérieur de la zone.');
      return;
    }
    setTablePlacementZoneId(null);
    void createTable({ x, y });
  }

  async function createTablesBatch(event: React.FormEvent) {
    event.preventDefault();
    if (!orgId || live || bulkCreateLoading) return;
    const count = Number(bulkCreateForm.count);
    const capacity = Number(bulkCreateForm.capacity);
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      setError('Choisissez entre 1 et 50 tables.');
      return;
    }
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 30) {
      setError('La capacité doit être comprise entre 1 et 30 places.');
      return;
    }

    setBulkCreateLoading(true);
    setError('');
    const names = [...allTables];
    const created: FloorPlanTable[] = [];
    try {
      for (let index = 0; index < count; index += 1) {
        const name = getNextTableName(names);
        const table = await post<FloorPlanTable>(`restaurants/${orgId}/floor-plan/tables`, {
          sectionId: null,
          minCapacity: 1,
          positionX: null,
          positionY: null,
          capacity,
          shape: 'rect',
          name,
          ...(floorPlanId ? { floorPlanId } : {}),
        });
        created.push(table);
        names.push({ ...table, name } as CanvasTable);
      }
      setFloorPlan((prev) => {
        if (!prev) return prev;
        return created.reduce((next, table) => replaceTable(next, table), prev);
      });
      setSelectedTableIds(new Set(created.map((table) => table.id)));
      setLastSelectedTableId(created[0]?.id ?? null);
      setSelectedWallId(null);
      setBulkCreateDialogOpen(false);
    } catch (err) {
      setError(getErrorMessage(err, 'Impossible de créer les tables'));
    } finally {
      setBulkCreateLoading(false);
    }
  }

  async function autoLayoutTables({ initial = false }: { initial?: boolean } = {}) {
    if (!orgId || live || autoLayoutLoading || tablesToPlace.length === 0 || !floorPlan) return;
    setAutoLayoutLoading(true);
    setError('');
    const occupied = [...placedTables];
    const placements: Array<{ table: CanvasTable; x: number; y: number }> = [];
    for (const table of tablesToPlace) {
      const { width, height } = getTableSize(table);
      const position = findNextPosition(
        width,
        height,
        occupied,
        canvasWidth,
        canvasHeight,
        getTableSize(table).rotation,
        table.shape ?? 'rect',
      );
      if (!position) {
        setError('Il ne reste pas assez de place pour toutes les tables.');
        setAutoLayoutLoading(false);
        return;
      }
      occupied.push({ ...table, positionX: position.x, positionY: position.y });
      placements.push({ table, ...position });
    }

    try {
      const updatedTables = await Promise.all(
        placements.map(({ table, x, y }) =>
          patch<FloorPlanTable>(`restaurants/${orgId}/floor-plan/tables/${table.id}`, {
            positionX: x,
            positionY: y,
            ...(floorPlanId ? { floorPlanId } : {}),
          }),
        ),
      );
      const nextPlan = updatedTables.reduce(
        (plan, updated, index) =>
          replaceTablePosition(
            plan,
            placements[index].table.id,
            updated.positionX ?? placements[index].x,
            updated.positionY ?? placements[index].y,
          ),
        floorPlan,
      );
      recordGeometry({
        before: { tables: tablesToPlace.map(snapshotTableGeometry), walls: [] },
        after: {
          tables: updatedTables.map((updated, index) =>
            snapshotTableGeometry({
              ...placements[index].table,
              positionX: updated.positionX ?? placements[index].x,
              positionY: updated.positionY ?? placements[index].y,
            }),
          ),
          walls: [],
        },
      });
      setFloorPlan(nextPlan);
      if (initial) {
        setSelectedTableIds(new Set());
        setLastSelectedTableId(null);
        setSelectedWallId(null);
        setAutoLayoutNotice(true);
      } else {
        setSelectedTableIds(new Set(updatedTables.map((table) => table.id)));
        setLastSelectedTableId(updatedTables[0]?.id ?? null);
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Impossible de générer la disposition automatique'));
    } finally {
      setAutoLayoutLoading(false);
    }
  }

  useEffect(() => {
    if (
      live ||
      !floorPlan ||
      autoLayoutCandidateRef.current !== floorPlan.id ||
      autoLayoutLoading ||
      allTables.length === 0 ||
      placedTables.length > 0
    ) {
      return;
    }

    // Consommer le candidat avant la mutation asynchrone évite qu'un rerender
    // ou la réponse de l'API ne relance une seconde disposition automatique.
    autoLayoutCandidateRef.current = null;
    void autoLayoutTables({ initial: true });
  }, [allTables.length, autoLayoutLoading, autoLayoutTables, floorPlan, live, placedTables.length]);

  const quickAddFromPalette = useCallback(
    async (data: PaletteItemData) => {
      if (!orgId || live) return;
      if (data.kind === 'table') {
        const { width, height } = getTableSize({
          capacity: data.capacity,
          shape: data.shape,
        } as FloorPlanTable);
        const position = findNextPosition(
          width,
          height,
          placedTables,
          canvasWidth,
          canvasHeight,
          0,
          data.shape,
        );
        if (!position) {
          setError('Aucune place libre pour ajouter cette table.');
          return;
        }
        const { x, y } = position;
        const name = getNextTableName(allTables);
        try {
          setError('');
          const created = await post<FloorPlanTable>(`restaurants/${orgId}/floor-plan/tables`, {
            sectionId: null,
            minCapacity: 1,
            positionX: x,
            positionY: y,
            capacity: data.capacity,
            shape: data.shape,
            name,
            ...(floorPlanId ? { floorPlanId } : {}),
          });
          setFloorPlan((prev) => (prev ? replaceTable(prev, created) : prev));
          setSelectedTableIds(new Set([created.id]));
          setLastSelectedTableId(created.id);
          setSelectedWallId(null);
        } catch (err) {
          setError(getErrorMessage(err, 'Impossible de créer la table'));
        }
        return;
      }
      if (data.kind === 'zone') {
        const width = Math.min(360, canvasWidth - 64);
        const height = Math.min(220, canvasHeight - 64);
        const position = findNextZonePosition(width, height, zones, canvasWidth, canvasHeight);
        try {
          setError('');
          const created = await post<FloorPlanZone>(`restaurants/${orgId}/floor-plan/zones`, {
            name: getNextZoneName(zones),
            sectionId: null,
            ...position,
            width,
            height,
            rotation: 0,
            ...(floorPlanId ? { floorPlanId } : {}),
          });
          setFloorPlan((prev) =>
            prev
              ? {
                  ...prev,
                  zones: [...(prev.zones ?? []), created],
                }
              : prev,
          );
          setSelectedTableIds(new Set());
          setLastSelectedTableId(null);
          setSelectedWallId(null);
          setSelectedZoneId(created.id);
        } catch (err) {
          setError(getErrorMessage(err, 'Impossible de créer la zone'));
        }
        return;
      }
      if (data.kind !== 'wall') return;
      const wallLengths: Record<PaletteWallType, number> = { wall: 160, door: 110, bar: 160 };
      const length = wallLengths[data.type];
      const centerX = Math.round(canvasWidth / 2);
      const centerY = Math.round(canvasHeight / 2);
      try {
        setError('');
        const wall = await post<FloorPlanWall>(`restaurants/${orgId}/floor-plan/walls`, {
          x1: Math.max(0, centerX - length / 2),
          y1: centerY,
          x2: Math.min(canvasWidth, centerX + length / 2),
          y2: centerY,
          type: data.type as WallType,
          name: null,
          ...(floorPlanId ? { floorPlanId } : {}),
        });
        setFloorPlan((prev) => (prev ? { ...prev, walls: [...(prev.walls ?? []), wall] } : prev));
        setSelectedTableIds(new Set());
        setLastSelectedTableId(null);
        setSelectedWallId(wall.id);
        setSelectedZoneId(null);
      } catch (err) {
        setError(getErrorMessage(err, 'Impossible de créer le mur'));
      }
    },
    [orgId, live, allTables, placedTables, zones, canvasWidth, canvasHeight, floorPlanId, post],
  );

  function openEditDialog(table: CanvasTable) {
    setEditingTable(table);
    setForm({
      name: table.name,
      capacity: String(table.capacity),
      minCapacity: String(table.minCapacity),
      shape: table.shape ?? 'rect',
      isActive: table.isActive,
    });
    setDialogOpen(true);
  }

  function selectTable(table: CanvasTable, event?: React.MouseEvent) {
    setTablePlacementZoneId(null);
    if (!event) {
      setSelectedTableIds(new Set([table.id]));
      setLastSelectedTableId(table.id);
      setSelectedWallId(null);
      setSelectedZoneId(null);
      return;
    }
    const isMeta = event.ctrlKey || event.metaKey;
    const isShift = event.shiftKey;
    if (isMeta) {
      setSelectedTableIds((prev) => {
        const next = new Set(prev);
        if (next.has(table.id)) next.delete(table.id);
        else next.add(table.id);
        return next;
      });
      setLastSelectedTableId(table.id);
      setSelectedWallId(null);
      setSelectedZoneId(null);
      return;
    }
    if (isShift && lastSelectedTableId) {
      const ids = allTables.map((t) => t.id);
      const start = ids.indexOf(lastSelectedTableId);
      const end = ids.indexOf(table.id);
      if (start !== -1 && end !== -1) {
        const [rangeStart, rangeEnd] = start < end ? [start, end] : [end, start];
        const range = ids.slice(rangeStart, rangeEnd + 1);
        setSelectedTableIds((prev) => {
          const next = new Set(prev);
          for (const id of range) next.add(id);
          return next;
        });
      }
      setLastSelectedTableId(table.id);
      setSelectedWallId(null);
      setSelectedZoneId(null);
      return;
    }
    setSelectedTableIds(new Set([table.id]));
    setLastSelectedTableId(table.id);
    setSelectedWallId(null);
    setSelectedZoneId(null);
  }

  function handleTableClick(table: CanvasTable, event?: React.MouseEvent) {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    if (live) {
      if (unassignedPlacement.reservationId) {
        if (unassignedPlacement.suggestions.some((suggestion) => suggestion.tableId === table.id)) {
          setUnassignedPlacement((current) => ({
            ...current,
            targetTableId: table.id,
            message: null,
          }));
        }
        return;
      }
      if (unassignedPanelOpen) setUnassignedPanelOpen(false);
      setSelectedServiceTableId(table.id);
      return;
    }
    selectTable(table, event);
  }

  function selectZone(zone: FloorPlanZone) {
    if (live) return;
    setTablePlacementZoneId(null);
    if (zoneJustDraggedRef.current) {
      zoneJustDraggedRef.current = false;
      return;
    }
    setSelectedZoneId(zone.id);
    setSelectedTableIds(new Set());
    setLastSelectedTableId(null);
    setSelectedWallId(null);
  }

  function handleZonePointerDown(event: React.PointerEvent<HTMLDivElement>, zone: FloorPlanZone) {
    if (live) return;
    zoneJustDraggedRef.current = false;
    setSelectedZoneId(zone.id);
    setSelectedTableIds(new Set());
    setSelectedWallId(null);
    setZoneDragStart({ zone, pointerX: event.clientX, pointerY: event.clientY });
  }

  function startZoneResize(event: React.PointerEvent<HTMLDivElement>, zone: FloorPlanZone) {
    if (live || tablePlacementZoneId) return;
    event.stopPropagation();
    event.preventDefault();
    resizeZoneStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      width: zone.width,
      height: zone.height,
    };
    setSelectedZoneId(zone.id);
    setSelectedTableIds(new Set());
    setSelectedWallId(null);
    setResizeZoneId(zone.id);
  }

  useEffect(() => {
    if (!zoneDragStart) return;
    const handleMove = (event: PointerEvent) => {
      const dx = (event.clientX - zoneDragStart.pointerX) / zoom;
      const dy = (event.clientY - zoneDragStart.pointerY) / zoom;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) zoneJustDraggedRef.current = true;
      const grid = snap ? GRID_SIZE : 1;
      const nextX = Math.max(
        0,
        Math.min(
          canvasWidth - zoneDragStart.zone.width,
          Math.round((zoneDragStart.zone.x + dx) / grid) * grid,
        ),
      );
      const nextY = Math.max(
        0,
        Math.min(
          canvasHeight - zoneDragStart.zone.height,
          Math.round((zoneDragStart.zone.y + dy) / grid) * grid,
        ),
      );
      setFloorPlan((prev) =>
        prev
          ? replaceZone(prev, {
              ...zoneDragStart.zone,
              x: nextX,
              y: nextY,
            })
          : prev,
      );
    };
    const handleUp = () => {
      const current = zoneDragStart.zone;
      const latest = zones.find((zone) => zone.id === current.id);
      if (latest && (latest.x !== current.x || latest.y !== current.y)) {
        recordGeometry({
          before: { tables: [], walls: [], zones: [snapshotZoneGeometry(current)] },
          after: { tables: [], walls: [], zones: [snapshotZoneGeometry(latest)] },
        });
        void patchZone(current.id, { x: latest.x, y: latest.y });
      }
      setZoneDragStart(null);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [zoneDragStart, zoom, snap, canvasWidth, canvasHeight, zones]);

  useEffect(() => {
    if (!resizeZoneId || !resizeZoneStartRef.current) return;
    const handleMove = (event: PointerEvent) => {
      const start = resizeZoneStartRef.current;
      if (!start) return;
      const zone = zones.find((item) => item.id === resizeZoneId);
      if (!zone) return;
      const dx = (event.clientX - start.pointerX) / zoom;
      const dy = (event.clientY - start.pointerY) / zoom;
      const grid = snap ? GRID_SIZE : 1;
      const width = Math.max(
        ZONE_MIN_WIDTH,
        Math.min(canvasWidth - zone.x, Math.round((start.width + dx) / grid) * grid),
      );
      const height = Math.max(
        ZONE_MIN_HEIGHT,
        Math.min(canvasHeight - zone.y, Math.round((start.height + dy) / grid) * grid),
      );
      start.currentWidth = width;
      start.currentHeight = height;
      setFloorPlan((prev) =>
        prev
          ? replaceZone(prev, {
              ...zone,
              width,
              height,
            })
          : prev,
      );
    };
    const handleUp = () => {
      const start = resizeZoneStartRef.current;
      const zone = zones.find((item) => item.id === resizeZoneId);
      if (start && zone) {
        const width = Math.round(start.currentWidth ?? start.width);
        const height = Math.round(start.currentHeight ?? start.height);
        if (width !== start.width || height !== start.height) {
          const before = zone
            ? snapshotZoneGeometry({ ...zone, width: start.width, height: start.height })
            : null;
          const after = zone ? snapshotZoneGeometry({ ...zone, width, height }) : null;
          if (before && after) {
            recordGeometry({
              before: { tables: [], walls: [], zones: [before] },
              after: { tables: [], walls: [], zones: [after] },
            });
          }
          void patchZone(resizeZoneId, { width, height });
        }
      }
      setResizeZoneId(null);
      resizeZoneStartRef.current = null;
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [resizeZoneId, zoom, snap, canvasWidth, canvasHeight, zones]);

  function handleTableDoubleClick(table: CanvasTable) {
    if (live) return;
    openEditDialog(table);
  }

  async function patchTable(tableId: string, updates: Partial<FloorPlanTable>) {
    if (!orgId) return;
    const mutationVersion = (tableMutationVersionRef.current.get(tableId) ?? 0) + 1;
    tableMutationVersionRef.current.set(tableId, mutationVersion);
    try {
      setError('');
      const updated = await patch<FloorPlanTable>(
        `restaurants/${orgId}/floor-plan/tables/${tableId}`,
        { ...updates, ...(floorPlanId ? { floorPlanId } : {}) },
      );
      if (tableMutationVersionRef.current.get(tableId) !== mutationVersion) return;
      setFloorPlan((prev) => (prev ? replaceTable(prev, updated) : prev));
    } catch (err) {
      if (tableMutationVersionRef.current.get(tableId) === mutationVersion) {
        const table = allTables.find((table) => table.id === tableId);
        setError(
          `Modification de ${table?.displayName ?? table?.name ?? 'la table'} non enregistrée. ${getErrorMessage(err, 'Réessayez.')}`,
        );
      }
    }
  }

  function saveTableName(table: CanvasTable, rawName: string) {
    const name = rawName.trim();
    if (!name || name === table.name) return;
    void patchTable(table.id, { name });
  }

  function changeTableCapacity(table: CanvasTable, delta: number) {
    const capacity = Math.max(1, table.capacity + delta);
    if (capacity === table.capacity) return;
    void patchTable(table.id, { capacity });
  }

  async function patchZone(zoneId: string, updates: Partial<FloorPlanZone>) {
    if (!orgId) return;
    try {
      setError('');
      const updated = await patch<FloorPlanZone>(
        `restaurants/${orgId}/floor-plan/zones/${zoneId}`,
        { ...updates, ...(floorPlanId ? { floorPlanId } : {}) },
      );
      setFloorPlan((prev) => (prev ? replaceZone(prev, updated) : prev));
    } catch (err) {
      setError(getErrorMessage(err, 'Impossible de modifier la zone'));
    }
  }

  async function deleteZone(zoneId: string) {
    if (!orgId) return;
    try {
      setError('');
      await del(
        `restaurants/${orgId}/floor-plan/zones/${zoneId}${floorPlanId ? `?floorPlanId=${floorPlanId}` : ''}`,
      );
      setFloorPlan((prev) => (prev ? removeZone(prev, zoneId) : prev));
      setSelectedZoneId(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Impossible de supprimer la zone'));
    }
  }

  async function duplicateTable(table: FloorPlanTable, x: number, y: number, name?: string) {
    if (!orgId || !floorPlan) return;
    const generatedName =
      name ??
      (() => {
        const numericTableNames = allTables
          .map((t) => Number(t.name.match(/^T(\d+)$/i)?.[1] ?? 0))
          .filter((value) => value > 0);
        return `T${Math.max(0, ...numericTableNames) + 1}`;
      })();
    const created = await post<FloorPlanTable>(`restaurants/${orgId}/floor-plan/tables`, {
      sectionId: null,
      name: generatedName,
      minCapacity: table.minCapacity,
      capacity: table.capacity,
      shape: table.shape,
      positionX: x,
      positionY: y,
      width: table.width ?? null,
      height: table.height ?? null,
      rotation: table.rotation ?? 0,
      ...(floorPlanId ? { floorPlanId } : {}),
    });
    return created;
  }

  async function duplicateSingleTable(table: FloorPlanTable) {
    if (!orgId || !floorPlan) return;
    try {
      const position = findNearbyFreeTablePosition(table, allTables, canvasWidth, canvasHeight);
      if (!position) {
        setError('Aucun emplacement libre pour dupliquer cette table dans le plan.');
        return;
      }
      const created = await duplicateTable(table, position.x, position.y);
      if (created) {
        setFloorPlan((prev) =>
          prev ? { ...prev, tables: [...(prev.tables ?? []), created] } : prev,
        );
        setSelectedTableIds(new Set([created.id]));
        setLastSelectedTableId(created.id);
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Impossible de dupliquer la table'));
    }
  }

  function nextTableName(offset = 1): string {
    const numericTableNames = allTables
      .map((t) => Number(t.name.match(/^T(\d+)$/i)?.[1] ?? 0))
      .filter((value) => value > 0);
    const max = Math.max(0, ...numericTableNames);
    return `T${max + offset}`;
  }

  const rowSource = duplicateDialogOpen ? selectedTables[0] : undefined;
  const rowSize = rowSource ? getTableSize(rowSource) : null;
  const rowCount = duplicateForm.count;
  const rowSpacing = duplicateForm.spacing;
  const rowPositions =
    rowSource &&
    rowSize &&
    rowSource.positionX !== null &&
    rowSource.positionY !== null &&
    Number.isInteger(rowCount) &&
    rowCount >= 2 &&
    rowCount <= 50 &&
    Number.isInteger(rowSpacing) &&
    rowSpacing >= 0
      ? Array.from({ length: rowCount - 1 }, (_, i) => ({
          x: rowSource.positionX! + (i + 1) * (rowSize.width + rowSpacing),
          y: rowSource.positionY!,
        }))
      : [];
  const rowFits =
    rowSource &&
    rowSize &&
    rowPositions.length > 0 &&
    rowPositions.every(
      ({ x, y }, index) =>
        x + rowSize.width <= canvasWidth &&
        y + rowSize.height <= canvasHeight &&
        !tablePlatesOverlapAtPosition({
          ...rowSize,
          x,
          y,
          shape: rowSource.shape,
          tables: [
            ...placedTables,
            ...rowPositions.slice(0, index).map((position) => ({
              ...rowSource,
              positionX: position.x,
              positionY: position.y,
            })),
          ],
        }),
    );

  function openRowDuplicate() {
    setDuplicateDialogOpen(true);
  }

  async function duplicateSelectedAsRow() {
    if (!rowSource || !rowFits) return;
    setDuplicateDialogOpen(false);
    const created: FloorPlanTable[] = [];
    try {
      setError('');
      for (const [index, { x, y }] of rowPositions.entries()) {
        const table = await duplicateTable(rowSource, x, y, nextTableName(index + 1));
        if (!table) break;
        created.push(table);
        setFloorPlan((prev) => (prev ? replaceTable(prev, table) : prev));
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Impossible de terminer la rangée'));
    }
    if (created.length > 0) {
      setSelectedTableIds(new Set(created.map((table) => table.id)));
      setLastSelectedTableId(created.at(-1)?.id ?? null);
    }
  }

  async function deleteSelectedTables() {
    if (selectedTables.length === 0) return;
    // Invalide tout snapshot qui ciblerait l'une de ces tables supprimées.
    resetGeometryHistory();
    for (const table of selectedTables) {
      tableMutationVersionRef.current.delete(table.id);
    }
    try {
      setError('');
      await Promise.all(
        selectedTables.map((table) =>
          del(
            `restaurants/${orgId}/floor-plan/tables/${table.id}${
              floorPlanId ? `?floorPlanId=${floorPlanId}` : ''
            }`,
          ),
        ),
      );
      setFloorPlan((prev) => {
        if (!prev) return prev;
        let next = prev;
        for (const table of selectedTables) next = removeTable(next, table.id);
        return next;
      });
      setSelectedTableIds(new Set());
      setLastSelectedTableId(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Impossible de supprimer les tables'));
    }
  }

  function alignSelectedTables(axis: 'x' | 'y', anchor: 'min' | 'center' | 'max') {
    if (selectedTables.length < 2) return;
    const dimensions = selectedTables.map((table) => {
      const { width, height } = getTableSize(table);
      const x = table.positionX ?? 0;
      const y = table.positionY ?? 0;
      return { table, width, height, x, y };
    });
    const values =
      axis === 'x'
        ? dimensions.map((d) => ({ min: d.x, center: d.x + d.width / 2, max: d.x + d.width }))
        : dimensions.map((d) => ({ min: d.y, center: d.y + d.height / 2, max: d.y + d.height }));
    const target =
      anchor === 'min'
        ? Math.min(...values.map((v) => v.min))
        : anchor === 'max'
          ? Math.max(...values.map((v) => v.max))
          : values[0].center;
    const nextTables = dimensions.map(({ table, width, height, x, y }) => {
      let nextX = x;
      let nextY = y;
      if (axis === 'x') {
        nextX = anchor === 'min' ? target : anchor === 'max' ? target - width : target - width / 2;
      } else {
        nextY =
          anchor === 'min' ? target : anchor === 'max' ? target - height : target - height / 2;
      }
      return {
        ...table,
        positionX: Math.round(nextX),
        positionY: Math.round(nextY),
      };
    });

    if (
      nextTables.every(
        (table, index) =>
          table.positionX === dimensions[index].table.positionX &&
          table.positionY === dimensions[index].table.positionY,
      )
    ) {
      return;
    }

    const occupied = placedTables.filter((table) => !selectedTableIds.has(table.id));
    for (const table of nextTables) {
      if (
        tablePlatesOverlapAtPosition({
          ...getTableSize(table),
          x: table.positionX,
          y: table.positionY,
          shape: table.shape,
          tables: occupied,
        }) ||
        findOverlappingTableChairs(table, occupied, { plateOnly: true })
      ) {
        toast.error('Cet alignement ferait se chevaucher des tables.');
        return;
      }
      occupied.push(table);
    }

    const before: GeometrySnapshot = {
      tables: dimensions.map(({ table }) => snapshotTableGeometry(table)),
      walls: [],
    };
    const after: GeometrySnapshot = { tables: nextTables.map(snapshotTableGeometry), walls: [] };
    recordGeometry({ before, after });
    applyGeometrySnapshot(after);
  }

  function startTableResize(e: React.PointerEvent, table: CanvasTable) {
    e.stopPropagation();
    e.preventDefault();
    const { width, height } = getTableSize(table);
    resizeStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      width,
      height,
      beforeTable: { ...table },
    };
    setResizeTableId(table.id);
    setSelectedTableIds(new Set([table.id]));
    setSelectedWallId(null);
  }

  function startTableRotate(e: React.PointerEvent, table: CanvasTable) {
    e.stopPropagation();
    e.preventDefault();
    const { width, height } = getTableSize(table);
    const centerX = (table.positionX ?? 0) + width / 2;
    const centerY = (table.positionY ?? 0) + height / 2;
    rotateStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      startRotation: table.rotation ?? 0,
      centerX,
      centerY,
      beforeTable: { ...table },
    };
    setRotateTableId(table.id);
    setSelectedTableIds(new Set([table.id]));
    setSelectedWallId(null);
  }

  function handleTablePointerMove(e: PointerEvent) {
    const resizeStart = resizeStartRef.current;
    if (resizeTableId && resizeStart) {
      const dx = (e.clientX - resizeStart.pointerX) / zoom;
      const dy = (e.clientY - resizeStart.pointerY) / zoom;
      const width = Math.max(TABLE_LAYOUT.minimumDimension, resizeStart.width + dx);
      const height = Math.max(TABLE_LAYOUT.minimumDimension, resizeStart.height + dy);
      setFloorPlan((prev) => {
        if (!prev) return prev;
        const table = prev.sections
          .flatMap((s) => s.tables)
          .concat(prev.tables ?? [])
          .find((t) => t.id === resizeTableId);
        if (!table) return prev;
        const clampedWidth = Math.max(
          TABLE_LAYOUT.minimumDimension,
          Math.min(width, canvasWidth - (table.positionX ?? 0)),
        );
        const clampedHeight = Math.max(
          TABLE_LAYOUT.minimumDimension,
          Math.min(height, canvasHeight - (table.positionY ?? 0)),
        );
        resizeStart.currentWidth = clampedWidth;
        resizeStart.currentHeight = clampedHeight;
        return replaceTable(prev, {
          ...table,
          width: Math.round(clampedWidth),
          height: Math.round(clampedHeight),
        });
      });
    }
    if (rotateTableId && rotateStartRef.current && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const cx = rect.left + rotateStartRef.current.centerX * zoom;
      const cy = rect.top + rotateStartRef.current.centerY * zoom;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      const startAngle =
        (Math.atan2(rotateStartRef.current.pointerY - cy, rotateStartRef.current.pointerX - cx) *
          180) /
        Math.PI;
      const rotation = Math.round(
        (rotateStartRef.current.startRotation + angle - startAngle) % 360,
      );
      rotateStartRef.current.currentRotation = rotation;
      setFloorPlan((prev) => {
        if (!prev) return prev;
        const table = prev.sections
          .flatMap((s) => s.tables)
          .concat(prev.tables ?? [])
          .find((t) => t.id === rotateTableId);
        if (!table) return prev;
        return replaceTable(prev, { ...table, rotation });
      });
    }
  }

  function handleTablePointerUp() {
    if (resizeTableId && resizeStartRef.current) {
      const start = resizeStartRef.current;
      const finalWidth = Math.round(start.currentWidth ?? start.width);
      const finalHeight = Math.round(start.currentHeight ?? start.height);
      if (start.beforeTable && (finalWidth !== start.width || finalHeight !== start.height)) {
        recordGeometry({
          before: { tables: [snapshotTableGeometry(start.beforeTable)], walls: [] },
          after: {
            tables: [
              snapshotTableGeometry({
                ...start.beforeTable,
                width: finalWidth,
                height: finalHeight,
              }),
            ],
            walls: [],
          },
        });
      }
      void patchTable(resizeTableId, {
        width: finalWidth,
        height: finalHeight,
      });
      setResizeTableId(null);
      resizeStartRef.current = null;
    }
    if (rotateTableId && rotateStartRef.current) {
      const start = rotateStartRef.current;
      const finalRotation = start.currentRotation ?? start.startRotation;
      if (start.beforeTable && finalRotation !== start.startRotation) {
        recordGeometry({
          before: { tables: [snapshotTableGeometry(start.beforeTable)], walls: [] },
          after: {
            tables: [snapshotTableGeometry({ ...start.beforeTable, rotation: finalRotation })],
            walls: [],
          },
        });
      }
      void patchTable(rotateTableId, {
        rotation: finalRotation,
      });
      setRotateTableId(null);
      rotateStartRef.current = null;
    }
  }

  useEffect(() => {
    if (!resizeTableId && !rotateTableId) return;
    const handleMove = (e: PointerEvent) => handleTablePointerMove(e);
    const handleUp = () => handleTablePointerUp();
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resizeTableId, rotateTableId, allTables, zoom, canvasWidth, canvasHeight]);

  async function handleSubmitTable(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId || !form.name.trim() || !editingTable) return;

    const capacity = Number(form.capacity);
    const minCapacity = Number(form.minCapacity);
    if (Number.isNaN(capacity) || capacity < 1) {
      setError('La capacité doit être un nombre positif');
      return;
    }
    if (Number.isNaN(minCapacity) || minCapacity < 1) {
      setError('La capacité minimale doit être un nombre positif');
      return;
    }

    setError('');

    try {
      const updated = await patch<FloorPlanTable>(
        `restaurants/${orgId}/floor-plan/tables/${editingTable.id}`,
        {
          name: form.name.trim(),
          capacity,
          minCapacity,
          shape: form.shape,
          isActive: form.isActive,
          ...(floorPlanId ? { floorPlanId } : {}),
        },
      );
      setFloorPlan((prev) => (prev ? replaceTable(prev, updated) : prev));
      setDialogOpen(false);
      setEditingTable(null);
    } catch (err) {
      setError(getErrorMessage(err, "Impossible d'enregistrer la table"));
    }
  }

  async function confirmDeleteTable() {
    const tableId = pendingDeleteTableId;
    if (!orgId || !tableId) return;
    setConfirmOpen(false);
    setPendingDeleteTableId(null);
    // Invalide tout snapshot qui ciblerait cette table supprimée.
    // Appliquer un undo ultérieur la recréerait silencieusement en base.
    resetGeometryHistory();
    tableMutationVersionRef.current.delete(tableId);
    try {
      setError('');
      await del(
        `restaurants/${orgId}/floor-plan/tables/${tableId}${
          floorPlanId ? `?floorPlanId=${floorPlanId}` : ''
        }`,
      );
      setFloorPlan((prev) => (prev ? removeTable(prev, tableId) : prev));
    } catch (err) {
      setError(getErrorMessage(err, 'Impossible de supprimer la table'));
    }
  }

  async function confirmMultiDelete() {
    setMultiDeleteConfirmOpen(false);
    await deleteSelectedTables();
  }

  async function updateWall(wall: FloorPlanWall, type: WallType, name: string | null) {
    if (!orgId) return;
    const mutationVersion = (wallMutationVersionRef.current.get(wall.id) ?? 0) + 1;
    wallMutationVersionRef.current.set(wall.id, mutationVersion);
    setError('');
    try {
      const updated = await patch<FloorPlanWall>(
        `restaurants/${orgId}/floor-plan/walls/${wall.id}`,
        { ...wall, type, name, ...(floorPlanId ? { floorPlanId } : {}) },
      );
      if (wallMutationVersionRef.current.get(wall.id) !== mutationVersion) return;
      setFloorPlan((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          walls: (prev.walls ?? []).map((w) => (w.id === updated.id ? updated : w)),
        };
      });
    } catch (err) {
      if (wallMutationVersionRef.current.get(wall.id) !== mutationVersion) return;
      setError(getErrorMessage(err, 'Impossible de modifier le mur'));
      throw err;
    }
  }

  /** Met à jour la géométrie d'un mur sans toucher à type/name (undo/redo). */
  async function updateWallGeometry(geometry: WallGeometry) {
    if (!orgId) return;
    const mutationVersion = (wallMutationVersionRef.current.get(geometry.id) ?? 0) + 1;
    wallMutationVersionRef.current.set(geometry.id, mutationVersion);
    setError('');
    try {
      const updated = await patch<FloorPlanWall>(
        `restaurants/${orgId}/floor-plan/walls/${geometry.id}`,
        { ...geometry, ...(floorPlanId ? { floorPlanId } : {}) },
      );
      if (wallMutationVersionRef.current.get(geometry.id) !== mutationVersion) return;
      setFloorPlan((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          walls: (prev.walls ?? []).map((w) => (w.id === updated.id ? updated : w)),
        };
      });
    } catch (err) {
      if (wallMutationVersionRef.current.get(geometry.id) !== mutationVersion) return;
      setError(getErrorMessage(err, 'Impossible de modifier le mur'));
    }
  }

  function tableGeometry(table: TableGeometry): Partial<FloorPlanTable> {
    return {
      positionX: table.positionX,
      positionY: table.positionY,
      width: table.width,
      height: table.height,
      rotation: table.rotation,
    };
  }

  /**
   * Réapplique un snapshot immédiatement dans le canvas, puis persiste sa
   * géométrie. Une action de groupe (aligner) reste donc atomique du
   * point de vue de la pile, tout en conservant les mutations API existantes.
   */
  function applyGeometrySnapshot(snapshot: GeometrySnapshot) {
    if (snapshot.tables.length === 0 && snapshot.walls.length === 0 && !snapshot.zones?.length)
      return;

    const tableUpdates = new Map(snapshot.tables.map((table) => [table.id, table]));
    const wallUpdates = new Map(snapshot.walls.map((wall) => [wall.id, wall]));
    const zoneUpdates = new Map((snapshot.zones ?? []).map((zone) => [zone.id, zone]));
    const currentTableIds = new Set(
      [
        ...(floorPlan?.sections.flatMap((section) => section.tables) ?? []),
        ...(floorPlan?.tables ?? []),
      ].map((table) => table.id),
    );
    const currentWalls = new Map((floorPlan?.walls ?? []).map((wall) => [wall.id, wall]));
    const currentZones = new Map((floorPlan?.zones ?? []).map((zone) => [zone.id, zone]));

    setFloorPlan((prev) => {
      if (!prev) return prev;
      const mergeTableGeometry = (table: FloorPlanTable): FloorPlanTable => {
        const geometry = tableUpdates.get(table.id);
        return geometry ? { ...table, ...geometry } : table;
      };
      return {
        ...prev,
        sections: prev.sections.map((section) => ({
          ...section,
          tables: section.tables.map(mergeTableGeometry),
        })),
        tables: (prev.tables ?? []).map(mergeTableGeometry),
        walls: (prev.walls ?? []).map((wall) => {
          const geometry = wallUpdates.get(wall.id);
          return geometry ? { ...wall, ...geometry } : wall;
        }),
        zones: (prev.zones ?? []).map((zone) => {
          const geometry = zoneUpdates.get(zone.id);
          return geometry ? { ...zone, ...geometry } : zone;
        }),
      };
    });

    for (const table of snapshot.tables) {
      if (currentTableIds.has(table.id)) void patchTable(table.id, tableGeometry(table));
    }
    for (const geometry of snapshot.walls) {
      if (!currentWalls.has(geometry.id)) continue;
      void updateWallGeometry(geometry);
    }
    for (const geometry of snapshot.zones ?? []) {
      if (!currentZones.has(geometry.id)) continue;
      void patchZone(geometry.id, geometry);
    }
  }

  function undoGeometry() {
    const snapshot = undoGeometrySnapshot();
    if (snapshot) applyGeometrySnapshot(snapshot);
  }

  function redoGeometry() {
    const snapshot = redoGeometrySnapshot();
    if (snapshot) applyGeometrySnapshot(snapshot);
  }

  async function deleteWall(wallId: string) {
    if (!orgId) return;
    setError('');
    // Invalide tout snapshot qui ciblerait ce mur supprimé.
    resetGeometryHistory();
    wallMutationVersionRef.current.delete(wallId);
    try {
      await del(
        `restaurants/${orgId}/floor-plan/walls/${wallId}${
          floorPlanId ? `?floorPlanId=${floorPlanId}` : ''
        }`,
      );
      setFloorPlan((prev) => {
        if (!prev) return prev;
        return { ...prev, walls: (prev.walls ?? []).filter((w) => w.id !== wallId) };
      });
    } catch (err) {
      setError(getErrorMessage(err, 'Impossible de supprimer le mur'));
    }
  }

  async function duplicateWall(wall: FloorPlanWall) {
    if (!orgId || live) return;
    try {
      setError('');
      const offset = GRID_SIZE;
      const duplicated = await post<FloorPlanWall>(`restaurants/${orgId}/floor-plan/walls`, {
        x1: Math.min(canvasWidth, wall.x1 + offset),
        y1: Math.min(canvasHeight, wall.y1 + offset),
        x2: Math.min(canvasWidth, wall.x2 + offset),
        y2: Math.min(canvasHeight, wall.y2 + offset),
        type: wall.type,
        name: wall.name ? `${wall.name} copie` : null,
        ...(floorPlanId ? { floorPlanId } : {}),
      });
      setFloorPlan((prev) =>
        prev ? { ...prev, walls: [...(prev.walls ?? []), duplicated] } : prev,
      );
      setSelectedWallId(duplicated.id);
    } catch (err) {
      setError(getErrorMessage(err, 'Impossible de dupliquer le mur'));
    }
  }

  function toggleWallLock(wallId: string) {
    setLockedWallIds((current) => {
      const next = new Set(current);
      if (next.has(wallId)) next.delete(wallId);
      else next.add(wallId);
      return next;
    });
  }

  function updateWallLength(wall: FloorPlanWall, length: number) {
    if (!Number.isFinite(length) || length < 1) return;
    const angle = Math.atan2(wall.y2 - wall.y1, wall.x2 - wall.x1);
    const nextWall = {
      ...wall,
      x2: Math.round(wall.x1 + Math.cos(angle) * length),
      y2: Math.round(wall.y1 + Math.sin(angle) * length),
    };
    if (nextWall.x2 === wall.x2 && nextWall.y2 === wall.y2) return;
    const before: GeometrySnapshot = { tables: [], walls: [snapshotWallGeometry(wall)] };
    const after: GeometrySnapshot = { tables: [], walls: [snapshotWallGeometry(nextWall)] };
    recordGeometry({ before, after });
    applyGeometrySnapshot(after);
  }

  function updateWallAngle(wall: FloorPlanWall, degrees: number) {
    if (!Number.isFinite(degrees)) return;
    const length = getWallLength(wall);
    const radians = (degrees * Math.PI) / 180;
    const nextWall = {
      ...wall,
      x2: Math.round(wall.x1 + Math.cos(radians) * length),
      y2: Math.round(wall.y1 + Math.sin(radians) * length),
    };
    if (nextWall.x2 === wall.x2 && nextWall.y2 === wall.y2) return;
    const before: GeometrySnapshot = { tables: [], walls: [snapshotWallGeometry(wall)] };
    const after: GeometrySnapshot = { tables: [], walls: [snapshotWallGeometry(nextWall)] };
    recordGeometry({ before, after });
    applyGeometrySnapshot(after);
  }

  async function handleSaveFloorSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId) return;
    const widthMeters = parseRoomMeters(floorSettings.widthMeters);
    const lengthMeters = parseRoomMeters(floorSettings.lengthMeters);
    if (widthMeters === null || lengthMeters === null) {
      setSettingsError(
        `Utilisez des dimensions comprises entre ${MIN_ROOM_DIMENSION_METERS} et ${MAX_ROOM_DIMENSION_METERS} m, avec au maximum deux décimales.`,
      );
      return;
    }
    setError('');
    setSettingsError('');
    try {
      const path = floorPlanId
        ? `restaurants/${orgId}/floor-plans/${floorPlanId}`
        : `restaurants/${orgId}/floor-plan`;
      const updated = await patch<FloorPlan>(path, {
        name: floorSettings.name.trim() || 'Salle principale',
        width: Math.round(widthMeters * CANVAS_PIXELS_PER_METER),
        height: Math.round(lengthMeters * CANVAS_PIXELS_PER_METER),
      });
      setFloorPlan(updated);
      setSettingsDialogOpen(false);
    } catch (err) {
      setError(getErrorMessage(err, 'Impossible de modifier les paramètres du plan'));
    }
  }

  function handleWallPointerDown(
    e: React.PointerEvent,
    wall: FloorPlanWall,
    mode: 'move' | 'resize-start' | 'resize-end',
  ) {
    if (live || lockedWallIds.has(wall.id)) return;
    e.stopPropagation();
    setSelectedWallId(wall.id);
    setWallDragMode(mode);
    setWallDragStart({ pointerX: e.clientX, pointerY: e.clientY, wall });
    wallDragCurrentRef.current = wall;
    setWallLengthGuide(null);
    setWallResizeAlignGuide(null);
  }

  function findWallLengthGuide(wall: FloorPlanWall): WallLengthGuide | null {
    const wallLength = getWallLength(wall);
    if (wallLength < 1) return null;

    let best: { referenceWall: FloorPlanWall; length: number; diff: number } | null = null;
    for (const referenceWall of floorPlan?.walls ?? []) {
      if (referenceWall.id === wall.id || !areWallsPerpendicular(wall, referenceWall)) continue;
      const length = getWallLength(referenceWall);
      const diff = Math.abs(wallLength - length);
      if (diff <= WALL_LENGTH_MATCH_DISTANCE && (!best || diff < best.diff)) {
        best = { referenceWall, length, diff };
      }
    }

    if (!best) return null;

    const activeMidpoint = getWallMidpoint(wall);
    const referenceMidpoint = getWallMidpoint(best.referenceWall);
    return {
      activeWallId: wall.id,
      referenceWallId: best.referenceWall.id,
      activeWall: wall,
      referenceWall: best.referenceWall,
      length: best.length,
      labelX: (activeMidpoint.x + referenceMidpoint.x) / 2,
      labelY: (activeMidpoint.y + referenceMidpoint.y) / 2,
    };
  }

  function matchWallLengthToGuide(
    wall: FloorPlanWall,
    mode: 'resize-start' | 'resize-end',
    guide: WallLengthGuide,
  ): Partial<FloorPlanWall> {
    const fixed = mode === 'resize-start' ? { x: wall.x2, y: wall.y2 } : { x: wall.x1, y: wall.y1 };
    const dragged =
      mode === 'resize-start' ? { x: wall.x1, y: wall.y1 } : { x: wall.x2, y: wall.y2 };
    const dx = dragged.x - fixed.x;
    const dy = dragged.y - fixed.y;
    const currentLength = Math.hypot(dx, dy);
    if (currentLength < 1) return {};

    const ratio = guide.length / currentLength;
    const nextPoint = {
      x: Math.max(0, Math.min(canvasWidth, fixed.x + dx * ratio)),
      y: Math.max(0, Math.min(canvasHeight, fixed.y + dy * ratio)),
    };

    return mode === 'resize-start'
      ? { x1: nextPoint.x, y1: nextPoint.y }
      : { x2: nextPoint.x, y2: nextPoint.y };
  }

  function findWallResizeAlignGuide(
    wall: FloorPlanWall,
    mode: 'resize-start' | 'resize-end',
  ): { guide: WallResizeAlignGuide; coords: Partial<FloorPlanWall> } | null {
    const horizontal = Math.abs(wall.y1 - wall.y2) <= 0.5;
    const vertical = Math.abs(wall.x1 - wall.x2) <= 0.5;
    if (!horizontal && !vertical) return null;

    const dragged =
      mode === 'resize-start' ? { x: wall.x1, y: wall.y1 } : { x: wall.x2, y: wall.y2 };
    const candidates: { axis: 'x' | 'y'; value: number; dist: number }[] = [];

    const addCandidate = (axis: 'x' | 'y', value: number) => {
      const dist = Math.abs((axis === 'x' ? dragged.x : dragged.y) - value);
      if (dist <= WALL_ALIGN_GUIDE_DISTANCE) {
        candidates.push({ axis, value, dist });
      }
    };

    for (const referenceWall of floorPlan?.walls ?? []) {
      if (referenceWall.id === wall.id) continue;
      if (horizontal) {
        addCandidate('x', referenceWall.x1);
        addCandidate('x', referenceWall.x2);
      } else if (vertical) {
        addCandidate('y', referenceWall.y1);
        addCandidate('y', referenceWall.y2);
      }
    }

    if (candidates.length === 0) return null;

    const match = candidates.reduce((a, b) => (a.dist < b.dist ? a : b));
    const coords =
      mode === 'resize-start'
        ? match.axis === 'x'
          ? { x1: match.value }
          : { y1: match.value }
        : match.axis === 'x'
          ? { x2: match.value }
          : { y2: match.value };

    return {
      coords,
      guide: {
        axis: match.axis,
        value: match.value,
      },
    };
  }

  function getSnappedWallCoords(
    wall: FloorPlanWall,
    mode: 'move' | 'resize-start' | 'resize-end',
  ): Partial<FloorPlanWall> {
    const otherWalls = (floorPlan?.walls ?? []).filter((w) => w.id !== wall.id);
    const otherEndpoints: { x: number; y: number }[] = [];
    for (const w of otherWalls) {
      otherEndpoints.push({ x: w.x1, y: w.y1 });
      otherEndpoints.push({ x: w.x2, y: w.y2 });
    }

    if (mode === 'move') {
      const startRaw = { x: wall.x1, y: wall.y1 };
      const endRaw = { x: wall.x2, y: wall.y2 };
      let bestStart = startRaw;
      let bestEnd = endRaw;
      let bestStartDist = Infinity;
      let bestEndDist = Infinity;

      for (const ep of otherEndpoints) {
        const distStart = Math.hypot(startRaw.x - ep.x, startRaw.y - ep.y);
        if (distStart < WALL_SNAP_DISTANCE && distStart < bestStartDist) {
          bestStartDist = distStart;
          bestStart = ep;
        }
        const distEnd = Math.hypot(endRaw.x - ep.x, endRaw.y - ep.y);
        if (distEnd < WALL_SNAP_DISTANCE && distEnd < bestEndDist) {
          bestEndDist = distEnd;
          bestEnd = ep;
        }
      }

      if (bestStartDist < WALL_SNAP_DISTANCE || bestEndDist < WALL_SNAP_DISTANCE) {
        if (bestStartDist < bestEndDist) {
          const dx = bestStart.x - wall.x1;
          const dy = bestStart.y - wall.y1;
          return { x1: bestStart.x, y1: bestStart.y, x2: wall.x2 + dx, y2: wall.y2 + dy };
        } else {
          const dx = bestEnd.x - wall.x2;
          const dy = bestEnd.y - wall.y2;
          return { x1: wall.x1 + dx, y1: wall.y1 + dy, x2: bestEnd.x, y2: bestEnd.y };
        }
      }
      return {};
    }

    if (mode === 'resize-start') {
      const rawX = wall.x1;
      const rawY = wall.y1;
      const fixedX = wall.x2;
      const fixedY = wall.y2;

      // 1) Connexion prioritaire : accroche l'extremite a un point d'un autre mur
      //    (coin parfait). On ignore l'alignement d'axe tant qu'un point est proche.
      let bestEndpoint: { x: number; y: number; dist: number } | null = null;
      for (const ep of otherEndpoints) {
        const dist = Math.hypot(rawX - ep.x, rawY - ep.y);
        if (dist < WALL_SNAP_DISTANCE && (!bestEndpoint || dist < bestEndpoint.dist)) {
          bestEndpoint = { x: ep.x, y: ep.y, dist };
        }
      }
      if (bestEndpoint) {
        return { x1: bestEndpoint.x, y1: bestEndpoint.y };
      }

      // 2) Repli : alignement d'axe sur le propre mur (horizontal/vertical)
      const candidates: { x: number; y: number; dist: number }[] = [];
      if (Math.abs(rawY - fixedY) < WALL_SNAP_DISTANCE) {
        candidates.push({ x: rawX, y: fixedY, dist: Math.abs(rawY - fixedY) });
      }
      if (Math.abs(rawX - fixedX) < WALL_SNAP_DISTANCE) {
        candidates.push({ x: fixedX, y: rawY, dist: Math.abs(rawX - fixedX) });
      }

      if (candidates.length === 0) {
        return { x1: rawX, y1: rawY };
      }

      const best = candidates.reduce((a, b) => (a.dist < b.dist ? a : b));
      return { x1: best.x, y1: best.y };
    }

    // resize-end
    const rawX = wall.x2;
    const rawY = wall.y2;
    const fixedX = wall.x1;
    const fixedY = wall.y1;

    // 1) Connexion prioritaire : accroche l'extremite a un point d'un autre mur
    let bestEndpoint: { x: number; y: number; dist: number } | null = null;
    for (const ep of otherEndpoints) {
      const dist = Math.hypot(rawX - ep.x, rawY - ep.y);
      if (dist < WALL_SNAP_DISTANCE && (!bestEndpoint || dist < bestEndpoint.dist)) {
        bestEndpoint = { x: ep.x, y: ep.y, dist };
      }
    }
    if (bestEndpoint) {
      return { x2: bestEndpoint.x, y2: bestEndpoint.y };
    }

    // 2) Repli : alignement d'axe sur le propre mur (horizontal/vertical)
    const candidates: { x: number; y: number; dist: number }[] = [];
    if (Math.abs(rawY - fixedY) < WALL_SNAP_DISTANCE) {
      candidates.push({ x: rawX, y: fixedY, dist: Math.abs(rawY - fixedY) });
    }
    if (Math.abs(rawX - fixedX) < WALL_SNAP_DISTANCE) {
      candidates.push({ x: fixedX, y: rawY, dist: Math.abs(rawX - fixedX) });
    }

    if (candidates.length === 0) {
      return { x2: rawX, y2: rawY };
    }

    const best = candidates.reduce((a, b) => (a.dist < b.dist ? a : b));
    return { x2: best.x, y2: best.y };
  }

  function handleWallPointerMove(e: PointerEvent) {
    if (!wallDragStart || !wallDragMode) return;
    wallJustDraggedRef.current = true;

    let deltaX = (e.clientX - wallDragStart.pointerX) / zoom;
    let deltaY = (e.clientY - wallDragStart.pointerY) / zoom;
    if (snap) {
      deltaX = Math.round(deltaX / GRID_SIZE) * GRID_SIZE;
      deltaY = Math.round(deltaY / GRID_SIZE) * GRID_SIZE;
    }

    let rawCoords: Partial<FloorPlanWall>;
    if (wallDragMode === 'move') {
      rawCoords = {
        x1: wallDragStart.wall.x1 + deltaX,
        y1: wallDragStart.wall.y1 + deltaY,
        x2: wallDragStart.wall.x2 + deltaX,
        y2: wallDragStart.wall.y2 + deltaY,
      };
    } else if (wallDragMode === 'resize-start') {
      rawCoords = {
        x1: wallDragStart.wall.x1 + deltaX,
        y1: wallDragStart.wall.y1 + deltaY,
      };
    } else {
      rawCoords = {
        x2: wallDragStart.wall.x2 + deltaX,
        y2: wallDragStart.wall.y2 + deltaY,
      };
    }

    // Clamp raw coordinates to canvas bounds
    const clamped: Partial<FloorPlanWall> = {};
    if (rawCoords.x1 !== undefined) clamped.x1 = Math.max(0, Math.min(canvasWidth, rawCoords.x1));
    if (rawCoords.y1 !== undefined) clamped.y1 = Math.max(0, Math.min(canvasHeight, rawCoords.y1));
    if (rawCoords.x2 !== undefined) clamped.x2 = Math.max(0, Math.min(canvasWidth, rawCoords.x2));
    if (rawCoords.y2 !== undefined) clamped.y2 = Math.max(0, Math.min(canvasHeight, rawCoords.y2));

    // Build a temporary wall object from start + clamped
    const tempWall = { ...wallDragStart.wall, ...clamped };

    // Apply axis/endpoint snapping
    const snapped = getSnappedWallCoords(tempWall, wallDragMode);

    // Merge clamped + snapped
    let finalCoords = { ...clamped, ...snapped };
    let nextWall = { ...wallDragStart.wall, ...finalCoords };

    if (wallDragMode !== 'move') {
      const lengthGuide = findWallLengthGuide(nextWall);
      if (lengthGuide) {
        const lengthMatched = matchWallLengthToGuide(nextWall, wallDragMode, lengthGuide);
        finalCoords = { ...finalCoords, ...lengthMatched };
        nextWall = { ...wallDragStart.wall, ...finalCoords };
        setWallLengthGuide({ ...lengthGuide, activeWall: nextWall });
      } else {
        setWallLengthGuide(null);
      }

      const alignGuide = findWallResizeAlignGuide(nextWall, wallDragMode);
      if (alignGuide) {
        finalCoords = { ...finalCoords, ...alignGuide.coords };
        nextWall = { ...wallDragStart.wall, ...finalCoords };
        setWallResizeAlignGuide(alignGuide.guide);
      } else {
        setWallResizeAlignGuide(null);
      }
    } else {
      setWallLengthGuide(null);
      setWallResizeAlignGuide(null);
    }

    // Clamp again after snapping to ensure we stay in bounds
    const finalClamped: Partial<FloorPlanWall> = {};
    if (finalCoords.x1 !== undefined)
      finalClamped.x1 = Math.max(0, Math.min(canvasWidth, finalCoords.x1));
    if (finalCoords.y1 !== undefined)
      finalClamped.y1 = Math.max(0, Math.min(canvasHeight, finalCoords.y1));
    if (finalCoords.x2 !== undefined)
      finalClamped.x2 = Math.max(0, Math.min(canvasWidth, finalCoords.x2));
    if (finalCoords.y2 !== undefined)
      finalClamped.y2 = Math.max(0, Math.min(canvasHeight, finalCoords.y2));

    const finalWall = { ...wallDragStart.wall, ...finalClamped };

    setFloorPlan((prev) =>
      prev
        ? {
            ...prev,
            walls: (prev.walls ?? []).map((w) => (w.id === wallDragStart.wall.id ? finalWall : w)),
          }
        : prev,
    );
    wallDragCurrentRef.current = finalWall;
  }

  function handleWallPointerUp() {
    if (!wallDragStart) return;
    const currentWall = wallDragCurrentRef.current;
    if (currentWall) {
      const before = wallDragStart.wall;
      if (
        currentWall.x1 !== before.x1 ||
        currentWall.y1 !== before.y1 ||
        currentWall.x2 !== before.x2 ||
        currentWall.y2 !== before.y2
      ) {
        recordGeometry({
          before: { tables: [], walls: [snapshotWallGeometry(before)] },
          after: { tables: [], walls: [snapshotWallGeometry(currentWall)] },
        });
      }
      void updateWall(currentWall, currentWall.type, currentWall.name ?? null).catch(() => {
        // updateWall already sets the error message
      });
    }
    setWallDragMode(null);
    setWallDragStart(null);
    wallDragCurrentRef.current = null;
    setWallLengthGuide(null);
    setWallResizeAlignGuide(null);
    setSelectedWallId(null);
    setTimeout(() => {
      wallJustDraggedRef.current = false;
    }, 0);
  }

  useEffect(() => {
    if (!wallDragMode) return;
    const handleMove = (e: PointerEvent) => handleWallPointerMove(e);
    const handleUp = () => handleWallPointerUp();
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallDragMode, wallDragStart, zoom, snap, canvasWidth, canvasHeight]);

  // Deselect wall on Escape
  useEffect(() => {
    if (!selectedWallId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedWallId(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedWallId]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.matches('input, textarea, select, [contenteditable="true"]')
      ) {
        return;
      }

      if (event.key.toLowerCase() === 'g' && !live) {
        event.preventDefault();
        setGridVisible((visible) => !visible);
      } else if (event.key.toLowerCase() === 's' && !live) {
        event.preventDefault();
        setSnap((enabled) => !enabled);
      } else if (event.key.toLowerCase() === 'f' && !live) {
        event.preventDefault();
        centerCanvas();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
        if (selectedWall && !live) {
          event.preventDefault();
          void duplicateWall(selectedWall);
        }
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !live) {
        // Undo/redo des mutations de géométrie (édition uniquement).
        event.preventDefault();
        if (event.shiftKey) {
          redoGeometry();
        } else {
          undoGeometry();
        }
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && !live) {
        if (selectedTables.length > 0) {
          event.preventDefault();
          setMultiDeleteConfirmOpen(true);
        } else if (selectedZone) {
          event.preventDefault();
          void deleteZone(selectedZone.id);
        } else if (selectedWall) {
          event.preventDefault();
          void deleteWall(selectedWall.id);
        }
      } else if (
        ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) &&
        !live &&
        selectedTables.length > 0
      ) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        const nextTables = selectedTables.map((table) => {
          const dimensions = getTableSize(table);
          return {
            ...table,
            positionX: Math.min(
              Math.max(0, (table.positionX ?? 0) + dx),
              Math.max(0, (floorPlan?.width ?? DEFAULT_CANVAS_WIDTH) - dimensions.width),
            ),
            positionY: Math.min(
              Math.max(0, (table.positionY ?? 0) + dy),
              Math.max(0, (floorPlan?.height ?? DEFAULT_CANVAS_HEIGHT) - dimensions.height),
            ),
          };
        });
        const selectedIds = new Set(nextTables.map((table) => table.id));
        const stationaryTables = allTables.filter((table) => !selectedIds.has(table.id));
        if (
          nextTables.some((table) => {
            const { width, height, rotation } = getTableSize(table);
            return tablePlatesOverlapAtPosition({
              x: table.positionX ?? 0,
              y: table.positionY ?? 0,
              width,
              height,
              rotation,
              shape: table.shape,
              tables: stationaryTables,
            });
          })
        ) {
          return;
        }
        const before: GeometrySnapshot = {
          tables: selectedTables.map((t) => snapshotTableGeometry(t)),
          walls: [],
        };
        const after: GeometrySnapshot = {
          tables: nextTables.map((t) => snapshotTableGeometry(t)),
          walls: [],
        };
        recordGeometry({ before, after });
        applyGeometrySnapshot(after);
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  });

  function resolveTableDragPosition(
    start: DragStartInfo,
    delta: { x: number; y: number },
  ): {
    positionX: number;
    positionY: number;
    guides: TableAlignmentGuides;
    blocker?: CanvasTable;
  } {
    const rawX = start.originalX + delta.x / zoom;
    const rawY = start.originalY + delta.y / zoom;
    const boundedX = Math.max(0, Math.min(canvasWidth - start.width, rawX));
    const boundedY = Math.max(0, Math.min(canvasHeight - start.height, rawY));
    const guides = snap
      ? getTableAlignmentGuides({
          x: boundedX,
          y: boundedY,
          width: start.width,
          height: start.height,
          tables: allTables,
          excludedTableId: start.tableId,
        })
      : emptyTableAlignmentGuides();
    const grid = snap ? GRID_SIZE : 1;
    const snappedX = guides.x?.position ?? Math.round(boundedX / grid) * grid;
    const snappedY = guides.y?.position ?? Math.round(boundedY / grid) * grid;
    const positionX = Math.max(0, Math.min(canvasWidth - start.width, snappedX));
    const positionY = Math.max(0, Math.min(canvasHeight - start.height, snappedY));

    const neighbours = placedTables.filter((table) => table.id !== start.tableId);
    const proposed = { ...start.table, positionX, positionY };
    const plateBlocker = findOverlappingTablePlate({
      x: positionX,
      y: positionY,
      width: start.width,
      height: start.height,
      rotation: start.table.rotation ?? 0,
      shape: start.table.shape,
      tables: neighbours,
    });
    const chairBlocker = plateBlocker
      ? undefined
      : findOverlappingTableChairs(proposed, neighbours, { plateOnly: true });
    if (chairBlocker) {
      const nearby = nudgeTableClearOfChairs(proposed, neighbours, canvasWidth, canvasHeight);
      if (nearby) return { ...nearby, guides: emptyTableAlignmentGuides() };
    }
    const blocker = plateBlocker ?? chairBlocker;

    return {
      positionX,
      positionY,
      blocker,
      guides: blocker
        ? emptyTableAlignmentGuides()
        : {
            x: guides.x && positionX === guides.x.position ? guides.x : null,
            y: guides.y && positionY === guides.y.position ? guides.y : null,
          },
    };
  }

  function resolvePaletteTableDropPosition(
    table: Pick<FloorPlanTable, 'id' | 'capacity' | 'shape' | 'width' | 'height' | 'rotation'>,
    pointerStart: { x: number; y: number },
    delta: { x: number; y: number },
  ) {
    if (!canvasRef.current) return null;
    const rect = canvasRef.current.getBoundingClientRect();
    const { width, height } = getTableSize(table);
    const grid = snap ? GRID_SIZE : 1;
    const cursorX = (pointerStart.x + delta.x - rect.left) / zoom;
    const cursorY = (pointerStart.y + delta.y - rect.top) / zoom;
    const dropX = Math.round(cursorX / grid) * grid;
    const dropY = Math.round(cursorY / grid) * grid;
    const x = Math.max(0, Math.min(canvasWidth - width, dropX - width / 2));
    const y = Math.max(0, Math.min(canvasHeight - height, dropY - height / 2));
    return {
      x,
      y,
      width,
      height,
      overlapping: tablePlatesOverlapAtPosition({
        x,
        y,
        width,
        height,
        rotation: table.rotation ?? 0,
        shape: table.shape,
        tables: placedTables.filter((placedTable) => placedTable.id !== table.id),
      }),
    };
  }

  function handleDragStart(event: DragStartEvent) {
    justDraggedRef.current = true;
    setTableDragPreview(null);
    setTableDropOverlapping(false);
    setTableAlignGuides(emptyTableAlignmentGuides());
    const pointer = event.activatorEvent as PointerEvent | undefined;
    if (pointer) {
      pointerStartRef.current = { x: pointer.clientX, y: pointer.clientY };
    }

    const dragData = event.active.data.current as ActiveDragData | undefined;
    if (dragData?.kind === 'reservation') {
      setActiveDragData(dragData);
      return;
    }

    if (live) return;

    const table = allTables.find((t) => t.id === event.active.id);
    if (table) {
      const { width, height } = getTableSize(table);
      const moveId = ++tableMoveIdRef.current;
      const mutationVersion = (tableMutationVersionRef.current.get(table.id) ?? 0) + 1;
      tableMutationVersionRef.current.set(table.id, mutationVersion);
      setActiveDragData({ kind: 'existingTable', table });
      setDragStart({
        tableId: table.id,
        originalX: table.positionX ?? 0,
        originalY: table.positionY ?? 0,
        width,
        height,
        table,
        moveId,
        mutationVersion,
      });
    } else {
      setActiveDragData((event.active.data.current as PaletteItemData | undefined) ?? null);
    }
  }

  function handleDragCancel() {
    setActiveDragData(null);
    setDragStart(null);
    setTableDragPreview(null);
    setTableDropOverlapping(false);
    setWallAlignGuide(null);
    setTableAlignGuides(emptyTableAlignmentGuides());
    pointerStartRef.current = null;
    setTimeout(() => {
      justDraggedRef.current = false;
    }, 0);
  }

  async function handleDragEnd(event: DragEndEvent) {
    const start = dragStart;
    const data = activeDragData;
    const pointerStart = pointerStartRef.current;
    setActiveDragData(null);
    setDragStart(null);
    setTableDragPreview(null);
    setTableDropOverlapping(false);
    setWallAlignGuide(null);
    setTableAlignGuides(emptyTableAlignmentGuides());
    pointerStartRef.current = null;
    setTimeout(() => {
      justDraggedRef.current = false;
    }, 0);

    if (data?.kind === 'reservation') {
      const targetTableId = event.over?.id as string | undefined;
      if (targetTableId && targetTableId !== data.fromTableId) {
        void assignTable(data.reservation.id, targetTableId);
      }
      return;
    }

    if (live) {
      handleDragCancel();
      return;
    }

    if (!orgId) return;

    if (data?.kind === 'existingTable') {
      if (!start) return;
      const candidate = resolveTableDragPosition(start, event.delta);
      if (candidate.blocker) {
        toast.error(
          `Trop près de ${candidate.blocker.displayName ?? candidate.blocker.name}. La table est revenue à sa place.`,
        );
        return;
      }
      const { positionX: clampedX, positionY: clampedY } = candidate;
      if (clampedX === start.originalX && clampedY === start.originalY) return;

      recordGeometry({
        before: {
          tables: [
            snapshotTableGeometry({
              ...start.table,
              positionX: start.originalX,
              positionY: start.originalY,
            }),
          ],
          walls: [],
        },
        after: {
          tables: [
            snapshotTableGeometry({ ...start.table, positionX: clampedX, positionY: clampedY }),
          ],
          walls: [],
        },
      });

      setFloorPlan((prev) =>
        prev ? replaceTablePosition(prev, start.tableId, clampedX, clampedY) : prev,
      );

      try {
        setError('');
        const updated = await patch<FloorPlanTable>(
          `restaurants/${orgId}/floor-plan/tables/${start.tableId}`,
          {
            positionX: clampedX,
            positionY: clampedY,
            ...(floorPlanId ? { floorPlanId } : {}),
          },
        );
        if (
          start.moveId !== tableMoveIdRef.current ||
          start.mutationVersion !== tableMutationVersionRef.current.get(start.tableId)
        ) {
          return;
        }
        setFloorPlan((prev) =>
          prev
            ? replaceTablePosition(
                prev,
                start.tableId,
                updated.positionX ?? clampedX,
                updated.positionY ?? clampedY,
              )
            : prev,
        );
      } catch (err) {
        if (
          start.moveId !== tableMoveIdRef.current ||
          start.mutationVersion !== tableMutationVersionRef.current.get(start.tableId)
        ) {
          return;
        }
        setError(
          `Déplacement de ${start.table.displayName ?? start.table.name} non enregistré. ${getErrorMessage(err, 'Réessayez.')}`,
        );
        setFloorPlan((prev) =>
          prev ? replaceTablePosition(prev, start.tableId, start.originalX, start.originalY) : prev,
        );
      }
      return;
    }

    if (data?.kind === 'placeTable' && pointerStart) {
      const candidate = resolvePaletteTableDropPosition(data.table, pointerStart, event.delta);
      if (!candidate) return;
      const finalPosition = candidate.overlapping
        ? findNearbyFreeTablePosition(
            { ...data.table, positionX: candidate.x, positionY: candidate.y },
            placedTables,
            canvasWidth,
            canvasHeight,
          )
        : { x: candidate.x, y: candidate.y };

      if (!finalPosition) {
        setError('Aucune place libre près de cet emplacement.');
        return;
      }

      const before = snapshotTableGeometry(data.table);
      const after = snapshotTableGeometry({
        ...data.table,
        positionX: finalPosition.x,
        positionY: finalPosition.y,
      });
      recordGeometry({
        before: { tables: [before], walls: [] },
        after: { tables: [after], walls: [] },
      });
      setSelectedTableIds(new Set([data.table.id]));
      setLastSelectedTableId(data.table.id);
      setSelectedWallId(null);
      setFloorPlan((prev) =>
        prev ? replaceTablePosition(prev, data.table.id, finalPosition.x, finalPosition.y) : prev,
      );
      try {
        setError('');
        const updated = await patch<FloorPlanTable>(
          `restaurants/${orgId}/floor-plan/tables/${data.table.id}`,
          {
            positionX: finalPosition.x,
            positionY: finalPosition.y,
            ...(floorPlanId ? { floorPlanId } : {}),
          },
        );
        const positionX = updated.positionX ?? finalPosition.x;
        const positionY = updated.positionY ?? finalPosition.y;
        setFloorPlan((prev) =>
          prev ? replaceTablePosition(prev, data.table.id, positionX, positionY) : prev,
        );
      } catch (err) {
        setError(getErrorMessage(err, 'Impossible de placer la table'));
        setFloorPlan((prev) =>
          prev
            ? replaceTablePosition(prev, data.table.id, data.table.positionX, data.table.positionY)
            : prev,
        );
      }
      return;
    }

    if (data?.kind === 'placeTable' && pointerStart && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const { width, height } = getTableSize(data.table);
      const grid = snap ? GRID_SIZE : 1;
      const cursorX = (pointerStart.x + event.delta.x - rect.left) / zoom;
      const cursorY = (pointerStart.y + event.delta.y - rect.top) / zoom;
      const positionX = Math.max(
        0,
        Math.min(canvasWidth - width, Math.round((cursorX - width / 2) / grid) * grid),
      );
      const positionY = Math.max(
        0,
        Math.min(canvasHeight - height, Math.round((cursorY - height / 2) / grid) * grid),
      );
      const before = snapshotTableGeometry(data.table);
      const after = snapshotTableGeometry({ ...data.table, positionX, positionY });
      recordGeometry({
        before: { tables: [before], walls: [] },
        after: { tables: [after], walls: [] },
      });
      setSelectedTableIds(new Set([data.table.id]));
      setLastSelectedTableId(data.table.id);
      setSelectedWallId(null);
      setFloorPlan((prev) =>
        prev ? replaceTablePosition(prev, data.table.id, positionX, positionY) : prev,
      );
      try {
        setError('');
        const updated = await patch<FloorPlanTable>(
          `restaurants/${orgId}/floor-plan/tables/${data.table.id}`,
          {
            positionX,
            positionY,
            ...(floorPlanId ? { floorPlanId } : {}),
          },
        );
        setFloorPlan((prev) =>
          prev
            ? replaceTablePosition(
                prev,
                data.table.id,
                updated.positionX ?? positionX,
                updated.positionY ?? positionY,
              )
            : prev,
        );
      } catch (err) {
        setError(getErrorMessage(err, 'Impossible de placer la table'));
        setFloorPlan((prev) =>
          prev
            ? replaceTablePosition(prev, data.table.id, data.table.positionX, data.table.positionY)
            : prev,
        );
      }
      return;
    }

    if (data?.kind === 'zone' && pointerStart && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const width = Math.min(360, canvasWidth - 64);
      const height = Math.min(220, canvasHeight - 64);
      const grid = snap ? GRID_SIZE : 1;
      const cursorX = (pointerStart.x + event.delta.x - rect.left) / zoom;
      const cursorY = (pointerStart.y + event.delta.y - rect.top) / zoom;
      const x = Math.max(
        0,
        Math.min(canvasWidth - width, Math.round((cursorX - width / 2) / grid) * grid),
      );
      const y = Math.max(
        0,
        Math.min(canvasHeight - height, Math.round((cursorY - height / 2) / grid) * grid),
      );
      try {
        setError('');
        const zone = await post<FloorPlanZone>(`restaurants/${orgId}/floor-plan/zones`, {
          name: getNextZoneName(zones),
          sectionId: null,
          x,
          y,
          width,
          height,
          rotation: 0,
          ...(floorPlanId ? { floorPlanId } : {}),
        });
        setFloorPlan((prev) => (prev ? { ...prev, zones: [...(prev.zones ?? []), zone] } : prev));
        setSelectedTableIds(new Set());
        setLastSelectedTableId(null);
        setSelectedWallId(null);
        setSelectedZoneId(zone.id);
      } catch (err) {
        setError(getErrorMessage(err, 'Impossible de créer la zone'));
      }
      return;
    }

    if (
      data &&
      (data.kind === 'table' || data.kind === 'wall') &&
      pointerStart &&
      canvasRef.current
    ) {
      const rect = canvasRef.current.getBoundingClientRect();
      const finalClientX = pointerStart.x + event.delta.x;
      const finalClientY = pointerStart.y + event.delta.y;

      const grid = snap ? GRID_SIZE : 1;
      let dropX = Math.round((finalClientX - rect.left) / zoom / grid) * grid;
      let dropY = Math.round((finalClientY - rect.top) / zoom / grid) * grid;

      if (data.kind === 'table') {
        const table = {
          id: 'palette-new-table',
          name: 'Table',
          capacity: data.capacity,
          minCapacity: 1,
          isActive: true,
          positionX: null,
          positionY: null,
          width: null,
          height: null,
          rotation: 0,
          shape: data.shape,
        } satisfies FloorPlanTable;
        const candidate = resolvePaletteTableDropPosition(table, pointerStart, event.delta);
        if (!candidate) return;
        const finalPosition = candidate.overlapping
          ? findNearbyFreeTablePosition(
              { ...table, positionX: candidate.x, positionY: candidate.y },
              placedTables,
              canvasWidth,
              canvasHeight,
            )
          : { x: candidate.x, y: candidate.y };
        if (!finalPosition) {
          setError('Aucune place libre près de cet emplacement.');
          return;
        }
        const numericTableNames = allTables
          .map((table) => Number(table.name.match(/^T(\d+)$/i)?.[1] ?? 0))
          .filter((value) => value > 0);
        const name = `T${Math.max(0, ...numericTableNames) + 1}`;

        try {
          setError('');
          const created = await post<FloorPlanTable>(`restaurants/${orgId}/floor-plan/tables`, {
            sectionId: null,
            minCapacity: 1,
            positionX: finalPosition.x,
            positionY: finalPosition.y,
            capacity: data.capacity,
            shape: data.shape,
            name,
            ...(floorPlanId ? { floorPlanId } : {}),
          });
          setFloorPlan((prev) => (prev ? replaceTable(prev, created) : prev));
        } catch (err) {
          setError(getErrorMessage(err, 'Impossible de créer la table'));
        }
      } else if (data.kind === 'wall') {
        const wallLengths: Record<PaletteWallType, number> = { wall: 120, door: 80, bar: 120 };
        const length = wallLengths[data.type];
        let x1: number;
        let x2: number;
        let y1: number;
        let y2: number;
        if (wallAlignGuide?.axis === 'x') {
          // Mur vertical aligne sur l'axe X d'un mur existant
          const vx = wallAlignGuide.value;
          x1 = vx;
          x2 = vx;
          y1 = Math.max(0, Math.min(canvasHeight, dropY - length / 2));
          y2 = Math.max(0, Math.min(canvasHeight, dropY + length / 2));
        } else if (wallAlignGuide?.axis === 'y') {
          // Mur horizontal aligne sur l'axe Y d'un mur existant
          const hy = wallAlignGuide.value;
          y1 = hy;
          y2 = hy;
          x1 = Math.max(0, Math.min(canvasWidth, dropX - length / 2));
          x2 = Math.max(0, Math.min(canvasWidth, dropX + length / 2));
        } else {
          const centerX = dropX;
          const centerY = dropY;
          x1 = Math.max(0, Math.min(canvasWidth, centerX - length / 2));
          x2 = Math.max(0, Math.min(canvasWidth, centerX + length / 2));
          y1 = Math.max(0, Math.min(canvasHeight, centerY));
          y2 = Math.max(0, Math.min(canvasHeight, centerY));
        }

        // Accroche les pointes du nouveau mur aux points existants (coins parfaits)
        const snapDropPoint = (px: number, py: number): { x: number; y: number } | null => {
          let best: { x: number; y: number; dist: number } | null = null;
          for (const w of floorPlan?.walls ?? []) {
            for (const ep of [
              { x: w.x1, y: w.y1 },
              { x: w.x2, y: w.y2 },
            ]) {
              const d = Math.hypot(px - ep.x, py - ep.y);
              if (d < WALL_SNAP_DISTANCE && (!best || d < best.dist)) {
                best = { x: ep.x, y: ep.y, dist: d };
              }
            }
          }
          return best ? { x: best.x, y: best.y } : null;
        };
        const snappedStart = snapDropPoint(x1, y1);
        if (snappedStart) {
          x1 = snappedStart.x;
          y1 = snappedStart.y;
        }
        const snappedEnd = snapDropPoint(x2, y2);
        if (snappedEnd) {
          x2 = snappedEnd.x;
          y2 = snappedEnd.y;
        }

        try {
          setError('');
          const wall = await post<FloorPlanWall>(`restaurants/${orgId}/floor-plan/walls`, {
            x1,
            y1,
            x2,
            y2,
            type: data.type as WallType,
            name: null,
            ...(floorPlanId ? { floorPlanId } : {}),
          });
          setFloorPlan((prev) => (prev ? { ...prev, walls: [...(prev.walls ?? []), wall] } : prev));
        } catch (err) {
          setError(getErrorMessage(err, 'Impossible de créer le mur'));
        }
      }
    }
  }

  // Pendant un drag de mur depuis la palette : detecte un mur existant de meme
  // orientation dont l'axe est aligne avec le mur preview, et stocke le guide.
  function handleDragMove(event: DragMoveEvent) {
    const data = activeDragData;
    const pointerStart = pointerStartRef.current;

    if (data?.kind === 'existingTable' && dragStart) {
      const nextPosition = resolveTableDragPosition(dragStart, event.delta);
      const nextGuides = nextPosition.guides;
      setTableDragPreview({
        ...nextPosition,
        chairConflict: nextPosition.blocker
          ? undefined
          : findOverlappingTableChairs(
              {
                ...dragStart.table,
                positionX: nextPosition.positionX,
                positionY: nextPosition.positionY,
              },
              placedTables,
            ),
      });
      setTableAlignGuides((current) => {
        const sameGuide = (a: TableAlignmentGuide | null, b: TableAlignmentGuide | null) =>
          a?.value === b?.value && a?.position === b?.position;
        return sameGuide(current.x, nextGuides.x) && sameGuide(current.y, nextGuides.y)
          ? current
          : nextGuides;
      });
      if (wallAlignGuide) setWallAlignGuide(null);
      return;
    }

    if ((data?.kind === 'table' || data?.kind === 'placeTable') && pointerStart) {
      const table =
        data.kind === 'placeTable'
          ? data.table
          : {
              id: 'palette-new-table',
              capacity: data.capacity,
              shape: data.shape,
              width: null,
              height: null,
              rotation: 0,
            };
      setTableDropOverlapping(
        resolvePaletteTableDropPosition(table, pointerStart, event.delta)?.overlapping ?? false,
      );
      setTableAlignGuides(emptyTableAlignmentGuides());
      if (wallAlignGuide) setWallAlignGuide(null);
      return;
    }

    setTableDropOverlapping(false);
    setTableAlignGuides((current) =>
      current.x || current.y ? emptyTableAlignmentGuides() : current,
    );

    if (data?.kind !== 'wall' || !pointerStart || !canvasRef.current) {
      if (wallAlignGuide) setWallAlignGuide(null);
      return;
    }
    const rect = canvasRef.current.getBoundingClientRect();
    const cursorX = (pointerStart.x + event.delta.x - rect.left) / zoom;
    const cursorY = (pointerStart.y + event.delta.y - rect.top) / zoom;

    let best: { axis: 'x' | 'y'; value: number; dist: number } | null = null;

    for (const w of floorPlan?.walls ?? []) {
      const horiz = Math.abs(w.y1 - w.y2) <= 0.5;
      const vert = Math.abs(w.x1 - w.x2) <= 0.5;
      if (horiz) {
        const wy = (w.y1 + w.y2) / 2;
        const d = Math.abs(cursorY - wy);
        if (d <= WALL_ALIGN_GUIDE_DISTANCE && (!best || d < best.dist)) {
          best = { axis: 'y', value: wy, dist: d };
        }
      } else if (vert) {
        const wx = (w.x1 + w.x2) / 2;
        const d = Math.abs(cursorX - wx);
        if (d <= WALL_ALIGN_GUIDE_DISTANCE && (!best || d < best.dist)) {
          best = { axis: 'x', value: wx, dist: d };
        }
      }
    }
    if (best) {
      if (
        !wallAlignGuide ||
        wallAlignGuide.axis !== best.axis ||
        wallAlignGuide.value !== best.value
      ) {
        setWallAlignGuide({ axis: best.axis, value: best.value });
      }
    } else if (wallAlignGuide) {
      setWallAlignGuide(null);
    }
  }

  const dialog = (
    <Dialog
      open={dialogOpen}
      onOpenChange={(open) => {
        if (!open) {
          setDialogOpen(false);
          setEditingTable(null);
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Modifier la table</DialogTitle>
          <DialogDescription>Modifiez les informations de la table.</DialogDescription>
        </DialogHeader>

        <form id="table-form" onSubmit={handleSubmitTable} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="table-name">Nom</Label>
            <Input
              id="table-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="bg-card border-border"
              placeholder="Ex. Table 1"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="table-capacity">Capacité</Label>
              <Input
                id="table-capacity"
                type="number"
                min={1}
                value={form.capacity}
                onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value }))}
                className="bg-card border-border"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="table-min-capacity">Min.</Label>
              <Input
                id="table-min-capacity"
                type="number"
                min={1}
                value={form.minCapacity}
                onChange={(e) => setForm((f) => ({ ...f, minCapacity: e.target.value }))}
                className="bg-card border-border"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="table-shape">Forme</Label>
              <Select
                value={form.shape}
                onValueChange={(value) => setForm((f) => ({ ...f, shape: value as TableShape }))}
              >
                <SelectTrigger id="table-shape" className="bg-card border-border">
                  <SelectValue placeholder="Forme" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rect">Rectangle</SelectItem>
                  <SelectItem value="round">Rond</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Switch
              id="table-active"
              checked={form.isActive}
              onCheckedChange={(checked) => setForm((f) => ({ ...f, isActive: checked }))}
            />
            <Label htmlFor="table-active" className="text-sm text-muted-foreground">
              Table active
            </Label>
          </div>
        </form>

        <DialogFooter className="gap-2 sm:gap-2">
          {editingTable ? (
            <Button
              variant="destructive"
              type="button"
              onClick={() => {
                setPendingDeleteTableId(editingTable.id);
                setDialogOpen(false);
                setConfirmOpen(true);
              }}
            >
              <Trash2 size={16} className="mr-1" />
              Supprimer
            </Button>
          ) : null}
          <Button
            variant="outline"
            type="button"
            onClick={() => {
              setDialogOpen(false);
              setEditingTable(null);
            }}
          >
            Annuler
          </Button>
          <Button type="submit" form="table-form">
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const confirm = (
    <ConfirmDialog
      open={confirmOpen}
      onConfirm={confirmDeleteTable}
      onCancel={() => {
        setConfirmOpen(false);
        setPendingDeleteTableId(null);
      }}
      title="Supprimer la table"
      description="Cette action est irréversible. Voulez-vous vraiment supprimer cette table ?"
      confirmLabel="Supprimer"
      cancelLabel="Annuler"
      variant="destructive"
    />
  );

  const delayRecoveryConfirm = (
    <ConfirmDialog
      open={delayRecoveryConfirmOpen}
      onConfirm={() => void applyDelayRecovery()}
      onCancel={() => {
        setDelayRecoveryConfirmOpen(false);
        setWaitingListAcceptanceConfirmed(false);
      }}
      title="Confirmer les deux changements ?"
      description={
        delayImpact?.alternativeTable && delayImpact.waitingListEntry
          ? `${delayImpact.waitingListEntry.customerName} prendra la table libérée et ${reportedDelayReservation?.customerName || 'la réservation retardée'} passera sur ${delayImpact.alternativeTable.name}. Suppernote vérifiera encore les disponibilités. Aucun message n’est envoyé automatiquement.`
          : 'Suppernote vérifiera encore les disponibilités avant application. Aucun message n’est envoyé automatiquement.'
      }
      confirmLabel={applyingDelayRecovery ? 'Application…' : 'Confirmer les changements'}
      cancelLabel="Annuler"
      pending={applyingDelayRecovery}
      acknowledgementLabel={
        delayImpact?.waitingListEntry
          ? `${delayImpact.waitingListEntry.customerName} est présent(e) et accepte la table proposée.`
          : undefined
      }
      acknowledgementChecked={waitingListAcceptanceConfirmed}
      onAcknowledgementChange={setWaitingListAcceptanceConfirmed}
    />
  );

  const delayRecoveryRevertConfirm = (
    <ConfirmDialog
      open={delayRecoveryRevertConfirmOpen}
      onConfirm={() => void revertDelayRecovery()}
      onCancel={() => setDelayRecoveryRevertConfirmOpen(false)}
      title="Annuler ce plan ?"
      description={
        appliedDelayRecovery
          ? `${appliedDelayRecovery.delayedCustomerName} retrouvera ${appliedDelayRecovery.delayedOriginalTableName} et son horaire initial. La réservation créée pour ${appliedDelayRecovery.waitingCustomerName} sera annulée et le groupe retournera en liste d’attente. Les communications déjà effectuées ne peuvent pas être annulées.`
          : 'Suppernote restaurera le plan initial seulement si aucune donnée n’a changé depuis son application.'
      }
      confirmLabel={revertingDelayRecovery ? 'Annulation…' : 'Annuler ce plan'}
      cancelLabel="Conserver le plan"
      pending={revertingDelayRecovery}
      variant="destructive"
    />
  );

  const multiDeleteConfirm = (
    <ConfirmDialog
      open={multiDeleteConfirmOpen}
      onConfirm={confirmMultiDelete}
      onCancel={() => setMultiDeleteConfirmOpen(false)}
      title={`Supprimer ${selectedTables.length} tables`}
      description="Cette action est irréversible. Voulez-vous vraiment supprimer les tables sélectionnées ?"
      confirmLabel="Supprimer"
      cancelLabel="Annuler"
      variant="destructive"
    />
  );

  const settingsDialog = (
    <Dialog open={settingsDialogOpen} onOpenChange={setSettingsDialogOpen}>
      <DialogContent className="bg-card/95 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Paramètres de la salle</DialogTitle>
          <DialogDescription>Modifiez le nom et les dimensions du plan.</DialogDescription>
        </DialogHeader>

        <form id="floor-settings-form" onSubmit={handleSaveFloorSettings} className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="floor-name">Nom</Label>
            <Input
              id="floor-name"
              value={floorSettings.name}
              onChange={(e) => {
                setSettingsError('');
                setFloorSettings((s) => ({ ...s, name: e.target.value }));
              }}
              placeholder="Salle principale"
              className="bg-background"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="floor-width">Largeur</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="floor-width"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={floorSettings.widthMeters}
                  onChange={(e) => {
                    setSettingsError('');
                    setFloorSettings((s) => ({ ...s, widthMeters: e.target.value }));
                  }}
                  aria-invalid={Boolean(settingsError)}
                  aria-describedby="floor-settings-help"
                  className="bg-background tabular-nums"
                />
                <span className="text-sm text-muted-foreground">m</span>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="floor-length">Longueur</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="floor-length"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={floorSettings.lengthMeters}
                  onChange={(e) => {
                    setSettingsError('');
                    setFloorSettings((s) => ({ ...s, lengthMeters: e.target.value }));
                  }}
                  aria-invalid={Boolean(settingsError)}
                  aria-describedby="floor-settings-help"
                  className="bg-background tabular-nums"
                />
                <span className="text-sm text-muted-foreground">m</span>
              </div>
            </div>
          </div>
          <p
            id="floor-settings-help"
            className={cn('text-xs text-muted-foreground', settingsError && 'text-destructive')}
            role={settingsError ? 'alert' : undefined}
          >
            {settingsError ||
              `De ${MIN_ROOM_DIMENSION_METERS} à ${MAX_ROOM_DIMENSION_METERS} m · 12,5 et 12.5 sont acceptés.`}
          </p>
        </form>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" type="button" onClick={() => setSettingsDialogOpen(false)}>
            Annuler
          </Button>
          <Button type="submit" form="floor-settings-form">
            Appliquer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const bulkCreateDialog = (
    <Dialog open={bulkCreateDialogOpen} onOpenChange={setBulkCreateDialogOpen}>
      <DialogContent className="bg-card/95 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Créer mes tables</DialogTitle>
          <DialogDescription>
            Créez rapidement un lot de tables. Elles apparaîtront ensuite dans « À placer ».
          </DialogDescription>
        </DialogHeader>

        <form id="bulk-create-tables-form" onSubmit={createTablesBatch} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="bulk-table-count">Nombre de tables</Label>
              <Input
                id="bulk-table-count"
                type="number"
                min={1}
                max={50}
                value={bulkCreateForm.count}
                onChange={(event) =>
                  setBulkCreateForm((form) => ({ ...form, count: event.target.value }))
                }
                className="bg-background tabular-nums"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bulk-table-capacity">Places par table</Label>
              <Input
                id="bulk-table-capacity"
                type="number"
                min={1}
                max={30}
                value={bulkCreateForm.capacity}
                onChange={(event) =>
                  setBulkCreateForm((form) => ({ ...form, capacity: event.target.value }))
                }
                className="bg-background tabular-nums"
              />
            </div>
          </div>
        </form>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={() => setBulkCreateDialogOpen(false)}>
            Annuler
          </Button>
          <Button type="submit" form="bulk-create-tables-form" disabled={bulkCreateLoading}>
            {bulkCreateLoading ? 'Création…' : 'Créer les tables'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const duplicateDialog = (
    <Dialog open={duplicateDialogOpen} onOpenChange={setDuplicateDialogOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Dupliquer en rangée</DialogTitle>
          <DialogDescription>
            Créez plusieurs copies alignées avec le même espacement.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="duplicate-count">Nombre total de tables</Label>
            <Input
              id="duplicate-count"
              type="number"
              min={2}
              max={50}
              value={duplicateForm.count}
              onChange={(e) =>
                setDuplicateForm((f) => ({ ...f, count: Number(e.target.value) || 1 }))
              }
              className="bg-card border-border"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="duplicate-spacing">Espacement (cm)</Label>
            <Input
              id="duplicate-spacing"
              type="number"
              min={0}
              value={duplicateForm.spacing}
              onChange={(e) =>
                setDuplicateForm((f) => ({ ...f, spacing: Number(e.target.value) || 0 }))
              }
              className="bg-card border-border"
            />
          </div>
          {rowSource && rowSize ? (
            <figure className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
              <figcaption className="text-sm font-medium">Aperçu de la rangée</figcaption>
              {rowPositions.length > 0 ? (
                <svg
                  role="img"
                  aria-label={`${rowCount} tables, dont ${rowSource.name}`}
                  className="h-16 w-full text-primary"
                  viewBox={`0 0 ${rowCount * rowSize.width + (rowCount - 1) * rowSpacing} ${rowSize.height}`}
                >
                  {[rowSource.positionX!, ...rowPositions.map(({ x }) => x)].map((x, index) => (
                    <rect
                      key={x}
                      x={x - rowSource.positionX!}
                      y={0}
                      width={rowSize.width}
                      height={rowSize.height}
                      rx={rowSource.shape === 'round' ? rowSize.height / 2 : 8}
                      fill="currentColor"
                      opacity={index === 0 ? 1 : 0.35}
                    />
                  ))}
                </svg>
              ) : null}
              {!rowFits ? (
                <p role="status" className="text-sm text-destructive">
                  {rowPositions.length === 0
                    ? 'Indiquez un nombre de 2 à 50 tables et un espacement entier.'
                    : 'La rangée ne tient pas à droite de cette table. Réduisez le nombre de tables ou l’espacement.'}
                </p>
              ) : null}
            </figure>
          ) : null}
        </form>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" type="button" onClick={() => setDuplicateDialogOpen(false)}>
            Annuler
          </Button>
          <Button type="button" disabled={!rowFits} onClick={() => void duplicateSelectedAsRow()}>
            Dupliquer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // Le plein écran est piloté par la carte : on reflète l'état réel du navigateur
  // pour proposer une sortie explicite au lieu du seul raccourci Échap.
  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === cardRef.current);
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const selectedServiceStatus = selectedServiceTable
    ? tableStatuses.get(selectedServiceTable.id)
    : undefined;
  const selectedServiceReservation = selectedServiceStatus?.reservation ?? null;
  const unassignedReservations = useMemo(
    () =>
      (loadedLiveDate === liveDate ? reservations : [])
        .filter(
          (reservation) =>
            !reservation.tableId && ['PENDING', 'CONFIRMED'].includes(reservation.state),
        )
        .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)),
    [liveDate, loadedLiveDate, reservations],
  );
  const selectedUnassignedReservation = unassignedPlacement.reservationId
    ? (unassignedReservations.find(
        (reservation) => reservation.id === unassignedPlacement.reservationId,
      ) ?? null)
    : null;
  const unassignedAssignmentTable = unassignedPlacement.targetTableId
    ? (allTables.find((table) => table.id === unassignedPlacement.targetTableId) ?? null)
    : null;
  const compatibleUnassignedReservations =
    serviceIsToday &&
    selectedServiceTable &&
    selectedServiceStatus?.status === 'free' &&
    !selectedServiceReservation
      ? unassignedReservations.filter(
          (reservation) => reservation.partySize <= selectedServiceTable.capacity,
        )
      : [];

  async function loadUnassignedSuggestions(reservation: PlanningReservation) {
    setUnassignedPlacement((current) => ({ ...current, loading: true, message: null }));
    try {
      const query = floorPlanId ? `?floorPlanId=${floorPlanId}` : '';
      const result = await getRef.current<{
        suggestions?: TableSuggestion[];
        reason?: string;
      }>(`restaurants/${orgId}/floor-plan/reservations/${reservation.id}/suggest-table${query}`);
      const suggestions = (result.suggestions ?? []).filter((suggestion) =>
        placedTables.some((table) => table.id === suggestion.tableId),
      );
      setUnassignedPlacement((current) =>
        current.reservationId === reservation.id
          ? {
              ...current,
              suggestions,
              loading: false,
              message: suggestions.length ? null : result.reason || 'Aucune table disponible',
            }
          : current,
      );
    } catch (err) {
      setUnassignedPlacement((current) =>
        current.reservationId === reservation.id
          ? {
              ...current,
              loading: false,
              message: getErrorMessage(err, 'Impossible de suggérer une table'),
            }
          : current,
      );
    }
  }

  function startUnassignedPlacement(
    reservation: PlanningReservation,
    targetTableId: string | null = null,
  ) {
    setUnassignedPanelOpen(true);
    setUnassignedPlacement({
      reservationId: reservation.id,
      suggestions: [],
      targetTableId,
      message: null,
      loading: false,
    });
    if (reservation.state !== 'PENDING' && !targetTableId) {
      void loadUnassignedSuggestions(reservation);
    }
  }

  async function confirmUnassignedReservation() {
    if (!orgId || !selectedUnassignedReservation) return;
    const reservation = selectedUnassignedReservation;
    setUnassignedPlacement((current) => ({ ...current, loading: true, message: null }));
    try {
      await patchRef.current<void>(`reservations/${reservation.id}`, { status: 'CONFIRMED' });
      setReservations((current) =>
        current.map((item) =>
          item.id === reservation.id ? { ...item, state: 'CONFIRMED' } : item,
        ),
      );
      setUnassignedPlacement((current) => ({ ...current, loading: false, message: null }));
      if (!unassignedPlacement.targetTableId) {
        await loadUnassignedSuggestions({ ...reservation, state: 'CONFIRMED' });
      }
      await loadReservations({ force: true });
    } catch (err) {
      setUnassignedPlacement((current) => ({
        ...current,
        loading: false,
        message: getErrorMessage(err, 'Impossible de confirmer cette réservation'),
      }));
    }
  }

  async function confirmUnassignedAssignment() {
    if (!selectedUnassignedReservation || !unassignedAssignmentTable) return;
    const assigned = await assignTable(
      selectedUnassignedReservation.id,
      unassignedAssignmentTable.id,
    );
    if (!assigned) return;
    setUnassignedPlacement({
      reservationId: null,
      suggestions: [],
      targetTableId: null,
      message: null,
      loading: false,
    });
    setUnassignedPanelOpen(false);
    setSelectedServiceTableId(unassignedAssignmentTable.id);
  }

  function clearUnassignedPlacement() {
    setUnassignedPlacement({
      reservationId: null,
      suggestions: [],
      targetTableId: null,
      message: null,
      loading: false,
    });
  }

  const unassignedReservationsContent = (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">À placer</p>
            <Badge variant="secondary" className="h-5 min-w-5 justify-center px-1.5 text-[10px]">
              {unassignedReservations.length}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {unassignedReservations[0]
              ? `Prochaine arrivée · ${format(parseISO(unassignedReservations[0].startsAt), 'HH:mm')}`
              : 'Réservations sans table'}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="size-8 shrink-0 rounded-full p-0 transition-all duration-200"
          aria-label="Fermer les réservations à placer"
          onClick={() => {
            setUnassignedPanelOpen(false);
            setSelectedServiceTableId(null);
            clearUnassignedPlacement();
          }}
        >
          <X size={16} />
        </Button>
      </div>
      {unassignedReservations.length ? (
        <ul className="-mx-1 divide-y divide-border/70 pr-1">
          {unassignedReservations.map((reservation) => {
            const customerName = reservation.customerName || 'Sans nom';
            const startsAt = format(parseISO(reservation.startsAt), 'HH:mm');

            return (
              <li key={reservation.id}>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Choisir une table pour ${customerName}, ${startsAt}, ${reservation.partySize} couverts`}
                  className="group h-auto min-h-12 w-full justify-between gap-2 whitespace-normal rounded-lg px-1.5 py-2 text-left font-normal text-foreground transition-all duration-200 hover:bg-muted/50 hover:text-foreground"
                  onClick={() => startUnassignedPlacement(reservation)}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-3">
                    <time
                      dateTime={reservation.startsAt}
                      className="w-11 shrink-0 text-xs font-semibold tabular-nums text-foreground"
                    >
                      {startsAt}
                    </time>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{customerName}</span>
                        {reservation.state === 'PENDING' ? (
                          <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px]">
                            À confirmer
                          </Badge>
                        ) : null}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <Users size={12} aria-hidden="true" />
                        {reservation.partySize} couverts
                        {reservation.state === 'PENDING' ? (
                          <span className="ml-1 text-warning">· À confirmer</span>
                        ) : null}
                      </span>
                    </span>
                  </span>
                  <ChevronRight
                    size={15}
                    aria-hidden="true"
                    className="shrink-0 text-muted-foreground/60 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground"
                  />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p
          role="status"
          className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground"
        >
          Toutes les réservations sans table ont été traitées.
        </p>
      )}
    </div>
  );

  const unassignedPlacementContent = selectedUnassignedReservation ? (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 gap-1 px-2 text-xs transition-all duration-200"
          aria-label="Retour à la liste des réservations"
          onClick={() => {
            setSelectedServiceTableId(null);
            clearUnassignedPlacement();
            setUnassignedPanelOpen(true);
          }}
        >
          <ChevronLeft size={14} />À placer
        </Button>
        <p className="min-w-0 flex-1 truncate text-right text-sm font-semibold">
          Choisir une table
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="size-8 shrink-0 rounded-full p-0 transition-all duration-200"
          aria-label="Fermer le placement de réservation"
          onClick={() => {
            setUnassignedPanelOpen(false);
            clearUnassignedPlacement();
          }}
        >
          <X size={16} />
        </Button>
      </div>

      <div className="rounded-lg border border-border bg-background p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">
              {selectedUnassignedReservation.customerName || 'Sans nom'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {format(parseISO(selectedUnassignedReservation.startsAt), 'HH:mm')} ·{' '}
              {selectedUnassignedReservation.partySize} couverts
            </p>
          </div>
          <Badge variant="outline" className="shrink-0">
            {selectedUnassignedReservation.state === 'PENDING' ? 'À confirmer' : 'Confirmée'}
          </Badge>
        </div>
      </div>

      {selectedUnassignedReservation.state === 'PENDING' ? (
        <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3">
          <p className="text-xs text-foreground">
            Cette réservation n’est pas encore confirmée. Confirmez-la avant de lui attribuer une
            table.
          </p>
          <Button
            type="button"
            size="sm"
            className="w-full transition-all duration-200"
            disabled={unassignedPlacement.loading}
            onClick={() => void confirmUnassignedReservation()}
          >
            {unassignedPlacement.loading ? 'Confirmation…' : 'Confirmer la réservation'}
          </Button>
        </div>
      ) : null}

      {selectedUnassignedReservation.state === 'CONFIRMED' && !unassignedPlacement.targetTableId ? (
        <div className="space-y-2">
          <p role="status" className="text-xs text-muted-foreground">
            {unassignedPlacement.loading
              ? 'Recherche des tables compatibles…'
              : unassignedPlacement.suggestions.length
                ? 'Choisissez sur le plan ou parmi ces tables.'
                : (unassignedPlacement.message ?? 'Aucune table compatible disponible.')}
          </p>
          {unassignedPlacement.suggestions.map((suggestion, index) => (
            <Button
              key={suggestion.tableId}
              type="button"
              variant="outline"
              className={cn(
                'h-auto w-full justify-between gap-2 rounded-lg py-2.5 text-left transition-all duration-200',
                index === 0 &&
                  'border-success/30 bg-success/5 hover:border-success/50 hover:bg-success/10',
              )}
              onClick={() =>
                setUnassignedPlacement((current) => ({
                  ...current,
                  targetTableId: suggestion.tableId,
                  message: null,
                }))
              }
            >
              <span>
                {suggestion.name} · {suggestion.capacity} places
              </span>
              <span
                className={cn(
                  'shrink-0 text-xs font-medium',
                  index === 0 ? 'text-success' : 'text-muted-foreground',
                )}
              >
                {index === 0 ? 'Recommandée' : 'Compatible'}
              </span>
            </Button>
          ))}
        </div>
      ) : null}

      {unassignedPlacement.targetTableId ? (
        <div className="space-y-2 rounded-lg border border-border bg-background p-3">
          <p className="text-xs text-muted-foreground">Table choisie</p>
          <p className="text-sm font-semibold">
            {unassignedAssignmentTable?.displayName ??
              unassignedAssignmentTable?.name ??
              'Table indisponible'}
            {unassignedAssignmentTable ? ` · ${unassignedAssignmentTable.capacity} places` : ''}
          </p>
          {selectedUnassignedReservation.state === 'CONFIRMED' ? (
            <Button
              type="button"
              className="w-full transition-all duration-200"
              disabled={!unassignedAssignmentTable}
              onClick={() => void confirmUnassignedAssignment()}
            >
              Confirmer l’attribution
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full transition-all duration-200"
            onClick={() => {
              setUnassignedPlacement((current) => ({ ...current, targetTableId: null }));
              if (!unassignedPlacement.suggestions.length) {
                void loadUnassignedSuggestions(selectedUnassignedReservation);
              }
            }}
          >
            Choisir une autre table
          </Button>
        </div>
      ) : null}

      {unassignedPlacement.message && selectedUnassignedReservation.state === 'PENDING' ? (
        <p role="alert" className="text-xs text-destructive">
          {unassignedPlacement.message}
        </p>
      ) : null}
    </div>
  ) : null;

  const compatibleUnassignedReservationsContent = compatibleUnassignedReservations.length ? (
    <div className="space-y-2 border-t border-border pt-3">
      <p className="text-xs font-semibold">Réservations adaptées à la capacité</p>
      <ul className="max-h-40 space-y-2 overflow-y-auto pr-1">
        {compatibleUnassignedReservations.map((reservation) => (
          <li
            key={reservation.id}
            className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background p-2"
          >
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">
                {reservation.customerName || 'Sans nom'}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {format(parseISO(reservation.startsAt), 'HH:mm')} · {reservation.partySize} pers.
                {reservation.state === 'PENDING' ? ' · À confirmer' : ''}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="shrink-0 transition-all duration-200"
              onClick={() => {
                if (selectedServiceTable) {
                  startUnassignedPlacement(reservation, selectedServiceTable.id);
                }
              }}
            >
              Choisir
            </Button>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  useEffect(() => {
    setMobileServiceDetailsOpen(false);
  }, [selectedServiceTableId]);

  const selectedServiceStatusDotClass = statusDotClasses[selectedServiceStatus?.status ?? 'free'];

  const serviceOverview = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 transition-all duration-200"
          aria-label="Légende des statuts"
          title="Aide du plan"
        >
          <CircleHelp size={15} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 space-y-3 p-3">
        <p className="text-sm font-semibold">Légende</p>
        <div className="grid grid-cols-2 gap-3">
          {(['free', 'reserved', 'upcoming', 'late', 'occupied'] as TableStatus[]).map((status) => (
            <div key={status} className="flex items-center gap-2 text-xs text-foreground">
              <span
                aria-hidden="true"
                className={cn('size-2 shrink-0 rounded-full', statusDotClasses[status])}
              />
              {statusMeta[status].label}
            </div>
          ))}
        </div>
        <p className="border-t border-border pt-2 text-xs text-foreground/80">
          Attendues : tables affectées à une réservation à venir ou en retard. Une arrivée est
          imminente dans les 30 minutes. Les réservations sans table affectée ne sont pas comptées
          ici.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const mobileServiceInspector =
    live && serviceTab === 'plan' && (selectedServiceTable || unassignedPanelOpen) ? (
      <aside
        role="dialog"
        aria-label={
          selectedUnassignedReservation
            ? `Placement de ${selectedUnassignedReservation.customerName || 'la réservation'}`
            : selectedServiceTable
              ? `Actions pour ${selectedServiceTable.displayName ?? selectedServiceTable.name}`
              : 'Réservations à placer'
        }
        className="floor-plan-mobile-service-sheet pointer-events-auto max-h-[18rem] overflow-y-auto rounded-2xl border border-border bg-card/95 p-3 shadow-2xl backdrop-blur-md lg:hidden"
      >
        <div
          className="mx-auto mb-2 h-1 w-10 rounded-full bg-muted-foreground/25"
          aria-hidden="true"
        />
        {selectedUnassignedReservation ? (
          unassignedPlacementContent
        ) : unassignedPanelOpen && !selectedServiceTable ? (
          unassignedReservationsContent
        ) : selectedServiceTable ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">
                  {selectedServiceTable.displayName ?? selectedServiceTable.name}
                  <span className="font-normal text-muted-foreground">
                    {' · '}
                    {selectedServiceTable.capacity} places
                  </span>
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <span
                    aria-hidden="true"
                    className={cn('size-1.5 shrink-0 rounded-full', selectedServiceStatusDotClass)}
                  />
                  {selectedServiceStatus
                    ? statusMeta[selectedServiceStatus.status].label
                    : 'Disponible'}
                </p>
                {combinableTableIds.has(selectedServiceTable.id) ? (
                  <p className="mt-1 text-xs text-foreground">
                    Peut être combinée avec d’autres tables
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-8 shrink-0 rounded-full p-0 text-muted-foreground transition-all duration-200 hover:text-foreground"
                aria-label="Fermer les actions de la table"
                onClick={() => setSelectedServiceTableId(null)}
              >
                <X size={16} />
              </Button>
            </div>

            {selectedServiceReservation ? (
              <div className="mt-2 space-y-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <UserRound size={13} aria-hidden="true" />
                    <span className="truncate">
                      {selectedServiceReservation.customerName || 'Sans nom'} ·{' '}
                      {selectedServiceReservation.partySize} pers.
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Clock3 size={13} aria-hidden="true" />
                    {format(parseISO(selectedServiceReservation.startsAt), 'HH:mm')}
                  </span>
                </div>
                <ServiceCardBadges
                  reservationId={selectedServiceReservation.id}
                  state={serviceCards}
                />
                {selectedServiceReservation.state === 'SEATED' &&
                  selectedServiceReservation.seatedAt && (
                    <p className="flex items-center gap-1 text-[11px] font-medium text-foreground">
                      <Clock3 size={11} aria-hidden="true" />
                      <span>
                        À table depuis{' '}
                        {formatDistanceToNow(parseISO(selectedServiceReservation.seatedAt), {
                          locale: fr,
                          addSuffix: true,
                        })}
                      </span>
                    </p>
                  )}
              </div>
            ) : null}

            <div className="mt-3 flex gap-2">
              {selectedServiceReservation ? (
                <Button
                  type="button"
                  size="sm"
                  className="h-10 min-w-0 flex-1 transition-all duration-200"
                  disabled={updatingReservationStateId === selectedServiceReservation.id}
                  onClick={() =>
                    void updateReservationState(
                      selectedServiceReservation.id,
                      selectedServiceReservation.state === 'SEATED' ? 'HONORED' : 'SEATED',
                    )
                  }
                >
                  {selectedServiceReservation.state === 'SEATED' ? 'Libérer la table' : 'Installer'}
                </Button>
              ) : (
                <WalkInPlacement
                  key={selectedServiceTable.id}
                  table={{
                    id: selectedServiceTable.id,
                    name: selectedServiceTable.displayName ?? selectedServiceTable.name,
                    capacity: selectedServiceTable.capacity,
                  }}
                  onPlace={(partySize, name) =>
                    createWalkIn(selectedServiceTable.id, partySize, name)
                  }
                />
              )}
              {selectedServiceReservation ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-10 min-w-0 flex-1 transition-all duration-200"
                  disabled={!selectedServiceReservation}
                  aria-expanded={Boolean(selectedServiceReservation && mobileServiceDetailsOpen)}
                  onClick={() => setMobileServiceDetailsOpen((open) => !open)}
                >
                  Voir la réservation
                </Button>
              ) : null}
            </div>

            {!selectedServiceReservation ? compatibleUnassignedReservationsContent : null}

            {selectedServiceReservation && mobileServiceDetailsOpen ? (
              <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl border border-border bg-background/70 p-3 text-xs">
                <div>
                  <p className="text-muted-foreground">Arrivée</p>
                  <p className="mt-0.5 font-medium text-foreground">
                    {format(parseISO(selectedServiceReservation.startsAt), 'HH:mm')}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Suivi</p>
                  <p className="mt-0.5 font-medium text-foreground">
                    {formatServiceTiming(
                      selectedServiceReservation,
                      selectedServiceStatus?.status ?? 'upcoming',
                      new Date(),
                    )}
                  </p>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </aside>
    ) : null;

  const mobileEditInspector =
    !live && selectedTables.length > 0 && selectedTables.some((t) => t.positionX !== null) ? (
      <aside
        aria-label={
          selectedTable
            ? `Actions pour ${selectedTable.displayName ?? selectedTable.name}`
            : `${selectedTables.length} tables sélectionnées`
        }
        className="floor-plan-mobile-service-sheet pointer-events-auto max-h-[26rem] overflow-y-auto rounded-2xl border border-border bg-card/95 p-3 shadow-2xl backdrop-blur-md lg:hidden"
      >
        <div
          className="mx-auto mb-2 h-1 w-10 rounded-full bg-muted-foreground/25"
          aria-hidden="true"
        />
        {selectedTable ? (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">
                  {selectedTable.displayName ?? selectedTable.name}
                  <span className="font-normal text-muted-foreground">
                    {' · '}
                    {selectedTable.capacity} places
                  </span>
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {selectedTable.shape === 'round' ? 'Table ronde' : 'Table rectangulaire'}
                  {selectedTable.rotation ? ` · ${selectedTable.rotation}°` : ''}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-8 shrink-0 rounded-full p-0 text-muted-foreground transition-all duration-200 hover:text-foreground"
                aria-label="Fermer"
                onClick={() => setSelectedTableIds(new Set())}
              >
                <X size={16} />
              </Button>
            </div>

            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
              <div className="min-w-0 space-y-1">
                <Label
                  className="text-[10px] text-muted-foreground"
                  htmlFor="mobile-selected-table-name"
                >
                  Nom de la table
                </Label>
                <Input
                  key={`mobile-name-${selectedTable.id}-${selectedTable.name}`}
                  id="mobile-selected-table-name"
                  defaultValue={selectedTable.name}
                  className="h-9 bg-background text-sm"
                  onBlur={(event) => saveTableName(selectedTable, event.currentTarget.value)}
                />
              </div>
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground">Couverts</p>
                <div className="flex h-9 items-center rounded-md border border-input bg-background">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="size-8 rounded-r-none p-0"
                    aria-label="Diminuer la capacité"
                    disabled={selectedTable.capacity <= 1}
                    onClick={() => changeTableCapacity(selectedTable, -1)}
                  >
                    <Minus size={14} />
                  </Button>
                  <span
                    aria-live="polite"
                    className="min-w-7 px-1 text-center text-xs font-semibold tabular-nums"
                  >
                    {selectedTable.capacity}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="size-8 rounded-l-none p-0"
                    aria-label="Augmenter la capacité"
                    onClick={() => changeTableCapacity(selectedTable, 1)}
                  >
                    <Plus size={14} />
                  </Button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-9 justify-center gap-1.5 text-xs font-medium transition-all duration-200"
                onClick={() => void duplicateSingleTable(selectedTable)}
              >
                <Copy size={14} />
                Dupliquer
              </Button>
              {selectedTable.positionX !== null ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={openRowDuplicate}
                  className="col-span-full"
                >
                  Dupliquer en rangée
                </Button>
              ) : null}

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 justify-center gap-1.5 text-xs font-medium transition-all duration-200"
                onClick={() =>
                  void patchTable(selectedTable.id, {
                    rotation: ((selectedTable.rotation ?? 0) + 90) % 360,
                  })
                }
              >
                <RotateCw size={14} />
                90°
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 justify-center gap-1.5 text-xs font-medium transition-all duration-200"
                onClick={() =>
                  void patchTable(selectedTable.id, {
                    shape: selectedTable.shape === 'round' ? 'rect' : 'round',
                  })
                }
              >
                {selectedTable.shape === 'round' ? (
                  <>
                    <Square size={14} />
                    Rect.
                  </>
                ) : (
                  <>
                    <Circle size={14} />
                    Ronde
                  </>
                )}
              </Button>
            </div>
          </div>
        ) : selectedTables.length > 1 ? (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">
                  {selectedTables.length} tables sélectionnées
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Capacité cumulée : {selectedTables.reduce((acc, t) => acc + t.capacity, 0)} places
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-8 shrink-0 rounded-full p-0 text-muted-foreground transition-all duration-200 hover:text-foreground"
                aria-label="Fermer"
                onClick={() => setSelectedTableIds(new Set())}
              >
                <X size={16} />
              </Button>
            </div>

            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 flex-1 gap-1 text-xs"
                onClick={() => alignSelectedTables('x', 'center')}
              >
                <AlignCenter size={13} />
                Aligner
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="h-9 shrink-0 gap-1 text-xs"
                onClick={() => setMultiDeleteConfirmOpen(true)}
              >
                <Trash2 size={13} />
                Supprimer
              </Button>
            </div>
          </div>
        ) : null}
      </aside>
    ) : null;

  const inspector = live ? (
    <aside
      className={cn(
        'order-3 hidden h-full shrink-0 flex-col overflow-hidden bg-card motion-safe:transition-[width] motion-safe:duration-200 lg:flex',
        selectedServiceTable || unassignedPanelOpen ? 'w-72 border-l border-border' : 'w-0',
      )}
    >
      {selectedUnassignedReservation ? (
        <div className="w-72 flex-1 overflow-y-auto p-4">{unassignedPlacementContent}</div>
      ) : unassignedPanelOpen && !selectedServiceTable ? (
        <div className="w-72 flex-1 overflow-y-auto p-4">{unassignedReservationsContent}</div>
      ) : selectedServiceTable ? (
        <div className="w-72 flex-1 space-y-5 overflow-y-auto p-4">
          <div>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-lg font-semibold">
                  {selectedServiceTable.displayName ?? selectedServiceTable.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {selectedServiceTable.capacity} places
                  {selectedServiceTable.sectionName ? ` · ${selectedServiceTable.sectionName}` : ''}
                </p>
                {combinableTableIds.has(selectedServiceTable.id) ? (
                  <p className="mt-1 text-xs text-foreground">
                    Peut être combinée avec d’autres tables
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-1">
                <Badge variant="outline">
                  {selectedServiceStatus
                    ? statusMeta[selectedServiceStatus.status].label
                    : 'Disponible'}
                </Badge>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="size-8 shrink-0 rounded-full p-0 transition-all duration-200"
                  aria-label="Fermer la fiche de la table"
                  onClick={() => setSelectedServiceTableId(null)}
                >
                  <X size={16} />
                </Button>
              </div>
            </div>
          </div>
          {selectedServiceReservation ? (
            <div className="space-y-3 rounded-lg border border-border bg-background p-3">
              <div className="flex items-center gap-2 text-sm">
                <UserRound size={16} className="text-muted-foreground" />
                <span className="font-medium">
                  {selectedServiceReservation.customerName || 'Sans nom'}
                </span>
              </div>
              <ServiceCardBadges
                reservationId={selectedServiceReservation.id}
                state={serviceCards}
              />
              <div className="flex items-center gap-2 text-sm">
                <Users size={16} className="text-muted-foreground" />
                <span>{selectedServiceReservation.partySize} personnes</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Clock3 size={16} className="text-muted-foreground" />
                <span>
                  {format(parseISO(selectedServiceReservation.startsAt), 'HH:mm')} ·{' '}
                  {formatServiceTiming(
                    selectedServiceReservation,
                    selectedServiceStatus?.status ?? 'upcoming',
                    new Date(),
                  )}
                </span>
              </div>
              <div className="mt-3 flex gap-2">
                {['PENDING', 'CONFIRMED'].includes(selectedServiceReservation.state) && (
                  <Button
                    size="sm"
                    className="flex-1"
                    title="Confirme l’arrivée réelle du groupe et occupe la table"
                    disabled={updatingReservationStateId === selectedServiceReservation.id}
                    onClick={() =>
                      void updateReservationState(selectedServiceReservation.id, 'SEATED')
                    }
                  >
                    <UserRound size={15} className="mr-1.5" />
                    {updatingReservationStateId === selectedServiceReservation.id
                      ? 'Mise à jour…'
                      : 'Installer à table'}
                  </Button>
                )}
                {selectedServiceReservation.state === 'SEATED' && (
                  <Button
                    size="sm"
                    className="flex-1"
                    title="Clôture la réservation et rend la table disponible"
                    disabled={updatingReservationStateId === selectedServiceReservation.id}
                    onClick={() =>
                      void updateReservationState(selectedServiceReservation.id, 'HONORED')
                    }
                  >
                    <CircleCheck size={15} className="mr-1.5" />
                    {updatingReservationStateId === selectedServiceReservation.id
                      ? 'Mise à jour…'
                      : 'Libérer la table'}
                  </Button>
                )}
              </div>
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => void suggestTable(selectedServiceReservation.id)}
                >
                  Suggérer des tables
                </Button>
              </div>
              {copilotAllowed && selectedServiceReservation.state === 'CONFIRMED' && (
                <div className="space-y-2 rounded-md border border-border bg-card p-3">
                  <p className="text-xs font-semibold text-foreground">Retard annoncé</p>
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label="Retard annoncé en minutes"
                      type="number"
                      min={5}
                      max={180}
                      value={delayMinutes}
                      disabled={Boolean(
                        initialDelayImpact?.delayReportId &&
                        delayImpactReservationId === selectedServiceReservation.id,
                      )}
                      onChange={(event) => updateDelayMinutes(Number(event.target.value))}
                      className="h-8 bg-background text-xs"
                    />
                    <span className="shrink-0 text-xs text-muted-foreground">min</span>
                  </div>
                  {initialDelayImpact?.delayReportId &&
                  delayImpactReservationId === selectedServiceReservation.id ? (
                    <p className="text-[11px] text-muted-foreground">
                      Durée confirmée pendant l’appel client.
                    </p>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    disabled={delayImpactLoading}
                    onClick={() => void simulateDelayImpact(selectedServiceReservation.id)}
                  >
                    {delayImpactLoading ? 'Analyse…' : 'Analyser l’impact'}
                  </Button>
                  {delayImpact && delayImpactReservationId === selectedServiceReservation.id && (
                    <div
                      className={cn(
                        'space-y-2 rounded-md border p-2 text-xs',
                        delayImpact.feasible
                          ? 'border-success/25 bg-success/[0.04]'
                          : 'border-warning/25 bg-warning/[0.04]',
                      )}
                    >
                      <p className="font-medium text-foreground">{delayImpact.summary}</p>
                      {delayImpact.feasible &&
                      delayImpact.alternativeTable &&
                      delayImpact.waitingListEntry ? (
                        <>
                          <p className="text-muted-foreground">
                            Plan proposé : {delayImpact.waitingListEntry.customerName} · liste
                            d’attente, sans table →{' '}
                            {delayImpact.delayedReservation?.originalTableName ||
                              selectedServiceTable.displayName ||
                              selectedServiceTable.name}
                            {' ; '}
                            {selectedServiceReservation.customerName || 'Client'} ·{' '}
                            {delayImpact.delayedReservation?.originalTableName ||
                              selectedServiceTable.displayName ||
                              selectedServiceTable.name}{' '}
                            → {delayImpact.alternativeTable.name}.
                          </p>
                          {delayImpact.delayedReservation?.customerFacingProposedStartsAt ? (
                            <p className="text-muted-foreground">
                              Heure à communiquer au client :{' '}
                              {format(
                                parseISO(
                                  delayImpact.delayedReservation.customerFacingProposedStartsAt,
                                ),
                                'HH:mm',
                              )}
                              .
                            </p>
                          ) : null}
                          <Button
                            size="sm"
                            className="w-full"
                            onClick={() => setDelayRecoveryConfirmOpen(true)}
                          >
                            Vérifier et appliquer
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full"
                            disabled={communicationDraftsLoading}
                            onClick={() => void loadCommunicationDrafts()}
                          >
                            {communicationDraftsLoading ? 'Préparation…' : 'Préparer les messages'}
                          </Button>
                          {communicationDrafts.length > 0 ? (
                            <div className="space-y-2 border-t border-border pt-2">
                              {communicationDrafts.map((draft) => (
                                <div
                                  key={draft.recipient}
                                  className="rounded border border-border p-2"
                                >
                                  <p className="font-medium text-foreground">
                                    {draft.customerName} ·{' '}
                                    {draft.eligibleChannel
                                      ? `canal ${draft.eligibleChannel.toUpperCase()} autorisé`
                                      : draft.deliveryBlocker === 'no-contact'
                                        ? 'aucun contact'
                                        : 'consentement transactionnel requis'}
                                  </p>
                                  <p className="mt-1 text-muted-foreground">{draft.message}</p>
                                  <p className="mt-1 text-muted-foreground">
                                    Brouillon uniquement — aucun envoi automatique.
                                  </p>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                      <p className="text-muted-foreground">
                        {delayImpact.feasible
                          ? 'La confirmation reverra les conflits juste avant application.'
                          : 'Aucune modification n’est appliquée.'}
                      </p>
                    </div>
                  )}
                </div>
              )}
              {suggestions.length > 0 && (
                <ul className="mt-2 space-y-2">
                  {suggestions.map((s, idx) => (
                    <li key={s.tableId} className="rounded-md border border-border p-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">
                          {idx === 0 ? 'Meilleure · ' : ''}
                          {s.name} · {s.capacity} couverts
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs"
                          onClick={() => void assignTable(selectedServiceReservation.id, s.tableId)}
                        >
                          Assigner
                        </Button>
                      </div>
                      <p className="mt-1 text-muted-foreground">{s.reasons.join(' · ')}</p>
                    </li>
                  ))}
                </ul>
              )}
              {selectedServiceReservation.state === 'SEATED' &&
                selectedServiceReservation.seatedAt && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    À table depuis{' '}
                    {formatDistanceToNow(parseISO(selectedServiceReservation.seatedAt), {
                      locale: fr,
                      addSuffix: true,
                    })}
                  </p>
                )}
            </div>
          ) : (
            <div className="space-y-2 text-left">
              <p className="text-sm font-medium">Table disponible</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Aucune réservation en cours ou imminente.
              </p>
              {selectedServiceTable ? (
                <div className="mt-3">
                  <WalkInPlacement
                    key={selectedServiceTable.id}
                    table={{
                      id: selectedServiceTable.id,
                      name: selectedServiceTable.displayName ?? selectedServiceTable.name,
                      capacity: selectedServiceTable.capacity,
                    }}
                    onPlace={(partySize, name) =>
                      createWalkIn(selectedServiceTable.id, partySize, name)
                    }
                    className="w-full flex-none"
                  />
                </div>
              ) : null}
              {compatibleUnassignedReservationsContent}
            </div>
          )}
        </div>
      ) : null}
    </aside>
  ) : selectedWall || selectedZone || selectedTables.length > 0 ? (
    <aside
      className={cn(
        'order-3 h-auto max-h-72 w-full min-w-0 flex-col overflow-hidden border-t border-border bg-card lg:h-full lg:max-h-none lg:w-72 lg:min-w-72 lg:border-l lg:border-t-0',
        selectedTables.length > 0 || tablePlacementZoneId ? 'hidden lg:flex' : 'flex',
      )}
    >
      <div className="border-b border-border px-4 py-3">
        <p className="text-sm font-semibold">Inspecteur</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {selectedWall
            ? 'Mur sélectionné'
            : selectedZone
              ? `Zone ${selectedZone.name}`
              : selectedTables.length === 1
                ? `Table ${selectedTables[0]?.name ?? ''}`
                : `${selectedTables.length} tables sélectionnées`}
        </p>
      </div>
      {selectedWall ? (
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <div className="space-y-2">
            <Label htmlFor="wall-inspector-type">Type</Label>
            <Select
              value={selectedWall.type}
              onValueChange={(value) => {
                void updateWall(selectedWall, value as WallType, selectedWall.name ?? null).catch(
                  () => {},
                );
              }}
            >
              <SelectTrigger id="wall-inspector-type" className="bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="wall">Mur</SelectItem>
                <SelectItem value="door">Porte</SelectItem>
                <SelectItem value="window">Fenêtre</SelectItem>
                <SelectItem value="bar">Bar</SelectItem>
                <SelectItem value="plant">Décor</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="wall-inspector-name">Nom</Label>
            <Input
              key={`name-${selectedWall.id}-${selectedWall.name ?? ''}`}
              id="wall-inspector-name"
              defaultValue={selectedWall.name ?? ''}
              placeholder="Ex. Mur terrasse"
              className="bg-background"
              onBlur={(event) => {
                void updateWall(
                  selectedWall,
                  selectedWall.type,
                  event.currentTarget.value.trim() || null,
                ).catch(() => {});
              }}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="wall-inspector-length">Longueur</Label>
              <Input
                key={`length-${selectedWall.id}-${getWallLength(selectedWall)}`}
                id="wall-inspector-length"
                type="number"
                min={1}
                defaultValue={Math.round(getWallLength(selectedWall))}
                className="bg-background"
                onBlur={(event) =>
                  updateWallLength(selectedWall, Number(event.currentTarget.value))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wall-inspector-angle">Angle</Label>
              <Input
                key={`angle-${selectedWall.id}-${selectedWall.x2}-${selectedWall.y2}`}
                id="wall-inspector-angle"
                type="number"
                defaultValue={Math.round(
                  (Math.atan2(
                    selectedWall.y2 - selectedWall.y1,
                    selectedWall.x2 - selectedWall.x1,
                  ) *
                    180) /
                    Math.PI,
                )}
                className="bg-background"
                onBlur={(event) => updateWallAngle(selectedWall, Number(event.currentTarget.value))}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {(['x1', 'y1'] as const).map((coordinate) => (
              <div key={coordinate} className="space-y-2">
                <Label htmlFor={`wall-inspector-${coordinate}`}>
                  Position {coordinate === 'x1' ? 'X' : 'Y'}
                </Label>
                <Input
                  key={`${coordinate}-${selectedWall.id}-${selectedWall[coordinate]}`}
                  id={`wall-inspector-${coordinate}`}
                  type="number"
                  defaultValue={Math.round(selectedWall[coordinate])}
                  className="bg-background"
                  onBlur={(event) => {
                    const value = Number(event.currentTarget.value);
                    if (!Number.isFinite(value)) return;
                    const delta = value - selectedWall[coordinate];
                    const nextWall =
                      coordinate === 'x1'
                        ? { ...selectedWall, x1: value, x2: selectedWall.x2 + delta }
                        : { ...selectedWall, y1: value, y2: selectedWall.y2 + delta };
                    if (delta === 0) return;
                    recordGeometry({
                      before: { tables: [], walls: [snapshotWallGeometry(selectedWall)] },
                      after: { tables: [], walls: [snapshotWallGeometry(nextWall)] },
                    });
                    applyGeometrySnapshot({
                      tables: [],
                      walls: [snapshotWallGeometry(nextWall)],
                    });
                  }}
                />
              </div>
            ))}
          </div>
          <div className="rounded-lg border border-border bg-background p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Verrouillage</p>
                <p className="text-xs text-muted-foreground">Empêche tout déplacement.</p>
              </div>
              <Button
                type="button"
                variant={lockedWallIds.has(selectedWall.id) ? 'default' : 'outline'}
                size="sm"
                title={
                  lockedWallIds.has(selectedWall.id) ? 'Déverrouiller le mur' : 'Verrouiller le mur'
                }
                onClick={() => toggleWallLock(selectedWall.id)}
              >
                {lockedWallIds.has(selectedWall.id) ? <Lock size={16} /> : <Unlock size={16} />}
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 border-t border-border pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => void duplicateWall(selectedWall)}
            >
              <Copy size={16} className="mr-2" />
              Dupliquer
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                void deleteWall(selectedWall.id);
                setSelectedWallId(null);
              }}
            >
              <Trash2 size={16} className="mr-2" />
              Supprimer
            </Button>
          </div>
        </div>
      ) : selectedZone ? (
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <Button
            type="button"
            size="sm"
            className="w-full"
            onClick={() => {
              setTablePlacementZoneId(selectedZone.id);
              document
                .getElementById(`floor-plan-zone-${selectedZone.id}`)
                ?.focus({ preventScroll: true });
            }}
          >
            <Plus size={16} className="mr-1.5" />
            Ajouter une table ici
          </Button>
          <div className="space-y-2">
            <Label htmlFor="zone-inspector-name">Nom de la zone</Label>
            <Input
              key={`zone-name-${selectedZone.id}-${selectedZone.name}`}
              id="zone-inspector-name"
              defaultValue={selectedZone.name}
              className="bg-background"
              onBlur={(event) =>
                void patchZone(selectedZone.id, { name: event.currentTarget.value.trim() }).catch(
                  () => {},
                )
              }
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Une zone délimite un espace sur le plan. Utilisez la poignée du coin pour la
            redimensionner.
          </p>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="w-full transition-all duration-200"
            onClick={() => void deleteZone(selectedZone.id)}
          >
            <Trash2 size={14} className="mr-1.5" />
            Supprimer la zone
          </Button>
        </div>
      ) : selectedTables.length > 0 ? (
        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {selectedTable ? (
            <div className="space-y-4">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
                <div className="min-w-0 space-y-2">
                  <Label htmlFor="selected-table-name">Nom de la table</Label>
                  <Input
                    key={`selected-table-name-${selectedTable.id}-${selectedTable.name}`}
                    id="selected-table-name"
                    defaultValue={selectedTable.name}
                    className="bg-background"
                    onBlur={(event) => saveTableName(selectedTable, event.currentTarget.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Couverts</Label>
                  <div className="flex h-10 items-center rounded-md border border-input bg-background">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-9 rounded-r-none p-0"
                      aria-label="Diminuer la capacité"
                      disabled={selectedTable.capacity <= 1}
                      onClick={() => changeTableCapacity(selectedTable, -1)}
                    >
                      <Minus size={15} />
                    </Button>
                    <span
                      aria-live="polite"
                      className="min-w-8 px-1 text-center text-sm font-semibold tabular-nums"
                    >
                      {selectedTable.capacity}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-9 rounded-l-none p-0"
                      aria-label="Augmenter la capacité"
                      onClick={() => changeTableCapacity(selectedTable, 1)}
                    >
                      <Plus size={15} />
                    </Button>
                  </div>
                </div>
              </div>
              <div className="space-y-2 border-t border-border pt-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Forme
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      'px-1 transition-all duration-200',
                      selectedTable.shape !== 'round' && 'bg-secondary font-semibold',
                    )}
                    aria-label="Forme rectangle"
                    aria-pressed={selectedTable.shape !== 'round'}
                    onClick={() => void patchTable(selectedTable.id, { shape: 'rect' })}
                  >
                    <Square size={14} className="mr-1" />
                    Rectangle
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      'px-1 transition-all duration-200',
                      selectedTable.shape === 'round' && 'bg-secondary font-semibold',
                    )}
                    aria-label="Forme ronde"
                    aria-pressed={selectedTable.shape === 'round'}
                    onClick={() => void patchTable(selectedTable.id, { shape: 'round' })}
                  >
                    <Circle size={14} className="mr-1" />
                    Ronde
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full justify-center transition-all duration-200"
                  onClick={() => void duplicateSingleTable(selectedTable)}
                >
                  <Copy size={14} className="mr-1.5" />
                  Dupliquer
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full justify-center transition-all duration-200"
                  title="Pivoter de 90°"
                  onClick={() =>
                    void patchTable(selectedTable.id, {
                      rotation: ((selectedTable.rotation ?? 0) + 90) % 360,
                    })
                  }
                >
                  <RotateCw size={14} className="mr-1.5" />
                  Pivoter 90°
                </Button>
                {selectedTable.positionX !== null ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={openRowDuplicate}
                    className="col-span-full"
                  >
                    Dupliquer en rangée
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {selectedTables.length > 1 ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Aligner
              </p>
              <div className="grid grid-cols-3 gap-2">
                <Button variant="outline" size="sm" onClick={() => alignSelectedTables('x', 'min')}>
                  <AlignLeft size={14} className="mr-1" />
                  Gauche
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => alignSelectedTables('x', 'center')}
                >
                  <AlignCenter size={14} className="mr-1" />
                  Centre
                </Button>
                <Button variant="outline" size="sm" onClick={() => alignSelectedTables('x', 'max')}>
                  <AlignRight size={14} className="mr-1" />
                  Droite
                </Button>
                <Button variant="outline" size="sm" onClick={() => alignSelectedTables('y', 'min')}>
                  <AlignVerticalJustifyStart size={14} className="mr-1" />
                  Haut
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => alignSelectedTables('y', 'center')}
                >
                  <AlignVerticalJustifyCenter size={14} className="mr-1" />
                  Milieu
                </Button>
                <Button variant="outline" size="sm" onClick={() => alignSelectedTables('y', 'max')}>
                  <AlignVerticalJustifyEnd size={14} className="mr-1" />
                  Bas
                </Button>
              </div>
            </div>
          ) : null}

          {selectedTables.length > 1 ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Multiplier
              </p>
              <Button variant="outline" size="sm" onClick={openRowDuplicate}>
                <Copy size={14} className="mr-1" />
                Rangée
              </Button>
            </div>
          ) : null}

          <div className="border-t border-border pt-4">
            <Button variant="destructive" size="sm" onClick={() => setMultiDeleteConfirmOpen(true)}>
              <Trash2 size={14} className="mr-1" />
              Supprimer
            </Button>
          </div>
        </div>
      ) : null}
    </aside>
  ) : null;

  if (loading) {
    return (
      <>
        <Card className={cn('sokar-card', live && 'flex flex-1 flex-col')}>
          <CardHeader className="p-4">
            <Skeleton className="h-6 w-32 rounded-md" />
          </CardHeader>
          <CardContent
            className={cn(
              'overflow-hidden p-0',
              live
                ? 'min-h-56 flex-1'
                : 'h-[calc(100dvh-17rem)] min-h-[20rem] xl:h-[calc(100dvh-13rem)] xl:min-h-0',
            )}
          >
            <Skeleton className="h-full w-full" />
          </CardContent>
        </Card>
        {dialog}
        {confirm}
        {settingsDialog}
        {delayRecoveryConfirm}
        {delayRecoveryRevertConfirm}
      </>
    );
  }

  if (!floorPlan) {
    return (
      <>
        <Card className="sokar-card">
          <CardContent className="p-6">
            <DataFetchError
              message={planLoadError || error || 'Impossible de charger le plan de salle.'}
              onRetry={() => void loadFloorPlan()}
              retrying={loading}
            />
          </CardContent>
        </Card>
        {dialog}
        {confirm}
        {settingsDialog}
        {delayRecoveryConfirm}
        {delayRecoveryRevertConfirm}
      </>
    );
  }

  const activeDragTable = activeDragData?.kind === 'existingTable' ? activeDragData.table : null;
  const liveViewportBounds = live && serviceTab === 'plan' ? contentBounds : null;
  // En Live, le viewport est lui-même dimensionné sur la zone utile. Le canvas
  // complet est ensuite translaté sous ce cadre : les coordonnées métier restent
  // inchangées, mais le défilement ne peut plus atteindre le vide extérieur.
  const stageWidth = (liveViewportBounds?.width ?? canvasWidth) * zoom;
  const stageHeight = (liveViewportBounds?.height ?? canvasHeight) * zoom;
  const canvasTransform = liveViewportBounds
    ? `translate(${-liveViewportBounds.x * zoom}px, ${-liveViewportBounds.y * zoom}px) scale(${zoom})`
    : `scale(${zoom})`;

  // --- Cockpit de service : état, volumétrie, navigation ---------------------
  // Une seule source de vérité par information : le bandeau d'état porte le
  // statut et les actions à mener, la bande KPI ne porte que la volumétrie.
  // Dérivé de la date affichée uniquement : `servicePulse.isLiveDate` décrit la
  // date du dernier pulse chargé et peut donc être périmé pendant le changement
  // de jour, ce qui ferait diverger le badge du champ date.
  const serviceHeader =
    serviceIsToday &&
    loadedLiveDate === liveDate &&
    !loading &&
    !planLoadError &&
    !reservationsError
      ? getServiceHeader(placedTables, reservations, new Date())
      : null;
  const headerTarget = serviceHeader?.target;
  const serviceDateLabel = format(parseISO(liveDate), 'd MMM yyyy', { locale: fr });
  // Service vide : sans réservation ni action en attente, le cockpit complet
  // affichait deux bandes de zéros (statut + volumétrie) et un message d'état
  // vide, soit près de la moitié de l'écran d'un téléphone pour ne rien dire.
  // Les compteurs restent masqués dans cet état ; la navigation du service
  // devient le premier repère visuel et le plan démarre immédiatement dessous.
  const compactServiceCockpit = Boolean(
    live &&
    servicePulse &&
    servicePulse.status === 'calm' &&
    reservations.length === 0 &&
    servicePulse.lateArrivals === 0 &&
    servicePulse.arrivalsToSeat === 0 &&
    servicePulse.arrivalsNext30Minutes === 0 &&
    servicePulse.seatedTables === 0 &&
    servicePulse.pendingWaitingList === 0,
  );
  function shiftServiceDate(days: number) {
    setLiveDate(format(addDays(parseISO(liveDate), days), 'yyyy-MM-dd'));
  }

  return (
    <>
      <Card
        ref={cardRef}
        className={cn(
          // Vue service : même surface que les autres rubriques (arrondis, bordure,
          // fond carte). Le plein écran repasse en angles droits pour ne pas laisser
          // apparaître la page dans les coins de l'écran.
          'sokar-card',
          live && 'flex flex-1 flex-col',
          live && isFullscreen && 'rounded-none',
        )}
      >
        <CardHeader
          className={cn(
            'border-b border-border',
            // `space-y-0` neutralise le `space-y-1.5` du CardHeader de base : sinon
            // une couture de 6 px apparaît entre les bandes du cockpit.
            live ? 'gap-0 space-y-0 p-0' : 'flex flex-col gap-2 p-2.5',
          )}
        >
          {!live ? (
            <div className="flex min-w-0 items-center justify-between gap-2 overflow-hidden sm:justify-start sm:overflow-x-auto">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="hidden h-8 shrink-0 px-2 sm:flex"
                title="Paramètres du plan"
                aria-label="Paramètres du plan"
                onClick={openRoomSettings}
              >
                <Settings2 size={16} />
              </Button>
              <div
                role="toolbar"
                aria-label="Affichage du plan"
                className="hidden shrink-0 items-center gap-0.5 rounded-md border border-border bg-background p-1 sm:flex"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2"
                  title="Zoom arrière — −"
                  aria-label="Zoom arrière"
                  onClick={() => changeZoom(-ZOOM_STEP)}
                >
                  <ZoomOut size={16} />
                </Button>
                <button
                  type="button"
                  className="min-w-11 rounded-md px-1 text-center text-xs tabular-nums text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
                  title="Ajuster le plan à l'écran"
                  aria-label="Ajuster le plan à l'écran"
                  onClick={resetView}
                >
                  {Math.round(zoom * 100)}%
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2"
                  title="Zoom avant — +"
                  aria-label="Zoom avant"
                  onClick={() => changeZoom(ZOOM_STEP)}
                >
                  <ZoomIn size={16} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2"
                  title="Centrer le plan — F"
                  aria-label="Centrer le plan"
                  onClick={centerCanvas}
                >
                  <LocateFixed size={16} className="sm:mr-1.5" />
                  <span className="hidden sm:inline">Centrer</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2"
                  title="Plein écran"
                  aria-label="Plein écran"
                  onClick={() => {
                    if (document.fullscreenElement) void document.exitFullscreen();
                    else void cardRef.current?.requestFullscreen();
                  }}
                >
                  <Maximize2 size={16} />
                </Button>
              </div>
              <div
                role="toolbar"
                aria-label="Aides au placement"
                className="flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-background p-1 shadow-sm"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'h-9 gap-1 rounded-md px-1.5 transition-all duration-200 sm:gap-1.5 sm:px-2',
                    gridVisible
                      ? 'border border-primary/20 bg-secondary font-semibold text-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                  )}
                  title={
                    gridVisible
                      ? 'Grille active — masquer avec G'
                      : 'Grille inactive — afficher avec G'
                  }
                  aria-label={gridVisible ? 'Grille active, masquer' : 'Grille inactive, afficher'}
                  aria-pressed={gridVisible}
                  onClick={() => setGridVisible((v) => !v)}
                >
                  <Grid2x2 size={16} className="sm:mr-1.5" />
                  <span className="hidden sm:inline">Grille</span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      'ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full',
                      gridVisible ? 'bg-primary' : 'bg-muted-foreground/40',
                    )}
                  />
                </Button>
                <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'h-9 gap-1 rounded-md px-1.5 transition-all duration-200 sm:gap-1.5 sm:px-2',
                    snap
                      ? 'border border-primary/20 bg-secondary font-semibold text-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                  )}
                  title={
                    snap
                      ? 'Magnétisme actif — désactiver avec S'
                      : 'Magnétisme inactif — activer avec S'
                  }
                  aria-label={snap ? 'Magnétisme actif, désactiver' : 'Magnétisme inactif, activer'}
                  aria-pressed={snap}
                  onClick={() => setSnap((s) => !s)}
                >
                  <Magnet size={16} className="sm:mr-1.5" />
                  <span className="hidden sm:inline">Magnétisme</span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      'ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full',
                      snap ? 'bg-primary' : 'bg-muted-foreground/40',
                    )}
                  />
                </Button>
              </div>
              <div
                role="toolbar"
                aria-label="Historique"
                className="flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-background p-1 shadow-sm"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 w-9 p-0"
                  title="Annuler — ⌘Z"
                  aria-label="Annuler"
                  disabled={!canUndo}
                  onClick={undoGeometry}
                >
                  <Undo2 size={16} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 w-9 p-0"
                  title="Rétablir — ⌘⇧Z"
                  aria-label="Rétablir"
                  disabled={!canRedo}
                  onClick={redoGeometry}
                >
                  <Redo2 size={16} />
                </Button>
              </div>
              {planWriteStatus ? (
                <div
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  className="ml-0 flex min-h-9 shrink-0 items-center sm:ml-auto"
                >
                  {planWriteStatus === 'error' ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-9 gap-1.5 px-2 text-xs text-destructive transition-all duration-200"
                      disabled={retryingPlanWrites}
                      aria-busy={retryingPlanWrites}
                      onClick={() => void retryPlanWrites()}
                    >
                      {retryingPlanWrites ? (
                        <RotateCw size={14} className="animate-spin" aria-hidden="true" />
                      ) : (
                        <AlertCircle size={14} aria-hidden="true" />
                      )}
                      {retryingPlanWrites ? 'Nouvel essai…' : 'Échec · Réessayer'}
                    </Button>
                  ) : (
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 px-2 text-xs',
                        planWriteStatus === 'saved' ? 'text-success' : 'text-muted-foreground',
                      )}
                    >
                      {planWriteStatus === 'saved' ? (
                        <CircleCheck size={14} aria-hidden="true" />
                      ) : (
                        <RotateCw size={14} className="animate-spin" aria-hidden="true" />
                      )}
                      {planWriteStatus === 'invalid'
                        ? 'Modification refusée'
                        : planWriteStatus === 'saving'
                          ? 'Enregistrement…'
                          : 'Enregistré'}
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
          {live ? (
            <>
              <div role="region" aria-label="État du service" className="px-3 py-2 sm:px-4">
                <div className="flex w-full flex-wrap items-center gap-2">
                  {serviceIsToday ? (
                    <span className="text-sm font-semibold">Aujourd’hui</span>
                  ) : null}
                  <div
                    title={serviceDateLabel}
                    className="flex min-w-0 items-center gap-0.5 rounded-md border border-border bg-background p-0.5"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="hidden h-8 px-1.5 transition-all duration-200 sm:inline-flex"
                      title="Jour précédent"
                      aria-label="Jour précédent"
                      onClick={() => shiftServiceDate(-1)}
                    >
                      <ChevronLeft size={16} />
                    </Button>
                    <div className="relative h-8 w-28 min-w-0">
                      <Input
                        type="date"
                        value={liveDate}
                        aria-label="Date du service"
                        onChange={(e) => setLiveDate(e.target.value)}
                        className="floor-plan-service-date-input peer relative z-10 h-8 w-full border-0 bg-transparent px-1 text-center text-sm text-transparent focus:text-foreground sm:text-foreground"
                      />
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center truncate px-1 text-sm text-foreground peer-focus:opacity-0 sm:hidden"
                      >
                        {serviceDateLabel}
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="hidden h-8 px-1.5 transition-all duration-200 sm:inline-flex"
                      title="Jour suivant"
                      aria-label="Jour suivant"
                      onClick={() => shiftServiceDate(1)}
                    >
                      <ChevronRight size={16} />
                    </Button>
                  </div>
                  {serviceIsToday ? (
                    <div className="flex min-w-0 items-center gap-2 text-xs">
                      <span
                        role="status"
                        className={cn(
                          serviceHeader?.blocked
                            ? 'font-semibold text-foreground'
                            : 'text-muted-foreground',
                        )}
                      >
                        {serviceHeader?.blocked ? (
                          <span
                            className="mr-1.5 inline-block h-2 w-2 rounded-full bg-warning"
                            aria-hidden="true"
                          />
                        ) : null}
                        {serviceHeader?.text ??
                          (reservationsError || planLoadError
                            ? 'État de la salle indisponible'
                            : 'Chargement de la salle…')}
                      </span>
                      {headerTarget?.tableId && serviceHeader?.blocked ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs transition-all duration-200"
                          onClick={() => void openHeaderAssignment(headerTarget)}
                        >
                          Voir les alternatives
                        </Button>
                      ) : null}
                    </div>
                  ) : (
                    <Badge variant="outline" className="h-7 text-xs text-muted-foreground">
                      Archive
                    </Badge>
                  )}
                  {!serviceIsToday ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 transition-all duration-200"
                      onClick={() => setLiveDate(serviceToday)}
                    >
                      Aujourd’hui
                    </Button>
                  ) : null}
                  <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
                    {copilotAllowed && serviceTab === 'plan' ? (
                      <ServiceCopilotSimulator orgId={orgId} selectedFloorPlanId={floorPlanId} />
                    ) : null}
                    {serviceTab === 'plan' &&
                    serviceIsToday &&
                    unassignedReservations.length > 0 ? (
                      <Button
                        type="button"
                        size="sm"
                        variant={unassignedPanelOpen ? 'secondary' : 'outline'}
                        aria-label={`${unassignedReservations.length} réservations à placer`}
                        aria-pressed={unassignedPanelOpen}
                        aria-expanded={unassignedPanelOpen}
                        className="h-8 gap-1.5 whitespace-nowrap px-2 transition-all duration-200"
                        onClick={() => {
                          const open = !unassignedPanelOpen;
                          setUnassignedPanelOpen(open);
                          setSelectedServiceTableId(null);
                          if (!open) {
                            setUnassignedPlacement({
                              reservationId: null,
                              suggestions: [],
                              targetTableId: null,
                              message: null,
                              loading: false,
                            });
                          }
                        }}
                      >
                        <UserRound size={14} aria-hidden="true" />À placer ·{' '}
                        {unassignedReservations.length}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant={serviceTab === 'waiting-list' ? 'secondary' : 'outline'}
                      aria-label={
                        waitingListCount > 0
                          ? `${serviceTab === 'waiting-list' ? 'Retour au plan' : "Liste d'attente"}, ${waitingListCount} client${waitingListCount > 1 ? 's' : ''} en attente`
                          : serviceTab === 'waiting-list'
                            ? 'Retour au plan'
                            : "Liste d'attente"
                      }
                      aria-pressed={serviceTab === 'waiting-list'}
                      aria-controls="service-content"
                      title={
                        waitingListCount > 0
                          ? `${waitingListCount} client${waitingListCount > 1 ? 's' : ''} en attente`
                          : serviceTab === 'waiting-list'
                            ? 'Retour au plan'
                            : 'Liste d’attente'
                      }
                      className="relative h-8 w-8 shrink-0 p-0 transition-all duration-200"
                      onClick={() => setServiceTab(serviceTab === 'plan' ? 'waiting-list' : 'plan')}
                    >
                      <ListOrdered size={15} aria-hidden="true" />
                      {waitingListCount > 0 ? (
                        <span
                          aria-hidden="true"
                          className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-background bg-primary px-1 text-[9px] font-semibold leading-none text-primary-foreground"
                        >
                          {waitingListCount}
                        </span>
                      ) : null}
                    </Button>
                    {serviceTab === 'plan' ? serviceOverview : null}
                    {serviceTab === 'plan' && hasServerFilter ? (
                      <Select
                        value={selectedServerFilter ?? '_all_'}
                        onValueChange={(val) =>
                          setSelectedServerFilter(val === '_all_' ? null : val)
                        }
                      >
                        <SelectTrigger
                          aria-label="Filtrer par serveur"
                          title="Filtrer par serveur"
                          className="h-8 w-9 justify-center gap-0.5 border-border bg-background px-0 text-xs font-medium"
                        >
                          {selectedServerFilter === '_unassigned_' ? (
                            <UserX size={13} className="shrink-0 text-muted-foreground" />
                          ) : (
                            <UserRound size={13} className="shrink-0 text-primary" />
                          )}
                          {/* Sur téléphone le filtre reste une icône : la ligne du jour
                          doit tenir sans repousser les onglets sur une 3e ligne. */}
                          <span className="sr-only">
                            <SelectValue placeholder="Tous les serveurs" />
                          </span>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="_all_">
                            Toutes les tables ({placedTables.length})
                          </SelectItem>
                          {unassignedCount > 0 ? (
                            <SelectItem value="_unassigned_">
                              <span className="flex items-center gap-1.5">
                                <UserX size={13} className="shrink-0 text-muted-foreground" />
                                Sans serveur affecté ({unassignedCount})
                              </span>
                            </SelectItem>
                          ) : null}
                          {allServers.map((server) => {
                            const count = serverTableCounts.get(server) ?? 0;
                            return (
                              <SelectItem key={server} value={server}>
                                {server} ({count} {count > 1 ? 'tables' : 'table'})
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                    ) : null}
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </CardHeader>

        {live && (error || reservationsError) ? (
          <div className="sokar-error m-4 text-sm">
            <AlertCircle size={16} />
            {error || reservationsError}
          </div>
        ) : null}

        {!live && autoLayoutNotice ? (
          <div
            role="status"
            className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground"
          >
            <CircleCheck size={15} className="shrink-0 text-primary" aria-hidden="true" />
            <p className="min-w-0 flex-1">
              Disposition initiale appliquée. Les modifications sont enregistrées automatiquement ;
              vous pouvez annuler avec ⌘Z.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              aria-label="Masquer le message de disposition automatique"
              onClick={() => setAutoLayoutNotice(false)}
            >
              <X size={14} />
            </Button>
          </div>
        ) : null}

        {copilotAllowed && live && serviceTab === 'plan' && delayRecoveries.length > 0 ? (
          <section
            role="region"
            aria-label="Historique des plans de retard"
            className="border-b border-border bg-muted/30 px-4 py-2.5"
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Clock3 size={15} className="text-muted-foreground" />
                <p className="text-xs font-semibold text-foreground">Plans de retard</p>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Conservés après actualisation · {delayRecoveries.length} opération
                {delayRecoveries.length > 1 ? 's' : ''}
              </p>
            </div>
            <div className="grid gap-2 lg:grid-cols-2 xl:grid-cols-3">
              {delayRecoveries.slice(0, 3).map((recovery) => (
                <div
                  key={recovery.operationId}
                  className="flex min-w-0 items-start justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2 transition-all duration-200"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="truncate text-xs font-semibold text-foreground">
                        {recovery.delayedCustomerName} · +{recovery.delayMinutes} min
                      </p>
                      <Badge
                        variant="outline"
                        className={cn(
                          'h-5 text-[10px]',
                          recovery.status === 'reverted'
                            ? 'border-success/30 text-success'
                            : recovery.status === 'blocked'
                              ? 'border-warning/30 text-warning'
                              : 'border-primary/30 text-primary',
                        )}
                      >
                        {recovery.status === 'reverted'
                          ? 'Annulé'
                          : recovery.status === 'blocked'
                            ? 'À vérifier'
                            : 'Appliqué'}
                      </Badge>
                    </div>
                    <p className="mt-1 truncate text-[11px] text-muted-foreground">
                      {recovery.delayedCustomerName} : {recovery.originalTableName} →{' '}
                      {recovery.alternativeTableName} · {recovery.waitingCustomerName} →{' '}
                      {recovery.originalTableName}
                    </p>
                    <p
                      className={cn(
                        'mt-1 truncate text-[10px]',
                        recovery.blockedReason ? 'text-warning' : 'text-muted-foreground',
                      )}
                    >
                      {recovery.blockedReason ??
                        (recovery.revertedAt
                          ? `Annulé à ${format(parseISO(recovery.revertedAt), 'HH:mm')}`
                          : `Appliqué à ${format(parseISO(recovery.appliedAt), 'HH:mm')}`)}
                    </p>
                  </div>
                  {recovery.revertible ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 shrink-0 transition-all duration-200"
                      onClick={() => openPersistedRecoveryRevert(recovery)}
                    >
                      <Undo2 size={13} className="mr-1" />
                      Annuler
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* Le résumé du jour est déjà dans la barre du service. */}
        {live &&
        !serviceIsToday &&
        !compactServiceCockpit &&
        serviceTab === 'plan' &&
        allTables.length > 0 &&
        reservations.length === 0 &&
        loadedLiveDate === liveDate ? (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground"
          >
            <span className="flex items-center gap-1.5">
              <CalendarDays size={14} aria-hidden="true" />
              {`Aucune réservation pour le ${serviceDateLabel}.`}
            </span>
          </div>
        ) : null}

        <Dialog
          open={headerAssignment !== null}
          onOpenChange={(open) => !open && setHeaderAssignment(null)}
        >
          {headerAssignment ? (
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Attribuer une table</DialogTitle>
                <DialogDescription>
                  {headerAssignment.reservation.customerName ?? 'Réservation'} ·{' '}
                  {headerAssignment.reservation.partySize} couverts
                </DialogDescription>
              </DialogHeader>
              {headerAssignment.message ? <p role="status">{headerAssignment.message}</p> : null}
              {!headerAssignment.suggestions && !headerAssignment.message ? (
                <p role="status">Recherche des tables disponibles…</p>
              ) : null}
              {headerAssignment.suggestions?.map((table) => (
                <Button
                  key={table.tableId}
                  type="button"
                  variant="outline"
                  disabled={headerAssignment.saving}
                  onClick={async () => {
                    const pending = { ...headerAssignment, saving: true, message: undefined };
                    setHeaderAssignment(pending);
                    const assigned = await assignTable(pending.reservation.id, table.tableId);
                    setHeaderAssignment((current) =>
                      current === pending
                        ? assigned
                          ? null
                          : {
                              ...pending,
                              saving: false,
                              message: 'Impossible d’attribuer cette table.',
                            }
                        : current,
                    );
                  }}
                >
                  {table.name} · {table.capacity} places
                </Button>
              ))}
            </DialogContent>
          ) : null}
        </Dialog>

        <CardContent
          id={live ? 'service-content' : undefined}
          className={cn(
            'overflow-hidden p-0',
            live
              ? 'flex min-h-56 flex-1 flex-col'
              : 'h-[calc(100dvh-17rem)] min-h-[20rem] xl:h-[calc(100dvh-13rem)] xl:min-h-0',
          )}
        >
          {live && serviceTab === 'waiting-list' ? (
            <WaitingListPanel
              entries={waitingList}
              isLoading={waitingListLoading}
              promotingEntryId={promotingWaitingListEntryId}
              entryErrors={waitingListEntryErrors}
              onPromote={promoteWaitingListEntry}
            />
          ) : (
            <DndContext
              sensors={sensors}
              onDragStart={handleDragStart}
              onDragMove={handleDragMove}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <div
                className={cn(
                  'relative flex min-h-0 flex-col lg:flex-row',
                  live ? 'flex-1' : 'h-full',
                )}
              >
                <div className="order-2 lg:order-1 lg:contents">
                  {!live ? (
                    <FloorPlanPalette
                      tablesToPlace={tablesToPlace}
                      totalTables={allTables.length}
                      onPlaceTable={(table) => void placeExistingTable(table)}
                      onCreateTable={() => void createTable()}
                      onAutoLayout={() => void autoLayoutTables()}
                      autoLayoutLoading={autoLayoutLoading}
                      onQuickAdd={quickAddFromPalette}
                    />
                  ) : null}
                </div>
                <div className="relative order-1 flex min-h-0 min-w-0 flex-1 flex-col lg:order-2">
                  <div role="status" className="pointer-events-none absolute left-3 top-3 z-40">
                    {tableDragPreview?.blocker ? (
                      <p className="rounded-md border border-destructive/40 bg-background px-2 py-1 text-sm text-destructive shadow-sm">
                        Trop près de{' '}
                        {tableDragPreview.blocker.displayName ?? tableDragPreview.blocker.name}
                      </p>
                    ) : tableDragPreview?.chairConflict ? (
                      <p className="rounded-md border border-warning/40 bg-background px-2 py-1 text-sm text-foreground shadow-sm">
                        Les chaises sont trop proches de{' '}
                        {tableDragPreview.chairConflict.displayName ??
                          tableDragPreview.chairConflict.name}
                      </p>
                    ) : null}
                  </div>
                  {tablePlacementZoneId ? (
                    <div className="absolute left-3 right-3 top-3 z-50 flex w-fit max-w-[calc(100%-1.5rem)] items-center gap-3 rounded-lg border border-primary/30 bg-card p-2 shadow-md">
                      <p role="status" className="pl-2 text-sm">
                        Choisissez l’emplacement dans la zone.
                      </p>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setTablePlacementZoneId(null)}
                      >
                        Annuler
                      </Button>
                    </div>
                  ) : null}
                  {!live && (error || reservationsError) ? (
                    <div
                      role="alert"
                      className="sokar-error pointer-events-none absolute left-3 right-3 top-3 z-40 m-0 text-sm"
                    >
                      <AlertCircle size={16} />
                      {error || reservationsError}
                    </div>
                  ) : null}
                  {/* Le pincement à deux doigts pilote le zoom du plan ; le
                      glissement d'un doigt le défile (défilement natif). */}
                  <div
                    ref={canvasViewportRef}
                    style={{ touchAction: 'pan-x pan-y' }}
                    className={cn(
                      'relative min-h-0 w-full flex-1 overflow-auto bg-muted/70',
                      !live && 'min-h-[14rem] md:min-h-[22rem]',
                      activeDragData?.kind === 'table' ||
                        activeDragData?.kind === 'wall' ||
                        activeDragData?.kind === 'zone'
                        ? 'cursor-copy'
                        : activeDragTable
                          ? 'cursor-grabbing'
                          : undefined,
                    )}
                  >
                    {displayedInitialDelayImpact && !reportedDelayBannerDismissed ? (
                      <div
                        role="region"
                        aria-label="Retard signalé par téléphone"
                        className={cn(
                          'absolute left-3 right-3 top-3 z-40 rounded-xl border bg-background/95 p-3 shadow-lg backdrop-blur transition-all duration-200',
                          delayRecoveryApplied ? 'border-success/30' : 'border-warning/30',
                        )}
                      >
                        <div className="flex items-start gap-3">
                          <div
                            className={cn(
                              'mt-0.5 rounded-full p-2',
                              delayRecoveryApplied ? 'bg-success/10' : 'bg-warning/10',
                            )}
                          >
                            {delayRecoveryApplied ? (
                              <CircleCheck size={18} className="text-success" />
                            ) : (
                              <Phone size={18} className="text-warning" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge
                                variant="outline"
                                className={cn(
                                  'h-5 text-[10px] uppercase tracking-wide',
                                  delayRecoveryApplied
                                    ? 'border-success/30 text-success'
                                    : 'border-warning/30 text-warning',
                                )}
                              >
                                {delayRecoveryReverted
                                  ? 'Plan restauré'
                                  : delayRecoveryApplied
                                    ? 'Communication requise'
                                    : 'Appel reçu'}
                              </Badge>
                              <p className="text-sm font-semibold text-foreground">
                                {delayRecoveryApplied
                                  ? delayRecoveryReverted
                                    ? 'Plan de retard annulé'
                                    : 'Plan de retard appliqué'
                                  : `${reportedDelayReservation?.customerName || 'Client'} · ${reportedDelayReservation?.partySize ?? '—'} pers. · +${displayedInitialDelayImpact.delayMinutes} min`}
                              </p>
                            </div>
                            {delayRecoveryApplied ? (
                              <div className="mt-2 rounded-lg border border-warning/25 bg-warning/[0.05] px-3 py-2">
                                <p className="text-xs font-semibold text-foreground">
                                  {delayRecoveryReverted
                                    ? 'Plan initial restauré'
                                    : 'Plan appliqué'}
                                </p>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                  {appliedDelayRecovery
                                    ? delayRecoveryReverted
                                      ? `${appliedDelayRecovery.delayedCustomerName} retrouve ${appliedDelayRecovery.delayedOriginalTableName} et son horaire initial. ${appliedDelayRecovery.waitingCustomerName} retourne en liste d’attente.`
                                      : `${appliedDelayRecovery.waitingCustomerName} : liste d’attente → ${appliedDelayRecovery.waitingTableName}. ${appliedDelayRecovery.delayedCustomerName} : ${appliedDelayRecovery.delayedOriginalTableName} → ${appliedDelayRecovery.delayedAlternativeTableName}.`
                                    : 'Les deux changements de table ont été enregistrés.'}
                                </p>
                                {delayRecoveryReverted ? (
                                  <p className="mt-1 text-xs font-medium text-warning">
                                    Prévenez les deux clients : les communications humaines déjà
                                    effectuées ne peuvent pas être annulées.
                                  </p>
                                ) : (
                                  <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                    <p className="text-xs font-medium text-warning">
                                      Prévenez les deux clients. Aucun message n’a été envoyé
                                      automatiquement.
                                    </p>
                                    {appliedDelayRecovery ? (
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        className="shrink-0 transition-all duration-200"
                                        onClick={() => setDelayRecoveryRevertConfirmOpen(true)}
                                      >
                                        <Undo2 size={14} className="mr-1.5" />
                                        Annuler ce plan
                                      </Button>
                                    ) : null}
                                  </div>
                                )}
                              </div>
                            ) : reportedDelayLookupError ? (
                              <p className="mt-2 text-xs font-medium text-warning">
                                {reportedDelayLookupError}
                              </p>
                            ) : delayImpactLoading ? (
                              <p className="mt-1 text-xs text-muted-foreground">
                                Analyse de la salle et de la liste d’attente…
                              </p>
                            ) : delayImpact &&
                              delayImpactReservationId ===
                                displayedInitialDelayImpact.reservationId ? (
                              <>
                                {delayImpact.feasible &&
                                delayImpact.alternativeTable &&
                                delayImpact.waitingListEntry ? (
                                  <div className="mt-2 space-y-2">
                                    <div className="grid gap-2 sm:grid-cols-2">
                                      <div className="rounded-lg border border-border bg-card px-3 py-2">
                                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                          {delayImpact.waitingListEntry.isAvailableNow
                                            ? 'Disponible maintenant'
                                            : `Créneau ${format(
                                                parseISO(
                                                  delayImpact.waitingListEntry
                                                    .customerFacingRequestedStartsAt ??
                                                    delayImpact.waitingListEntry.proposedStartsAt,
                                                ),
                                                'HH:mm',
                                              )}`}
                                        </p>
                                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs font-semibold text-foreground">
                                          <span className="truncate">Liste d’attente</span>
                                          <ArrowRight
                                            size={13}
                                            className="shrink-0 text-muted-foreground"
                                          />
                                          <span className="shrink-0">
                                            {delayImpact.delayedReservation?.originalTableName ||
                                              reportedDelayReservation?.tableName ||
                                              'Table actuelle'}
                                          </span>
                                        </div>
                                        <p className="mt-1 truncate text-[11px] text-muted-foreground">
                                          {delayImpact.waitingListEntry.customerName} n’avait pas
                                          encore de table.
                                        </p>
                                      </div>
                                      <div className="rounded-lg border border-border bg-card px-3 py-2">
                                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                          {delayImpact.delayedReservation
                                            ?.customerFacingProposedStartsAt
                                            ? `À ${format(
                                                parseISO(
                                                  delayImpact.delayedReservation
                                                    .customerFacingProposedStartsAt,
                                                ),
                                                'HH:mm',
                                              )}`
                                            : 'À son arrivée'}
                                        </p>
                                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs font-semibold text-foreground">
                                          <span className="truncate">
                                            {reportedDelayReservation?.customerName ||
                                              'Réservation retardée'}
                                          </span>
                                          <span className="shrink-0 text-muted-foreground">
                                            ·{' '}
                                            {delayImpact.delayedReservation?.originalTableName ||
                                              reportedDelayReservation?.tableName ||
                                              'Table actuelle'}
                                          </span>
                                          <ArrowRight
                                            size={13}
                                            className="shrink-0 text-muted-foreground"
                                          />
                                          <span className="shrink-0">
                                            {delayImpact.alternativeTable.name}
                                          </span>
                                        </div>
                                      </div>
                                    </div>
                                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                      <p className="text-[11px] text-muted-foreground">
                                        Vérification automatique avant application · Aucun SMS
                                        envoyé
                                      </p>
                                      <Button
                                        size="sm"
                                        className="shrink-0"
                                        onClick={() => setDelayRecoveryConfirmOpen(true)}
                                      >
                                        Vérifier et appliquer
                                      </Button>
                                    </div>
                                  </div>
                                ) : (
                                  <p className="mt-2 text-xs font-medium text-warning">
                                    Aucun changement sûr n’est proposé. Aucune modification n’est
                                    appliquée.
                                  </p>
                                )}
                              </>
                            ) : (
                              <p className="mt-1 text-xs text-muted-foreground">
                                Ouvrez la table sélectionnée pour relancer l’analyse.
                              </p>
                            )}
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 shrink-0 p-0"
                            aria-label="Masquer le retard signalé"
                            onClick={() => setReportedDelayBannerDismissed(true)}
                          >
                            <X size={16} />
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    <div
                      className={cn(
                        'relative',
                        liveViewportBounds ? 'mx-auto overflow-hidden' : undefined,
                      )}
                      data-testid={liveViewportBounds ? 'floor-plan-live-stage' : undefined}
                      style={{ width: stageWidth, height: stageHeight }}
                    >
                      {/* Garantie d'aire défilable : l'espaceur fait exactement la
                          taille de la scène visible. En Live, cette scène est
                          limitée à la zone utile ; l'édition conserve la salle
                          entière comme surface de travail. */}
                      <div
                        aria-hidden="true"
                        className="pointer-events-none"
                        style={{ width: stageWidth, height: stageHeight }}
                      />
                      <div
                        ref={canvasRef}
                        className={cn(
                          // Le canvas doit recouvrir l'espaceur de scroll, pas se
                          // placer apres lui a sa position statique. Sans cet
                          // ancrage, sa hauteur zoomée apparaissait comme un grand
                          // vide au-dessus des tables, surtout en Live mobile.
                          liveViewportBounds
                            ? 'absolute left-0 top-0 origin-top-left border-0 bg-transparent shadow-none'
                            : 'absolute left-0 top-0 origin-top-left border border-border bg-background shadow-sm',
                          activeDragData?.kind === 'table' ||
                            activeDragData?.kind === 'wall' ||
                            activeDragData?.kind === 'zone'
                            ? 'cursor-copy border-primary/50 ring-2 ring-primary/30'
                            : undefined,
                        )}
                        onClick={() => {
                          setTablePlacementZoneId(null);
                          setSelectedTableIds(new Set());
                          setSelectedServiceTableId(null);
                          setSelectedWallId(null);
                          setSelectedZoneId(null);
                        }}
                        style={{
                          width: canvasWidth,
                          height: canvasHeight,
                          transform: canvasTransform,
                          transformOrigin: 'top left',
                          backgroundImage:
                            !live && gridVisible
                              ? `linear-gradient(to right, hsl(var(--muted-foreground) / 0.22) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--muted-foreground) / 0.22) 1px, transparent 1px), linear-gradient(to right, hsl(var(--muted-foreground) / 0.08) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--muted-foreground) / 0.08) 1px, transparent 1px)`
                              : undefined,
                          backgroundSize: `${GRID_SIZE * 5}px ${GRID_SIZE * 5}px, ${GRID_SIZE * 5}px ${
                            GRID_SIZE * 5
                          }px, ${GRID_SIZE}px ${GRID_SIZE}px, ${GRID_SIZE}px ${GRID_SIZE}px`,
                        }}
                      >
                        {zones.map((zone) => (
                          <ZoneCard
                            key={zone.id}
                            zone={zone}
                            editable={!live}
                            isSelected={!live && selectedZoneId === zone.id}
                            placingTable={tablePlacementZoneId === zone.id}
                            onClick={(event) =>
                              tablePlacementZoneId === zone.id
                                ? placeNewTableInZone(zone, event)
                                : selectZone(zone)
                            }
                            onPointerDown={(event) => {
                              if (!tablePlacementZoneId) handleZonePointerDown(event, zone);
                            }}
                            onResizeStart={(event) => startZoneResize(event, zone)}
                          />
                        ))}
                        <svg
                          className="absolute inset-0 w-full h-full pointer-events-none"
                          style={{ zIndex: 10 }}
                          onClick={() => {
                            setSelectedWallId(null);
                            setSelectedZoneId(null);
                          }}
                        >
                          <g className={live ? 'pointer-events-none' : 'pointer-events-auto'}>
                            {floorPlan?.walls?.map((w) => (
                              <WallSegment
                                key={w.id}
                                wall={w}
                                isSelected={!live && selectedWallId === w.id}
                                editable={!live}
                                locked={lockedWallIds.has(w.id)}
                                onClick={
                                  live
                                    ? undefined
                                    : () => {
                                        if (wallJustDraggedRef.current) {
                                          wallJustDraggedRef.current = false;
                                          return;
                                        }
                                        setSelectedTableIds(new Set());
                                        setSelectedWallId(w.id);
                                      }
                                }
                                onPointerDownMove={(e) => handleWallPointerDown(e, w, 'move')}
                                onPointerDownStart={(e) =>
                                  handleWallPointerDown(e, w, 'resize-start')
                                }
                                onPointerDownEnd={(e) => handleWallPointerDown(e, w, 'resize-end')}
                              />
                            ))}
                            {wallLengthGuide ? (
                              <g className="pointer-events-none">
                                <line
                                  x1={wallLengthGuide.activeWall.x1}
                                  y1={wallLengthGuide.activeWall.y1}
                                  x2={wallLengthGuide.activeWall.x2}
                                  y2={wallLengthGuide.activeWall.y2}
                                  stroke="hsl(var(--primary))"
                                  strokeWidth={8}
                                  strokeLinecap="square"
                                  opacity={0.35}
                                />
                                <line
                                  x1={wallLengthGuide.referenceWall.x1}
                                  y1={wallLengthGuide.referenceWall.y1}
                                  x2={wallLengthGuide.referenceWall.x2}
                                  y2={wallLengthGuide.referenceWall.y2}
                                  stroke="hsl(var(--primary))"
                                  strokeWidth={8}
                                  strokeLinecap="square"
                                  opacity={0.35}
                                />
                                <line
                                  x1={
                                    (wallLengthGuide.activeWall.x1 +
                                      wallLengthGuide.activeWall.x2) /
                                    2
                                  }
                                  y1={
                                    (wallLengthGuide.activeWall.y1 +
                                      wallLengthGuide.activeWall.y2) /
                                    2
                                  }
                                  x2={
                                    (wallLengthGuide.referenceWall.x1 +
                                      wallLengthGuide.referenceWall.x2) /
                                    2
                                  }
                                  y2={
                                    (wallLengthGuide.referenceWall.y1 +
                                      wallLengthGuide.referenceWall.y2) /
                                    2
                                  }
                                  stroke="hsl(var(--primary))"
                                  strokeWidth={1.5}
                                  strokeDasharray="5 5"
                                  opacity={0.9}
                                />
                                <circle
                                  cx={
                                    (wallLengthGuide.activeWall.x1 +
                                      wallLengthGuide.activeWall.x2) /
                                    2
                                  }
                                  cy={
                                    (wallLengthGuide.activeWall.y1 +
                                      wallLengthGuide.activeWall.y2) /
                                    2
                                  }
                                  r={4}
                                  fill="hsl(var(--primary))"
                                />
                                <circle
                                  cx={
                                    (wallLengthGuide.referenceWall.x1 +
                                      wallLengthGuide.referenceWall.x2) /
                                    2
                                  }
                                  cy={
                                    (wallLengthGuide.referenceWall.y1 +
                                      wallLengthGuide.referenceWall.y2) /
                                    2
                                  }
                                  r={4}
                                  fill="hsl(var(--primary))"
                                />
                                <foreignObject
                                  x={Math.max(
                                    8,
                                    Math.min(canvasWidth - 132, wallLengthGuide.labelX - 66),
                                  )}
                                  y={Math.max(
                                    8,
                                    Math.min(canvasHeight - 38, wallLengthGuide.labelY - 19),
                                  )}
                                  width={132}
                                  height={38}
                                >
                                  <div className="flex h-full items-center justify-center rounded-md border border-primary/40 bg-background/95 px-2 text-[11px] font-medium text-primary shadow-sm">
                                    Même longueur · {formatWallLength(wallLengthGuide.length)}
                                  </div>
                                </foreignObject>
                              </g>
                            ) : null}
                            {wallResizeAlignGuide ? (
                              <g className="pointer-events-none">
                                {wallResizeAlignGuide.axis === 'y' ? (
                                  <line
                                    x1={0}
                                    y1={wallResizeAlignGuide.value}
                                    x2={canvasWidth}
                                    y2={wallResizeAlignGuide.value}
                                    stroke="hsl(var(--primary))"
                                    strokeWidth={2}
                                    strokeDasharray="6 4"
                                    opacity={0.95}
                                  />
                                ) : (
                                  <line
                                    x1={wallResizeAlignGuide.value}
                                    y1={0}
                                    x2={wallResizeAlignGuide.value}
                                    y2={canvasHeight}
                                    stroke="hsl(var(--primary))"
                                    strokeWidth={2}
                                    strokeDasharray="6 4"
                                    opacity={0.95}
                                  />
                                )}
                              </g>
                            ) : null}
                          </g>
                        </svg>
                        {wallAlignGuide ? (
                          <svg
                            className="absolute inset-0 w-full h-full pointer-events-none"
                            style={{ zIndex: 11 }}
                          >
                            {wallAlignGuide.axis === 'y' ? (
                              <line
                                x1={0}
                                y1={wallAlignGuide.value}
                                x2={canvasWidth}
                                y2={wallAlignGuide.value}
                                stroke="hsl(var(--primary))"
                                strokeWidth={1}
                                strokeDasharray="4 4"
                              />
                            ) : (
                              <line
                                x1={wallAlignGuide.value}
                                y1={0}
                                x2={wallAlignGuide.value}
                                y2={canvasHeight}
                                stroke="hsl(var(--primary))"
                                strokeWidth={1}
                                strokeDasharray="4 4"
                              />
                            )}
                          </svg>
                        ) : null}
                        {tableAlignGuides.x || tableAlignGuides.y ? (
                          <svg
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-0 h-full w-full"
                            style={{ zIndex: 12 }}
                          >
                            {tableAlignGuides.x ? (
                              <line
                                x1={tableAlignGuides.x.value}
                                y1={0}
                                x2={tableAlignGuides.x.value}
                                y2={canvasHeight}
                                stroke="hsl(var(--primary))"
                                strokeWidth={1.5}
                                strokeDasharray="5 4"
                                opacity={0.9}
                              />
                            ) : null}
                            {tableAlignGuides.y ? (
                              <line
                                x1={0}
                                y1={tableAlignGuides.y.value}
                                x2={canvasWidth}
                                y2={tableAlignGuides.y.value}
                                stroke="hsl(var(--primary))"
                                strokeWidth={1.5}
                                strokeDasharray="5 4"
                                opacity={0.9}
                              />
                            ) : null}
                          </svg>
                        ) : null}
                        {placedTables.map((table) => {
                          const { width, height } = getTableSize(table);
                          const status = live ? tableStatuses.get(table.id) : undefined;
                          const tableServer = table.assignedServer?.trim() || null;
                          const isFilteredOut =
                            live &&
                            selectedServerFilter !== null &&
                            (selectedServerFilter === '_unassigned_'
                              ? Boolean(tableServer)
                              : tableServer !== selectedServerFilter);
                          return (
                            <DraggableTable
                              key={table.id}
                              table={table}
                              invalidPlacement={tableDragPreview?.blocker?.id === table.id}
                              status={status}
                              isSelected={
                                live
                                  ? selectedServiceTableId === table.id ||
                                    (!reportedDelayBannerDismissed &&
                                      (reportedDelayOriginalTableId === table.id ||
                                        reportedDelayAlternativeTableId === table.id))
                                  : selectedTableIds.has(table.id)
                              }
                              draggable={!live}
                              droppable={live}
                              draggableReservation={live}
                              editable={!live}
                              zoom={zoom}
                              compact={compactTableCards}
                              assignmentCandidate={unassignedPlacement.suggestions.some(
                                (suggestion) => suggestion.tableId === table.id,
                              )}
                              onClick={(e) => handleTableClick(table, e)}
                              onDoubleClick={() => handleTableDoubleClick(table)}
                              onResizeStart={
                                selectedTableIds.size > 1
                                  ? undefined
                                  : (e) => startTableResize(e, table)
                              }
                              onRotateStart={
                                selectedTableIds.size > 1
                                  ? undefined
                                  : (e) => startTableRotate(e, table)
                              }
                              isCombinable={live && combinableTableIds.has(table.id)}
                              style={{
                                left: table.positionX ?? 0,
                                top: table.positionY ?? 0,
                                width,
                                height,
                                position: 'absolute',
                                zIndex: selectedTableIds.has(table.id) ? 3 : 2,
                                opacity:
                                  activeDragTable?.id === table.id
                                    ? 0
                                    : isFilteredOut &&
                                        !unassignedPlacement.suggestions.some(
                                          (suggestion) => suggestion.tableId === table.id,
                                        )
                                      ? 0.25
                                      : 1,
                                filter:
                                  isFilteredOut &&
                                  !unassignedPlacement.suggestions.some(
                                    (suggestion) => suggestion.tableId === table.id,
                                  )
                                    ? 'grayscale(80%)'
                                    : undefined,
                                transition:
                                  activeDragTable?.id === table.id ? 'none' : 'all 0.2s ease',
                              }}
                            />
                          );
                        })}
                        {activeDragTable && dragStart ? (
                          <div
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-0 z-20"
                          >
                            <div
                              className={cn(
                                'absolute border border-dashed border-muted-foreground/50',
                                activeDragTable.shape === 'round' ? 'rounded-full' : 'rounded-lg',
                              )}
                              style={{
                                left: dragStart.originalX,
                                top: dragStart.originalY,
                                width: dragStart.width,
                                height: dragStart.height,
                                transform: `rotate(${activeDragTable.rotation ?? 0}deg)`,
                              }}
                            />
                            <TableCard
                              table={activeDragTable}
                              invalidPlacement={Boolean(tableDragPreview?.blocker)}
                              isOverlay
                              compact={compactTableCards}
                              zoom={zoom}
                              style={{
                                position: 'absolute',
                                left: tableDragPreview?.positionX ?? dragStart.originalX,
                                top: tableDragPreview?.positionY ?? dragStart.originalY,
                              }}
                            />
                          </div>
                        ) : null}
                      </div>
                    </div>
                    {placedTables.length === 0 &&
                    !selectedZone &&
                    ((floorPlan?.walls ?? []).length === 0 || !live) ? (
                      <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-6">
                        <div className="flex max-w-xs flex-col items-center text-center">
                          {live ? (
                            <span
                              className="flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-muted-foreground/40 bg-background/90 text-muted-foreground shadow-sm"
                              aria-hidden="true"
                            >
                              <Armchair size={20} />
                            </span>
                          ) : null}
                          <p
                            className={cn('text-sm font-medium text-foreground', live && 'mt-2.5')}
                          >
                            {live
                              ? allTables.length > 0
                                ? `${allTables.length} table${allTables.length > 1 ? 's' : ''} à placer`
                                : 'Aucune table dans ce plan'
                              : tablesToPlace.length > 0
                                ? 'Construisez votre plan'
                                : 'Aucune table configurée'}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {live
                              ? allTables.length > 0
                                ? 'Placez les tables depuis Plan visuel pour suivre le service ici.'
                                : 'Ajoutez vos tables depuis Plan visuel pour suivre le service ici.'
                              : tablesToPlace.length > 0
                                ? `${tablesToPlace.length} table${tablesToPlace.length > 1 ? 's restent' : ' reste'} à placer.`
                                : 'Créez vos tables métier avant de les positionner dans la salle.'}
                          </p>
                          {!live && tablesToPlace.length > 0 ? (
                            <div className="pointer-events-auto mt-3 flex flex-wrap justify-center gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="transition-all duration-200"
                                onClick={focusTablesToPlace}
                              >
                                Placer les tables
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                className="transition-all duration-200"
                                onClick={() => void autoLayoutTables()}
                                disabled={autoLayoutLoading}
                              >
                                {autoLayoutLoading ? 'Placement…' : 'Disposition automatique'}
                              </Button>
                            </div>
                          ) : null}
                          {!live && allTables.length === 0 ? (
                            <Button
                              type="button"
                              size="sm"
                              className="pointer-events-auto mt-3 transition-all duration-200"
                              onClick={() => setBulkCreateDialogOpen(true)}
                            >
                              <Plus size={15} className="mr-1.5" />
                              Créer mes tables
                            </Button>
                          ) : null}
                          {live && onRequestEdit ? (
                            <Button
                              type="button"
                              size="sm"
                              className="pointer-events-auto mt-3 w-full transition-all duration-200 sm:w-auto"
                              onClick={onRequestEdit}
                            >
                              Configurer la salle
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  {live && placedTables.length > 0 ? (
                    <div
                      role="group"
                      aria-label="Zoom du plan"
                      className="absolute bottom-3 left-3 z-30 flex items-center gap-0.5 rounded-lg border border-border bg-card/95 p-0.5 shadow-sm"
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 transition-all duration-200"
                        aria-label="Réduire le plan"
                        title="Réduire le plan"
                        onClick={() => changeZoom(-ZOOM_STEP)}
                      >
                        <ZoomOut size={14} />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 transition-all duration-200"
                        aria-label="Ajuster le plan"
                        title="Ajuster le plan"
                        onClick={resetView}
                      >
                        <LocateFixed size={14} aria-hidden="true" />
                      </Button>
                      <output aria-label="Niveau de zoom" className="sr-only">
                        {Math.round(zoom * 100)} %
                      </output>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 transition-all duration-200"
                        aria-label="Agrandir le plan"
                        title="Agrandir le plan"
                        onClick={() => changeZoom(ZOOM_STEP)}
                      >
                        <ZoomIn size={14} />
                      </Button>
                    </div>
                  ) : null}
                </div>
                {!live || allTables.length > 0 ? inspector : null}
              </div>
              {typeof document !== 'undefined'
                ? createPortal(
                    <DragOverlay dropAnimation={null}>
                      {activeDragData?.kind === 'placeTable' ? (
                        <TableCard
                          table={activeDragData.table}
                          invalidPlacement={tableDropOverlapping}
                          isOverlay
                          zoom={zoom}
                          compact={compactTableCards}
                          style={{
                            transform: `scale(${zoom})`,
                            transformOrigin: 'top left',
                          }}
                        />
                      ) : null}
                      {activeDragData?.kind === 'table' ? (
                        <NewTableOverlay
                          shape={activeDragData.shape}
                          capacity={activeDragData.capacity}
                          zoom={zoom}
                          invalidPlacement={tableDropOverlapping}
                        />
                      ) : null}
                      {activeDragData?.kind === 'zone' ? (
                        <div className="flex h-28 w-44 items-center justify-center rounded-xl border border-primary/40 bg-primary/10 text-xs font-semibold uppercase tracking-[0.14em] text-primary shadow-lg">
                          Zone
                        </div>
                      ) : null}
                      {activeDragData?.kind === 'wall' ? (
                        <NewWallOverlay type={activeDragData.type} zoom={zoom} />
                      ) : null}
                      {activeDragData?.kind === 'reservation' ? (
                        <div
                          className={cn(
                            'flex flex-col items-center justify-center rounded-md border-2 border-dashed bg-background/95 px-3 py-2 text-center shadow-lg',
                            statusClasses[
                              tableStatuses.get(activeDragData.fromTableId)?.status ?? 'free'
                            ],
                          )}
                        >
                          <p className="text-xs font-semibold">
                            {formatCustomerName(activeDragData.reservation.customerName)}
                          </p>
                          <p className="text-[9px] text-muted-foreground">
                            {activeDragData.reservation.partySize} pers. ·{' '}
                            {activeDragData.reservation.startsAt
                              ? format(parseISO(activeDragData.reservation.startsAt), 'HH:mm')
                              : '—'}
                          </p>
                        </div>
                      ) : null}
                    </DragOverlay>,
                    document.body,
                  )
                : null}
            </DndContext>
          )}
        </CardContent>
      </Card>
      {typeof document !== 'undefined'
        ? createPortal(
            <>
              {mobileServiceInspector}
              {mobileEditInspector}
            </>,
            document.body,
          )
        : null}
      {dialog}
      {confirm}
      {delayRecoveryConfirm}
      {delayRecoveryRevertConfirm}
      {multiDeleteConfirm}
      {settingsDialog}
      {bulkCreateDialog}
      {duplicateDialog}
    </>
  );
}
