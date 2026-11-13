import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../shared/db/client';
import {
  TeamError,
  claimInvitedMembership,
  changeMemberRole,
  inviteMember,
  listTeam,
  removeMember,
  resetClaimMisses,
  revokeInvitation,
  transferOwnership,
} from '../team.service';

const clerk = vi.hoisted(() => ({
  getOrganizationMembershipList: vi.fn(),
  getOrganizationInvitationList: vi.fn(),
  createOrganizationInvitation: vi.fn(),
  revokeOrganizationInvitation: vi.fn(),
  deleteOrganizationMembership: vi.fn(),
  updateOrganizationMembershipMetadata: vi.fn(),
}));
vi.mock('@clerk/fastify', () => ({ clerkClient: { organizations: clerk } }));

const invite = (overrides: Partial<Parameters<typeof inviteMember>[0]> = {}) =>
  inviteMember({
    organizationId: 'org_1',
    inviterUserId: 'user_owner',
    email: 'Serveur@Example.com ',
    role: 'STAFF',
    redirectUrl: 'https://suppernote.com/register',
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
  resetClaimMisses();
  clerk.getOrganizationInvitationList.mockResolvedValue({ data: [] });
  clerk.getOrganizationMembershipList.mockResolvedValue({ data: [] });
  clerk.createOrganizationInvitation.mockResolvedValue({
    id: 'inv_1',
    emailAddress: 'serveur@example.com',
    createdAt: Date.parse('2026-10-13T10:00:00Z'),
  });
});

describe('claimInvitedMembership', () => {
  it('ne transforme pas une attribution limitée à un site en accès global', async () => {
    vi.mocked(db.restaurantAccount.findUnique).mockResolvedValue({
      id: 'account_1',
      status: 'ACTIVE',
    } as never);
    vi.mocked(db.restaurantAccountMembership.findFirst).mockResolvedValue({
      id: 'site-membership',
    } as never);
    clerk.getOrganizationMembershipList.mockResolvedValue({
      data: [{ publicMetadata: { sokarRole: 'MANAGER' } }],
    });
    expect(
      await claimInvitedMembership({ organizationId: 'org_1', userId: 'user_site' }),
    ).toBeNull();
    expect(db.restaurantAccountMembership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId: 'account_1', clerkUserId: 'user_site' },
      }),
    );
    expect(db.restaurantAccountMembership.create).not.toHaveBeenCalled();
  });

  it('rattache une invitation authentifiée quand aucune attribution ne préexiste', async () => {
    vi.mocked(db.restaurantAccount.findUnique).mockResolvedValue({
      id: 'account_1',
      status: 'ACTIVE',
    } as never);
    vi.mocked(db.restaurantAccountMembership.findFirst)
      .mockResolvedValueOnce({ id: 'owner' } as never)
      .mockResolvedValueOnce(null);
    clerk.getOrganizationMembershipList.mockResolvedValue({
      data: [{ publicMetadata: { sokarRole: 'STAFF' } }],
    });
    expect(await claimInvitedMembership({ organizationId: 'org_1', userId: 'user_new' })).toBe(
      'STAFF',
    );
    expect(db.restaurantAccountMembership.create).toHaveBeenCalledWith({
      data: {
        accountId: 'account_1',
        restaurantId: null,
        clerkUserId: 'user_new',
        role: 'STAFF',
      },
    });
  });
});

