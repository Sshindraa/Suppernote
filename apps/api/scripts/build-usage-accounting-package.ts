/**
 * Build a destination-neutral accounting import package.
 *
 * The package keeps the operator usage export (EUR) and vendor invoice lines
 * (original currency, for example a Telnyx MRC in USD) in separate files. It
 * is intentionally file-based until Suppernote chooses an accounting provider and
 * supplies its credentials. No network request or database write is made.
 *
 * Example:
 *   pnpm --filter @suppernote/api usage:accounting:package -- \
 *     --month 2026-08 \
 *     --usage-csv ./private/suppernote-usage-accounting-2026-08.csv \
 *     --invoice ./private/telnyx-invoice-2026-08.json \
 *     --invoice-pdf ./private/telnyx-invoice-2026-08.pdf \
 *     --reconciliation ./private/telnyx-reconciliation-2026-08.json \
 *     --mrc-amount 1.00 --mrc-currency USD \
 *     --output-dir ./private/accounting/2026-08
 */

import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import {
  assertUsageAccountingCsv,
  buildAccountingPackageManifest,
  buildVendorInvoiceAccountingRow,
  sha256Hex,
  serializeAccountingPackageManifest,
  vendorInvoiceAccountingToCsv,
  type AccountingReconciliationCounts,
} from '../src/modules/usage/usage-accounting-package.service.js';

interface Args {
  readonly month: string;
  readonly usageCsv: string;
  readonly invoice: string;
  readonly invoicePdf: string;
  readonly reconciliation: string;
  readonly mrcAmount: string;
  readonly mrcCurrency: string;
  readonly outputDir: string;
  readonly importReceipt?: string;
}

const log = (message: string): void => process.stdout.write(`${message}\n`);

function usage(): void {
  log(`Usage: tsx build-usage-accounting-package.ts --month YYYY-MM [options]

Options:
  --month <YYYY-MM>             Provider invoice month (required).
  --usage-csv <path>            Operator CSV from /admin/usage/accounting-export.csv.
  --invoice <path>              Telnyx invoice metadata JSON (required).
  --invoice-pdf <path>          Downloaded provider invoice PDF (required).
  --reconciliation <path>       Read-only reconciliation JSON (required).
  --mrc-amount <decimal>        MRC amount read from the invoice (required).
  --mrc-currency <ISO-4217>     Original MRC currency, e.g. USD (required).
  --output-dir <path>           Directory for the import package (required).
  --import-receipt <id>         Existing downstream receipt; marks package IMPORTED.
  --help, -h                    Show this help.`);
}

function parseArgs(): Args {
  const raw = process.argv.slice(2);
  if (raw[0] === '--') raw.shift();
  const values = new Map<string, string>();
  for (let index = 0; index < raw.length; index++) {
    const arg = raw[index];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    const value = raw[++index];
    if (!arg?.startsWith('--') || !value || value.startsWith('-')) {
      throw new Error(`${arg ?? '<missing option>'} requires a value`);
    }
    if (values.has(arg)) throw new Error(`${arg} cannot be repeated`);
    values.set(arg, value);
  }
  const required = [
    '--month',
    '--usage-csv',
    '--invoice',
    '--invoice-pdf',
    '--reconciliation',
    '--mrc-amount',
    '--mrc-currency',
    '--output-dir',
  ];
  for (const option of required) if (!values.get(option)) throw new Error(`${option} is required`);
  const month = values.get('--month')!;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('--month must use YYYY-MM');
  return {
    month,
    usageCsv: values.get('--usage-csv')!,
    invoice: values.get('--invoice')!,
    invoicePdf: values.get('--invoice-pdf')!,
    reconciliation: values.get('--reconciliation')!,
    mrcAmount: values.get('--mrc-amount')!,
    mrcCurrency: values.get('--mrc-currency')!.toUpperCase(),
    outputDir: values.get('--output-dir')!,
    importReceipt: values.get('--import-receipt'),
  };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is missing`);
  return value.trim();
}

function count(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} is invalid`);
  return value as number;
}

function monthPeriod(month: string): { readonly start: string; readonly end: string } {
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return { start: `${month}-01`, end: lastDay };
}

