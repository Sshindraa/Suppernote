import { z } from 'zod';
import { db } from '../../shared/db/client';
import {
  normalizeCustomerEmail,
  normalizeCustomerPhone,
  upsertCustomerIdentity,
} from './customer-crm.service';

/** Fields the importer understands; the owner can remap any of them on screen. */
export const IMPORT_FIELDS = [
  'firstName',
  'lastName',
  'name',
  'phone',
  'email',
  'notes',
  'birthday',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
/** Field → header name in the file. `null` means the field is not imported. */
export type ImportMapping = Partial<Record<ImportField, string | null>>;

export const IMPORT_ROW_LIMIT = 10_000;

// Synonyms are compared after `normalizeHeader`: lowercase, no accents, letters and digits only.
const SYNONYMS: Record<ImportField, string[]> = {
  firstName: ['prenom', 'firstname', 'givenname'],
  lastName: ['nom', 'nomdefamille', 'lastname', 'surname'],
  name: ['nomcomplet', 'nomclient', 'client', 'name', 'fullname'],
  phone: [
    'telephone',
    'tel',
    'mobile',
    'portable',
    'gsm',
    'phone',
    'numerodetelephone',
    'telephonemobile',
    'telephoneportable',
  ],
  email: ['email', 'mail', 'courriel', 'adressemail', 'adressecourriel'],
  notes: ['notes', 'note', 'commentaire', 'commentaires', 'remarque', 'remarques', 'comment'],
  birthday: ['anniversaire', 'datedanniversaire', 'datedenaissance', 'naissance', 'birthday'],
};

export type CsvRecord = { line: number; cells: string[] };

export type ImportLine = {
  line: number;
  phone: string | null;
  name: string | null;
  email: string | null;
  notes: string | null;
  birthMonth: number | null;
  birthDay: number | null;
};

export type ImportReading = {
  headers: string[];
  mapping: ImportMapping;
  lines: ImportLine[];
};

export function normalizeHeader(value: string): string {
  return value
    .replace(/^﻿/, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** `;` or `,`, whichever the header line uses more (French Excel exports use `;`). */
function detectDelimiter(text: string): ';' | ',' {
  const head = text.split(/\r?\n/, 1)[0] ?? '';
  const commas = head.split(',').length - 1;
  const semicolons = head.split(';').length - 1;
  return commas > semicolons ? ',' : ';';
}

/** RFC 4180 reader: quoted cells, `""` escapes, newlines inside quotes, CRLF or LF. */
export function parseCsv(input: string): CsvRecord[] {
  const text = input.replace(/^﻿/, '');
  const delimiter = detectDelimiter(text);
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;

  const endRecord = () => {
    cells.push(cell);
    if (cells.some((value) => value.trim() !== '')) records.push({ line: recordLine, cells });
    cells = [];
    cell = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || cells.length > 0) endRecord();
  return records;
}

/** Header name for each field, by synonym. Each header is used for at most one field. */
export function detectMapping(headers: string[]): ImportMapping {
  const mapping: ImportMapping = {};
  const used = new Set<string>();
  for (const field of IMPORT_FIELDS) {
    const header = headers.find(
      (candidate) => !used.has(candidate) && SYNONYMS[field].includes(normalizeHeader(candidate)),
    );
    if (header !== undefined) {
      mapping[field] = header;
      used.add(header);
    }
  }
  return mapping;
}

/** Accepts `JJ/MM`, `JJ/MM/AAAA` and `AAAA-MM-JJ`; anything else (or an impossible date) is ignored. */
export function parseBirthday(value: string): { month: number; day: number } | null {
  const french = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-]\d{2,4})?$/.exec(value);
  const iso = /^\d{4}-(\d{1,2})-(\d{1,2})$/.exec(value);
  const match = french ?? iso;
  if (!match) return null;
  const [day, month] = french
    ? [Number(match[1]), Number(match[2])]
    : [Number(match[2]), Number(match[1])];
  // Leap day allowed: the year is unknown.
  const probe = new Date(Date.UTC(2000, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { month, day };
}

/**
 * Reads a customer CSV into normalised lines. Throws a readable Error when the mapping names a
 * header the file does not have. Personal values stay in memory: callers must not log them.
 */
export function readCustomerImport(input: string, requested?: ImportMapping): ImportReading {
  const records = parseCsv(input);
  const [header, ...body] = records;
  const headers = header ? header.cells.map((cell) => cell.trim()) : [];
  const mapping: ImportMapping = requested ?? detectMapping(headers);
  for (const field of IMPORT_FIELDS) {
    const column = mapping[field];
    if (column && !headers.includes(column)) {
      throw new Error(`Colonne introuvable dans le fichier : ${column}`);
    }
  }

  const valueOf = (cells: string[], field: ImportField): string | null => {
    const column = mapping[field];
    if (!column) return null;
    const index = headers.indexOf(column);
    const value = (cells[index] ?? '').trim();
    return value === '' ? null : value;
  };

  const lines = body.map(({ line, cells }): ImportLine => {
    const first = valueOf(cells, 'firstName');
    const last = valueOf(cells, 'lastName');
    const name = [first, last].filter(Boolean).join(' ') || valueOf(cells, 'name');
    const phoneRaw = valueOf(cells, 'phone');
    const emailRaw = valueOf(cells, 'email');
    const birthday = valueOf(cells, 'birthday');
    const parsedBirthday = birthday ? parseBirthday(birthday) : null;
    return {
      line,
      phone: phoneRaw ? normalizeCustomerPhone(phoneRaw) : null,
      name: name ? name.slice(0, 100) : null,
      email: emailRaw ? normalizeCustomerEmail(emailRaw) : null,
      notes: valueOf(cells, 'notes')?.slice(0, 500) ?? null,
      birthMonth: parsedBirthday?.month ?? null,
      birthDay: parsedBirthday?.day ?? null,
    };
  });

  return { headers, mapping, lines };
}

export const ImportCustomersSchema = z.object({
  csv: z.string().min(1).max(5_000_000),
  mapping: z
    .object(
      Object.fromEntries(
        IMPORT_FIELDS.map((field) => [field, z.string().max(200).nullable().optional()]),
      ),
    )
    .optional(),
  dryRun: z.boolean(),
});

export type ImportOutcome = {
  counts: { created: number; completed: number; skipped: number };
  /** Line numbers and reasons only: no personal data. */
  reasons: { line: number; reason: string }[];
  /** Dry run only: the first lines as they would be imported, for the owner to check. */
  preview: Pick<ImportLine, 'name' | 'phone' | 'email' | 'birthMonth' | 'birthDay'>[];
};

type ExistingCustomer = {
  id: string;
  phone: string;
  name: string | null;
  emailNormalized: string | null;
  birthMonth: number | null;
  notes: string | null;
  archivedAt: Date | null;
  mergedIntoId: string | null;
};

/** Only empty fields of an existing customer are filled; nothing is overwritten. */
function fillsFor(match: ExistingCustomer, line: ImportLine) {
  return {
    ...(!match.name && line.name ? { name: line.name } : {}),
    ...(!match.emailNormalized && line.email ? { emailNormalized: line.email } : {}),
    ...(match.birthMonth === null && line.birthMonth
      ? { birthMonth: line.birthMonth, birthDay: line.birthDay }
      : {}),
    ...(!match.notes && line.notes ? { notes: line.notes } : {}),
  };
}

/**
 * Creates or completes customers from a reading. Matches on (restaurantId, phone), never
 * touches consent or marketing permissions, and writes nothing when `dryRun` is set.
 */
export async function applyCustomerImport(
  restaurantId: string,
  reading: ImportReading,
  dryRun: boolean,
): Promise<ImportOutcome> {
  const phones = [...new Set(reading.lines.flatMap((line) => (line.phone ? [line.phone] : [])))];
  const existing: ExistingCustomer[] = phones.length
    ? await db.customer.findMany({
        where: { restaurantId, phone: { in: phones } },
        select: {
          id: true,
          phone: true,
          name: true,
          emailNormalized: true,
          birthMonth: true,
          notes: true,
          archivedAt: true,
          mergedIntoId: true,
        },
      })
    : [];
  const byPhone = new Map(existing.map((customer) => [customer.phone, customer]));
  const seen = new Set<string>();
  const outcome: ImportOutcome = {
    counts: { created: 0, completed: 0, skipped: 0 },
    reasons: [],
    preview: reading.lines.slice(0, 5).map(({ name, phone, email, birthMonth, birthDay }) => ({
      name,
      phone,
      email,
      birthMonth,
      birthDay,
    })),
  };
  const skip = (line: number, reason: string) => {
    outcome.counts.skipped += 1;
    outcome.reasons.push({ line, reason });
  };

  for (const line of reading.lines) {
    if (!line.phone) {
      skip(line.line, 'Téléphone absent ou invalide');
      continue;
    }
    if (seen.has(line.phone)) {
      skip(line.line, 'Numéro déjà présent plus haut dans le fichier');
      continue;
    }
    seen.add(line.phone);

    const match = byPhone.get(line.phone);
    if (match && (match.archivedAt || match.mergedIntoId)) {
      skip(line.line, 'Client archivé ou fusionné');
      continue;
    }
    const fills = match ? fillsFor(match, line) : null;
    if (match && fills && Object.keys(fills).length === 0) {
      skip(line.line, 'Client existant, rien à compléter');
      continue;
    }

    if (!dryRun) {
      try {
        await db.$transaction(async (tx) => {
          const customerId = match
            ? (
                await tx.customer.update({
                  where: { id: match.id, restaurantId },
                  data: fills!,
                })
              ).id
            : (
                await tx.customer.create({
                  data: {
                    restaurantId,
                    phone: line.phone!,
                    name: line.name,
                    emailNormalized: line.email,
                    notes: line.notes,
                    birthMonth: line.birthMonth,
                    birthDay: line.birthDay,
                  },
                })
              ).id;
          await upsertCustomerIdentity(
            { restaurantId, customerId, type: 'PHONE', value: line.phone!, source: 'IMPORT' },
            tx,
          );
          if (line.email) {
            await upsertCustomerIdentity(
              { restaurantId, customerId, type: 'EMAIL', value: line.email, source: 'IMPORT' },
              tx,
            );
          }
        });
      } catch {
        // A concurrent insert of the same number lands here: reported, never leaked.
        skip(line.line, 'Enregistrement impossible');
        continue;
      }
    }
    if (match) outcome.counts.completed += 1;
    else outcome.counts.created += 1;
  }
  return outcome;
}