describe('inviteMember', () => {
  it('envoie une invitation Clerk qui porte le rôle Suppernote choisi', async () => {
    const result = await invite();

    expect(clerk.createOrganizationInvitation).toHaveBeenCalledWith({
      organizationId: 'org_1',
      inviterUserId: 'user_owner',
      emailAddress: 'serveur@example.com',
      role: 'org:member',
      publicMetadata: { sokarRole: 'STAFF' },
      redirectUrl: 'https://suppernote.com/register',
    });
    expect(result).toEqual({
      id: 'inv_1',
      email: 'serveur@example.com',
      role: 'STAFF',
      createdAt: '2026-10-13T10:00:00.000Z',
    });
  });

  it.each(['OWNER', 'ADMIN', '', 'staff'])('refuse le rôle %j', async (role) => {
    await expect(invite({ role })).rejects.toMatchObject({ code: 'INVALID_ROLE' });
    expect(clerk.createOrganizationInvitation).not.toHaveBeenCalled();
  });

  it.each(['pas-un-email', 'a@b', '@example.com', 'a b@example.com'])(
    'refuse l’adresse %j',
    async (email) => {
      await expect(invite({ email })).rejects.toMatchObject({ code: 'INVALID_EMAIL' });
      expect(clerk.createOrganizationInvitation).not.toHaveBeenCalled();
    },
  );

  it('refuse une invitation déjà en attente pour la même adresse', async () => {
    clerk.getOrganizationInvitationList.mockResolvedValue({
      data: [{ id: 'inv_0', emailAddress: 'SERVEUR@example.com' }],
    });

    await expect(invite()).rejects.toMatchObject({ code: 'ALREADY_INVITED' });
    expect(clerk.createOrganizationInvitation).not.toHaveBeenCalled();
  });

  it('refuse quelqu’un qui fait déjà partie de l’organisation', async () => {
    clerk.getOrganizationMembershipList.mockResolvedValue({ data: [{}] });

    await expect(invite()).rejects.toMatchObject({ code: 'ALREADY_MEMBER' });
  });

  it('plafonne les invitations en attente', async () => {
    clerk.getOrganizationInvitationList.mockResolvedValue({
      data: Array.from({ length: 20 }, (_, i) => ({ id: `inv_${i}`, emailAddress: `a${i}@x.fr` })),
    });

    await expect(invite()).rejects.toMatchObject({ code: 'TOO_MANY_INVITATIONS' });
  });

  it('traduit une panne de Clerk, sans la laisser fuiter', async () => {
    clerk.createOrganizationInvitation.mockRejectedValue(new Error('clé secrète sk_live_xxx'));

    const error = await invite().catch((e) => e);
    expect(error).toBeInstanceOf(TeamError);
    expect(error.code).toBe('IDENTITY_PROVIDER_UNAVAILABLE');
    expect(error.message).not.toContain('sk_live');
  });
});

describe('listTeam', () => {
  it('relie les rôles Suppernote aux noms de Clerk et marque l’utilisateur courant', async () => {
    vi.mocked(db.restaurantAccountMembership.findMany).mockResolvedValue([
      { clerkUserId: 'user_owner', role: 'OWNER' },
      { clerkUserId: 'user_staff', role: 'STAFF' },
      { clerkUserId: 'user_gone', role: 'MANAGER' },
    ] as never);
    clerk.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          publicUserData: {
            userId: 'user_owner',
            firstName: 'Camille',
            lastName: 'Martin',
            identifier: 'camille@example.com',
          },
        },
        { publicUserData: { userId: 'user_staff', identifier: 'serveur@example.com' } },
      ],
    });
    clerk.getOrganizationInvitationList.mockResolvedValue({
      data: [
        {
          id: 'inv_1',
          emailAddress: 'nouveau@example.com',
          publicMetadata: { sokarRole: 'READ_ONLY' },
          createdAt: Date.parse('2026-10-12T08:00:00Z'),
        },
        {
          id: 'inv_2',
          emailAddress: 'inconnu@example.com',
          publicMetadata: { sokarRole: 'OWNER' },
          createdAt: Date.parse('2026-10-12T09:00:00Z'),
        },
      ],
    });

    const team = await listTeam({
      organizationId: 'org_1',
      accountId: 'account_1',
      currentUserId: 'user_owner',
    });

    expect(team.members).toEqual([
      {
        userId: 'user_owner',
        name: 'Camille Martin',
        email: 'camille@example.com',
        role: 'OWNER',
        isYou: true,
      },
      {
        userId: 'user_staff',
        name: 'serveur@example.com',
        email: 'serveur@example.com',
        role: 'STAFF',
        isYou: false,
      },
      { userId: 'user_gone', name: 'Membre', email: null, role: 'MANAGER', isYou: false },
    ]);
    expect(team.invitations).toEqual([
      {
        id: 'inv_1',
        email: 'nouveau@example.com',
        role: 'READ_ONLY',
        createdAt: '2026-10-12T08:00:00.000Z',
      },
      // Un rôle que l'invitation ne peut pas porter n'est pas affiché comme valide.
      {
        id: 'inv_2',
        email: 'inconnu@example.com',
        role: null,
        createdAt: '2026-10-12T09:00:00.000Z',
      },
    ]);
  });

  it('signale l’indisponibilité de Clerk', async () => {
    vi.mocked(db.restaurantAccountMembership.findMany).mockResolvedValue([] as never);
    clerk.getOrganizationMembershipList.mockRejectedValue(new Error('down'));

    await expect(
      listTeam({ organizationId: 'org_1', accountId: 'account_1', currentUserId: 'user_owner' }),
    ).rejects.toMatchObject({ code: 'IDENTITY_PROVIDER_UNAVAILABLE' });
  });
});

