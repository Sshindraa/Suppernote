import { describe, expect, it } from 'vitest';
import { cardGuaranteeNotice, formatGuaranteeEuros } from '../card-guarantee';

describe('texte d’empreinte bancaire', () => {
  it('formate les montants en euros à la française', () => {
    expect(formatGuaranteeEuros('120.00')).toBe('120 €');
    expect(formatGuaranteeEuros('22.50')).toBe('22,50 €');
  });

  it('annonce le principe, le délai et le montant maximal', () => {
    expect(
      cardGuaranteeNotice({
        restaurantName: 'Chez Test',
        partySize: 6,
        terms: { amountPerPerson: '20.00', totalAmount: '120.00', cancellationHours: 24 },
      }),
    ).toBe(
      'Pour confirmer votre réservation, Chez Test demande l’enregistrement de votre carte bancaire. ' +
        'Aucun montant n’est débité aujourd’hui. Si vous annulez moins de 24 h avant, ou si vous ne ' +
        'venez pas sans prévenir, le restaurant pourra prélever jusqu’à 20 € par personne, soit ' +
        '120 € pour 6 personnes.',
    );
  });
});
