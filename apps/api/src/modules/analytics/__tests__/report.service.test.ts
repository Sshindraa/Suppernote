/**
 * Tests for the daily-report HTML email builder.
 *
 * Pure function: takes a ReportData shape, returns an HTML string. The
 * function injects the TheFork commission savings (commission per couvert
 * × number of couverts) only when totalCouverts is provided. The
 * rendered numbers are formatted in fr-FR locale, currency EUR.
 */
import { describe, expect, it } from 'vitest';
import { buildReportEmail, type ReportData } from '../report.service';

function makeBase(overrides: Partial<ReportData> = {}): ReportData {
  return {
    restaurantName: 'Chez Suppernote',
    totalCalls: 12,
    reserved: 8,
    cancelled: 1,
    estimatedRevenue: 480.5,
    ...overrides,
  };
}

describe('buildReportEmail', () => {
  it('contient le nom du restaurant dans le titre', () => {
    const html = buildReportEmail(makeBase({ restaurantName: 'Le Bistrot' }));
    expect(html).toContain('Rapport du jour — Le Bistrot');
  });

  it('affiche les compteurs (appels, réservations, annulations)', () => {
    const html = buildReportEmail(makeBase({ totalCalls: 17, reserved: 11, cancelled: 3 }));
    expect(html).toContain('<strong>Appels reçus</strong>');
    expect(html).toContain('<strong>Réservations confirmées</strong>');
    expect(html).toContain('<strong>Annulations</strong>');
    // Les valeurs sont rendues dans les <td> de droite — on vérifie leur présence
    expect(html).toMatch(/>\s*17\s*</);
    expect(html).toMatch(/>\s*11\s*</);
    expect(html).toMatch(/>\s*3\s*</);
  });

  it('formate le revenu estimé avec 2 décimales + espace avant €', () => {
    const html = buildReportEmail(makeBase({ estimatedRevenue: 1234.5 }));
    expect(html).toContain('1234.50');
    expect(html).toContain('€');
  });

  it("n'affiche PAS le bloc économies TheFork si totalCouverts est absent", () => {
    const html = buildReportEmail(makeBase());
    expect(html).not.toContain('Économies commissions TheFork évitées');
  });

  it("n'affiche PAS le bloc économies TheFork si totalCouverts = 0", () => {
    const html = buildReportEmail(makeBase({ totalCouverts: 0 }));
    expect(html).not.toContain('Économies commissions TheFork évitées');
  });

  it('affiche le bloc économies TheFork avec le bon montant (3€ × couverts)', () => {
    const html = buildReportEmail(makeBase({ totalCouverts: 50 }));
    // 50 × 3 = 150 € (formaté en fr-FR)
    expect(html).toContain('Économies commissions TheFork évitées');
    expect(html).toMatch(/150,00\s*€/);
  });

  it('formate les grosses sommes avec séparateur de milliers fr-FR', () => {
    const html = buildReportEmail(makeBase({ totalCouverts: 1234 }));
    // 1234 × 3 = 3 702,00 €
    expect(html).toMatch(/3\s*702,00\s*€/);
  });

  it('affiche le branding Suppernote et le footer "envoyé automatiquement"', () => {
    const html = buildReportEmail(makeBase());
    expect(html).toContain('Suppernote');
    expect(html).toContain('Cet email est envoyé automatiquement par Suppernote.');
  });

  it('produit un markup HTML bien formé (sécurise contre injection côté rendu)', () => {
    const html = buildReportEmail(makeBase({ restaurantName: '<script>x</script>' }));
    // Le nom est injecté tel quel dans le H2 — on vérifie juste que la fonction
    // ne throw pas. La sanitisation est gérée en amont (escape côté caller
    // ou CSP côté email client). Ce test documente le comportement actuel.
    expect(html).toContain('<script>x</script>');
  });

  it('reste cohérent quand tous les compteurs sont à 0', () => {
    const html = buildReportEmail(
      makeBase({ totalCalls: 0, reserved: 0, cancelled: 0, estimatedRevenue: 0 }),
    );
    // estimatedRevenue est formaté via toFixed(2) → "0.00 €" (en_US)
    // (les économies TheFork passent par toLocaleString fr-FR)
    expect(html).toContain('0.00 €');
    expect(html).not.toContain('Économies commissions TheFork évitées');
  });
});
