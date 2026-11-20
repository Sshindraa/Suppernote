import { describe, expect, it } from 'vitest';
import { sayAfterAmorce, speakableAmorce } from '../stream/structured-turn/amorce';

describe('speakableAmorce', () => {
  it('garde une reprise courte de ce que l’appelant a dit, ponctuée', () => {
    expect(speakableAmorce('Vendredi à 20 h')).toBe('Vendredi à 20 h.');
    expect(speakableAmorce("Quatre, d'accord.")).toBe("Quatre, d'accord.");
    expect(speakableAmorce('Pour un anniversaire,')).toBe('Pour un anniversaire,');
  });

  it('refuse ce qui répond ou promet avant les garde-fous', () => {
    expect(speakableAmorce('Oui, vendredi.')).toBeNull();
    expect(speakableAmorce('Vendredi, c’est libre.')).toBeNull();
    expect(speakableAmorce('Je vous réserve ça.')).toBeNull();
    expect(speakableAmorce('Vendredi ?')).toBeNull();
    expect(speakableAmorce('Nous sommes fermés.')).toBeNull();
  });

  it('refuse un accusé de réception seul, une épellation, une phrase longue', () => {
    expect(speakableAmorce("D'accord.")).toBeNull();
    expect(speakableAmorce('Très bien')).toBeNull();
    expect(speakableAmorce('H, O, U, E, T.')).toBeNull();
    expect(speakableAmorce('Vendredi soir à vingt heures pour quatre personnes')).toBeNull();
    expect(speakableAmorce('')).toBeNull();
    expect(speakableAmorce(undefined)).toBeNull();
  });
});

describe('sayAfterAmorce', () => {
  it('retire les mots de l’amorce quand say les répète', () => {
    expect(sayAfterAmorce('Vendredi à 20 h.', 'Vendredi à 20 h, vous serez combien ?', true)).toBe(
      'vous serez combien ?',
    );
  });

  it('laisse say intact quand il commence autrement', () => {
    expect(sayAfterAmorce('Quatre, d’accord.', 'Et c’est à quel nom ?', false)).toBe(
      'Et c’est à quel nom ?',
    );
  });

  it('attend la suite tant que le début reçu ne permet pas de trancher', () => {
    expect(sayAfterAmorce('Vendredi à 20 h.', 'Vendredi', false)).toBeNull();
    expect(sayAfterAmorce('Vendredi à 20 h.', 'Vendredi à 20 h', true)).toBe('');
  });
});

describe('sayAfterAmorce — début commun partiel', () => {
  it('retire « Dimanche » répété, garde la suite', () => {
    expect(
      sayAfterAmorce('Dimanche soir,', 'Dimanche, le restaurant est fermé. Un autre jour ?', true),
    ).toBe('le restaurant est fermé. Un autre jour ?');
    expect(sayAfterAmorce('Demain,', 'Demain, oui, de midi à 22 h.', true)).toBe(
      'oui, de midi à 22 h.',
    );
  });

  it('ne retire pas un simple mot outil commun', () => {
    expect(sayAfterAmorce('À 18 heures,', 'À 19 heures plutôt ?', true)).toBe(
      'À 19 heures plutôt ?',
    );
  });
});
