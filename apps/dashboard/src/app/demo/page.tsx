import { Mail } from 'lucide-react';
import DemoRequestForm from '@/app/demo/DemoRequestForm';
import MarketingShell from '@/app/MarketingShell';
import { DEMO_METADATA } from '@/app/marketing-metadata';

export const metadata = DEMO_METADATA;

export default function DemoPage() {
  return (
    <MarketingShell>
      <main className="day-paper w-full">
        <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-4 pb-16 pt-32 sm:px-6">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Démonstration
          </p>
          <h1 className="mt-3 font-brand text-4xl font-medium tracking-tight md:text-5xl">
            Demander une démonstration
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Présentez-nous votre restaurant : nous vous montrons Suppernote sur votre situation.
            Aucun compte n’est nécessaire pour demander une démonstration.
          </p>
          <div className="mt-8 rounded-2xl border border-border bg-card p-6 sm:p-8">
            <DemoRequestForm />
          </div>
          <p className="mt-6 text-center text-sm leading-6 text-muted-foreground">
            Vous préférez nous écrire ?{' '}
            <a
              href="mailto:hello@suppernote.com"
              className="inline-flex min-h-[44px] items-center gap-1.5 text-foreground underline underline-offset-4 transition-all duration-200 hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Mail size={14} aria-hidden="true" />
              hello@suppernote.com
            </a>
          </p>
        </div>
      </main>
    </MarketingShell>
  );
}
