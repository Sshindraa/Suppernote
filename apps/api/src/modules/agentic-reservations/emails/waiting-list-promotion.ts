import { fitToOneSegment } from '../../../shared/messaging/confirmation-text';
export interface WaitingListPromotionTemplateData {
  restaurantName: string;
  date: string;
  time: string;
  partySize: number;
  restaurantPhone: string;
}

export function buildWaitingListPromotionSms(data: WaitingListPromotionTemplateData): string {
  return fitToOneSegment(
    data.restaurantName,
    (name) =>
      `${name} : une table s'est libérée, votre réservation est confirmée le ${data.date} à ${data.time} (${data.partySize} pers.). Modifier ou annuler : ${data.restaurantPhone}`,
  );
}

export function buildWaitingListPromotionEmailHtml(data: WaitingListPromotionTemplateData): string {
  const people = data.partySize === 1 ? 'personne' : 'personnes';
  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h1 style="color: #0F172A;">Votre table chez ${data.restaurantName} est confirmée</h1>
      <p>Bonne nouvelle !</p>
      <p>Une table s'est libérée chez <strong>${data.restaurantName}</strong>. Votre réservation est confirmée le <strong>${data.date}</strong> à <strong>${data.time}</strong> pour <strong>${data.partySize} ${people}</strong>.</p>
      <p>Pour modifier ou annuler votre réservation, appelez le restaurant au <strong>${data.restaurantPhone}</strong>.</p>
    </div>
  `;
}
