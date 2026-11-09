import { describe, expect, it } from 'vitest';
import { evaluateRolePolicy } from '../role-policy';

const decide = (
  role: Parameters<typeof evaluateRolePolicy>[0]['role'],
  method: string,
  route?: string,
) => evaluateRolePolicy({ role, method, route });

describe('équipe de service (STAFF)', () => {
  it.each([
    ['GET', '/reservations'],
    ['GET', '/v2/reservations'],
    ['GET', '/v2/reservations/day'],
    ['GET', '/restaurants/:id/floor-plan'],
    ['GET', '/restaurants/:id/floor-plans'],
    ['GET', '/restaurants/:id/floor-plans/:floorPlanId'],
    ['GET', '/restaurants/:id/floor-plan/reservations'],
    ['GET', '/restaurants/:id/availability'],
    ['GET', '/customers/service-cards'],
    ['GET', '/restaurants/:id'],
    ['GET', '/restaurants/sites'],
    ['GET', '/restaurant/onboarding'],
    ['GET', '/api/restaurant/onboarding'],
    ['GET', '/entitlements'],
    ['POST', '/api/auth/sync'],
    ['HEAD', '/reservations'],
  ])('peut lire %s %s', (method, route) => {
    expect(decide('STAFF', method, route)).toEqual({ allowed: true });
  });

  it.each([
    ['POST', '/reservations'],
    ['PATCH', '/reservations/:id'],
    ['POST', '/reservations/:id/allocate-table'],
    ['POST', '/restaurants/:id/floor-plan/walk-ins'],
    ['PATCH', '/restaurants/:id/floor-plan/reservations/:reservationId/state'],
    ['PATCH', '/restaurants/:id/floor-plan/reservations/:reservationId/assign-table'],
    ['DELETE', '/restaurants/:id/waiting-list/:entryId'],
    ['POST', '/restaurants/:id/waiting-list/:entryId/promote'],
    ['POST', '/restaurants/:id/service-copilot/delay-impact/apply'],
  ])('peut agir pendant un service : %s %s', (method, route) => {
    expect(decide('STAFF', method, route)).toEqual({ allowed: true });
  });

  it.each([
    // Réglages et identité du restaurant
    ['PATCH', '/restaurants/:id'],
    ['PATCH', '/restaurants/:id/personality'],
    ['GET', '/restaurants/:id/personality'],
    ['PATCH', '/restaurants/:id/connect'],
    ['PATCH', '/restaurant/onboarding'],
    ['PUT', '/restaurant/onboarding/floor'],
    ['POST', '/restaurants/:id/images'],
    // Structure de la salle
    ['POST', '/restaurants/:id/floor-plan/tables'],
    ['PATCH', '/restaurants/:id/floor-plan/tables/:tableId'],
    ['DELETE', '/restaurants/:id/floor-plans/:floorPlanId'],
    ['POST', '/restaurants/:id/floor-plans'],
    // Argent, équipe, intégrations, canaux
    ['GET', '/billing/status'],
    ['POST', '/billing/checkout-session'],
    ['GET', '/team'],
    ['POST', '/team/invitations'],
    ['POST', '/restaurants/sites'],
    ['POST', '/restaurants/sites/:id/members'],
    ['POST', '/api/agentic/opt-in'],
    ['GET', '/api/agentic/exposure-settings'],
    // Données clients et activité
    ['GET', '/customers'],
    ['GET', '/crm/customers'],
    ['GET', '/calls'],
    ['GET', '/calls/:id/recording'],
    ['GET', '/dashboard/stats'],
    ['GET', '/analytics/roi'],
    ['POST', '/marketing/campaigns'],
    ['GET', '/restaurants/:id/gift-cards'],
    ['GET', '/reservations/:id/payment'],
    ['DELETE', '/reservations/:id'],
  ])('ne peut pas %s %s', (method, route) => {
    expect(decide('STAFF', method, route)).toEqual({ allowed: false, code: 'ROLE_FORBIDDEN' });
  });

  it('ne confond pas deux routes qui partagent un début de chemin', () => {
    expect(decide('STAFF', 'GET', '/reservations-export')).toMatchObject({ allowed: false });
    expect(decide('STAFF', 'GET', '/restaurants/:id/availabilityx')).toMatchObject({
      allowed: false,
    });
    expect(decide('STAFF', 'GET', '/reservation-payments/:paymentId')).toMatchObject({
      allowed: false,
    });
  });

  it('refuse par défaut quand la route est inconnue', () => {
    expect(decide('STAFF', 'GET', undefined)).toEqual({ allowed: false, code: 'ROLE_FORBIDDEN' });
  });
});

describe('autres rôles', () => {
  it('READ_ONLY ne lit pas les routes de direction, Companion compris', () => {
    expect(decide('READ_ONLY', 'GET', '/companion/tonight')).toEqual({
      allowed: false,
      code: 'ROLE_FORBIDDEN',
    });
    expect(decide('READ_ONLY', 'POST', '/companion/chat')).toEqual({
      allowed: false,
      code: 'READ_ONLY_ACCESS',
    });
    expect(decide('OWNER', 'GET', '/companion/tonight')).toEqual({ allowed: true });
    expect(decide('MANAGER', 'GET', '/companion/tonight')).toEqual({ allowed: true });
  });

  it('remplissage de service : direction seule, l’équipe de service et la lecture seule sont refusées', () => {
    for (const path of ['/marketing/fill-service/preview', '/marketing/fill-service']) {
      expect(decide('STAFF', 'POST', path)).toEqual({ allowed: false, code: 'ROLE_FORBIDDEN' });
      expect(decide('READ_ONLY', 'POST', path)).toEqual({
        allowed: false,
        code: 'READ_ONLY_ACCESS',
      });
      expect(decide('OWNER', 'POST', path)).toEqual({ allowed: true });
      expect(decide('MANAGER', 'POST', path)).toEqual({ allowed: true });
    }
  });

  it('suggestions de services creux : lecture et ignorance réservées à la direction', () => {
    for (const [method, path] of [
      ['GET', '/marketing/fill-suggestions'],
      ['POST', '/marketing/fill-suggestions/dismiss'],
    ]) {
      expect(decide('STAFF', method, path)).toEqual({ allowed: false, code: 'ROLE_FORBIDDEN' });
      expect(decide('READ_ONLY', method, path)).toEqual({
        allowed: false,
        code: method === 'GET' ? 'ROLE_FORBIDDEN' : 'READ_ONLY_ACCESS',
      });
      expect(decide('OWNER', method, path)).toEqual({ allowed: true });
      expect(decide('MANAGER', method, path)).toEqual({ allowed: true });
    }
  });

  it('READ_ONLY lit tout et n’écrit rien', () => {
    expect(decide('READ_ONLY', 'GET', '/customers')).toEqual({ allowed: true });
    expect(decide('READ_ONLY', 'HEAD', '/calls')).toEqual({ allowed: true });
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(decide('READ_ONLY', method, '/reservations')).toEqual({
        allowed: false,
        code: 'READ_ONLY_ACCESS',
      });
    }
  });

  it.each(['OWNER', 'MANAGER', 'ORG_MEMBER'] as const)('%s garde l’accès aux routes', (role) => {
    expect(decide(role, 'PATCH', '/restaurants/:id')).toEqual({ allowed: true });
    expect(decide(role, 'GET', '/customers')).toEqual({ allowed: true });
    expect(decide(role, 'POST', '/restaurants/:id/floor-plan/tables')).toEqual({ allowed: true });
    expect(decide(role, 'POST', '/anything')).toEqual({ allowed: true });
  });
});
