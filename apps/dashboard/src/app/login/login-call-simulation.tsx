'use client';

import { useEffect, useState } from 'react';
import { CalendarCheck, Check, Pause, PhoneCall, Play } from 'lucide-react';

const MESSAGES = [
  { speaker: 'Client', text: 'Bonjour, une table pour quatre ce soir ?' },
  { speaker: 'Suppernote', text: 'Avec plaisir. Je peux vous proposer 20 h. Cela vous convient ?' },
  { speaker: 'Client', text: 'Oui, 20 h, c’est parfait.' },
  { speaker: 'Suppernote', text: 'Votre table pour quatre est réservée. À ce soir !' },
];

export default function LoginCallSimulation() {
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 768px)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(timer);
      if (reducedMotion.matches) {
        setStep(4);
      } else if (desktop.matches && !paused) {
        timer = setInterval(() => setStep((current) => (current + 1) % 7), 2600);
      }
    };
    sync();
    desktop.addEventListener('change', sync);
    reducedMotion.addEventListener('change', sync);
    return () => {
      clearInterval(timer);
      desktop.removeEventListener('change', sync);
      reducedMotion.removeEventListener('change', sync);
    };
  }, [paused]);

  const confirmed = step >= MESSAGES.length;
  const visibleMessages = MESSAGES.slice(0, Math.min(step + 1, MESSAGES.length)).slice(-2);

  return (
    <div
      className="suppernote-login-call"
      role="group"
      aria-label="Simulation d’un appel de réservation"
    >
      <div className="suppernote-login-call__header">
        <span className="suppernote-login-call__phone">
          <PhoneCall size={16} aria-hidden="true" />
        </span>
        <div className="suppernote-login-call__identity">
          <strong>Assistant Suppernote</strong>
          <span>{confirmed ? 'Réservation confirmée' : 'Appel en cours'}</span>
        </div>
        <span className="suppernote-login-call__badge">Simulation</span>
        <button
          type="button"
          className="suppernote-login-call__pause"
          aria-label={paused ? 'Reprendre la simulation' : 'Mettre la simulation en pause'}
          onClick={() => setPaused((current) => !current)}
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
        </button>
      </div>
      <div className="suppernote-login-call__messages" aria-live="off">
        {visibleMessages.map((message) => (
          <div
            key={message.text}
            className="suppernote-login-call__message"
            data-speaker={message.speaker}
          >
            <span>{message.speaker}</span>
            <p>{message.text}</p>
          </div>
        ))}
      </div>
      <div className="suppernote-login-call__result" data-confirmed={confirmed}>
        {confirmed ? (
          <Check size={16} aria-hidden="true" />
        ) : (
          <CalendarCheck size={16} aria-hidden="true" />
        )}
        <div className="suppernote-login-call__summary">
          <strong>{confirmed ? '4 personnes · Ce soir à 20 h' : 'Une table se prépare…'}</strong>
          <span>Exemple fictif · aucun appel réel</span>
        </div>
        <div
          className="suppernote-login-call__wave"
          aria-hidden="true"
          data-paused={paused || confirmed}
        >
          {[0, 1, 2, 3, 4].map((bar) => (
            <i
              className="suppernote-login-call__bar"
              key={bar}
              style={{ animationDelay: `${bar * -0.18}s` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
