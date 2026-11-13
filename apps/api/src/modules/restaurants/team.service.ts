import { clerkClient } from '@clerk/fastify';
import { db } from '../../shared/db/client';
import { lockAccountMemberships } from './site-context';
import { assertClerkOrganizationMember } from './clerk-membership.service';
import { logger } from '../../shared/logger/pino';

/**
 * Équipe d'un restaurant : invitations et rôles.
 *
 * Les invitations passent par les invitations d'organisation Clerk (e-mail, compte à créer ou à
 * rejoindre). Le rôle Suppernote choisi par le propriétaire voyage dans les métadonnées publiques de
 * l'invitation, que seul le serveur peut écrire ; Clerk les recopie sur l'appartenance de
 * l'invité à l'acceptation. Au premier appel de l'invité, on lit ce rôle et on crée sa
 * membership Suppernote (`claimInvitedMembership`). Un rôle absent ou inconnu ne donne aucun accès, et
 * `OWNER` ne peut jamais être attribué par invitation.
 */
export const INVITABLE_ROLES = ['MANAGER', 'STAFF', 'READ_ONLY'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export const ROLE_METADATA_KEY = 'suppernoteRole';
/** Ancienne clé Clerk : relue tant que des comptes la portent encore (shortcut: retirer après migration des métadonnées Clerk). */
export const LEGACY_ROLE_METADATA_KEY = 'sokarRole';

export function readRoleMetadata(metadata: Record<string, unknown> | null | undefined): unknown {
  return metadata?.[ROLE_METADATA_KEY] ?? metadata?.[LEGACY_ROLE_METADATA_KEY];
}
const MAX_PENDING_INVITATIONS = 20;
const PAGE_SIZE = 100;

export type TeamErrorCode =
  | 'INVALID_EMAIL'
  | 'INVALID_ROLE'
  | 'TOO_MANY_INVITATIONS'
  | 'ALREADY_INVITED'
  | 'ALREADY_MEMBER'
  | 'MEMBER_NOT_FOUND'
  | 'CANNOT_EDIT_SELF'
  | 'CANNOT_EDIT_OWNER'
  | 'INVITATION_NOT_FOUND'
  | 'IDENTITY_PROVIDER_UNAVAILABLE'
  | 'TRANSFER_INVALID';

export class TeamError extends Error {
  constructor(
    readonly code: TeamErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TeamError';
  }
}

export function isInvitableRole(value: unknown): value is InvitableRole {
  return typeof value === 'string' && (INVITABLE_ROLES as readonly string[]).includes(value);
}

export type TeamMember = {
  userId: string;
  name: string;
  email: string | null;
  role: string;
  isYou: boolean;
};

export type TeamInvitation = {
  id: string;
  email: string;
  role: InvitableRole | null;
  createdAt: string;
};

function unavailable(cause: unknown): TeamError {
  return new TeamError(
    'IDENTITY_PROVIDER_UNAVAILABLE',
    'Le service de connexion est indisponible. Réessayez dans un instant.',
    { cause },
  );
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

type ClerkMembershipLike = {
  publicMetadata?: Record<string, unknown> | null;
  publicUserData?: {
    userId?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    identifier?: string | null;
  } | null;
};

function displayName(membership: ClerkMembershipLike | undefined): string {
  const data = membership?.publicUserData;
  const full = [data?.firstName, data?.lastName].filter(Boolean).join(' ').trim();
  return full || data?.identifier || 'Membre';
}

export async function listTeam(input: {
  organizationId: string;
  accountId: string;
  currentUserId: string;
}): Promise<{ members: TeamMember[]; invitations: TeamInvitation[] }> {
  const [rows, clerk] = await Promise.all([
    db.restaurantAccountMembership.findMany({
      where: { accountId: input.accountId, restaurantId: null },
      orderBy: { createdAt: 'asc' },
      select: { clerkUserId: true, role: true },
    }),
    (async () => {
      try {
        const [memberships, invitations] = await Promise.all([
          clerkClient.organizations.getOrganizationMembershipList({
            organizationId: input.organizationId,
            limit: PAGE_SIZE,
          }),
          clerkClient.organizations.getOrganizationInvitationList({
            organizationId: input.organizationId,
            status: ['pending'],
            limit: PAGE_SIZE,
          }),
        ]);
        return { memberships: memberships.data, invitations: invitations.data };
      } catch (cause) {
        throw unavailable(cause);
      }
    })(),
  ]);

  const byUser = new Map(
    clerk.memberships.map((membership) => [
      (membership as ClerkMembershipLike).publicUserData?.userId ?? '',
      membership as ClerkMembershipLike,
    ]),
  );

  return {
    members: rows.map((row) => {
      const membership = byUser.get(row.clerkUserId);
      return {
        userId: row.clerkUserId,
        name: displayName(membership),
        email: membership?.publicUserData?.identifier ?? null,
        role: row.role,
        isYou: row.clerkUserId === input.currentUserId,
      };
    }),
    invitations: clerk.invitations.map((invitation) => {
      const role = readRoleMetadata(invitation.publicMetadata);
      return {
        id: invitation.id,
        email: invitation.emailAddress,
        role: isInvitableRole(role) ? role : null,
        createdAt: new Date(invitation.createdAt).toISOString(),
      };
    }),
  };
}

export async function inviteMember(input: {
  organizationId: string;
  inviterUserId: string;
  email: string;
  role: string;
  redirectUrl: string;
}): Promise<TeamInvitation> {
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) {
    throw new TeamError('INVALID_EMAIL', 'Cette adresse e-mail n’est pas valide.');
  }
  if (!isInvitableRole(input.role)) {
    throw new TeamError('INVALID_ROLE', 'Ce rôle ne peut pas être attribué par invitation.');
  }
  const role = input.role;

  try {
    const [pending, members] = await Promise.all([
      clerkClient.organizations.getOrganizationInvitationList({
        organizationId: input.organizationId,
        status: ['pending'],
        limit: PAGE_SIZE,
      }),
      clerkClient.organizations.getOrganizationMembershipList({
        organizationId: input.organizationId,
        emailAddress: [email],
        limit: 1,
      }),
    ]);
    if (pending.data.length >= MAX_PENDING_INVITATIONS) {
      throw new TeamError(
        'TOO_MANY_INVITATIONS',
        'Trop d’invitations sont en attente. Annulez-en avant d’en envoyer de nouvelles.',
      );
    }
    if (pending.data.some((invitation) => normalizeEmail(invitation.emailAddress) === email)) {
      throw new TeamError(
        'ALREADY_INVITED',
        'Une invitation est déjà en attente pour cette adresse.',
      );
    }
    if (members.data.length > 0) {
      throw new TeamError('ALREADY_MEMBER', 'Cette personne fait déjà partie de l’équipe.');
    }

    const invitation = await clerkClient.organizations.createOrganizationInvitation({
      organizationId: input.organizationId,
      inviterUserId: input.inviterUserId,
      emailAddress: email,
      role: 'org:member',
      publicMetadata: { [ROLE_METADATA_KEY]: role },
      redirectUrl: input.redirectUrl,
    });
    return {
      id: invitation.id,
      email: invitation.emailAddress,
      role,
      createdAt: new Date(invitation.createdAt).toISOString(),
    };
  } catch (error) {
    if (error instanceof TeamError) throw error;
    throw unavailable(error);
  }
}

export async function revokeInvitation(input: {
  organizationId: string;
  invitationId: string;
  requestingUserId: string;
}): Promise<void> {
  try {
    await clerkClient.organizations.revokeOrganizationInvitation({
      organizationId: input.organizationId,
      invitationId: input.invitationId,
      requestingUserId: input.requestingUserId,
    });
  } catch (cause) {
    const status = (cause as { status?: number } | null)?.status;
    if (status === 404) {
      throw new TeamError('INVITATION_NOT_FOUND', 'Cette invitation n’existe plus.', { cause });
    }
    throw unavailable(cause);
  }
}

function assertEditable(
  member: { role: string } | null,
  userId: string,
  actingUserId: string,
): asserts member is { role: string } {
  if (!member) throw new TeamError('MEMBER_NOT_FOUND', 'Ce membre n’existe pas.');
  if (userId === actingUserId) {
    throw new TeamError('CANNOT_EDIT_SELF', 'Vous ne pouvez pas modifier votre propre accès.');
  }
  if (member.role === 'OWNER') {
    throw new TeamError('CANNOT_EDIT_OWNER', 'Le propriétaire du compte ne peut pas être modifié.');
  }
}

export async function changeMemberRole(input: {
  accountId: string;
  userId: string;
  role: string;
  actingUserId: string;
}): Promise<void> {
  if (!isInvitableRole(input.role)) {
    throw new TeamError('INVALID_ROLE', 'Ce rôle ne peut pas être attribué.');
  }
  await db.$transaction(async (tx) => {
    await lockAccountMemberships(tx, input.accountId);
    const member = await tx.restaurantAccountMembership.findFirst({
      where: { accountId: input.accountId, restaurantId: null, clerkUserId: input.userId },
      select: { id: true, role: true },
    });
    assertEditable(member, input.userId, input.actingUserId);
    await tx.restaurantAccountMembership.updateMany({
      where: {
        accountId: input.accountId,
        clerkUserId: input.userId,
        ...(input.role === 'READ_ONLY' ? {} : { restaurantId: null }),
      },
      data: { role: input.role },
    });
  });
}

export async function transferOwnership(input: {
  accountId: string;
  organizationId: string;
  actingUserId: string;
  targetUserId: string;
  previousOwnerAccess: 'MANAGER' | 'READ_ONLY' | 'NONE';
}): Promise<void> {
  if (input.actingUserId === input.targetUserId)
    throw new TeamError('TRANSFER_INVALID', 'Choisissez un autre membre.');
  await db.$transaction(
    async (tx) => {
      await lockAccountMemberships(tx, input.accountId);
      const owners = await tx.restaurantAccountMembership.findMany({
        where: { accountId: input.accountId, restaurantId: null, role: 'OWNER' },
        select: { id: true, clerkUserId: true },
      });
      if (owners.length !== 1 || owners[0].clerkUserId !== input.actingUserId) {
        throw new TeamError(
          'TRANSFER_INVALID',
          'Le propriétaire du compte ne peut pas être vérifié.',
        );
      }
      const target = await tx.restaurantAccountMembership.findFirst({
        where: { accountId: input.accountId, restaurantId: null, clerkUserId: input.targetUserId },
        select: { id: true },
      });
      if (!target) throw new TeamError('MEMBER_NOT_FOUND', 'Choisissez un membre du compte.');
      try {
        await assertClerkOrganizationMember({
          organizationId: input.organizationId,
          userId: input.targetUserId,
        });
        if (input.previousOwnerAccess === 'NONE') {
          await clerkClient.organizations.updateOrganizationMembershipMetadata({
            organizationId: input.organizationId,
            userId: input.actingUserId,
            publicMetadata: { [ROLE_METADATA_KEY]: 'REVOKED' },
          });
        }
      } catch (error) {
        throw unavailable(error);
      }
      // tenant-scoping: global — membre vérifié par accountId dans la même transaction.
      await tx.restaurantAccountMembership.update({
        where: { id: target.id },
        data: { role: 'OWNER' },
      });
      await tx.reservationAuditLog.create({
        data: {
          event: 'account_ownership_transferred',
          actor: input.actingUserId,
          metadata: {
            accountId: input.accountId,
            newOwnerId: input.targetUserId,
            previousOwnerAccess: input.previousOwnerAccess,
          },
        },
      });
      if (input.previousOwnerAccess === 'NONE') {
        await tx.restaurantAccountMembership.deleteMany({
          where: { accountId: input.accountId, clerkUserId: input.actingUserId },
        });
      } else {
        await tx.restaurantAccountMembership.updateMany({
          where: { accountId: input.accountId, clerkUserId: input.actingUserId },
          data: { role: input.previousOwnerAccess },
        });
      }
    },
    { timeout: 30000 },
  );
  if (input.previousOwnerAccess === 'NONE') {
    try {
      await clerkClient.organizations.deleteOrganizationMembership({
        organizationId: input.organizationId,
        userId: input.actingUserId,
      });
    } catch {
      logger.warn(
        { accountId: input.accountId },
        'Former owner remains in Clerk without Suppernote access',
      );
    }
  }
}

/**
 * Retire un membre. L'appartenance Clerk est supprimée d'abord : tant qu'elle existerait, ses
 * métadonnées permettraient de le rattacher de nouveau.
 */
export async function removeMember(input: {
  organizationId: string;
  accountId: string;
  userId: string;
  actingUserId: string;
}): Promise<void> {
  await db.$transaction(
    async (tx) => {
      await lockAccountMemberships(tx, input.accountId);
      const member = await tx.restaurantAccountMembership.findFirst({
        where: { accountId: input.accountId, restaurantId: null, clerkUserId: input.userId },
        select: { id: true, role: true },
      });
      assertEditable(member, input.userId, input.actingUserId);
      try {
        await clerkClient.organizations.deleteOrganizationMembership({
          organizationId: input.organizationId,
          userId: input.userId,
        });
      } catch (cause) {
        if ((cause as { status?: number } | null)?.status !== 404) throw unavailable(cause);
      }
      await tx.restaurantAccountMembership.deleteMany({
        where: { accountId: input.accountId, clerkUserId: input.userId },
      });
    },
    { timeout: 30000 },
  );
}

const CLAIM_MISS_TTL_MS = 60_000;
const claimMisses = new Map<string, number>();

/**
 * Premier appel d'un invité : il appartient à l'organisation Clerk mais n'a pas encore de
 * membership Suppernote. On lit le rôle porté par son invitation et on le rattache. Renvoie `null`
 * (et ne rappelle pas Clerk pendant une minute) quand il n'y a rien à rattacher.
 */
export async function claimInvitedMembership(input: {
  organizationId: string;
  userId: string;
}): Promise<InvitableRole | null> {
  const missKey = `${input.organizationId}:${input.userId}`;
  const lastMiss = claimMisses.get(missKey);
  if (lastMiss && Date.now() - lastMiss < CLAIM_MISS_TTL_MS) return null;

  const miss = () => {
    claimMisses.set(missKey, Date.now());
    return null;
  };

  const account = await db.restaurantAccount.findUnique({
    where: { clerkOrganizationId: input.organizationId },
    select: { id: true, status: true },
  });
  if (!account || account.status !== 'ACTIVE') return miss();

  return db.$transaction(
    async (tx) => {
      await lockAccountMemberships(tx, account.id);
      const owner = await tx.restaurantAccountMembership.findFirst({
        where: { accountId: account.id, restaurantId: null, role: 'OWNER' },
        select: { id: true },
      });
      if (!owner) return null;
      const existing = await tx.restaurantAccountMembership.findFirst({
        where: { accountId: account.id, clerkUserId: input.userId },
        select: { id: true },
      });
      if (existing) return null;
      let role: unknown;
      try {
        const memberships = await clerkClient.organizations.getOrganizationMembershipList({
          organizationId: input.organizationId,
          userId: [input.userId],
          limit: 1,
        });
        role = readRoleMetadata(
          (memberships.data[0] as ClerkMembershipLike | undefined)?.publicMetadata,
        );
      } catch {
        return null;
      }
      if (!isInvitableRole(role)) return miss();
      await tx.restaurantAccountMembership.create({
        data: { accountId: account.id, restaurantId: null, clerkUserId: input.userId, role },
      });
      claimMisses.delete(missKey);
      return role;
    },
    { timeout: 30000 },
  );
}

/** Réservé aux tests : vide la mémoire des tentatives de rattachement sans résultat. */
export function resetClaimMisses(): void {
  claimMisses.clear();
}
