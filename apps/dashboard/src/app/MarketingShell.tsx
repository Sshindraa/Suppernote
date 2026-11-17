import Link from 'next/link';
import Image from 'next/image';
import localFont from 'next/font/local';
import MobileNav from '@/components/MobileNav';
import AuthCTA from '@/components/AuthCTA';
import FeaturesMenu from '@/app/FeaturesMenu';
import SiteFooter from '@/components/footer/SiteFooter';
import './brand-palette.css';

// Habillage unique des pages publiques (docs/architecture/marketing-site.md) : une page publique
// ne recrée jamais son menu, ses polices ni son pied de page. marketing-claims.test.ts le vérifie.
// `dark` : le site public reste bleu nuit même si le visiteur a choisi le thème clair du dashboard.

// Keep production builds independent from the Google Fonts network endpoint.
const outfit = localFont({
  src: './fonts/outfit-latin.woff2',
  display: 'swap',
  variable: '--font-display',
  weight: '300 900',
});

// Police de marque : réservée au mot-symbole et aux titres.
const fraunces = localFont({
  src: './fonts/fraunces-latin.woff2',
  display: 'swap',
  variable: '--font-brand',
  weight: '400 700',
});

const jakarta = localFont({
  src: './fonts/plus-jakarta-sans-latin.woff2',
  display: 'swap',
  variable: '--font-sans',
  weight: '300 800',
});

const NAV_LINKS = [
  { label: 'La journée', href: '/#services' },
  { label: 'Tarifs', href: '/pricing' },
];

export default function MarketingShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={`dark brand-palette day-home relative min-h-screen w-full bg-background text-foreground flex flex-col justify-between items-center font-sans antialiased ${outfit.variable} ${fraunces.variable} ${jakarta.variable}`}
    >
      <div
        aria-hidden="true"
        className="day-header-glass pointer-events-none fixed inset-x-0 top-0 z-40 h-24 backdrop-blur-md [mask-image:linear-gradient(to_bottom,black_25%,transparent)]"
      />

      <Link
        href="/"
        className="fixed left-4 top-5 z-50 hidden h-[52px] lg:flex items-center gap-2 rounded-full transition-all duration-200 hover:opacity-80 sm:left-6"
      >
        <Image
          src="/logo-nav.png"
          alt=""
          width={36}
          height={36}
          className="h-9 w-9 brightness-0 invert sm:h-10 sm:w-10"
          priority
        />
        <span className="font-brand text-2xl font-medium tracking-tight text-[hsl(var(--day-ink))]">
          Suppernote
        </span>
      </Link>

      {/* Floating navbar */}
      <div className="fixed left-1/2 top-5 z-50 -translate-x-1/2 flex items-center">
        <nav className="day-nav flex items-center gap-2 rounded-full border px-2 py-1.5 backdrop-blur-md">
          {/* Logo inside navbar on mobile */}
          <Link
            href="/"
            className="flex items-center gap-1.5 lg:hidden pl-1 hover:opacity-80 transition-opacity"
          >
            <Image
              src="/logo-nav.png"
              alt=""
              width={28}
              height={28}
              className="h-7 w-7 brightness-0 invert"
            />
            <span className="font-brand text-sm">Suppernote</span>
          </Link>
          <span className="h-4 w-px bg-current opacity-15 lg:hidden mx-1" />

          <div className="hidden items-center gap-1 md:flex">
            <FeaturesMenu />
            {NAV_LINKS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="whitespace-nowrap rounded-full px-3 py-1.5 text-sm transition-all duration-200 hover:bg-foreground/5"
              >
                {item.label}
              </Link>
            ))}
          </div>
          <AuthCTA variant="nav" />

          {/* Mobile hamburger inside the navbar */}
          <MobileNav buttonStyle="flat" />
        </nav>
      </div>

      {children}

      <SiteFooter />
    </div>
  );
}
