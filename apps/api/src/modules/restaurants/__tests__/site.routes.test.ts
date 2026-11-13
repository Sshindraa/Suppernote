import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeApp, getApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import { clerkClient } from '@clerk/fastify';

vi.mock('@clerk/fastify', () => ({
  clerkClient: {
    organizations: {
      getOrganizationMembershipList: vi.fn(),
      updateOrganizationMembershipMetadata: vi.fn(),
    },
  },
}));

describe('restaurant routes — sites accessibles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeApp();
  });

  it('retourne les établissements visibles et le site actif', async () => {
    const app = await getApp();
    vi.mocked(db.restaurantAccount.findUnique).mockResolvedValue({
      id: 'account_1',
      status: 'ACTIVE',
      restaurants: [
        {
          id: 'site_primary',
          name: 'Chez Suppernote Lyon',
          siteStatus: 'ACTIVE',
          isPrimary: true,
          createdAt: new Date(1),
        },
        {
          id: 'site_two',
          name: 'Chez Suppernote Paris',
          siteStatus: 'ACTIVE',
          isPrimary: false,
          createdAt: new Date(2),
        },
        {
          id: 'site_paused',
          name: 'Chez Suppernote Lille',
          siteStatus: 'SUSPENDED',
          isPrimary: false,
          createdAt: new Date(3),
        },
      ],
      memberships: [{ restaurantId: null, clerkUserId: 'test-user-1', role: 'OWNER' }],
    } as never);

    const res = await app.inject({
      method: 'GET',
      url: '/restaurants/sites',
      headers: { authorization: 'Bearer test' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      accountId: 'test-account-1',
      activeSiteId: 'test-rest-1',
      sites: [
        {
          id: 'site_primary',
          name: 'Chez Suppernote Lyon',
          siteStatus: 'ACTIVE',
          isPrimary: true,
          role: 'OWNER',
        },
        {
          id: 'site_two',
          name: 'Chez Suppernote Paris',
          siteStatus: 'ACTIVE',
          isPrimary: false,
          role: 'OWNER',
        },
        {
          id: 'site_paused',
          name: 'Chez Suppernote Lille',
          siteStatus: 'SUSPENDED',
          isPrimary: false,
          role: 'OWNER',
        },
      ],
    });
  });

  it('refuse les opérations de gestion à un membre STAFF', async () => {
    const app = await getApp();

    const createSite = await app.inject({
      method: 'POST',
      url: '/restaurants/sites',
      headers: { authorization: 'Bearer test', 'x-test-site-role': 'STAFF' },
      payload: { name: 'Site interdit', phoneNumber: '+33111111111' },
    });
    expect(createSite.statusCode).toBe(403);
    expect(createSite.json()).toEqual({ error: 'SITE_ADMIN_REQUIRED' });

    const manageMember = await app.inject({
      method: 'POST',
      url: '/restaurants/sites/site_two/members',
      headers: { authorization: 'Bearer test', 'x-test-site-role': 'STAFF' },
      payload: { clerkUserId: 'user_2', role: 'STAFF' },
    });
    expect(manageMember.statusCode).toBe(403);
    expect(manageMember.json()).toEqual({ error: 'SITE_ADMIN_REQUIRED' });
    expect(clerkClient.organizations.getOrganizationMembershipList).not.toHaveBeenCalled();
    expect(db.restaurant.create).not.toHaveBeenCalled();
    expect(db.restaurantAccountMembership.create).not.toHaveBeenCalled();
  });

  it('ajoute un établissement pour le propriétaire dans le quota facturé', async () => {
    const app = await getApp();
    vi.mocked(db.restaurantAccount.findUnique).mockResolvedValue({
      id: 'test-account-1',
      status: 'ACTIVE',
    } as never);
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      accountId: 'test-account-1',
      plan: 'PREMIUM',
    } as never);
    vi.mocked(db.restaurant.count).mockResolvedValue(1);
    vi.mocked(db.restaurantAccountBilling.findUnique).mockResolvedValue({
      entitledSiteCount: 2,
    } as never);
    vi.mocked(db.restaurant.create).mockResolvedValue({
      id: 'site_two',
      name: 'Chez Suppernote Paris',
      siteStatus: 'ACTIVE',
      isPrimary: false,
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/restaurants/sites',
      headers: { authorization: 'Bearer test' },
      payload: { name: 'Chez Suppernote Paris', phoneNumber: '+33123456789' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: 'site_two',
      name: 'Chez Suppernote Paris',
      siteStatus: 'ACTIVE',
      isPrimary: false,
      role: 'OWNER',
    });
    expect(db.restaurant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId: 'test-account-1',
        isPrimary: false,
        siteStatus: 'ACTIVE',
        name: 'Chez Suppernote Paris',
        // La ligne saisie est la ligne publique du site ; le numéro Suppernote est provisoire et
        // attribué ensuite par un opérateur.
        phoneNumber: expect.stringMatching(/^\+000site-/),
        phoneE164: '+33123456789',
        plan: 'PREMIUM',
      }),
    });
  });

  it('bloque l’ajout d’un site hors quota', async () => {
    const app = await getApp();
    vi.mocked(db.restaurantAccount.findUnique).mockResolvedValue({
      id: 'test-account-1',
      status: 'ACTIVE',
    } as never);
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      accountId: 'test-account-1',
      plan: 'PRO',
    } as never);
    vi.mocked(db.restaurant.count).mockResolvedValue(1);
    vi.mocked(db.restaurantAccountBilling.findUnique).mockResolvedValue({
      entitledSiteCount: 1,
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/restaurants/sites',
      headers: { authorization: 'Bearer test' },
      payload: { name: 'Site bloqué', phoneNumber: '+33198765432' },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe('MULTI_SITE_SUBSCRIPTION_REQUIRED');
    expect(db.restaurant.create).not.toHaveBeenCalled();
  });

  it('refuse d’archiver le site principal s’il est le dernier actif', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'test-rest-1',
      accountId: 'test-account-1',
      isPrimary: true,
      siteStatus: 'ACTIVE',
      name: 'Chez Suppernote',
    } as never);
    vi.mocked(db.restaurant.count).mockResolvedValue(0);

    const res = await app.inject({
      method: 'PATCH',
      url: '/restaurants/sites/test-rest-1',
      headers: { authorization: 'Bearer test' },
      payload: { siteStatus: 'ARCHIVED' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('PRIMARY_SITE_REQUIRED');
    expect(db.restaurant.update).not.toHaveBeenCalled();
  });

  it('transfère le principal au plus ancien site actif avant sa suspension', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'test-rest-1',
      accountId: 'test-account-1',
      isPrimary: true,
      siteStatus: 'ACTIVE',
      name: 'Chez Suppernote',
    } as never);
    vi.mocked(db.restaurant.findFirst).mockResolvedValue({ id: 'site_two' } as never);
    vi.mocked(db.restaurant.update).mockResolvedValue({
      id: 'test-rest-1',
      name: 'Chez Suppernote',
      siteStatus: 'SUSPENDED',
      isPrimary: false,
    } as never);

    const res = await app.inject({
      method: 'PATCH',
      url: '/restaurants/sites/test-rest-1',
      headers: { authorization: 'Bearer test' },
      payload: { siteStatus: 'SUSPENDED' },
    });

    expect(res.statusCode).toBe(200);
    expect(db.restaurant.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'site_two' },
      data: { isPrimary: true },
    });
    expect(db.restaurant.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'test-rest-1' },
      data: { siteStatus: 'SUSPENDED', isPrimary: false },
      select: { id: true, name: true, siteStatus: true, isPrimary: true },
    });
  });

  it('n’ajoute un membre qu’après validation de son appartenance Clerk', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'site_two',
      accountId: 'test-account-1',
      siteStatus: 'ACTIVE',
    } as never);
    vi.mocked(clerkClient.organizations.getOrganizationMembershipList).mockResolvedValue({
      data: [{ publicUserData: { userId: 'user_2' } }],
    } as never);
    vi.mocked(db.restaurantAccountMembership.create).mockResolvedValue({
      id: 'membership_2',
      restaurantId: 'site_two',
      clerkUserId: 'user_2',
      role: 'STAFF',
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/restaurants/sites/site_two/members',
      headers: { authorization: 'Bearer test' },
      payload: { clerkUserId: 'user_2', role: 'STAFF' },
    });

    expect(res.statusCode).toBe(201);
    expect(clerkClient.organizations.getOrganizationMembershipList).toHaveBeenCalledWith({
      organizationId: 'test-rest-1',
      userId: ['user_2'],
      limit: 1,
    });
    expect(db.restaurantAccountMembership.create).toHaveBeenCalledWith({
      data: {
        accountId: 'test-account-1',
        restaurantId: 'site_two',
        clerkUserId: 'user_2',
        role: 'STAFF',
      },
    });
  });

  it('refuse un rôle local supérieur à la lecture seule du compte', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'site_two',
      accountId: 'test-account-1',
      siteStatus: 'ACTIVE',
    } as never);
    vi.mocked(clerkClient.organizations.getOrganizationMembershipList).mockResolvedValue({
      data: [{}],
    } as never);
    vi.mocked(db.restaurantAccountMembership.findFirst).mockResolvedValue({
      role: 'READ_ONLY',
    } as never);
    const res = await app.inject({
      method: 'POST',
      url: '/restaurants/sites/site_two/members',
      headers: { authorization: 'Bearer test' },
      payload: { clerkUserId: 'user_2', role: 'MANAGER' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('ACCOUNT_READ_ONLY');
    expect(db.restaurantAccountMembership.create).not.toHaveBeenCalled();
  });

  it('désactive le rattachement automatique avant de retirer la dernière attribution', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ accountId: 'test-account-1' } as never);
    vi.mocked(db.restaurantAccountMembership.findFirst).mockResolvedValue({
      id: 'site-grant',
    } as never);
    vi.mocked(db.restaurantAccountMembership.count).mockResolvedValue(0);
    const res = await app.inject({
      method: 'DELETE',
      url: '/restaurants/sites/site_two/members/user_2',
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(204);
    expect(clerkClient.organizations.updateOrganizationMembershipMetadata).toHaveBeenCalledWith({
      organizationId: 'test-rest-1',
      userId: 'user_2',
      publicMetadata: { suppernoteRole: 'REVOKED' },
    });
    expect(db.restaurantAccountMembership.delete).toHaveBeenCalledWith({
      where: { id: 'site-grant' },
    });
  });

  it('conserve l’attribution si Clerk ne peut pas empêcher le rattachement', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ accountId: 'test-account-1' } as never);
    vi.mocked(db.restaurantAccountMembership.findFirst).mockResolvedValue({
      id: 'site-grant',
    } as never);
    vi.mocked(db.restaurantAccountMembership.count).mockResolvedValue(0);
    vi.mocked(clerkClient.organizations.updateOrganizationMembershipMetadata).mockRejectedValueOnce(
      new Error('Clerk unavailable'),
    );
    const res = await app.inject({
      method: 'DELETE',
      url: '/restaurants/sites/site_two/members/user_2',
      headers: { authorization: 'Bearer test' },
    });
    expect(res.statusCode).toBe(503);
    expect(db.restaurantAccountMembership.delete).not.toHaveBeenCalled();
  });

  it('refuse un utilisateur absent de l’organisation Clerk sans écriture locale', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'site_two',
      accountId: 'test-account-1',
      siteStatus: 'ACTIVE',
    } as never);
    vi.mocked(clerkClient.organizations.getOrganizationMembershipList).mockResolvedValue({
      data: [],
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/restaurants/sites/site_two/members',
      headers: { authorization: 'Bearer test' },
      payload: { clerkUserId: 'user_outside', role: 'STAFF' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error: 'CLERK_MEMBER_REQUIRED',
      message: 'L’utilisateur doit d’abord appartenir à votre organisation Clerk.',
    });
    expect(db.restaurantAccountMembership.create).not.toHaveBeenCalled();
    expect(db.restaurantAccountMembership.update).not.toHaveBeenCalled();
  });

  it('bloque l’écriture si la vérification Clerk est indisponible', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'site_two',
      accountId: 'test-account-1',
      siteStatus: 'ACTIVE',
    } as never);
    vi.mocked(clerkClient.organizations.getOrganizationMembershipList).mockRejectedValue(
      new Error('Clerk timeout'),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/restaurants/sites/site_two/members',
      headers: { authorization: 'Bearer test' },
      payload: { clerkUserId: 'user_2', role: 'STAFF' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('CLERK_MEMBERSHIP_UNAVAILABLE');
    expect(db.restaurantAccountMembership.create).not.toHaveBeenCalled();
    expect(db.restaurantAccountMembership.update).not.toHaveBeenCalled();
  });
});
