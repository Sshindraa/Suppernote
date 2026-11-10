import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { detectColumns, parseCsv } from '@suppernote/shared';
import { db } from '../../shared/db/client';
import {
  customerPhoneLookupValues,
  normalizeCustomerEmail,
  normalizeCustomerPhone,
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

/** Header name for each field, by synonym. Each header is used for at most one field. */
export function detectMapping(headers: string[]): ImportMapping {
  return detectColumns(headers, SYNONYMS, IMPORT_FIELDS);
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

/**
 * Largest CSV text accepted, in characters. Bytes decide what nginx lets through (accents take two
 * bytes, JSON escapes add more), so the dashboard also checks the exact body size before sending.
 */
export const IMPORT_CSV_MAX_CHARS = 700_000;
/** nginx's default `client_max_body_size` is 1 MiB: the whole request body has to fit under it. */
export const IMPORT_BODY_LIMIT_BYTES = 1_048_576;

export const ImportCustomersSchema = z.object({
  csv: z.string().min(1).max(IMPORT_CSV_MAX_CHARS),
  mapping: z
    .object(
      Object.fromEntries(
        IMPORT_FIELDS.map((field) => [field, z.string().max(200).nullable().optional()]),
      ),
    )
    .optional(),
  dryRun: z.boolean(),
});

/** New customers per transaction: keeps each write well under the 30 s proxy timeout. */
const BATCH_SIZE = 1_000;
/** Lines per lookup query: bounds the number of bind parameters. */
const LOOKUP_CHUNK = 500;

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

type Fills = {
  name?: string;
  emailNormalized?: string;
  birthMonth?: number;
  birthDay?: number;
  notes?: string;
};

type PendingCreate = { id: string; phone: string; line: ImportLine };

/** Only empty fields of an existing customer are filled; nothing is overwritten. */
function fillsFor(match: ExistingCustomer, line: ImportLine): Fills {
  const fills: Fills = {};
  if (!match.name && line.name) fills.name = line.name;
  if (!match.emailNormalized && line.email) fills.emailNormalized = line.email;
  if (match.birthMonth === null && line.birthMonth && line.birthDay) {
    fills.birthMonth = line.birthMonth;
    fills.birthDay = line.birthDay;
  }
  if (!match.notes && line.notes) fills.notes = line.notes;
  return fills;
}

function identityRow(
  restaurantId: string,
  customerId: string,
  type: 'PHONE' | 'EMAIL',
  value: string,
): Prisma.CustomerIdentityCreateManyInput {
  return { restaurantId, customerId, type, value, normalizedValue: value, source: 'IMPORT' };
}

/**
 * Existing customers of the file, keyed by E.164. A legacy « 06… » row of the same number is found
 * and counts as that customer; the E.164 row wins if both exist.
 */
async function loadExistingByPhone(
  restaurantId: string,
  lines: ImportLine[],
): Promise<Map<string, ExistingCustomer>> {
  const phones = [...new Set(lines.flatMap((line) => (line.phone ? [line.phone] : [])))];
  const byPhone = new Map<string, ExistingCustomer>();
  for (let start = 0; start < phones.length; start += LOOKUP_CHUNK) {
    const values = [
      ...new Set(
        phones
          .slice(start, start + LOOKUP_CHUNK)
          .flatMap((phone) => customerPhoneLookupValues(phone)),
      ),
    ];
    const rows = await db.customer.findMany({
      where: { restaurantId, phone: { in: values } },
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
    });
    for (const row of rows) {
      const key = normalizeCustomerPhone(row.phone) ?? row.phone;
      if (!byPhone.has(key) || row.phone === key) byPhone.set(key, row);
    }
  }
  return byPhone;
}

/**
 * One transaction per batch. Only the rows this batch really inserted get identities: a number
 * created in the meantime by someone else is left alone (skipDuplicates) and reported by the caller.
 */
async function insertBatch(restaurantId: string, batch: PendingCreate[]): Promise<Set<string>> {
  return db.$transaction(
    async (tx) => {
      await tx.customer.createMany({
        data: batch.map(({ id, phone, line }) => ({
          id,
          restaurantId,
          phone,
          name: line.name,
          emailNormalized: line.email,
          notes: line.notes,
          birthMonth: line.birthMonth,
          birthDay: line.birthDay,
        })),
        skipDuplicates: true,
      });
      const inserted = await tx.customer.findMany({
        where: { restaurantId, id: { in: batch.map(({ id }) => id) } },
        select: { id: true, phone: true, emailNormalized: true },
      });
      const identities = inserted.flatMap((row) => [
        identityRow(restaurantId, row.id, 'PHONE', row.phone),
        ...(row.emailNormalized
          ? [identityRow(restaurantId, row.id, 'EMAIL', row.emailNormalized)]
          : []),
      ]);
      if (identities.length > 0) {
        // The tenant is forced on every row, whatever the rows were built from.
        await tx.customerIdentity.createMany({
          data: identities.map((row) => ({ ...row, restaurantId })),
          skipDuplicates: true,
        });
      }
      return new Set(inserted.map((row) => row.id));
    },
    { timeout: 30_000 },
  );
}

/**
 * Creates or completes customers from a reading. Matches on the E.164 phone (legacy forms included),
 * never touches consent or marketing permissions, and writes nothing when `dryRun` is set.
 */
export async function applyCustomerImport(
  restaurantId: string,
  reading: ImportReading,
  dryRun: boolean,
): Promise<ImportOutcome> {
  const existing = await loadExistingByPhone(restaurantId, reading.lines);
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

  let pending: PendingCreate[] = [];
  const flush = async () => {
    const batch = pending;
    pending = [];
    if (batch.length === 0) return;
    try {
      const inserted = await insertBatch(restaurantId, batch);
      for (const item of batch) {
        if (inserted.has(item.id)) outcome.counts.created += 1;
        else skip(item.line.line, 'Client créé en même temps par une autre saisie');
      }
    } catch {
      // The batch transaction rolled back: nothing from it is reported as created.
      for (const item of batch) skip(item.line.line, 'Enregistrement impossible');
    }
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

    const match = existing.get(line.phone);
    if (!match) {
      if (dryRun) {
        outcome.counts.created += 1;
      } else {
        pending.push({ id: randomUUID(), phone: line.phone, line });
        if (pending.length >= BATCH_SIZE) await flush();
      }
      continue;
    }
    if (match.archivedAt || match.mergedIntoId) {
      skip(line.line, 'Client archivé ou fusionné');
      continue;
    }
    const fills = fillsFor(match, line);
    if (Object.keys(fills).length === 0) {
      skip(line.line, 'Client existant, rien à compléter');
      continue;
    }
    if (dryRun) {
      outcome.counts.completed += 1;
      continue;
    }
    try {
      await db.$transaction(async (tx) => {
        await tx.customer.update({
          where: { id: match.id, restaurantId },
          data: fills,
          select: { id: true },
        });
        // The e-mail identity follows the e-mail actually stored, never the one only sent.
        if (fills.emailNormalized) {
          await tx.customerIdentity.createMany({
            data: [identityRow(restaurantId, match.id, 'EMAIL', fills.emailNormalized)],
            skipDuplicates: true,
          });
        }
      });
      outcome.counts.completed += 1;
    } catch {
      skip(line.line, 'Enregistrement impossible');
    }
  }
  await flush();
  return outcome;
}
