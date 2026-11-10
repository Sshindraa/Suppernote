import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CustomerImportDialog } from './customer-import-dialog';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('@/lib/api', () => ({
  useApi: () => ({ post: mocks.post }),
}));

const headers = ['Nom', 'Téléphone', 'Email'];
const analysis = {
  dryRun: true,
  columns: { headers, mapping: { lastName: 'Nom', phone: 'Téléphone', email: 'Email' } },
  counts: { created: 1, completed: 0, skipped: 1 },
  reasons: [{ line: 3, reason: 'Téléphone absent ou invalide' }],
  preview: [
    { name: 'Alice Martin', phone: '+33612345678', email: null, birthMonth: null, birthDay: null },
  ],
};

function chooseFile(
  content: string | Uint8Array<ArrayBuffer> = 'Nom;Téléphone;Email\nAlice Martin;0612345678;\n',
) {
  const input = screen.getByLabelText('Fichier CSV à importer');
  const file = new File([content], 'clients.csv', { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [file] } });
}

describe('CustomerImportDialog', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('analyse le fichier en dryRun, affiche les colonnes et un aperçu', async () => {
    mocks.post.mockResolvedValueOnce({ data: analysis });
    render(<CustomerImportDialog open onOpenChange={vi.fn()} />);

    chooseFile();

    expect(await screen.findByText('Aperçu des 5 premières lignes')).toBeInTheDocument();
    expect(screen.getByText('Alice Martin')).toBeInTheDocument();
    expect(screen.getByText('1 à créer · 0 à compléter · 1 ignorée(s)')).toBeInTheDocument();
    expect(screen.getByText('Ligne 3 : Téléphone absent ou invalide')).toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledWith('customers/import', {
      csv: expect.stringContaining('Alice Martin'),
      dryRun: true,
    });
  });

  it('relance la vérification quand une colonne est corrigée', async () => {
    mocks.post.mockResolvedValueOnce({ data: analysis }).mockResolvedValueOnce({
      data: {
        ...analysis,
        columns: { ...analysis.columns, mapping: { ...analysis.columns.mapping, email: null } },
      },
    });
    render(<CustomerImportDialog open onOpenChange={vi.fn()} />);
    chooseFile();
    await screen.findByText('Aperçu des 5 premières lignes');

    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: '' } });

    await waitFor(() =>
      expect(mocks.post).toHaveBeenLastCalledWith('customers/import', {
        csv: expect.any(String),
        dryRun: true,
        mapping: expect.objectContaining({ email: null, phone: 'Téléphone' }),
      }),
    );
  });

  it('affiche un état vide quand le fichier ne contient aucune ligne', async () => {
    mocks.post.mockResolvedValueOnce({
      data: {
        ...analysis,
        counts: { created: 0, completed: 0, skipped: 0 },
        reasons: [],
        preview: [],
      },
    });
    render(<CustomerImportDialog open onOpenChange={vi.fn()} />);
    chooseFile('Nom;Téléphone\n');
    expect(
      await screen.findByText('Le fichier ne contient aucune ligne de client.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Importer 0 client(s)' })).toBeDisabled();
  });

  it('affiche l’erreur de l’API et reste sur le choix du fichier', async () => {
    mocks.post.mockRejectedValueOnce(new Error('Le fichier dépasse 10000 clients'));
    render(<CustomerImportDialog open onOpenChange={vi.fn()} />);
    chooseFile();
    expect(await screen.findByRole('alert')).toHaveTextContent('Le fichier dépasse 10000 clients');
    expect(screen.getByLabelText('Fichier CSV à importer')).toBeInTheDocument();
  });

  it('bloque l’import tant que la colonne du téléphone n’est pas choisie', async () => {
    mocks.post.mockResolvedValueOnce({
      data: { ...analysis, columns: { headers, mapping: { lastName: 'Nom' } } },
    });
    render(<CustomerImportDialog open onOpenChange={vi.fn()} />);
    chooseFile();
    await screen.findByText('Aperçu des 5 premières lignes');
    expect(screen.getByText(/Choisissez la colonne du téléphone/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Importer/ })).toBeDisabled();
  });

  it('importe pour de vrai puis affiche le compte rendu', async () => {
    const onImported = vi.fn();
    mocks.post.mockResolvedValueOnce({ data: analysis }).mockResolvedValueOnce({
      data: { ...analysis, dryRun: false, counts: { created: 1, completed: 0, skipped: 1 } },
    });
    render(<CustomerImportDialog open onOpenChange={vi.fn()} onImported={onImported} />);
    chooseFile();
    await screen.findByText('Aperçu des 5 premières lignes');

    fireEvent.click(screen.getByRole('button', { name: 'Importer 1 client(s)' }));

    expect(await screen.findByText('1 créé(s) · 0 complété(s) · 1 ignoré(s)')).toBeInTheDocument();
    expect(mocks.post).toHaveBeenLastCalledWith('customers/import', {
      csv: expect.any(String),
      dryRun: false,
      mapping: {
        firstName: null,
        lastName: 'Nom',
        name: null,
        phone: 'Téléphone',
        email: 'Email',
        birthday: null,
        notes: null,
      },
    });
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it('décode un export Excel en Windows-1252 (« Renée » avec un é non UTF-8)', async () => {
    mocks.post.mockResolvedValueOnce({ data: analysis });
    render(<CustomerImportDialog open onOpenChange={vi.fn()} />);

    chooseFile(
      new Uint8Array([
        0x4e, 0x6f, 0x6d, 0x3b, 0x54, 0x65, 0x6c, 0x0a, 0x52, 0x65, 0x6e, 0xe9, 0x65, 0x3b, 0x30,
        0x36, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38,
      ]),
    );

    await screen.findByText('Aperçu des 5 premières lignes');
    expect(mocks.post).toHaveBeenCalledWith('customers/import', {
      csv: 'Nom;Tel\nRenée;0612345678',
      dryRun: true,
    });
  });

  it('refuse un fichier trop volumineux avant tout envoi', async () => {
    render(<CustomerImportDialog open onOpenChange={vi.fn()} />);

    chooseFile(`Nom;Téléphone\n${'Alice;0612345678\n'.repeat(60_000)}`);

    expect(await screen.findByRole('alert')).toHaveTextContent('trop volumineux');
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('refuse avant envoi un CSV sous 700 000 caractères dont le corps JSON dépasse 1 Mo', async () => {
    render(<CustomerImportDialog open onOpenChange={vi.fn()} />);

    // 650 000 guillemets : chaque « " » devient « \" » dans le JSON envoyé, soit plus de 1 Mo.
    chooseFile(`Nom;Téléphone\n${'"'.repeat(650_000)}`);

    expect(await screen.findByRole('alert')).toHaveTextContent('Découpez-le en plusieurs fichiers');
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('refuse avant envoi un CSV de plus de 700 000 caractères', async () => {
    render(<CustomerImportDialog open onOpenChange={vi.fn()} />);

    chooseFile(`Nom;Téléphone\n${'a'.repeat(700_001)}`);

    expect(await screen.findByRole('alert')).toHaveTextContent('700 000 caractères');
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
