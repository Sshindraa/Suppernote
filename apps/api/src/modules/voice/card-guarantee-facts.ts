import { formatGuaranteeEuros } from '@suppernote/shared';
import {
  findCardGuaranteeTerms,
  type CardGuaranteeTerms,
} from '../reservation-payments/reservation-guarantee.public';

/** Après un appel, la table est tenue 2 h le temps d'enregistrer la carte (spec §5). */
export const VOICE_CARD_GUARANTEE_HOLD_MS = 2 * 60 * 60 * 1000;

/**
 * Conditions d'empreinte pour une table prise au téléphone. Les faits ci-dessous sont donnés au
 * modèle, qui choisit ses mots : le prompt porte le principe (annonce avant l'accord, jamais de
 * carte au téléphone).
 */
export async function voiceCardGuaranteeTerms(input: {
  restaurantId: string;
  date: string;
  partySize: number;
  demo?: boolean;
}): Promise<CardGuaranteeTerms | null> {
  if (input.demo) return null;
  return findCardGuaranteeTerms({
    restaurantId: input.restaurantId,
    partySize: input.partySize,
    localDate: input.date,
  });
}

export function cardGuaranteeAvailabilityFact(terms: CardGuaranteeTerms): string {
  return (
    ` Empreinte bancaire demandée par le restaurant pour cette réservation : aucun montant n'est ` +
    `débité aujourd'hui ; jusqu'à ${formatGuaranteeEuros(terms.amountPerPerson)} par personne ` +
    `(${formatGuaranteeEuros(terms.totalAmount)} au total) pourront être prélevés en cas ` +
    `d'absence sans prévenir ou d'annulation moins de ${terms.cancellationHours} h avant. La carte ` +
    `s'enregistre par un lien envoyé par SMS après l'appel, jamais au téléphone.`
  );
}

export function cardGuaranteeCreatedFact(input: {
  customerName: string;
  date: string;
  time: string;
  partySize: number;
}): string {
  return (
    `Réservation enregistrée EN ATTENTE d'empreinte bancaire pour ${input.customerName}, le ` +
    `${input.date} à ${input.time}, pour ${input.partySize} personne(s) : elle n'est pas encore ` +
    `confirmée. La table est gardée 2 heures. Un SMS avec le lien sécurisé d'enregistrement de la ` +
    `carte part au numéro de l'appelant ; la réservation sera confirmée dès la carte enregistrée, ` +
    `sinon la table sera libérée.`
  );
}

export const CARD_GUARANTEE_NO_PHONE_FACT =
  "Empreinte bancaire demandée, mais aucun numéro de téléphone pour envoyer le lien : la réservation n'a pas été créée. Propose le gérant ou de laisser un message.";
