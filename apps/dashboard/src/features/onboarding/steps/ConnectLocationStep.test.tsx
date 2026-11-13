import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ConnectLocationStep } from './ConnectLocationStep';

const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  updateTask: vi.fn(),
  setPlaceImportDraft: vi.fn(),
  restaurant: {
    id: 'local-test',
    name: 'Chez Suppernote',
    formattedAddress: '12 rue de la République',
    postalCode: '69002',
    city: 'Lyon',
    country: 'FR',
    lat: 45.75 as number | null,
    lng: 4.85 as number | null,
  },
}));
vi.mock('@/lib/api', () => ({ useApi: () => ({ ...mocks, orgId: 'local-test' }) }));
vi.mock('../onboarding-provider', () => ({
  useOnboarding: () => ({
    state: { restaurant: mocks.restaurant },
    ...mocks,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setPlaceImportDraft.mockReset();
  Object.assign(mocks.restaurant, {
    formattedAddress: '12 rue de la République',
    postalCode: '69002',
    city: 'Lyon',
    country: 'FR',
    lat: 45.75,
    lng: 4.85,
  });
});

it('affiche d’abord le résumé de localisation et révèle le formulaire à la demande', () => {
  render(<ConnectLocationStep onComplete={vi.fn()} />);

  expect(screen.getByText('12 rue de la République')).toBeInTheDocument();
  expect(screen.getByText('Prête')).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Adresse du restaurant' })).not.toBeInTheDocument();

  const summaryRow = screen.getByRole('button', { name: /12 rue de la République/ });
  fireEvent.click(summaryRow);

  expect(summaryRow).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByLabelText('Adresse (ligne 1)')).toHaveValue('12 rue de la République');
  expect(screen.getByLabelText('Ville')).toHaveValue('Lyon');

  fireEvent.click(summaryRow);
  expect(summaryRow).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

it('bloque la suite en rouge puis ouvre le formulaire au clic sur l’adresse', () => {
  Object.assign(mocks.restaurant, {
    formattedAddress: '',
    postalCode: '',
    city: '',
    lat: null,
    lng: null,
  });
  const complete = vi.fn();
  render(<ConnectLocationStep onComplete={complete} />);

  expect(screen.getByText('Adresse à compléter')).toBeInTheDocument();
  const addressField = screen.getByLabelText('Adresse (ligne 1)');
  expect(addressField.closest('[aria-hidden="true"]')).toHaveAttribute('inert');
  fireEvent.click(screen.getByRole('button', { name: 'Compléter votre adresse' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Complétez l’adresse');
  const addressSummary = screen.getByRole('button', { name: /Adresse à compléter/ });
  expect(addressSummary).toHaveAttribute('aria-invalid', 'true');
  fireEvent.click(addressSummary);
  expect(addressSummary).toBeInTheDocument();
  expect(addressSummary).toHaveAttribute('aria-expanded', 'true');
  expect(addressSummary.closest('[data-review="true"]')).toBeInTheDocument();
  expect(addressField).toHaveValue('');
  expect(addressField).toHaveAttribute('aria-invalid', 'true');
  expect(addressField.closest('[aria-hidden="false"]')).toBeInTheDocument();
  expect(addressField).toHaveFocus();
  expect(mocks.patch).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});

it('passe à l’étape suivante après validation et sauvegarde de l’adresse', async () => {
  mocks.patch.mockResolvedValue({});
  mocks.updateTask.mockResolvedValue(true);
  const complete = vi.fn();
  render(<ConnectLocationStep onComplete={complete} />);

  fireEvent.click(screen.getByRole('button', { name: 'Continuer vers la cuisine et l’ambiance' }));

  await waitFor(() => expect(complete).toHaveBeenCalledWith('connect-cuisine'));
  expect(mocks.patch).toHaveBeenCalledWith('restaurants/local-test/connect', {
    formattedAddress: '12 rue de la République',
    postalCode: '69002',
    city: 'Lyon',
    country: 'FR',
    lat: 45.75,
    lng: 4.85,
  });
});
