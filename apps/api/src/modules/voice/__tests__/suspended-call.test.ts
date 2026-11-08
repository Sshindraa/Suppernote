import { describe, expect, it, vi } from 'vitest';
import {
  answerSuspendedCall,
  busyCallMessage,
  handleSuspendedCallEvent,
  isSuspendedCall,
  suspendedCallMessage,
  type SuspendedCallActions,
} from '../suspended-call';

function actions() {
  return {
    answer: vi.fn<SuspendedCallActions['answer']>().mockResolvedValue(undefined),
    speak: vi.fn<SuspendedCallActions['speak']>().mockResolvedValue(undefined),
    hangup: vi.fn<SuspendedCallActions['hangup']>().mockResolvedValue(undefined),
  };
}

describe('appel d’un restaurant suspendu', () => {
  it('annonce le restaurant et demande de rappeler', () => {
    expect(suspendedCallMessage('Le Bistrot')).toBe(
      'Bonjour, vous êtes bien chez Le Bistrot. Nous ne pouvons pas prendre votre appel pour le moment. Merci de rappeler un peu plus tard. Au revoir.',
    );
    expect(suspendedCallMessage(null)).toMatch(/^Bonjour\. Nous ne pouvons pas/);
  });

  it('décroche, lit le message puis raccroche', async () => {
    const a = actions();
    await answerSuspendedCall('cc-1', 'Le Bistrot', a);
    const state = a.answer.mock.calls[0][1] as string;
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
    expect(isSuspendedCall(decoded)).toBe(true);

    expect(await handleSuspendedCallEvent('call.answered', 'cc-1', decoded, a)).toBe('spoken');
    expect(a.speak).toHaveBeenCalledWith(
      'cc-1',
      expect.stringContaining('vous êtes bien chez Le Bistrot'),
      expect.any(String),
    );
    expect(await handleSuspendedCallEvent('call.speak.ended', 'cc-1', decoded, a)).toBe('hung_up');
    expect(a.hangup).toHaveBeenCalledWith('cc-1');
    expect(await handleSuspendedCallEvent('call.hangup', 'cc-1', decoded, a)).toBe('ignored');
  });

  it('refuse un appel au plafond avec un message d’occupation, puis raccroche', async () => {
    const a = actions();
    await answerSuspendedCall('cc-2', 'Le Bistrot', a, { busy: true });
    const decoded = JSON.parse(
      Buffer.from(a.answer.mock.calls[0][1] as string, 'base64').toString('utf8'),
    );
    expect(isSuspendedCall(decoded)).toBe(true);
    expect(decoded.busy).toBe(true);

    await handleSuspendedCallEvent('call.answered', 'cc-2', decoded, a);
    expect(a.speak).toHaveBeenCalledWith('cc-2', busyCallMessage('Le Bistrot'), expect.any(String));
    expect(busyCallMessage('Le Bistrot')).toContain('lignes sont occupées');
    expect(await handleSuspendedCallEvent('call.speak.ended', 'cc-2', decoded, a)).toBe('hung_up');
  });
});
