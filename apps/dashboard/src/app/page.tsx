import Link from 'next/link';
import { BRAND_SLOGAN } from '@suppernote/shared';
import PricingSection from '@/app/PricingSection';
import FaqSection from '@/app/FaqSection';
import HeroServiceDay from '@/app/HeroServiceDay';
import ServiceDaySection from '@/app/ServiceDaySection';
import HomeSmoothScroll from '@/app/HomeSmoothScroll';
import MarketingShell from '@/app/MarketingShell';
import { HOME_METADATA } from '@/app/marketing-metadata';

export const metadata = HOME_METADATA;

export default function HomePage() {
  return (
    <MarketingShell>
      <HomeSmoothScroll />

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
    </MarketingShell>
  );
}
