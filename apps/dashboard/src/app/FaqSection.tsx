'use client';

import { useState } from 'react';
import { ArrowRight, ChevronDown, MessageCircle } from 'lucide-react';
import { FAQS } from '@/app/constants';

export default function FaqSection() {
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(null);

  const toggleFaq = (index: number) => {
    setOpenFaqIndex(openFaqIndex === index ? null : index);
  };

  return (
    <section
      id="faq"
      className="relative flex w-full scroll-mt-24 flex-col items-center justify-center overflow-hidden px-4 py-10 sm:px-6 lg:px-10"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_18%,rgba(255,255,255,0.08),transparent_28rem)]" />
      <div className="text-center max-w-lg mb-8 sm:mb-10 px-2">
        <h2 className="font-brand text-[2.5rem] font-medium leading-[1.04] tracking-tight lg:text-[clamp(2.75rem,4.8vw,4.5rem)]">
          Foire aux questions
        </h2>
        <p className="mt-2 text-xs sm:text-sm text-white/50 leading-relaxed font-sans">
          Tout ce que vous devez savoir pour déployer Suppernote dans votre établissement.
        </p>
      </div>

      <div className="relative z-10 mt-4 flex w-full max-w-4xl flex-col gap-3 px-2 sm:mt-6 sm:gap-4 sm:px-0">
        {FAQS.map((faq, idx) => (
          <div
            key={idx}
            className="glass-card rounded-2xl border border-white/5 overflow-hidden transition-all duration-300 hover:border-white/10"
          >
            <button
              onClick={() => toggleFaq(idx)}
              className="w-full px-5 sm:px-6 py-4 sm:py-5 flex items-center justify-between text-left focus:outline-none transition-colors duration-200 hover:bg-white/[0.02] min-h-[56px]"
            >
              <span className="text-sm sm:text-base font-semibold text-white font-sans pr-4">
                {faq.question}
              </span>
              <ChevronDown
                size={16}
                className={`text-white/40 transition-transform duration-300 flex-shrink-0 ${
                  openFaqIndex === idx ? 'rotate-180 text-pricing-accent' : 'rotate-0'
                }`}
              />
            </button>

            <div
              className={`transition-all duration-300 ease-in-out overflow-hidden ${
                openFaqIndex === idx
                  ? 'max-h-[320px] sm:max-h-[260px] border-t border-white/5 overflow-y-auto'
                  : 'max-h-0'
              }`}
            >
              <p className="px-5 sm:px-6 py-4 sm:py-5 text-sm sm:text-sm text-white/50 leading-relaxed font-sans bg-white/[0.01]">
                {faq.answer}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="relative z-10 mt-10 flex w-full max-w-4xl flex-col items-start gap-6 rounded-[2rem] border border-dashed border-white/15 bg-white/[0.03] p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
        <div className="flex items-center gap-5">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-white text-black sm:h-16 sm:w-16">
            <MessageCircle size={25} aria-hidden="true" strokeWidth={1.8} />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-white sm:text-base">
              Vous avez encore une question ?
            </h3>
            <p className="mt-1 text-xs text-white/55 sm:text-sm">
              Écrivez-nous, nous serons ravis d’échanger avec vous.
            </p>
          </div>
        </div>
        <a
          href="mailto:hello@suppernote.com?subject=Question%20sur%20Suppernote"
          className="inline-flex min-h-12 w-full items-center justify-center gap-3 rounded-full bg-white px-6 py-3 text-sm font-semibold text-black transition-all duration-200 sm:text-base hover:-translate-y-0.5 hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 sm:w-auto"
        >
          Poser une question
          <ArrowRight size={18} aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}
