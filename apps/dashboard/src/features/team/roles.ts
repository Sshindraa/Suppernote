/**
 * Rôles d'une équipe, tels que l'API les attribue. Le dashboard n'en déduit que l'affichage : le
 * vrai contrôle d'accès est fait par l'API (`role-policy.ts`), qui refuse toute route hors rôle.
 */
export type TeamRole = 'OWNER' | 'MANAGER' | 'STAFF' | 'READ_ONLY';
export type InvitableRole = Exclude<TeamRole, 'OWNER'>;

export const ROLE_LABEL: Record<TeamRole, string> = {
  OWNER: 'Propriétaire',
  MANAGER: 'Responsable',
  STAFF: 'Équipe de service',
  READ_ONLY: 'Lecture seule',
};

export const ROLE_DESCRIPTION: Record<TeamRole, string> = {
  OWNER: 'Tous les accès, dont la facturation et l’équipe.',
  MANAGER: 'Gère le restaurant, les canaux et les clients. Pas la facturation ni l’équipe.',
  STAFF: 'Réservations, briefing et plan de salle pendant le service. Rien d’autre.',
  READ_ONLY: 'Consulte tout, ne modifie rien.',
};

export const INVITABLE_ROLES: readonly InvitableRole[] = ['MANAGER', 'STAFF', 'READ_ONLY'];

export function isInvitableRole(value: string): value is InvitableRole {
  return (INVITABLE_ROLES as readonly string[]).includes(value);
}

export function roleLabel(role: string | null | undefined): string {
  return role && role in ROLE_LABEL ? ROLE_LABEL[role as TeamRole] : 'Membre';
}

/** Page d'accueil de l'équipe de service. */
export const SERVICE_STAFF_HOME = '/dashboard/reservations';

const SERVICE_STAFF_PATHS = [
  '/dashboard/reservations',
  '/dashboard/floor-plan',
  '/dashboard/briefing',
];

export function isServiceStaff(role: string | null | undefined): boolean {
  return role === 'STAFF';
}

/**
 * L'équipe de service accède aux réservations, au briefing et au service en salle. La modification du
 * plan de salle (`?view=edit-plan`) lui est fermée, comme les routes qui l'enregistrent.
 */
export function canOpenDashboardPath(
  role: string | null | undefined,
  pathname: string,
  view?: string | null,
): boolean {
  if (!isServiceStaff(role)) return true;
  if (pathname.startsWith('/dashboard/floor-plan') && view === 'edit-plan') return false;
  return SERVICE_STAFF_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}
