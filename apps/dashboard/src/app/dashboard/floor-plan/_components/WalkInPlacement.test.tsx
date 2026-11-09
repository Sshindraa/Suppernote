import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  WalkInPlacement,
  defaultWalkInPartySize,
  walkInErrorMessage,
  type WalkInTable,
} from './WalkInPlacement';

const table: WalkInTable = { id: 'table-1', name: 'T4', capacity: 4 };

function open(onPlace = vi.fn().mockResolvedValue(undefined), tableUnderTest = table) {
  render(<WalkInPlacement table={tableUnderTest} onPlace={onPlace} />);
  fireEvent.click(screen.getByRole('button', { name: 'Walk-in' }));
  return { onPlace, form: screen.getByRole('form', { name: 'Placer un client sans réservation' }) };
}

describe('WalkInPlacement', () => {
  it('propose un seul bouton, libellé « Walk-in », sans emoji, puis ouvre le formulaire', () => {
    render(<WalkInPlacement table={table} onPlace={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Walk-in' });
    expect(button.textContent).toBe('Walk-in');
    expect(document.body.textContent).not.toMatch(/⚡/);
    expect(screen.queryByRole('form')).not.toBeInTheDocument();

    fireEvent.click(button);
    expect(screen.getByRole('form')).toBeInTheDocument();
  });

  it('propose 2 personnes par défaut, ou moins si la table est plus petite', () => {
    expect(defaultWalkInPartySize(4)).toBe(2);
    expect(defaultWalkInPartySize(2)).toBe(2);
    expect(defaultWalkInPartySize(1)).toBe(1);
    const { form } = open();
    expect(within(form).getByLabelText('Nombre de personnes')).toHaveValue(2);
  });

  it('prend 1 personne par défaut sur une table d’une place', () => {
    const { form } = open(undefined, { id: 't', name: 'Bar', capacity: 1 });
    expect(within(form).getByLabelText('Nombre de personnes')).toHaveValue(1);
  });

  it('plafonne le nombre de personnes à la capacité de la table', () => {
    const { form, onPlace } = open();
    const input = within(form).getByLabelText('Nombre de personnes');
    expect(input).toHaveAttribute('max', '4');
    expect(input).toHaveAttribute('min', '1');

    fireEvent.change(input, { target: { value: '5' } });
    expect(within(form).getByText('Entre 1 et 4 personnes pour cette table.')).toHaveClass(
      'text-destructive',
    );
    expect(within(form).getByRole('button', { name: 'Placer le client' })).toBeDisabled();
    fireEvent.submit(form);
    expect(onPlace).not.toHaveBeenCalled();

    for (const invalid of ['0', '', '2.5']) {
      fireEvent.change(input, { target: { value: invalid } });
      expect(within(form).getByRole('button', { name: 'Placer le client' })).toBeDisabled();
    }
    fireEvent.change(input, { target: { value: '4' } });
    expect(within(form).getByRole('button', { name: 'Placer le client' })).toBeEnabled();
  });

  it('envoie le nombre de personnes choisi, sans nom quand il est laissé vide', async () => {
    const { form, onPlace } = open();
    fireEvent.change(within(form).getByLabelText('Nombre de personnes'), {
      target: { value: '3' },
    });

    fireEvent.click(within(form).getByRole('button', { name: 'Placer le client' }));

    await waitFor(() => expect(onPlace).toHaveBeenCalledWith(3, undefined));
  });

  it('envoie le nom facultatif quand il est saisi, sans espaces autour', async () => {
    const { form, onPlace } = open();
    expect(within(form).getByLabelText('Nom (facultatif)')).toHaveValue('');

    fireEvent.change(within(form).getByLabelText('Nom (facultatif)'), {
      target: { value: '  Famille Durand ' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Placer le client' }));

    await waitFor(() => expect(onPlace).toHaveBeenCalledWith(2, 'Famille Durand'));
  });

  it('affiche l’erreur et garde le formulaire quand la table est déjà occupée', async () => {
    const message = walkInErrorMessage(
      Object.assign(new Error('Table non disponible'), { status: 409 }),
    );
    const { form } = open(vi.fn().mockRejectedValue(new Error(message)));

    fireEvent.click(within(form).getByRole('button', { name: 'Placer le client' }));

    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent('déjà occupée ou réservée');
    expect(alert).not.toHaveTextContent('Table non disponible');
    expect(within(form).getByRole('button', { name: 'Placer le client' })).toBeEnabled();
  });

  it('montre le chargement et bloque un second envoi pendant le placement', async () => {
    let finish: () => void = () => undefined;
    const onPlace = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { form } = open(onPlace);

    fireEvent.click(within(form).getByRole('button', { name: 'Placer le client' }));

    const busy = await within(form).findByRole('button', { name: 'Placement…' });
    expect(busy).toBeDisabled();
    expect(within(form).getByRole('button', { name: 'Annuler' })).toBeDisabled();
    expect(within(form).getByLabelText('Nombre de personnes')).toBeDisabled();
    fireEvent.submit(form);
    expect(onPlace).toHaveBeenCalledTimes(1);

    finish();
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
  });

  it('revient au bouton quand on annule', () => {
    const { form } = open();
    fireEvent.click(within(form).getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Walk-in' })).toBeInTheDocument();
  });
});

describe('walkInErrorMessage', () => {
  it('explique clairement qu’une table occupée ne peut pas être prise', () => {
    expect(walkInErrorMessage(Object.assign(new Error('brut'), { status: 409 }))).toBe(
      'Cette table n’est pas disponible : elle est déjà occupée ou réservée. Choisissez une autre table.',
    );
  });

  it('garde le message de l’API pour les autres erreurs, ou un message de repli', () => {
    expect(walkInErrorMessage(new Error('Capacité insuffisante'))).toBe('Capacité insuffisante');
    expect(walkInErrorMessage({})).toBe(
      'Impossible de placer ce client. Réessayez dans un instant.',
    );
  });
});
