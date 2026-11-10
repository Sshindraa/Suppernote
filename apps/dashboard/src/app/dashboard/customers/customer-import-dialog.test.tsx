import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CustomerImportDialog } from './customer-import-dialog';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('@/lib/api', () => ({
  useApi: () => ({ post: mocks.post }),
}));

type Body = {
  csv: string;
  dryRun: boolean;
  hasHeader?: boolean;
  lineOffset?: number;
  mapping?: Record<string, string | null>;
};

/** Stands in for the API: counts the rows of the piece it receives, as the real reader would. */
function fakeApi(body: Body) {
  const lines = body.csv.split('\n').filter((line) => line.trim() !== '');
  const rows = body.hasHeader === false ? lines : lines.slice(1);
  return {
    data: {
      dryRun: body.dryRun,
      columns: {
        headers: ['Nom', 'Téléphone'],
        headerLine: body.hasHeader === false ? null : 1,
        mapping: { lastName: 'Nom', phone: 'Téléphone' },
        byContent: [],
      },
      counts: { created: rows.length, completed: 0, skipped: 0 },
      reasons: [],
      preview: [
        {
          name: 'Alice Martin',
          phone: '+33612345678',
          email: null,
          birthMonth: null,
          birthDay: null,
        },
      ],
    },
  };
}

function chooseFile(
  content: string | Uint8Array<ArrayBuffer> = 'Nom;Téléphone\nAlice Martin;0612345678\n',
) {
  const input = screen.getByLabelText('Fichier à importer');
  const file = new File([content], 'clients.csv', { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [file] } });
}

