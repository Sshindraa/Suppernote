import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn(async (_payload: unknown) => ({ data: { id: 'msg_test_1' }, error: null }));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

import { sendEmail } from '../index';
import { waitForResendSlot } from '../rate-limit';

const MESSAGE = { to: 'client@example.com', subject: 'Test', html: '<p>Bonjour</p>' };

describe('sendEmail : expéditeur et Reply-To explicites', () => {
  beforeEach(() => {
    sendMock.mockClear();
    vi.mocked(waitForResendSlot).mockReset().mockResolvedValue(undefined);
    vi.stubEnv('RESEND_API_KEY', 'unit-test-placeholder');
    vi.stubEnv('EMAIL_FROM', 'noreply@suppernote.com');
    vi.stubEnv('EMAIL_REPLY_TO', '');
    vi.stubEnv('EMAIL_TEST_ALLOWLIST', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('garde EMAIL_FROM et la boîte de réponse par défaut quand rien n’est fourni', async () => {
    await sendEmail(MESSAGE);

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Suppernote <noreply@suppernote.com>',
        replyTo: 'hello@suppernote.com',
      }),
    );
  });

  it('utilise l’expéditeur et le Reply-To fournis, sans revenir à EMAIL_FROM', async () => {
    await sendEmail({
      ...MESSAGE,
      from: '"Chez Suppernote" <bonjour@news.suppernote.test>',
      replyTo: 'manager@chez-suppernote.test',
    });

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"Chez Suppernote" <bonjour@news.suppernote.test>',
        replyTo: 'manager@chez-suppernote.test',
      }),
    );
  });

  it('n’envoie aucun Reply-To quand il est explicitement absent', async () => {
    await sendEmail({
      ...MESSAGE,
      from: '"Chez Suppernote" <bonjour@news.suppernote.test>',
      replyTo: null,
    });

    expect(sendMock.mock.calls[0]?.[0]).not.toHaveProperty('replyTo');
  });
});
