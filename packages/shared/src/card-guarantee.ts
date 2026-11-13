/** Conditions d'empreinte bancaire renvoyées par l'API publique. */
export type CardGuaranteeTerms = {
  amountPerPerson: string;
  totalAmount: string;
  currency: 'EUR';
  cancellationHours: number;
};

/** « 120.00 » → « 120 € », « 22.50 » → « 22,50 € ». */
export function formatGuaranteeEuros(amount: string): string {
  return `${amount.replace(/\.00$/, '').replace('.', ',')} €`;
}

/**
 * Texte affiché au client avant l'enregistrement de sa carte (spec empreinte §8). Le même texte
 * est montré par les widgets et la page de garantie.
 */
export function cardGuaranteeNotice(input: {
  restaurantName: string;
  partySize: number;
  terms: Pick<CardGuaranteeTerms, 'amountPerPerson' | 'totalAmount' | 'cancellationHours'>;
}): string {
  const people = `${input.partySize} ${input.partySize > 1 ? 'personnes' : 'personne'}`;
  return (
    `Pour confirmer votre réservation, ${input.restaurantName} demande l’enregistrement de votre ` +
    `carte bancaire. Aucun montant n’est débité aujourd’hui. Si vous annulez moins de ` +
    `${input.terms.cancellationHours} h avant, ou si vous ne venez pas sans prévenir, le restaurant ` +
    `pourra prélever jusqu’à ${formatGuaranteeEuros(input.terms.amountPerPerson)} par personne, soit ` +
    `${formatGuaranteeEuros(input.terms.totalAmount)} pour ${people}.`
  );
}

export const CARD_GUARANTEE_ACCEPT_LABEL = 'J’accepte ces conditions d’annulation.';