function assertMonthPeriod(
  month: string,
  periodStart: string,
  periodEnd: string,
  field: string,
): void {
  const expected = monthPeriod(month);
  if (periodStart !== expected.start || periodEnd !== expected.end) {
    throw new Error(`${field} period ${periodStart}..${periodEnd} does not match ${month}`);
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return object(JSON.parse(await readFile(path, 'utf8')) as unknown, path);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const usagePath = resolve(process.cwd(), args.usageCsv);
  const invoicePath = resolve(process.cwd(), args.invoice);
  const invoicePdfPath = resolve(process.cwd(), args.invoicePdf);
  const reconciliationPath = resolve(process.cwd(), args.reconciliation);
  const outputDir = resolve(process.cwd(), args.outputDir);

  const usageCsv = await readFile(usagePath, 'utf8');
  assertUsageAccountingCsv(usageCsv);
  const invoice = await readJson(invoicePath);
  const invoiceFile = object(invoice.invoiceFile, 'invoice.invoiceFile');
  const reconciliation = await readJson(reconciliationPath);
  const countsRaw = object(reconciliation.counts, 'reconciliation.counts');
  const counts: AccountingReconciliationCounts = {
    MATCH: count(countsRaw.MATCH, 'reconciliation.counts.MATCH'),
    MISMATCH: count(countsRaw.MISMATCH, 'reconciliation.counts.MISMATCH'),
    INVOICE_ONLY: count(countsRaw.INVOICE_ONLY, 'reconciliation.counts.INVOICE_ONLY'),
    USAGE_ONLY: count(countsRaw.USAGE_ONLY, 'reconciliation.counts.USAGE_ONLY'),
    UNPRICED_USAGE: count(countsRaw.UNPRICED_USAGE, 'reconciliation.counts.UNPRICED_USAGE'),
  };
  const invoiceId = text(invoice.invoiceId, 'invoice.invoiceId');
  const periodStart = text(invoice.periodStart, 'invoice.periodStart');
  const periodEnd = text(invoice.periodEnd, 'invoice.periodEnd');
  assertMonthPeriod(args.month, periodStart, periodEnd, 'invoice');
  const paid = invoice.paid;
  const invoiceStatus = paid === true ? 'PAID' : paid === false ? 'OPEN' : 'UNKNOWN';
  const reportHash = text(reconciliation.reportHash, 'reconciliation.reportHash');
  const scope = object(reconciliation.scope, 'reconciliation.scope');
  const scopeStart = text(scope.start, 'reconciliation.scope.start');
  const scopeEnd = text(scope.end, 'reconciliation.scope.end');
  const expectedScope = monthPeriod(args.month);
  if (
    scopeStart !== `${expectedScope.start}T00:00:00.000Z` ||
    scopeEnd !==
      `${new Date(Date.UTC(Number(args.month.slice(0, 4)), Number(args.month.slice(5), 10), 1)).toISOString()}`
  ) {
    throw new Error(`reconciliation scope does not match ${args.month}`);
  }

  await stat(invoicePdfPath);
  const pdfBytes = await readFile(invoicePdfPath);
  if (pdfBytes.length === 0) throw new Error('invoice PDF is empty');
  const pdfHash = sha256Hex(pdfBytes);
  const declaredPdfHash = text(invoiceFile.sha256, 'invoice.invoiceFile.sha256');
  if (declaredPdfHash.toLowerCase() !== pdfHash) {
    throw new Error('invoice PDF hash does not match invoice metadata manifest');
  }

  await mkdir(outputDir, { recursive: true });
  const usageOutput = join(outputDir, `suppernote-usage-accounting-${args.month}.csv`);
  const vendorOutput = join(outputDir, `suppernote-vendor-invoices-${args.month}.csv`);
  const reconciliationOutput = join(outputDir, `suppernote-reconciliation-${args.month}.json`);
  const invoiceDocumentOutput = join(
    outputDir,
    `telnyx-invoice-${args.month}${extname(invoicePdfPath).toLowerCase() || '.pdf'}`,
  );
  const manifestOutput = join(outputDir, `suppernote-accounting-package-${args.month}.json`);

  await writeFile(usageOutput, usageCsv, 'utf8');
  await writeFile(reconciliationOutput, `${JSON.stringify(reconciliation, null, 2)}\n`, 'utf8');
  await copyFile(invoicePdfPath, invoiceDocumentOutput);

  const relativeInvoiceDocument = basename(invoiceDocumentOutput);
  const packageInput = {
    month: args.month,
    provider: 'telnyx',
    invoiceId,
    invoiceStatus,
    periodStart,
    periodEnd,
    mrcAmount: args.mrcAmount,
    mrcCurrency: args.mrcCurrency,
    invoiceDocument: relativeInvoiceDocument,
    invoiceDocumentSha256: pdfHash,
    usageExportSha256: sha256Hex(usageCsv),
    reconciliationFileSha256: sha256Hex(await readFile(reconciliationOutput)),
    reconciliationReportHash: reportHash,
    reconciliationCounts: counts,
    destination: 'file' as const,
    importReceipt: args.importReceipt ?? null,
  };
  const vendorRow = buildVendorInvoiceAccountingRow(packageInput);
  const vendorCsv = vendorInvoiceAccountingToCsv({ row: vendorRow });
  await writeFile(vendorOutput, vendorCsv, 'utf8');
  const manifest = buildAccountingPackageManifest(
    { ...packageInput, vendorInvoiceSha256: sha256Hex(vendorCsv) },
    {
      usageExportFile: basename(usageOutput),
      vendorInvoiceFile: basename(vendorOutput),
      reconciliationFile: basename(reconciliationOutput),
      invoiceDocumentFile: relativeInvoiceDocument,
    },
  );
  await writeFile(manifestOutput, serializeAccountingPackageManifest(manifest), 'utf8');

  log(`[PACKAGE] ${outputDir}`);
  log(`[USAGE] ${basename(usageOutput)} sha256=${packageInput.usageExportSha256}`);
  log(`[VENDOR] ${basename(vendorOutput)} ${args.mrcAmount} ${args.mrcCurrency} MRC`);
  log(`[RECONCILIATION] ${reportHash} MATCH=${counts.MATCH}`);
  log(`[DOCUMENT] ${relativeInvoiceDocument} sha256=${pdfHash}`);
  log(`[DESTINATION] file/${manifest.destination.status}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
