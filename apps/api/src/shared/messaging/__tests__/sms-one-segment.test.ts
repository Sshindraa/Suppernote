import { describe, expect, it } from 'vitest';
import { countSmsSegments } from '../../../modules/usage/messaging-usage.service';
import { fitToOneSegment, smsSafeText } from '../confirmation-text';

describe('fitToOneSegment', () => {
  const build = (name: string) =>
    `${name} : une table s'est libérée, votre réservation est confirmée le samedi 22/11 à 20:00 (4 pers.). Modifier ou annuler : 01 23 45 67 89`;

  it('garde le nom entier quand le message tient en un segment', () => {
    expect(fitToOneSegment('Le Petit Bistrot', build)).toBe(build('Le Petit Bistrot'));
  });

  it('raccourcit un nom trop long pour rester sur un segment', () => {
    const text = fitToOneSegment('La Grande Brasserie du Port et des Halles Réunies', build);
    expect(countSmsSegments(text)).toBe(1);
    expect(text.startsWith('La Grande')).toBe(true);
  });

  it('remplace l’apostrophe typographique qui ferait passer le SMS en UCS-2', () => {
    expect(smsSafeText('L’Atelier')).toBe("L'Atelier");
    expect(countSmsSegments(fitToOneSegment('L’Atelier', build))).toBe(1);
  });

  it('garde le nom entier plutôt que de le rendre illisible si un segment est impossible', () => {
    const text = fitToOneSegment('Crêperie', (name) => `${name} ${'x'.repeat(200)}`);
    expect(text.startsWith('Crêperie')).toBe(true);
  });
});
