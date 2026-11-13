'use client';

import { useEffect, useState } from 'react';

const LOGIN_HEADLINES = ['Un appel.', 'Une réservation.', 'Un service.'];

export default function LoginHeadline() {
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 768px)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: ReturnType<typeof setInterval> | undefined;

    const syncAnimation = () => {
      clearInterval(timer);
      if (desktop.matches && !reducedMotion.matches) {
        timer = setInterval(() => {
          setActiveIndex((current) => (current + 1) % LOGIN_HEADLINES.length);
        }, 3200);
      }
    };

    syncAnimation();
    desktop.addEventListener('change', syncAnimation);
    reducedMotion.addEventListener('change', syncAnimation);

    return () => {
      clearInterval(timer);
      desktop.removeEventListener('change', syncAnimation);
      reducedMotion.removeEventListener('change', syncAnimation);
    };
  }, []);

  return (
    <h2 className="suppernote-login__story-heading">
      <span
        key={LOGIN_HEADLINES[activeIndex]}
        className="suppernote-login__rotating-word"
        aria-live="off"
      >
        {LOGIN_HEADLINES[activeIndex]}
      </span>
      <span className="suppernote-login__story-highlight">Suppernote s’en occupe pour vous.</span>
    </h2>
  );
}
