import Image from 'next/image';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';

export default function ServiceDaySection() {
  return (
    <div className="w-full">
      <section
        aria-label="Le service tient dans une main"
        className="day-tablet w-full px-5 pt-20 sm:px-8 lg:pt-28"
      >
        <div className="mx-auto flex max-w-[78rem] flex-col items-center">
          <h2 className="max-w-[14em] text-balance text-center font-brand text-[2.5rem] font-medium leading-[1.04] tracking-tight lg:text-[clamp(2.75rem,4.8vw,4.5rem)]">
            Le service tient dans une main.
          </h2>
          <p className="day-muted mt-5 text-center text-base leading-relaxed lg:text-lg">
            Réservations, couverts et allergies en un coup d’œil.
          </p>
          <div className="mt-6 flex w-full justify-center overflow-hidden">
            <img
              src="/marketing/journee-briefing-tablette.webp"
              alt="Une tablette tenue en main affiche le briefing du service : réservations, couverts, allergies, habitués et risque d’absence."
              width={1448}
              height={1086}
              loading="lazy"
              decoding="async"
              className="block h-auto w-full max-w-[77.5rem] [mask-image:linear-gradient(to_bottom,black_90%,transparent)] max-sm:w-[130%] max-sm:max-w-none max-sm:shrink-0"
            />
          </div>
        </div>
      </section>
      <div aria-hidden="true" className="day-tablet-to-night h-24 w-full lg:h-40" />

      <section
        id="equipe"
        aria-labelledby="equipe-title"
        className="day-team w-full scroll-mt-24 overflow-hidden px-5 py-16 sm:px-8 lg:py-24"
      >
        <div className="mx-auto max-w-[78rem]">
          <p className="max-w-3xl text-lg leading-relaxed lg:text-xl">
            Les réservations, les informations clients et le briefing réunis pour que votre équipe
            se concentre sur l’accueil.
          </p>
          <div className="mt-8 grid gap-8 md:grid-cols-3 lg:mt-10 lg:gap-12">
            <div className="relative aspect-[4/5] overflow-hidden rounded-3xl sm:aspect-[3/2] md:col-span-2">
              <Image
                src="/marketing/salle-en-service.webp"
                alt="Une salle de brasserie en plein service : serveurs au travail, clients attablés."
                fill
                sizes="(min-width: 1320px) 800px, (min-width: 768px) 63vw, 100vw"
                className="object-cover"
              />
              <div className="absolute bottom-[8%] right-0 flex w-[90%] flex-col items-end gap-4 sm:w-[75%]">
                <div className="w-[54%] rounded-l-2xl bg-background/70 p-3 text-foreground backdrop-blur-xl sm:p-5 md:p-3 lg:p-7">
                  <p className="font-display text-3xl font-medium leading-none sm:text-5xl md:text-4xl lg:text-6xl">
                    1
                  </p>
                  <p className="mt-2 text-xs sm:text-sm lg:text-base">carnet pour toute l’équipe</p>
                </div>
                <div className="flex w-full items-center gap-3 rounded-l-2xl bg-primary px-4 py-4 text-primary-foreground sm:gap-4 sm:px-6 sm:py-6 md:px-4 md:py-4 lg:px-8 lg:py-7">
                  <div aria-hidden="true" className="flex shrink-0 -space-x-2">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-primary-foreground bg-primary-foreground text-xs font-semibold text-primary sm:h-10 sm:w-10">
                      S
                    </span>
                    <span className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-primary-foreground bg-primary-foreground/90 text-xs font-semibold text-primary sm:h-10 sm:w-10">
                      A
                    </span>
                    <span className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-primary-foreground bg-primary-foreground/80 text-xs font-semibold text-primary sm:h-10 sm:w-10">
                      C
                    </span>
                  </div>
                  <div>
                    <p className="text-sm font-semibold sm:text-base lg:text-lg">
                      La même information
                    </p>
                    <p className="mt-1 text-xs sm:text-sm">Salle, accueil, cuisine</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="min-w-0">
              <figure>
                <div className="relative aspect-[3/2] overflow-hidden rounded-2xl bg-gradient-to-br from-primary to-primary/70">
                  <div className="absolute left-[15%] right-[-5%] top-[20%] rounded-t-2xl bg-background p-4 lg:p-6">
                    <p className="text-xs text-muted-foreground lg:text-sm">Service du midi</p>
                    <p className="mt-1 font-display text-2xl font-medium lg:text-3xl">
                      28 couverts
                    </p>
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 280 100"
                      className="mt-3 w-full text-primary lg:mt-5"
                      fill="currentColor"
                    >
                      <g opacity="0.16">
                        <rect x="0" y="35" width="16" height="65" rx="8" />
                        <rect x="28" y="70" width="16" height="30" rx="8" />
                        <rect x="56" y="50" width="16" height="50" rx="8" />
                        <rect x="84" y="25" width="16" height="75" rx="8" />
                        <rect x="140" y="5" width="16" height="95" rx="8" />
                        <rect x="168" y="60" width="16" height="40" rx="8" />
                        <rect x="196" y="35" width="16" height="65" rx="8" />
                        <rect x="224" y="50" width="16" height="50" rx="8" />
                        <rect x="252" y="20" width="16" height="80" rx="8" />
                      </g>
                      <rect
                        x="112"
                        y="15"
                        width="16"
                        height="85"
                        rx="8"
                        className="day-hero-lit-text"
                      />
                    </svg>
                  </div>
                </div>
                <figcaption className="mt-2 text-xs text-muted-foreground">
                  Illustration · données de démonstration
                </figcaption>
              </figure>
              <h2
                id="equipe-title"
                className="mt-6 text-balance font-brand text-3xl font-medium leading-[1.15] tracking-tight lg:text-4xl"
              >
                Plus de présence en salle. Moins de dispersion.
              </h2>
              <p className="mt-4 text-base leading-relaxed text-muted-foreground lg:text-lg">
                Un même point de repère pour préparer le service, partager les attentions et
                accueillir chaque table.
              </p>
              <Link
                href="/demo"
                className="group mt-4 inline-flex min-h-11 items-center gap-2 rounded-sm text-sm font-medium text-primary transition-all duration-200 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:text-base"
              >
                Voir Suppernote en démonstration
                <ArrowUpRight
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 transition-all duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 motion-reduce:transform-none"
                />
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="day-night day-halo-night flex min-h-[78svh] w-full flex-col items-center justify-center px-5 pb-6 pt-16 text-center sm:px-8">
        <h2 className="font-brand text-6xl font-medium leading-none tracking-tight sm:text-8xl">
          Demain, 11 h.
        </h2>
        <p className="day-muted mx-auto mt-6 max-w-xl text-balance text-lg leading-relaxed">
          Un nouveau service commence. Voyez ce que Suppernote peut faire pour le vôtre.
        </p>
        <div
          aria-hidden="true"
          className="mt-16 h-20 w-px bg-gradient-to-b from-white/40 to-transparent lg:h-28"
        />
      </section>
    </div>
  );
}
