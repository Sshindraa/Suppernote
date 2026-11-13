import { describe, expect, it } from 'vitest';
import {
  assertUsageAccountingCsv,
  buildAccountingPackageManifest,
  buildVendorInvoiceAccountingRow,
  sha256Hex,
  vendorInvoiceAccountingToCsv,
  type AccountingPackageInput,
} from '../usage-accounting-package.service';

const hash = 'a'.repeat(64);
const input: AccountingPackageInput = {
  month: '2026-08',
  provider: 'telnyx',
  invoiceId: 'e1d3f6aa-db84-43b9-87d7-6c5331a68cb1',
  invoiceStatus: 'PAID',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  mrcAmount: '1.00',
  mrcCurrency: 'USD',
  invoiceDocument: 'telnyx-invoice-2026-08.pdf',
  invoiceDocumentSha256: hash,
  usageExportSha256: hash,
  reconciliationFileSha256: hash,
  vendorInvoiceSha256: hash,
  reconciliationReportHash: hash,
  reconciliationCounts: {
    MATCH: 2,
    MISMATCH: 0,
    INVOICE_ONLY: 0,
    USAGE_ONLY: 0,
    UNPRICED_USAGE: 0,
  },
  destination: 'file',
};

describe('usage accounting package', () => {
  it('keeps the vendor MRC in its original currency and separate CSV schema', () => {
    const row = buildVendorInvoiceAccountingRow(input);
    expect(row).toMatchObject({
      rowType: 'VENDOR_INVOICE',
      lineType: 'MRC',
      amount: '1.00',
      currency: 'USD',
      unit: 'month',
      accountingStatus: 'READY_FOR_IMPORT',
    });
    const csv = vendorInvoiceAccountingToCsv({ row });
    expect(csv).toContain('"amount","currency"');
    expect(csv).toContain('"1.00","USD"');
  });

  it('rejects a package when reconciliation contains an unresolved difference', () => {
    expect(() =>
      buildVendorInvoiceAccountingRow({
        ...input,
        reconciliationCounts: { ...input.reconciliationCounts, INVOICE_ONLY: 1 },
      }),
    ).toThrow(/only MATCH/);
  });

  it('validates the versioned operator usage header and builds a stable package id', () => {
    const usageHeader =
      '"schema_version","month","row_type","restaurant_id","restaurant_name","plan","category","provider","unit","period_start","period_end","quantity","cost_eur","currency","cost_status","event_count","source","report_hash","adjustment_id","adjustment_status","reason"\n';
    expect(() => assertUsageAccountingCsv(usageHeader)).not.toThrow();
    const manifest = buildAccountingPackageManifest(input, {
      usageExportFile: 'suppernote-usage-accounting-2026-08.csv',
      vendorInvoiceFile: 'suppernote-vendor-invoices-2026-08.csv',
      reconciliationFile: 'suppernote-reconciliation-2026-08.json',
      invoiceDocumentFile: 'telnyx-invoice-2026-08.pdf',
    });
    expect(manifest.packageId).toMatch(/^sokar-accounting-2026-08-[a-f0-9]{16}$/);
    expect(manifest.vendorInvoice.mrc).toEqual({ amount: '1.00', currency: 'USD', unit: 'month' });
    expect(sha256Hex('suppernote')).toHaveLength(64);
  });
});