describe('transferOwnership', () => {
  it.each(['MANAGER', 'READ_ONLY', 'NONE'] as const)(
    'transfère au membre et applique l’accès %s choisi',
    async (previousOwnerAccess) => {
      vi.mocked(db.restaurantAccountMembership.findMany).mockResolvedValue([
        { id: 'owner', clerkUserId: 'user_owner' },
      ] as never);
      vi.mocked(db.restaurantAccountMembership.findFirst).mockResolvedValue({
        id: 'target',
      } as never);
      clerk.getOrganizationMembershipList.mockResolvedValue({ data: [{}] });
      await transferOwnership({
        accountId: 'account_1',
        organizationId: 'org_1',
        actingUserId: 'user_owner',
        targetUserId: 'user_target',
        previousOwnerAccess,
      });
      expect(db.restaurantAccountMembership.update).toHaveBeenCalledWith({
        where: { id: 'target' },
        data: { role: 'OWNER' },
      });
      if (previousOwnerAccess === 'NONE') {
        expect(clerk.updateOrganizationMembershipMetadata).toHaveBeenCalledWith({
          organizationId: 'org_1',
          userId: 'user_owner',
          publicMetadata: { sokarRole: 'REVOKED' },
        });
        expect(clerk.deleteOrganizationMembership).toHaveBeenCalledWith({
          organizationId: 'org_1',
          userId: 'user_owner',
        });
        expect(db.restaurantAccountMembership.deleteMany).toHaveBeenCalledWith({
          where: { accountId: 'account_1', clerkUserId: 'user_owner' },
        });
      } else {
        expect(db.restaurantAccountMembership.updateMany).toHaveBeenCalledWith({
          where: { accountId: 'account_1', clerkUserId: 'user_owner' },
          data: { role: previousOwnerAccess },
        });
      }
    },
  );

  it('refuse le transfert si le demandeur n’est plus le propriétaire', async () => {
    vi.mocked(db.restaurantAccountMembership.findMany).mockResolvedValue([
      { id: 'owner', clerkUserId: 'other' },
    ] as never);
    await expect(
      transferOwnership({
        accountId: 'account_1',
        organizationId: 'org_1',
        actingUserId: 'user_owner',
        targetUserId: 'user_target',
        previousOwnerAccess: 'MANAGER',
      }),
    ).rejects.toMatchObject({ code: 'TRANSFER_INVALID' });
    expect(db.restaurantAccountMembership.update).not.toHaveBeenCalled();
  });
});

describe('changeMemberRole', () => {
  it('retire les droits locaux supérieurs lors du passage global en lecture seule', async () => {
    vi.mocked(db.restaurantAccountMembership.findFirst).mockResolvedValue({
      id: 'm1',
      role: 'MANAGER',
    } as never);
    await changeMemberRole({
      accountId: 'account_1',
      userId: 'user_staff',
      role: 'READ_ONLY',
      actingUserId: 'user_owner',
    });
    expect(db.restaurantAccountMembership.updateMany).toHaveBeenCalledWith({
      where: { accountId: 'account_1', clerkUserId: 'user_staff' },
      data: { role: 'READ_ONLY' },
    });
  });
  it('change le rôle d’un membre', async () => {
    vi.mocked(db.restaurantAccountMembership.findFirst).mockResolvedValue({
      id: 'm1',
      role: 'STAFF',
    } as never);

    await changeMemberRole({
      accountId: 'account_1',
      userId: 'user_staff',
      role: 'MANAGER',
      actingUserId: 'user_owner',
    });

    expect(db.restaurantAccountMembership.updateMany).toHaveBeenCalledWith({
      where: { accountId: 'account_1', restaurantId: null, clerkUserId: 'user_staff' },
      data: { role: 'MANAGER' },
    });
  });

  it('refuse de se modifier soi-même, de toucher au propriétaire, ou de donner OWNER', async () => {
    vi.mocked(db.restaurantAccountMembership.findFirst).mockResolvedValue({
      id: 'm1',
      role: 'OWNER',
    } as never);
    const base = { accountId: 'account_1', actingUserId: 'user_owner' };

    await expect(
      changeMemberRole({ ...base, userId: 'user_owner', role: 'STAFF' }),
    ).rejects.toMatchObject({ code: 'CANNOT_EDIT_SELF' });
    await expect(
      changeMemberRole({ ...base, userId: 'user_other_owner', role: 'STAFF' }),
    ).rejects.toMatchObject({ code: 'CANNOT_EDIT_OWNER' });
    await expect(
      changeMemberRole({ ...base, userId: 'user_staff', role: 'OWNER' }),
    ).rejects.toMatchObject({ code: 'INVALID_ROLE' });
    expect(db.restaurantAccountMembership.updateMany).not.toHaveBeenCalled();
  });

  it('refuse un membre inconnu', async () => {
    vi.mocked(db.restaurantAccountMembership.findFirst).mockResolvedValue(null);

    await expect(
      changeMemberRole({
        accountId: 'account_1',
        userId: 'user_x',
        role: 'STAFF',
        actingUserId: 'user_owner',
      }),
    ).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' });
  });
});

