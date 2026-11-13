import { describe, expect, it } from 'vitest';
import { buildConfirmationText } from '../confirmation-text';
import { countSmsSegments } from '../../../modules/usage/messaging-usage.service';

describe('confirmation SMS segment budget', () => {
  it.each([
    'Chez l’Exemple',
    '餐厅很好',
    'Le Restaurant '.repeat(30),
    'Restaurant 🍽️ '.repeat(20),
    'Chez Suppernote',
  ])('reste sur un segment pour %s', (name) => {
    const text = buildConfirmationText(name, '18/10/2026', '19:00', 20);
    expect(countSmsSegments(text)).toBe(1);
    expect(text).toContain('18/10/2026');
    expect(text).toContain('19:00');
    expect(text).toContain('20');
  });
});
