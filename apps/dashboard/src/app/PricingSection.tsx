import PricingPlans from '@/app/PricingPlans';

export default function PricingSection() {
  return (
    <section
      id="tarifs"
      className="relative flex w-full scroll-mt-24 items-center overflow-hidden px-4 pb-10 pt-16 sm:px-6 lg:px-10"
    >
      {/* Ambient glow behind cards */}
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/3 h-[600px] w-[900px] rounded-full"
        style={{
          background: 'radial-gradient(circle, hsl(var(--pricing-accent) / 0.18), transparent 70%)',
          filter: 'blur(80px)',
        }}
      />

      <div className="relative z-10 mx-auto flex w-full flex-col items-center">
        {/* Mini Hero */}
        <div className="text-center mb-8 relative px-2">
          <h2 className="text-center font-brand text-[2.5rem] font-medium leading-[1.04] tracking-tight lg:text-[clamp(2.75rem,4.8vw,4.5rem)]">
            Tarifs
          </h2>
        </div>

        <PricingPlans />
      </div>
    </section>
  );
}
