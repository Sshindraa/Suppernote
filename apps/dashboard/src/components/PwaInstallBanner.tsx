'use client';

import { useState, useEffect } from 'react';
import { Share, Plus, X, Sparkles } from 'lucide-react';
import { triggerHaptic } from '@/lib/utils';
import { usePathname } from 'next/navigation';

export default function PwaInstallBanner() {
  const pathname = usePathname();
  const [show, setShow] = useState(false);

  useEffect(() => {
    // L'invite est un onboarding du cockpit. Elle ne doit pas recouvrir une
    // réservation, une fiche client ou une action de service sur les écrans
    // secondaires ; le restaurateur peut revenir au cockpit pour l'installer.
    if (pathname !== '/dashboard') {
      setShow(false);
      return;
    }
    // Check if running on client-side
    if (typeof window === 'undefined') return;

    // Detect iOS — MSStream is an old IE proprietary property, not in TS DOM types.
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) &&
      !(window as unknown as { MSStream?: unknown }).MSStream;

    // Detect if app is already running in standalone mode (PWA installed or the iOS app shell)
    const isStandalone =
      (window.navigator as unknown as { standalone?: boolean }).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches ||
      navigator.userAgent.includes('SuppernoteIOS') ||
      navigator.userAgent.includes('SokarIOS');

    // Check localStorage to respect dismissal
    const isDismissed =
      (localStorage.getItem('suppernote_pwa_dismissed') ??
        localStorage.getItem('sokar_pwa_dismissed')) === 'true';

    // Show banner only if on iOS, NOT installed already, and NOT dismissed
    if (isIOS && !isStandalone && !isDismissed) {
      // Delay showing for premium feel (1.5 seconds after page load)
      const timer = setTimeout(() => {
        setShow(true);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [pathname]);

  const handleDismiss = () => {
    triggerHaptic(10);
    setShow(false);
    localStorage.setItem('suppernote_pwa_dismissed', 'true');
  };

  if (!show) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 z-[90] md:left-auto md:right-4 md:w-[380px] animate-in slide-in-from-bottom-5 fade-in duration-300">
      <div className="rounded-2xl border border-white/10 bg-black/80 p-5 shadow-2xl backdrop-blur-xl relative overflow-hidden">
        {/* Ambient background glow */}
        <div className="pointer-events-none absolute -right-10 -bottom-10 h-28 w-28 rounded-full bg-pricing-accent/10 blur-2xl" />

        {/* Close Button */}
        <button
          onClick={handleDismiss}
          className="absolute top-3 right-3 h-8 w-8 rounded-full border border-white/5 bg-white/5 flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-colors"
          aria-label="Dismiss banner"
        >
          <X size={15} />
        </button>

        {/* Header */}
        <div className="flex items-center gap-2 pr-6">
          <span className="flex h-8 w-8 items-center justify-center rounded-full border border-pricing-accent/20 bg-pricing-accent/10 text-pricing-accent">
            <Sparkles size={14} className="animate-pulse" />
          </span>
          <div>
            <h4 className="text-sm font-bold text-white tracking-wide">Installer Suppernote AI</h4>
            <p className="text-[11px] text-white/40">
              Ajoutez l&apos;app sur votre écran d&apos;accueil
            </p>
          </div>
        </div>

        {/* Steps */}
        <div className="mt-4 space-y-3 border-t border-white/5 pt-3">
          <div className="flex items-center gap-3 text-xs text-white/70">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 font-bold text-[10px] text-pricing-accent">
              1
            </span>
            <p className="leading-snug">
              Appuyez sur le bouton de partage{' '}
              <span className="inline-flex items-center align-middle mx-0.5 px-1 py-0.5 rounded bg-white/10 text-white">
                <Share size={12} />
              </span>{' '}
              en bas de Safari.
            </p>
          </div>

          <div className="flex items-center gap-3 text-xs text-white/70">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 font-bold text-[10px] text-pricing-accent">
              2
            </span>
            <p className="leading-snug">
              Sélectionnez l&apos;option{' '}
              <span className="inline-flex items-center align-middle mx-0.5 px-1 py-0.5 rounded bg-white/10 text-white font-medium">
                Sur l&apos;écran d&apos;accueil <Plus size={12} className="ml-1" />
              </span>
              .
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
