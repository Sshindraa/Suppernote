import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveCallPanel } from './LiveCallPanel';

const mocks = vi.hoisted(() => ({
  instances: [] as Array<Record<string, ReturnType<typeof vi.fn> | unknown>>,
  acquireMicrophone: vi.fn(),
  connect: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ useApi: () => ({ siteId: 'site-1' }) }));
vi.mock('../live-call/live-call-session', () => {
  class LiveCallError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  class LiveCallSession {
    handlers: { onEnded: (reason: string) => void; onAgentAudio?: () => void };
    prepare = vi.fn();
    hangup = vi.fn(() => this.handlers.onEnded('hangup'));
    setMuted = vi.fn();
    dispose = vi.fn();
    acquireMicrophone = mocks.acquireMicrophone;
    connect = mocks.connect;
    constructor(handlers: LiveCallSession['handlers']) {
      this.handlers = handlers;
      mocks.instances.push(this as never);
    }
  }
  return { LiveCallError, LiveCallSession };
});

import { LiveCallError } from '../live-call/live-call-session';

const session = () =>
  mocks.instances[mocks.instances.length - 1] as unknown as {
    prepare: ReturnType<typeof vi.fn>;
    hangup: ReturnType<typeof vi.fn>;
    setMuted: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    handlers: { onEnded: (reason: string) => void; onAgentAudio?: () => void };
  };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.instances.length = 0;
  mocks.acquireMicrophone.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue({ maxDurationSec: 180 });
  mocks.fetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ticket: 't', wsUrl: 'wss://api.test/voice/demo-stream/t' }),
  });
  vi.stubGlobal('fetch', mocks.fetch);
});

async function startCall(props: Partial<Parameters<typeof LiveCallPanel>[0]> = {}) {
  render(<LiveCallPanel {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Appeler Suppernote' }));
  await screen.findByRole('button', { name: 'Raccrocher' });
}

describe('LiveCallPanel', () => {
  it('propose d’appeler, sans rien démarrer avant le clic', () => {
    render(<LiveCallPanel />);
    expect(screen.getByRole('button', { name: 'Appeler Suppernote' })).toBeEnabled();
    expect(mocks.instances).toHaveLength(0);
  });

  it('enchaîne micro → sauvegarde → ticket → connexion, puis affiche l’appel en cours', async () => {
    const order: string[] = [];
    mocks.acquireMicrophone.mockImplementation(async () => void order.push('micro'));
    const beforeCall = vi.fn(async () => void order.push('sauvegarde'));
    mocks.fetch.mockImplementation(async () => {
      order.push('ticket');
      return { ok: true, status: 200, json: async () => ({ wsUrl: 'wss://api.test/x' }) };
    });
    mocks.connect.mockImplementation(async () => {
      order.push('connexion');
      return { maxDurationSec: 120 };
    });

    await startCall({ beforeCall });

    expect(order).toEqual(['micro', 'sauvegarde', 'ticket', 'connexion']);
    expect(session().prepare).toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith(
      '/api/proxy/restaurant/onboarding/live-demo',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Suppernote-Site-ID': 'site-1' }),
      }),
    );
    expect(mocks.connect).toHaveBeenCalledWith('wss://api.test/x');
    expect(screen.getByText(/En ligne · 0:00 \/ 2:00/)).toBeInTheDocument();
  });

  it('n’émet aucun ticket quand le micro est refusé', async () => {
    mocks.acquireMicrophone.mockRejectedValue(new LiveCallError('mic_denied', 'refusé'));
    const onUnavailable = vi.fn();
    render(<LiveCallPanel onUnavailable={onUnavailable} />);

    fireEvent.click(screen.getByRole('button', { name: 'Appeler Suppernote' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/micro est bloqué/);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(session().dispose).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Rappeler Suppernote' })).toBeEnabled();
  });

  it('n’appelle pas quand la sauvegarde de la personnalité échoue', async () => {
    const beforeCall = vi.fn().mockRejectedValue(new Error('Enregistrement indisponible'));
    render(<LiveCallPanel beforeCall={beforeCall} />);

    fireEvent.click(screen.getByRole('button', { name: 'Appeler Suppernote' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enregistrement indisponible');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('bascule sur l’aperçu pré-enregistré quand le service est indisponible (503)', async () => {
    mocks.fetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'Pas de fournisseur vocal.' }),
    });
    const onUnavailable = vi.fn();
    render(<LiveCallPanel onUnavailable={onUnavailable} />);

    fireEvent.click(screen.getByRole('button', { name: 'Appeler Suppernote' }));

    await waitFor(() => expect(onUnavailable).toHaveBeenCalledWith('Pas de fournisseur vocal.'));
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('explique la limite de débit (429) sans afficher un code technique', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    render(<LiveCallPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Appeler Suppernote' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Trop d’essais rapprochés/);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('affiche le message du plafond quotidien (429 avec code) tel que le serveur le donne', async () => {
    mocks.fetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        code: 'LIVE_DEMO_DAILY_LIMIT',
        error: 'Vous avez atteint le nombre d’appels d’essai pour aujourd’hui.',
      }),
    });
    render(<LiveCallPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Appeler Suppernote' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/appels d’essai pour aujourd’hui/);
  });

  it('explique un appel déjà en cours (busy)', async () => {
    mocks.connect.mockRejectedValue(new LiveCallError('busy', 'busy'));
    render(<LiveCallPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Appeler Suppernote' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/déjà en cours/);
  });

  it('coupe et réactive le micro', async () => {
    await startCall();
    const mute = screen.getByRole('button', { name: 'Couper le micro' });

    fireEvent.click(mute);
    expect(session().setMuted).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('button', { name: 'Réactiver le micro' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Réactiver le micro' }));
    expect(session().setMuted).toHaveBeenLastCalledWith(false);
  });

  it('raccrocher termine l’appel ; il compte comme essayé si l’assistant a parlé', async () => {
    const onCompleted = vi.fn();
    await startCall({ onCompleted });
    act(() => session().handlers.onAgentAudio?.());

    fireEvent.click(screen.getByRole('button', { name: 'Raccrocher' }));

    expect(session().hangup).toHaveBeenCalled();
    expect(await screen.findByText('Appel terminé')).toBeInTheDocument();
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Rappeler Suppernote' })).toBeEnabled();
  });

  it('ne valide pas l’essai si l’assistant n’a jamais parlé', async () => {
    const onCompleted = vi.fn();
    await startCall({ onCompleted });

    act(() => session().handlers.onEnded('network'));

    expect(await screen.findByRole('alert')).toHaveTextContent('La connexion a été interrompue.');
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it('raccroche à la fermeture du composant', async () => {
    const { unmount } = render(<LiveCallPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Appeler Suppernote' }));
    await screen.findByRole('button', { name: 'Raccrocher' });
    const current = session();

    // Changement de personnalité côté parent → nouvelle clé → démontage.
    unmount();

    expect(current.dispose).toHaveBeenCalled();
  });
});