describe('CustomerImportDialog', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.localStorage.clear();
    mocks.post.mockImplementation(async (_path: string, body: Body) => fakeApi(body));
  });

  it('fait l’essai tout seul dès le dépôt et affiche le résumé, sans écran de colonnes', async () => {
    render(<CustomerImportDialog open onOpenChange={vi.fn()} />);

    chooseFile();

    expect(await screen.findByText('Aperçu des 5 premières lignes')).toBeInTheDocument();
    expect(screen.getByText('Alice Martin')).toBeInTheDocument();
    expect(screen.getByText('1 à créer · 0 à compléter · 0 ignorée(s)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Modifier les colonnes' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Téléphone')).not.toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledWith(
      'customers/import',
      expect.objectContaining({ dryRun: true }),
    );
  });

  it('ouvre les colonnes seulement quand le téléphone n’est pas reconnu, et bloque l’import', async () => {
    mocks.post.mockImplementation(async (_path: string, body: Body) => ({
      data: {
        ...fakeApi(body).data,
        columns: {
          headers: ['Nom', 'Col2'],
          headerLine: 1,
          mapping: { lastName: 'Nom' },
          byContent: [],
        },
      },
    }));
    render(<CustomerImportDialog open onOpenChange={vi.fn()} />);

    chooseFile('Nom;Col2\nAlice;xx\n');

    expect(await screen.findByText(/Choisissez une colonne pour Téléphone/)).toBeInTheDocument();
    expect(screen.getByLabelText('Téléphone')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Importer/ })).toBeDisabled();
  });

  it('signale une colonne reconnue seulement par son contenu', async () => {
    mocks.post.mockImplementation(async (_path: string, body: Body) => ({
      data: {
        ...fakeApi(body).data,
        columns: {
          headers: ['Ref', 'Contact'],
          headerLine: 1,
          mapping: { phone: 'Contact' },
          byContent: ['phone'],
        },
      },
    }));
    render(<CustomerImportDialog open onOpenChange={vi.fn()} />);

    chooseFile('Ref;Contact\nA1;0612345678\n');

    expect(await screen.findByText(/à partir du contenu des colonnes/)).toBeInTheDocument();
    expect(screen.getByLabelText('Téléphone')).toHaveValue('Contact');
  });

  it('relance l’essai quand une colonne est corrigée à l’écran', async () => {
    mocks.post.mockImplementation(async (_path: string, body: Body) => ({
      data: {
        ...fakeApi(body).data,
        columns: {
          headers: ['Nom', 'Col2'],
          headerLine: 1,
          mapping: { lastName: 'Nom' },
          byContent: [],
        },
      },
    }));
    render(<CustomerImportDialog open onOpenChange={vi.fn()} />);
    chooseFile('Nom;Col2\nAlice;0612345678\n');
    await screen.findByText(/Choisissez une colonne pour Téléphone/);

    fireEvent.change(screen.getByLabelText('Téléphone'), { target: { value: 'Col2' } });

    await waitFor(() =>
      expect(mocks.post).toHaveBeenLastCalledWith(
        'customers/import',
        expect.objectContaining({
          dryRun: true,
          mapping: expect.objectContaining({ phone: 'Col2', email: null }),
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText(/Choisissez une colonne/)).not.toBeInTheDocument(),
    );
  });

  it('affiche un état vide quand le fichier ne contient aucune ligne', async () => {
    mocks.post.mockResolvedValue({
      data: {
        ...fakeApi({ csv: '', dryRun: true }).data,
        counts: { created: 0, completed: 0, skipped: 0 },
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
    expect(screen.getByLabelText('Fichier à importer')).toBeInTheDocument();
  });

  it('importe pour de vrai puis affiche le compte rendu', async () => {
    const onImported = vi.fn();
    render(<CustomerImportDialog open onOpenChange={vi.fn()} onImported={onImported} />);
    chooseFile();
    await screen.findByText('Aperçu des 5 premières lignes');

    fireEvent.click(screen.getByRole('button', { name: 'Importer 1 client(s)' }));

    expect(await screen.findByText('1 créé(s) · 0 complété(s) · 0 ignoré(s)')).toBeInTheDocument();
    expect(mocks.post).toHaveBeenLastCalledWith(
      'customers/import',
      expect.objectContaining({
        dryRun: false,
        mapping: expect.objectContaining({ phone: 'Téléphone', lastName: 'Nom', email: null }),
      }),
    );
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/mémorisées dans ce navigateur/)).toBeInTheDocument();
  });

  it('reprend les colonnes mémorisées au dépôt suivant', async () => {
    window.localStorage.setItem(
      'suppernote:import-columns:customers:default',
      JSON.stringify({ phone: 'Contact' }),
    );
    mocks.post.mockImplementation(async (_path: string, body: Body) => ({
      data: {
        ...fakeApi(body).data,
        columns: {
          headers: ['Nom', 'Contact'],
          headerLine: 1,
          mapping: { lastName: 'Nom' },
          byContent: [],
        },
      },
    }));
    render(<CustomerImportDialog open onOpenChange={vi.fn()} />);
    chooseFile('Nom;Contact\nAlice;0612345678\n');

    expect(
      await screen.findByText(/Colonnes reprises de votre dernier import/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Modifier les colonnes' })).toBeInTheDocument();
  });

  it('décode un export Excel en Windows-1252 (« Renée » avec un é non UTF-8)', async () => {
    render(<CustomerImportDialog open onOpenChange={vi.fn()} />);

    chooseFile(
      new Uint8Array([
        0x4e, 0x6f, 0x6d, 0x3b, 0x54, 0x65, 0x6c, 0x0a, 0x52, 0x65, 0x6e, 0xe9, 0x65, 0x3b, 0x30,
        0x36, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38,
      ]),
    );

    await screen.findByText('Aperçu des 5 premières lignes');
    expect(mocks.post).toHaveBeenCalledWith(
      'customers/import',
      expect.objectContaining({ csv: 'Nom;Tel\nRenée;0612345678' }),
    );
  });

  it('découpe un gros fichier en morceaux, sans message de refus, et garde les numéros de ligne', async () => {
    const rows = Array.from(
      { length: 30_000 },
      (_, i) => `Client ${i};06${String(i).padStart(8, '0')}`,
    );
    const big = ['Nom;Téléphone', ...rows].join('\n');
    render(<CustomerImportDialog open onOpenChange={vi.fn()} />);

    chooseFile(big);

    expect(
      await screen.findByText('30000 à créer · 0 à compléter · 0 ignorée(s)'),
    ).toBeInTheDocument();
    const pieces = mocks.post.mock.calls.filter(([, body]) => (body as Body).dryRun);
    expect(pieces.length).toBeGreaterThan(2);
    const second = pieces[2]?.[1] as Body;
    expect(second.csv.startsWith('Nom;Téléphone\n')).toBe(true);
    expect(second.lineOffset).toBeGreaterThan(0);
    expect(screen.queryByText(/découpez/i)).not.toBeInTheDocument();
  });

  it('un morceau en échec n’annule pas les précédents et permet de reprendre', async () => {
    const rows = Array.from(
      { length: 30_000 },
      (_, i) => `Client ${i};06${String(i).padStart(8, '0')}`,
    );
    const big = ['Nom;Téléphone', ...rows].join('\n');
    let failOnce = true;
    mocks.post.mockImplementation(async (_path: string, body: Body) => {
      // Second piece of the real import fails once.
      if (!body.dryRun && body.lineOffset && body.lineOffset > 0 && failOnce) {
        failOnce = false;
        throw new Error('Délai dépassé');
      }
      return fakeApi(body);
    });
    render(<CustomerImportDialog open onOpenChange={vi.fn()} />);
    chooseFile(big);
    await screen.findByText('30000 à créer · 0 à compléter · 0 ignorée(s)');

    fireEvent.click(screen.getByRole('button', { name: /Importer 30000 client/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Le morceau 2 sur \d+ n’a pas pu être importé/,
    );
    expect(screen.getByText(/Les morceaux précédents sont bien enregistrés/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reprendre à partir du morceau 2' }));

    expect(await screen.findByText(/Fichier importé en \d+ morceaux\./)).toBeInTheDocument();
  });
});