describe('removeMember', () => {
  const input = {
    organizationId: 'org_1',
    accountId: 'account_1',
    userId: 'user_staff',
    actingUserId: 'user_owner',
  };

  it('retire l’appartenance Clerk avant les accès Suppernote', async () => {
    vi.mocked(db.restaurantAccountMembership.findFirst).mockResolvedValue({
      id: 'm1',
      role: 'STAFF',
    } as never);
    const order: string[] = [];
    clerk.deleteOrganizationMembership.mockImplementation(async () => {
      order.push('clerk');
    });
    vi.mocked(db.restaurantAccountMembership.deleteMany).mockImplementation((async () => {
      order.push('database');
      return { count: 1 };
    }) as never);

    await removeMember(input);

    expect(order).toEqual(['clerk', 'database']);
    expect(clerk.deleteOrganizationMembership).toHaveBeenCalledWith({
      organizationId: 'org_1',
      userId: 'user_staff',
    });
    expect(db.restaurantAccountMembership.deleteMany).toHaveBeenCalledWith({
      where: { accountId: 'account_1', clerkUserId: 'user_staff' },
    });
  });

  it('ne retire rien de Suppernote si Clerk échoue : il pourrait être rattaché de nouveau', async () => {
    vi.mocked(db.restaurantAccountMembership.findFirst).mockResolvedValue({
      id: 'm1',
      role: 'STAFF',
    } as never);
    clerk.deleteOrganizationMembership.mockRejectedValue(
      Object.assign(new Error('down'), { status: 500 }),
    );

    await expect(removeMember(input)).rejects.toMatchObject({
      code: 'IDENTITY_PROVIDER_UNAVAILABLE',
    });
    expect(db.restaurantAccountMembership.deleteMany).not.toHaveBeenCalled();
  });

  it('continue si la personne a déjà quitté l’organisation', async () => {
    vi.mocked(db.restaurantAccountMembership.findFirst).mockResolvedValue({
      id: 'm1',
      role: 'STAFF',
    } as never);
    clerk.deleteOrganizationMembership.mockRejectedValue(
      Object.assign(new Error('absent'), { status: 404 }),
    );

    await removeMember(input);

    expect(db.restaurantAccountMembership.deleteMany).toHaveBeenCalled();
  });

  it('refuse de retirer le propriétaire ou soi-même', async () => {
    vi.mocked(db.restaurantAccountMembership.findFirst).mockResolvedValue({
      id: 'm1',
      role: 'OWNER',
    } as never);

    await expect(removeMember({ ...input, userId: 'user_owner' })).rejects.toMatchObject({
      code: 'CANNOT_EDIT_SELF',
    });
    await expect(removeMember({ ...input, userId: 'user_other_owner' })).rejects.toMatchObject({
      code: 'CANNOT_EDIT_OWNER',
    });
    expect(clerk.deleteOrganizationMembership).not.toHaveBeenCalled();
  });
});

describe('revokeInvitation', () => {
  it('annule une invitation en attente', async () => {
    clerk.revokeOrganizationInvitation.mockResolvedValue({});

    await revokeInvitation({
      organizationId: 'org_1',
      invitationId: 'inv_1',
      requestingUserId: 'user_owner',
    });

    expect(clerk.revokeOrganizationInvitation).toHaveBeenCalledWith({
      organizationId: 'org_1',
      invitationId: 'inv_1',
      requestingUserId: 'user_owner',
    });
  });

  it('signale une invitation qui n’existe plus', async () => {
    clerk.revokeOrganizationInvitation.mockRejectedValue(
      Object.assign(new Error('x'), { status: 404 }),
    );

    await expect(
      revokeInvitation({
        organizationId: 'org_1',
        invitationId: 'inv_x',
        requestingUserId: 'user_owner',
      }),
    ).rejects.toMatchObject({ code: 'INVITATION_NOT_FOUND' });
  });
});
