import PricingPlans from '@/app/PricingPlans';
import PricingDetails from '@/app/PricingDetails';
import MarketingShell from '@/app/MarketingShell';
import { PRICING_METADATA } from '@/app/marketing-metadata';

export const metadata = PRICING_METADATA;

export default function PricingPage() {
  return (
    <MarketingShell>
      <main className="day-deep relative z-10 flex w-full flex-col items-center">
        <section className="day-paper w-full px-5 pb-10 pt-32 text-center sm:px-8 lg:pt-40">
          <div className="mx-auto max-w-3xl">
            <p className="day-hero-muted mb-5 text-sm font-semibold">Les formules Suppernote</p>
            <h1 className="text-balance font-brand text-[2.5rem] font-medium leading-[1.04] tracking-tight lg:text-[clamp(3.25rem,5vw,5rem)]">
              L’accueil commence avant le premier couvert.
            </h1>
            <p className="day-hero-muted mx-auto mt-6 max-w-[34em] leading-relaxed lg:text-lg">
              Le téléphone sonne pendant le service. Une réservation arrive du web ou se prend en
              salle. Suppernote les réunit dans votre planning pour que l’équipe retrouve les bonnes
              informations au bon moment.
            </p>
          </div>
        </section>

        {/* ---- CARDS ---- */}
        <section
          className="relative z-[2] mx-auto max-w-[1180px] px-5 pb-28 md:px-8 md:pb-8 md:-mt-7"
          aria-label="Formules et facturation"
        >
          {/* Ambient glow behind cards */}
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/3 h-[600px] w-[900px] rounded-full -z-10"
            style={{
              background:
                'radial-gradient(circle, hsl(var(--pricing-accent) / 0.18), transparent 70%)',
              filter: 'blur(80px)',
            }}
          />
          <div className="flex flex-col items-center pb-8 pt-4 md:pb-10 md:pt-10">
            <PricingPlans haptic showComparison />
          </div>
        </section>

        <PricingDetails />
      </main>
    </MarketingShell>
  );
}
