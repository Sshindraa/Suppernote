import Link from 'next/link';
import Image from 'next/image';
import { BRAND_SLOGAN } from '@suppernote/shared';
import localFont from 'next/font/local';
import PricingSection from '@/app/PricingSection';
import FaqSection from '@/app/FaqSection';
import MobileNav from '@/components/MobileNav';
import AuthCTA from '@/components/AuthCTA';
import FeaturesMenu from '@/app/FeaturesMenu';
import HeroServiceDay from '@/app/HeroServiceDay';
import ServiceDaySection from '@/app/ServiceDaySection';
import HomeSmoothScroll from '@/app/HomeSmoothScroll';
import SiteFooter from '@/components/footer/SiteFooter';
import { HOME_METADATA } from '@/app/marketing-metadata';
import './brand-palette.css';

export const metadata = HOME_METADATA;

// Keep production builds independent from the Google Fonts network endpoint.
const outfit = localFont({
  src: './fonts/outfit-latin.woff2',
  display: 'swap',
  variable: '--font-display',
  weight: '300 900',
});

// Police de marque : réservée au mot-symbole et au titre principal.
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

export default function HomePage() {
  return (
    <div
      className={`brand-palette day-home relative min-h-screen w-full bg-background text-foreground flex flex-col justify-between items-center font-sans antialiased ${outfit.variable} ${fraunces.variable} ${jakarta.variable}`}
    >
      <HomeSmoothScroll />
      <div
        aria-hidden="true"
        className="day-header-glass pointer-events-none fixed inset-x-0 top-0 z-40 h-24 backdrop-blur-md [mask-image:linear-gradient(to_bottom,black_25%,transparent)]"
      />

      <Link
        href="/"
        className="fixed left-4 top-5 z-50 hidden h-[52px] md:flex items-center gap-2 rounded-full transition-all duration-200 hover:opacity-80 sm:left-6"
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
            className="flex items-center gap-1.5 md:hidden pl-1 hover:opacity-80 transition-opacity"
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
          <span className="h-4 w-px bg-current opacity-15 md:hidden mx-1" />

          <div className="hidden items-center gap-1 md:flex">
            <FeaturesMenu />
            {[
              { label: 'La journée', href: '/#services' },
              { label: 'Tarifs', href: '/pricing' },
            ].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-full px-3 py-1.5 text-sm transition-all duration-200 hover:bg-foreground/5"
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

      {/* Main Content */}
      <main className="relative z-10 flex w-full flex-col items-center">
        {/* HERO — rendu côté serveur ; la journée animée suit sur son propre écran */}
        <section className="day-paper relative flex min-h-[88svh] w-full flex-col justify-center overflow-hidden px-5 pb-10 pt-28 text-center [word-spacing:0.06em] sm:px-8 lg:px-14 lg:pb-12 lg:pt-32">
          {/* Une table vue du dessus, coupée par le coin : la signature de la page. */}
          <svg
            aria-hidden="true"
            viewBox="0 0 520 520"
            fill="none"
            className="pointer-events-none absolute -bottom-[13rem] -right-[9rem] hidden h-[40rem] w-[40rem] md:block"
          >
            <circle cx="260" cy="260" r="150" className="day-hero-emblem" />
            <path d="M225 80h70M225 440h70M440 225v70" className="day-hero-emblem" />
            <path d="M80 225v70" className="day-hero-emblem day-hero-emblem-lit" />
          </svg>
          <div className="relative mx-auto flex w-full max-w-[90rem] flex-col items-center">
            <h1 className="max-w-[14em] text-balance font-brand text-[2.625rem] font-medium leading-[1.02] tracking-tight [word-spacing:0] lg:text-[clamp(3.5rem,6.2vw,6.75rem)]">
              Le chef de rang digital de votre restaurant
            </h1>
            <p className="day-hero-muted mt-6 max-w-[34em] leading-relaxed lg:text-lg">
              {BRAND_SLOGAN}
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
              <Link
                href="/demo"
                className="day-cta inline-flex min-h-[3.25rem] items-center justify-center rounded-sm px-6 text-base font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98]"
              >
                Demander une démonstration
              </Link>
              <Link
                href="/register"
                className="inline-flex min-h-11 items-center text-[0.9375rem] underline underline-offset-4 transition-all duration-200 hover:opacity-80"
              >
                ou essayer 14 jours
              </Link>
            </div>
          </div>
          <div
            aria-hidden="true"
            className="day-hero-fade pointer-events-none absolute inset-x-0 bottom-0 h-40"
          />
        </section>

        <HeroServiceDay />

        <ServiceDaySection />

        <div className="day-deep relative w-full overflow-visible">
          <div className="relative mx-auto flex w-full flex-col items-center">
            {/* PRICING — client component for toggle interactivity */}
            <PricingSection />

            {/* FAQ — client component for accordion */}
            <FaqSection />
          </div>
        </div>
      </main>

      {/* FOOTER — fully static, server-rendered */}
      <SiteFooter />
    </div>
  );
}
