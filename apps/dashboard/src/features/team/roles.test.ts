import { describe, expect, it } from 'vitest';
import {
  SERVICE_STAFF_HOME,
  canOpenDashboardPath,
  isInvitableRole,
  isServiceStaff,
  roleLabel,
} from './roles';

describe('canOpenDashboardPath', () => {
  it.each(['/dashboard/reservations', '/dashboard/floor-plan', '/dashboard/floor-plan/anything'])(
    'l’équipe de service ouvre %s',
    (path) => {
      expect(canOpenDashboardPath('STAFF', path)).toBe(true);
    },
  );

  it.each([
    '/dashboard',
    '/dashboard/settings',
    '/dashboard/customers',
    '/dashboard/calls',
    '/dashboard/marketing',
    '/dashboard/reservations-export',
    '/dashboard/floor-plans',
  ])('l’équipe de service n’ouvre pas %s', (path) => {
    expect(canOpenDashboardPath('STAFF', path)).toBe(false);
  });

  it('ferme la modification du plan de salle à l’équipe de service seulement', () => {
    expect(canOpenDashboardPath('STAFF', '/dashboard/floor-plan', 'edit-plan')).toBe(false);
    expect(canOpenDashboardPath('STAFF', '/dashboard/floor-plan', 'service-live')).toBe(true);
    expect(canOpenDashboardPath('MANAGER', '/dashboard/floor-plan', 'edit-plan')).toBe(true);
  });

  it.each(['OWNER', 'MANAGER', 'READ_ONLY', 'ORG_MEMBER', undefined, null])(
    'ne limite pas le rôle %s',
    (role) => {
      expect(canOpenDashboardPath(role, '/dashboard/settings')).toBe(true);
    },
  );

  it('renvoie l’équipe de service vers les réservations', () => {
    expect(SERVICE_STAFF_HOME).toBe('/dashboard/reservations');
    expect(canOpenDashboardPath('STAFF', SERVICE_STAFF_HOME)).toBe(true);
    expect(canOpenDashboardPath('STAFF', '/dashboard/briefing')).toBe(true);
  });
});

describe('rôles', () => {
  it('reconnaît l’équipe de service', () => {
    expect(isServiceStaff('STAFF')).toBe(true);
    expect(isServiceStaff('MANAGER')).toBe(false);
    expect(isServiceStaff(undefined)).toBe(false);
  });

  it('ne laisse jamais choisir le propriétaire', () => {
    expect(isInvitableRole('OWNER')).toBe(false);
    expect(isInvitableRole('STAFF')).toBe(true);
    expect(isInvitableRole('')).toBe(false);
  });

  it('nomme chaque rôle en français', () => {
    expect(roleLabel('OWNER')).toBe('Propriétaire');
    expect(roleLabel('STAFF')).toBe('Équipe de service');
    expect(roleLabel(null)).toBe('Membre');
    expect(roleLabel('ADMIN')).toBe('Membre');
  });
});
