const { buildAudit } = require('../services/pharmacyFinanceProjection.service');

describe('pharmacy finance projection audit', () => {
  test('counts a linked pharmacy sale once and reports no anomaly', () => {
    const result = buildAudit({
      range: {},
      sales: [{ _id: 's1', sale_number: 'PS-1', invoice_id: 'i1', total_amount: 100, net_amount_after_returns: 100, balance_due: 0, status: 'Completed' }],
      invoices: [{ _id: 'i1', invoice_number: 'PI-1', total: 100 }],
      bills: [{ _id: 'b1', sale_id: 's1' }],
      ledgerEntries: [{ saleId: 's1', entryType: 'SALE', direction: 'IN', paymentMethod: 'Cash', amount: 100 }],
      returns: [], advanceRows: []
    });
    expect(result.summary.netSalesAfterReturns).toBe(100);
    expect(result.summary.externalCollections).toBe(100);
    expect(result.summary.anomalyCount).toBe(0);
  });

  test('detects missing invoice and bill links', () => {
    const result = buildAudit({ range: {}, sales: [{ _id: 's1', sale_number: 'PS-1', total_amount: 100, balance_due: 100, status: 'Pending' }], invoices: [], bills: [], ledgerEntries: [], returns: [], advanceRows: [] });
    expect(result.anomalies.map((row) => row.type)).toEqual(expect.arrayContaining(['PHARMACY_SALE_WITHOUT_INVOICE', 'PHARMACY_SALE_WITHOUT_BILL']));
  });

  test('keeps advance utilization separate from external collection', () => {
    const result = buildAudit({
      range: {},
      sales: [{ _id: 's1', sale_number: 'PS-1', invoice_id: 'i1', total_amount: 100, net_amount_after_returns: 100, balance_due: 0, status: 'Completed' }],
      invoices: [{ _id: 'i1', total: 100 }], bills: [{ _id: 'b1', sale_id: 's1' }],
      ledgerEntries: [{ saleId: 's1', entryType: 'ADVANCE_USED', direction: 'NON_CASH', paymentMethod: 'PharmacyAdvance', amount: 100 }], returns: [], advanceRows: []
    });
    expect(result.summary.externalCollections).toBe(0);
    expect(result.summary.advancesUsed).toBe(100);
  });
});
