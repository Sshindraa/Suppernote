import {
  Award,
  BarChart3,
  CalendarCheck,
  ClipboardList,
  Code,
  Gift,
  Receipt,
  HeartHandshake,
  Megaphone,
  PhoneCall,
  Radio,
  Share2,
  Sparkles,
  Star,
  Ticket,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { canOpenDashboardPath } from '@/features/team/roles';

// Clés du namespace `nav` des messages : libellés des sections et des entrées.
export type NavKey =
  | 'overview'
  | 'service'
  | 'customers'
  | 'growth'
  | 'offers'
  | 'channels'
  | 'reservations'
  | 'briefing'
  | 'calls'
  | 'floorPlan'
  | 'loyalty'
  | 'reactivation'
  | 'caisse'
  | 'marketing'
  | 'reputation'
  | 'experiences'
  | 'events'
  | 'giftCards'
  | 'widget'
  | 'connect'
  | 'distribution'
  | 'agentic';

export type NavSectionId =
  | 'overview'
  | 'service'
  | 'caisse'
  | 'clients'
  | 'marketing'
  | 'offers'
  | 'channels';

export type NavEntry = {
  href: string;
  key: NavKey;
  icon: LucideIcon;
  // Sélecteur Copilot / Salle : la barre latérale seule l'affiche, ni onglets ni menu Plus.
  spaceSwitch?: boolean;
  /** Shown only when the server grants this capability (fail closed while unknown). */
  capability?: 'pos.connect';
};

export type NavSection = {
  id: NavSectionId;
  labelKey: NavKey;
  icon: LucideIcon;
  entries: NavEntry[];
};

/** Sections without the entries this restaurant has no capability for; empty sections disappear. */
export function visibleNavSections(
  sections: NavSection[],
  capabilities: Record<string, boolean>,
): NavSection[] {
  return sections
    .map((section) => ({
      ...section,
      entries: section.entries.filter(
        (entry) => !entry.capability || capabilities[entry.capability] === true,
      ),
    }))
    .filter((section) => section.entries.length > 0);
}

export const navSections: NavSection[] = [
  {
    id: 'overview',
    labelKey: 'overview',
    icon: BarChart3,
    entries: [{ href: '/dashboard', key: 'overview', icon: BarChart3 }],
  },
  {
    id: 'service',
    labelKey: 'service',
    icon: PhoneCall,
    entries: [
      { href: '/dashboard/reservations', key: 'reservations', icon: CalendarCheck },
      { href: '/dashboard/briefing', key: 'briefing', icon: ClipboardList },
      { href: '/dashboard/calls', key: 'calls', icon: PhoneCall },
      {
        href: '/dashboard/floor-plan?view=service-live',
        key: 'floorPlan',
        icon: Radio,
        spaceSwitch: true,
      },
    ],
  },
  {
    id: 'caisse',
    labelKey: 'caisse',
    icon: Receipt,
    // Own section: the tab bar of Service must not show a tab the restaurant cannot open.
    entries: [
      { href: '/dashboard/caisse', key: 'caisse', icon: Receipt, capability: 'pos.connect' },
    ],
  },
  {
    id: 'clients',
    labelKey: 'customers',
    icon: Users,
    entries: [
      { href: '/dashboard/customers', key: 'customers', icon: Users },
      { href: '/dashboard/loyalty', key: 'loyalty', icon: Award },
      { href: '/dashboard/reactivation', key: 'reactivation', icon: HeartHandshake },
    ],
  },
  {
    id: 'marketing',
    labelKey: 'growth',
    icon: Megaphone,
    entries: [
      { href: '/dashboard/marketing', key: 'marketing', icon: Megaphone },
      { href: '/dashboard/reputation', key: 'reputation', icon: Star },
    ],
  },
  {
    id: 'offers',
    labelKey: 'offers',
    icon: Ticket,
    entries: [
      { href: '/dashboard/experiences', key: 'experiences', icon: CalendarCheck },
      { href: '/dashboard/events', key: 'events', icon: Ticket },
      { href: '/dashboard/gift-cards', key: 'giftCards', icon: Gift },
    ],
  },
  {
    id: 'channels',
    labelKey: 'channels',
    icon: Share2,
    entries: [
      { href: '/dashboard/widget', key: 'widget', icon: Code },
      { href: '/dashboard/connect', key: 'connect', icon: Zap },
      { href: '/dashboard/distribution', key: 'distribution', icon: Share2 },
      { href: '/dashboard/agentic', key: 'agentic', icon: Sparkles },
    ],
  },
];

// Même règle partout : la page elle-même ou une sous-page. Cartes cadeaux couvre aussi les packs.
export function isNavEntryActive(pathname: string, entry: NavEntry) {
  if (entry.key === 'giftCards') return pathname.startsWith('/dashboard/gift-card');
  const path = entry.href.split('?')[0];
  return pathname === path || (path !== '/dashboard' && pathname.startsWith(`${path}/`));
}

// Même garde que le layout : l'équipe de service ne voit que ses pages.
export function canOpenNavEntry(entry: NavEntry, role: string | null | undefined) {
  const [path, query] = entry.href.split('?');
  return canOpenDashboardPath(role, path, new URLSearchParams(query).get('view'));
}

// Section de la page courante. La Salle n'en a pas : elle n'a pas d'onglets.
export function findNavSection(pathname: string) {
  return navSections.find((section) =>
    section.entries.some((entry) => !entry.spaceSwitch && isNavEntryActive(pathname, entry)),
  );
}
