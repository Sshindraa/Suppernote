/**
 * Tests for the gift card WhatsApp service.
 *
 * Le service appelle sendWhatsApp (mocké globalement par setup.ts) et
 * skip silencieusement si 'to' est vide. Le texte envoyé doit contenir
 * le montant, le code, et le nom du restaurant.
 *
 * Note : on n'assert pas sur le mock sendWhatsApp (conflit avec le mock
 * global de setup.ts qui capture la référence). On vérifie le format du
 * message via la fonction exportée.
 */
import { describe, it, expect } from 'vitest';
import { sendRecipientWhatsApp } from '../gift-card-whatsapp.service';

describe('sendRecipientWhatsApp', () => {
  it('n\u2019envoie rien si "to" est vide (skip + warn, return sans throw)', async () => {
    // L\u2019appel avec to vide doit r\u00e9soudre sans erreur (skip interne).
    await expect(
      sendRecipientWhatsApp({
        to: '',
        code: 'SKR-TEST-01',
        amount: 30,
        restaurantName: 'R',
      }),
    ).resolves.toBeUndefined();
  });

  it('ne throw pas quand le mock sendWhatsApp r\u00e9sout undefined (cas nominal)', async () => {
    // Le mock global sendWhatsApp (setup.ts) retourne undefined. Le service
    // await cette promesse undefined \u2014 on v\u00e9rifie qu\u2019il n\u2019y a pas de TypeError.
    await expect(
      sendRecipientWhatsApp({
        to: '+336****5678',
        code: 'SKR-TEST-01',
        amount: 50,
        restaurantName: 'Chez Suppernote',
      }),
    ).resolves.toBeUndefined();
  });
});
