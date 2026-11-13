import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaceImportDraft } from '../onboarding-provider';
import { RestaurantStep } from './RestaurantStep';

const mocks = vi.hoisted(() => ({
  accountEmail: undefined as string | undefined,
  patch: vi.fn(),
  post: vi.fn(),
  updateTask: vi.fn(),
  setPlaceImportDraft: vi.fn(),
  placeImportDraft: null as PlaceImportDraft | null,
  restaurant: {
    id: 'restaurant-1',
    name: 'Chez Suppernote',
    managerPhone: '+33611112222',
    managerEmail: 'contact@example.com',
    phoneE164: null as string | null,
    googlePlaceId: null as string | null,
  },
}));

vi.hoisted(() => {
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'configured');
  vi.stubEnv('NEXT_PUBLIC_DEMO_RESTAURANT_ID', '');
});
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => {
  mocks.accountEmail = undefined;
  window.sessionStorage.clear();
});
vi.mock('@clerk/nextjs', () => ({
  useUser: () => ({
    user: {
      primaryEmailAddress: mocks.accountEmail
        ? { emailAddress: mocks.accountEmail, verification: { status: 'verified' } }
        : undefined,
    },
  }),
}));

vi.mock('@/lib/api', () => ({
  useApi: () => ({ patch: mocks.patch, post: mocks.post, orgId: 'restaurant-1' }),
}));

vi.mock('../onboarding-provider', () => ({
  useOnboarding: () => ({
    state: { restaurant: mocks.restaurant },
    updateTask: mocks.updateTask,
    placeImportDraft: mocks.placeImportDraft,
    setPlaceImportDraft: mocks.setPlaceImportDraft,
  }),
}));

const bistrot: PlaceImportDraft = {
  placeId: 'ChIJrestaurant123',
  name: 'Le Bistrot',
  phoneE164: '+33123456789',
  formattedAddress: '12 rue de la République',
  postalCode: '69002',
  city: 'Lyon',
  country: 'FR',
  openingHours: { mon: { open: '12:00', close: '14:30' } },
  hoursNeedReview: [],
};

