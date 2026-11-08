import { DemoRequestStatus, Prisma, type DemoRequest } from '@prisma/client';
import { db } from '../../shared/db/client';
import { sendEmail } from '../../shared/email';

export interface DemoRequestInput {
  idempotencyKey: string;
  establishmentName: string;
  contactEmail: string;
  contactPhone?: string;
  currentTool?: string;
  mainProblem?: string;
  pageVersion: string;
}

export interface CreateDemoRequestResult {
  record: DemoRequest;
  replayed: boolean;
}

function isIdempotencyConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Persiste la demande avant toute notification : un échec d'envoi ne doit jamais faire perdre un
 * prospect. Une même clé d'idempotence renvoie la demande existante (double clic, nouvel essai).
 */
export async function createDemoRequest(input: DemoRequestInput): Promise<CreateDemoRequestResult> {
  try {
    const record = await db.demoRequest.create({ data: input });
    return { record, replayed: false };
  } catch (error) {
    if (isIdempotencyConflict(error)) {
      const existing = await db.demoRequest.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) return { record: existing, replayed: true };
    }
    throw error;
  }
}

function parseRecipients(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((recipient) => recipient.trim())
    .filter(Boolean);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[char] ?? char;
  });
}

/**
 * Notifie l'équipe commerciale via DEMO_REQUEST_NOTIFY_TO. Sans destinataire configuré, rien n'est
 * envoyé et la fonction retourne false. Chaque destinataire est tenté, même si le précédent a échoué.
 * Retourne true seulement si chaque envoi a été accepté explicitement (`outcome` = 'success') : un refus
 * (liste de destinataires de test), un échec, un résultat inconnu ou une exception ne sont pas une notification.
 */
export async function notifyDemoRequest(record: Pick<DemoRequest, 'id'>): Promise<boolean> {
  const recipients = parseRecipients(process.env.DEMO_REQUEST_NOTIFY_TO);
  if (recipients.length === 0) return false;

  const dashboardUrl = new URL(
    '/admin/demo-requests',
    process.env.DASHBOARD_URL ?? 'https://suppernote.com',
  );
  // Les coordonnées restent dans le suivi authentifié, pas dans les copies e-mail.
  const html = [
    `<p>Nouvelle demande de démonstration (réf. ${escapeHtml(record.id)}).</p>`,
    `<p><a href="${escapeHtml(dashboardUrl.href)}">Consulter les demandes dans Suppernote</a></p>`,
    '<p>Une connexion avec un compte administrateur autorisé est nécessaire.</p>',
  ].join('');

  let allAccepted = true;
  for (const to of recipients) {
    try {
      const result = await sendEmail({
        to,
        subject: 'Nouvelle demande de démonstration Suppernote',
        html,
      });
      // Un retour vide ou sans `success` n'est pas une acceptation : on ne renseigne jamais notifiedAt sans preuve.
      if (result?.outcome !== 'success') allAccepted = false;
    } catch {
      allAccepted = false;
    }
  }
  return allAccepted;
}

export async function markDemoRequestNotified(id: string): Promise<void> {
  await db.demoRequest.update({ where: { id }, data: { notifiedAt: new Date() } });
}

export async function listDemoRequests(filter: {
  status?: DemoRequestStatus;
  isTest?: boolean;
  active?: boolean;
  limit: number;
}): Promise<DemoRequest[]> {
  return db.demoRequest.findMany({
    where: {
      ...(filter.status
        ? { status: filter.status }
        : filter.active
          ? { status: { in: ['NEW', 'CONTACTED'] } }
          : {}),
      ...(filter.isTest === undefined ? {} : { isTest: filter.isTest }),
    },
    orderBy: { createdAt: 'desc' },
    take: filter.limit,
  });
}

export async function markDemoRequestTest(
  id: string,
  isTest: boolean,
): Promise<DemoRequest | null> {
  const current = await db.demoRequest.findUnique({ where: { id } });
  if (!current) return null;
  return db.demoRequest.update({ where: { id }, data: { isTest } });
}

export async function getDemoRequestSummary() {
  const [statusGroups, notificationUnconfirmed] = await Promise.all([
    db.demoRequest.groupBy({ by: ['status'], _count: { _all: true } }),
    db.demoRequest.count({ where: { notifiedAt: null } }),
  ]);

  const byStatus: Record<DemoRequestStatus, number> = {
    [DemoRequestStatus.NEW]: 0,
    [DemoRequestStatus.CONTACTED]: 0,
    [DemoRequestStatus.DEMO_DONE]: 0,
    [DemoRequestStatus.CLOSED]: 0,
  };

  for (const group of statusGroups) byStatus[group.status] = group._count._all;

  return {
    total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
    byStatus,
    notificationUnconfirmed,
  };
}

/** Le premier passage à CONTACTED ou DEMO_DONE horodate l'étape ; les passages suivants la conservent. */
export async function updateDemoRequestStatus(
  id: string,
  status: DemoRequestStatus,
): Promise<DemoRequest | null> {
  const current = await db.demoRequest.findUnique({ where: { id } });
  if (!current) return null;

  const now = new Date();
  const timestamps: { contactedAt?: Date; demoDoneAt?: Date } = {};
  if (status === 'CONTACTED' && !current.contactedAt) timestamps.contactedAt = now;
  if (status === 'DEMO_DONE' && !current.demoDoneAt) timestamps.demoDoneAt = now;

  return db.demoRequest.update({ where: { id }, data: { status, ...timestamps } });
}

/** Enregistre la date de l'échange réellement constaté par un opérateur. */
export async function recordDemoRequestInteraction(
  id: string,
  occurredAt = new Date(),
): Promise<DemoRequest | null> {
  const current = await db.demoRequest.findUnique({ where: { id } });
  if (!current) return null;

  return db.demoRequest.update({ where: { id }, data: { lastInteractionAt: occurredAt } });
}
