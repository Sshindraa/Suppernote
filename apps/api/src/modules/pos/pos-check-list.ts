import { db } from '../../shared/db/client';

export interface PosCheckListItem {
  id: string;
  externalId: string;
  openedAt: string;
  closedAt: string | null;
  tableReference: string | null;
  total: string;
  currency: string;
  /** Best reservation link, if any. The client's name is never returned. */
  match: {
    status: string;
    confidence: number;
    reservation: {
      id: string;
      at: string;
      partySize: number;
      table: string | null;
    };
  } | null;
}

export interface PosCheckListPage {
  items: PosCheckListItem[];
  nextCursor: string | null;
}

/** Most recent tickets first. `cursor` is the last id of the previous page. */
export async function listPosChecks(
  restaurantId: string,
  args: { cursor?: string; limit: number },
): Promise<PosCheckListPage> {
  const rows = await db.posCheck.findMany({
    where: { restaurantId },
    orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    take: args.limit + 1,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      externalId: true,
      openedAt: true,
      closedAt: true,
      tableReference: true,
      total: true,
      currency: true,
      matches: {
        orderBy: { confidence: 'desc' },
        take: 1,
        select: {
          status: true,
          confidence: true,
          reservation: {
            select: {
              id: true,
              reservedAt: true,
              startsAt: true,
              partySize: true,
              table: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  const hasMore = rows.length > args.limit;
  const page = rows.slice(0, args.limit);
  return {
    items: page.map((row) => {
      const best = row.matches[0];
      return {
        id: row.id,
        externalId: row.externalId,
        openedAt: row.openedAt.toISOString(),
        closedAt: row.closedAt?.toISOString() ?? null,
        tableReference: row.tableReference,
        total: row.total.toFixed(2),
        currency: row.currency,
        match: best
          ? {
              status: best.status,
              confidence: best.confidence.toNumber(),
              reservation: {
                id: best.reservation.id,
                at: (best.reservation.startsAt ?? best.reservation.reservedAt).toISOString(),
                partySize: best.reservation.partySize,
                table: best.reservation.table?.name ?? null,
              },
            }
          : null,
      };
    }),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}