describe('RestaurantStep Google Places prefill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.placeImportDraft = null;
    Object.assign(mocks.restaurant, {
      name: 'Chez Suppernote',
      managerPhone: '+33611112222',
      managerEmail: 'contact@example.com',
      phoneE164: null,
      googlePlaceId: null,
    });
    mocks.patch.mockResolvedValue({});
    mocks.updateTask.mockResolvedValue({});
  });

  it('shows the imported place as a card in place of the search and lets the user change it', () => {
    mocks.placeImportDraft = bistrot;

    render(<RestaurantStep onComplete={vi.fn()} />);

    expect(
      screen.queryByLabelText('Rechercher votre établissement sur Google Maps'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Fiche retrouvée via Google Maps')).toBeInTheDocument();
    expect(screen.getByText('12 rue de la République')).toBeInTheDocument();
    expect(screen.queryByText(/Fiche sélectionnée/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Adresse trouvée/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Horaires repris/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Changer d’établissement' }));
    expect(mocks.setPlaceImportDraft).toHaveBeenCalledWith(null);
  });

  it('shows Google Maps attribution only once while autocomplete results are open', async () => {
    mocks.placeImportDraft = null;
    mocks.post.mockResolvedValue({
      suggestions: [{ placeId: 'ChIJcarmelo', mainText: 'Carmelo', secondaryText: 'Lyon, France' }],
    });

    render(<RestaurantStep onComplete={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Rechercher votre établissement sur Google Maps'), {
      target: { value: 'Carmelo Lyon' },
    });

    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Google Maps')).toBeInTheDocument();
    expect(screen.getAllByText('Google Maps')).toHaveLength(1);
  });

  it('saves the imported restaurant phone alongside the separate manager contacts', async () => {
    mocks.post
      .mockResolvedValueOnce({
        suggestions: [
          { placeId: bistrot.placeId, mainText: 'Le Bistrot', secondaryText: 'Lyon, France' },
        ],
      })
      .mockResolvedValueOnce(bistrot);
    const complete = vi.fn();

    render(<RestaurantStep onComplete={complete} />);
    expect(screen.queryByLabelText('Numéro appelé par vos clients')).not.toBeInTheDocument();

    const searchInput = screen.getByLabelText('Rechercher votre établissement sur Google Maps');
    fireEvent.change(searchInput, { target: { value: 'Le Bistrot Lyon' } });
    await screen.findByRole('option', { name: /Le Bistrot.*Lyon, France/ });
    expect(within(screen.getByRole('listbox')).getByText('Google Maps')).toBeInTheDocument();
    fireEvent.keyDown(searchInput, { key: 'Enter', code: 'Enter' });

    await waitFor(() => expect(mocks.setPlaceImportDraft).toHaveBeenCalledWith(bistrot));
    expect(screen.getByText('Le Bistrot')).toBeInTheDocument();
    expect(screen.getByText('01 23 45 67 89')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirmer et continuer' }));
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith('restaurants/restaurant-1', {
        name: 'Le Bistrot',
        managerPhone: '+33611112222',
        managerEmail: 'contact@example.com',
        phoneE164: '+33123456789',
        googlePlaceId: bistrot.placeId,
      }),
    );
    expect(complete).toHaveBeenCalledWith('hours');
  });

  it('enregistre l’adresse importée avant de terminer le restaurant', async () => {
    mocks.placeImportDraft = { ...bistrot, lat: 45.76, lng: 4.83 };
    mocks.restaurant.googlePlaceId = bistrot.placeId;
    mocks.restaurant.phoneE164 = bistrot.phoneE164;
    const complete = vi.fn();
    render(<RestaurantStep onComplete={complete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer et continuer' }));
    await waitFor(() => expect(complete).toHaveBeenCalledWith('hours'));
    expect(mocks.patch).toHaveBeenCalledWith('restaurants/restaurant-1/connect', {
      formattedAddress: bistrot.formattedAddress,
      postalCode: bistrot.postalCode,
      city: bistrot.city,
      country: bistrot.country,
      lat: 45.76,
      lng: 4.83,
    });
    const addressCall = mocks.patch.mock.invocationCallOrder[1];
    expect(addressCall).toBeLessThan(mocks.updateTask.mock.invocationCallOrder[0]);
  });

  it('blocks invalid contacts and saves corrected French numbers in E.164', async () => {
    const complete = vi.fn();
    render(<RestaurantStep onComplete={complete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Saisir mes informations manuellement' }));

    // Le téléphone manque : il est déjà un champ.
    fireEvent.change(screen.getByLabelText('Numéro appelé par vos clients'), {
      target: { value: '123' },
    });
    fireEvent.blur(screen.getByLabelText('Numéro appelé par vos clients'));

    // Le nom, le mobile et l'email sont des informations : on les modifie explicitement.
    fireEvent.click(screen.getByRole('button', { name: 'Modifier le nom' }));
    fireEvent.change(screen.getByLabelText('Nom du restaurant'), { target: { value: '  ' } });
    fireEvent.blur(screen.getByLabelText('Nom du restaurant'));

    fireEvent.click(screen.getByRole('button', { name: 'Modifier le mobile' }));
    fireEvent.change(screen.getByLabelText('Mobile du responsable'), {
      target: { value: '+33600000000' },
    });
    fireEvent.blur(screen.getByLabelText('Mobile du responsable'));

    fireEvent.click(screen.getByRole('button', { name: 'Modifier l’email de gestion' }));
    fireEvent.change(screen.getByLabelText('Email pour gérer Suppernote'), {
      target: { value: 'restaurant@example.local' },
    });
    fireEvent.blur(screen.getByLabelText('Email pour gérer Suppernote'));

    expect(screen.getAllByRole('alert')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer et continuer' }));
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Nom du restaurant'), {
      target: { value: ' Le Bistrot ' },
    });
    fireEvent.blur(screen.getByLabelText('Nom du restaurant'));
    fireEvent.change(screen.getByLabelText('Numéro appelé par vos clients'), {
      target: { value: '01 23 45 67 89' },
    });
    fireEvent.blur(screen.getByLabelText('Numéro appelé par vos clients'));
    fireEvent.change(screen.getByLabelText('Mobile du responsable'), {
      target: { value: '06 11 11 22 22' },
    });
    fireEvent.blur(screen.getByLabelText('Mobile du responsable'));
    fireEvent.change(screen.getByLabelText('Email pour gérer Suppernote'), {
      target: { value: 'contact@example.com' },
    });
    fireEvent.blur(screen.getByLabelText('Email pour gérer Suppernote'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirmer et continuer' }));
    await waitFor(() => expect(complete).toHaveBeenCalledWith('hours'));
    expect(mocks.patch).toHaveBeenCalledWith('restaurants/restaurant-1', {
      name: 'Le Bistrot',
      phoneE164: '+33123456789',
      managerPhone: '+33611112222',
      managerEmail: 'contact@example.com',
      googlePlaceId: null,
    });
  });

  it('validates on blur and reports a save failure without advancing', async () => {
    mocks.restaurant.phoneE164 = '+33123456789';
    mocks.patch.mockRejectedValue(new Error('Request failed'));
    const complete = vi.fn();
    render(<RestaurantStep onComplete={complete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Saisir mes informations manuellement' }));
    fireEvent.click(screen.getByRole('button', { name: 'Modifier l’email de gestion' }));
    const email = screen.getByLabelText('Email pour gérer Suppernote');
    fireEvent.change(email, { target: { value: 'invalid' } });
    fireEvent.blur(email);
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Saisissez une adresse email valide.');
    fireEvent.change(email, { target: { value: 'contact@example.com' } });
    fireEvent.blur(email);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer et continuer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Impossible d’enregistrer vos coordonnées.',
    );
    expect(mocks.updateTask).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('prefills the verified account email and preserves an explicit management-email change', () => {
    mocks.restaurant.managerEmail = '';
    mocks.accountEmail = 'owner@bistrot.fr';
    const view = render(<RestaurantStep onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Saisir mes informations manuellement' }));
    expect(screen.getByText('owner@bistrot.fr')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Modifier l’email de gestion' }));
    const email = screen.getByLabelText('Email pour gérer Suppernote');
    expect(email).toHaveValue('owner@bistrot.fr');
    fireEvent.change(email, { target: { value: 'gestion@bistrot.fr' } });
    mocks.accountEmail = 'updated@bistrot.fr';
    view.rerender(<RestaurantStep onComplete={vi.fn()} />);
    expect(email).toHaveValue('gestion@bistrot.fr');
  });

  it('stays on the form when the API cannot mark the restaurant step complete', async () => {
    mocks.restaurant.phoneE164 = '+33123456789';
    mocks.updateTask.mockResolvedValue(null);
    const complete = vi.fn();
    render(<RestaurantStep onComplete={complete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Saisir mes informations manuellement' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer et continuer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Impossible d’enregistrer vos coordonnées.',
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it('shows errors for invalid prefilled values without waiting for blur or submit', () => {
    Object.assign(mocks.restaurant, {
      name: ' ',
      phoneE164: '123',
      managerPhone: '+33600000000',
      managerEmail: 'restaurant@example.invalid',
    });
    render(<RestaurantStep onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Saisir mes informations manuellement' }));
    expect(screen.getAllByRole('alert')).toHaveLength(4);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it('keeps the unsaved entry when the user comes back to the step', () => {
    const first = render(<RestaurantStep onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Saisir mes informations manuellement' }));
    fireEvent.click(screen.getByRole('button', { name: 'Modifier le nom' }));
    fireEvent.change(screen.getByLabelText('Nom du restaurant'), {
      target: { value: 'Chez Test' },
    });
    first.unmount();

    render(<RestaurantStep onComplete={vi.fn()} />);
    expect(screen.getByText('Chez Test')).toBeInTheDocument();
  });

  it('shows the recognized name and phone as information and asks only for what is missing', () => {
    mocks.placeImportDraft = bistrot;
    mocks.restaurant.managerPhone = '';
    mocks.restaurant.managerEmail = '';
    render(<RestaurantStep onComplete={vi.fn()} />);
    expect(screen.getAllByText('Le Bistrot').length).toBeGreaterThan(0);
    expect(screen.getByText('01 23 45 67 89')).toBeInTheDocument();
    expect(screen.queryByLabelText('Nom du restaurant')).not.toBeInTheDocument();
    expect(screen.getByText(/Utilisé sur votre page et par l’assistant/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Numéro appelé par vos clients')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Mobile du responsable')).toBeInTheDocument();
    expect(screen.getByLabelText('Email pour gérer Suppernote')).toBeInTheDocument();
    expect(screen.getByText('2 à compléter')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Modifier le téléphone' }));
    expect(screen.getByLabelText('Numéro appelé par vos clients')).toHaveValue('01 23 45 67 89');
  });

  it('pre-fills the commercial name deduced from the Google Maps listing', async () => {
    mocks.placeImportDraft = { ...bistrot, name: 'Le Bistrot lyon 2', displayName: 'Le Bistrot' };
    mocks.restaurant.managerPhone = '+33611112222';
    mocks.restaurant.managerEmail = 'contact@example.com';
    const complete = vi.fn();
    render(<RestaurantStep onComplete={complete} />);
    expect(screen.getByText('Le Bistrot lyon 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Modifier le nom' }));
    expect(screen.getByLabelText('Nom du restaurant')).toHaveValue('Le Bistrot');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer et continuer' }));
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith(
        'restaurants/restaurant-1',
        expect.objectContaining({ name: 'Le Bistrot' }),
      ),
    );
  });

  it('lets the restaurant shorten the name imported from Google Maps', async () => {
    mocks.placeImportDraft = { ...bistrot, name: 'Le Bistrot lyon 2' };
    render(<RestaurantStep onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Modifier le nom' }));
    expect(screen.getByLabelText('Nom du restaurant')).toHaveValue('Le Bistrot lyon 2');
    fireEvent.change(screen.getByLabelText('Nom du restaurant'), {
      target: { value: 'Le Bistrot' },
    });
    expect(screen.getByLabelText('Nom du restaurant')).toHaveValue('Le Bistrot');
  });

  it('keeps the primary action disabled until a place is found or details are entered', () => {
    render(<RestaurantStep onComplete={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Confirmer et continuer' })).toBeDisabled();
  });

  it('offers the manual path when the search finds no establishment', async () => {
    mocks.post.mockResolvedValue({ suggestions: [] });
    render(<RestaurantStep onComplete={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Rechercher votre établissement sur Google Maps'), {
      target: { value: 'Inconnu Lyon' },
    });
    expect(
      await screen.findByText('Aucun résultat trouvé. Essayez avec un nom et une ville.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Saisir mes informations manuellement' }));
    expect(screen.getByText('Chez Suppernote')).toBeInTheDocument();
  });
});

describe('RestaurantStep mobile du gérant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.placeImportDraft = null;
    Object.assign(mocks.restaurant, {
      name: 'Chez Suppernote',
      managerPhone: '',
      managerEmail: 'contact@example.com',
      phoneE164: '+33123456789',
      googlePlaceId: null,
    });
    mocks.patch.mockResolvedValue({});
    mocks.updateTask.mockResolvedValue({});
  });

  it('bloque l’enregistrement tant que le mobile est vide ou invalide', async () => {
    const complete = vi.fn();
    render(<RestaurantStep onComplete={complete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Saisir mes informations manuellement' }));

    fireEvent.change(screen.getByLabelText('Mobile du responsable'), {
      target: { value: '12 34' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer et continuer' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('numéro de mobile valide');
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('enregistre un mobile saisi à la française au format international', async () => {
    const complete = vi.fn();
    render(<RestaurantStep onComplete={complete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Saisir mes informations manuellement' }));

    fireEvent.change(screen.getByLabelText('Mobile du responsable'), {
      target: { value: '06 12 34 56 78' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer et continuer' }));

    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith(
        'restaurants/restaurant-1',
        expect.objectContaining({ managerPhone: '+33612345678' }),
      ),
    );
    expect(complete).toHaveBeenCalledWith('hours');
  });
});

describe('RestaurantStep focus et validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.placeImportDraft = null;
    Object.assign(mocks.restaurant, {
      name: 'Chez Suppernote',
      managerPhone: '+33611112222',
      managerEmail: 'contact@example.com',
      phoneE164: null,
      googlePlaceId: null,
    });
    mocks.patch.mockResolvedValue({});
    mocks.updateTask.mockResolvedValue({});
  });

  it('moves the focus to the first empty field after manual entry', () => {
    render(<RestaurantStep onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Saisir mes informations manuellement' }));
    expect(screen.getByLabelText('Numéro appelé par vos clients')).toHaveFocus();
  });

  it('moves the focus to the first invalid field on submit', () => {
    render(<RestaurantStep onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Saisir mes informations manuellement' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer et continuer' }));
    expect(screen.getByLabelText('Numéro appelé par vos clients')).toHaveFocus();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it('counts the required fields still missing, then confirms when all are valid', () => {
    render(<RestaurantStep onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Saisir mes informations manuellement' }));
    expect(screen.getByText('1 à compléter')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Numéro appelé par vos clients'), {
      target: { value: '01 23 45 67 89' },
    });
    expect(screen.getByText('Prêt à continuer')).toBeInTheDocument();
  });

  it('closes the suggestions with Escape', async () => {
    mocks.post.mockResolvedValue({
      suggestions: [{ placeId: 'ChIJcarmelo', mainText: 'Carmelo', secondaryText: 'Lyon, France' }],
    });
    render(<RestaurantStep onComplete={vi.fn()} />);
    const search = screen.getByLabelText('Rechercher votre établissement sur Google Maps');
    fireEvent.change(search, { target: { value: 'Carmelo Lyon' } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('keeps the focus on the form after picking an establishment', async () => {
    mocks.post
      .mockResolvedValueOnce({
        suggestions: [
          { placeId: bistrot.placeId, mainText: 'Le Bistrot', secondaryText: 'Lyon, France' },
        ],
      })
      .mockResolvedValueOnce(bistrot);
    const view = render(<RestaurantStep onComplete={vi.fn()} />);
    const search = screen.getByLabelText('Rechercher votre établissement sur Google Maps');
    fireEvent.change(search, { target: { value: 'Le Bistrot Lyon' } });
    await screen.findByRole('option', { name: /Le Bistrot/ });
    fireEvent.keyDown(search, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(mocks.setPlaceImportDraft).toHaveBeenCalledWith(bistrot));
    mocks.placeImportDraft = bistrot;
    view.rerender(<RestaurantStep onComplete={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Vos informations' })).toHaveFocus(),
    );
  });
  it('restores a saved draft after hydration without discarding the form', async () => {
    window.sessionStorage.setItem(
      'sokar:onboarding:restaurant-form:v1:restaurant-1',
      JSON.stringify({
        name: 'Restaurant de démonstration',
        phone: '01 23 45 67 89',
        managerPhone: '',
        managerEmail: '',
      }),
    );
    const container = document.createElement('div');
    const serverMarkup = new DOMParser().parseFromString(
      renderToString(<RestaurantStep onComplete={vi.fn()} />),
      'text/html',
    );
    container.replaceChildren(...Array.from(serverMarkup.body.childNodes));
    document.body.appendChild(container);
    const recoverableError = vi.fn();
    let root!: ReturnType<typeof hydrateRoot>;
    try {
      await act(async () => {
        root = hydrateRoot(container, <RestaurantStep onComplete={vi.fn()} />, {
          onRecoverableError: recoverableError,
        });
      });
      expect(within(container).getByText('Restaurant de démonstration')).toBeInTheDocument();
      expect(within(container).getByText('2 à compléter')).toBeInTheDocument();
      expect(recoverableError).not.toHaveBeenCalled();
    } finally {
      await act(async () => root?.unmount());
      container.remove();
    }
  });
});
