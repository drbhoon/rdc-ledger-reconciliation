import { v4 as uuid } from 'uuid';
import { within } from './amount';
import { daysBetween, isOutsidePeriod } from './date';
import { normalizeNarration } from './reference';
import type { MatchRow, NormalizedTxn, ParseResult, ReconcileOptions, ReconcileResult, ReasonCode, SummaryLine, VoucherType } from './types';
const invoiceTypes: VoucherType[] = ['INVOICE','JOURNAL_INVOICE','DEBIT_NOTE'];
const paymentTypes: VoucherType[] = ['RECEIPT','PAYMENT'];
const tdsTypes: VoucherType[] = ['TDS','JOURNAL_TDS'];
const creditTypes: VoucherType[] = ['CREDIT_NOTE'];
function absSigned(t: NormalizedTxn) { return Math.abs(t.signedAmountRdcView); }
function refKey(t: NormalizedTxn) { return t.normalizedReferenceNo || t.extractedReferences?.[0] || ''; }
function matchRow(input: Partial<MatchRow>): MatchRow { return { matchId: uuid(), matchStatus: 'EXCEPTION', difference: 0, confidence: 0, ...input }; }
export function applyCustomerNetZeroReversals(customer: ParseResult, tolerance = 1) {
  const groups = new Map<string, NormalizedTxn[]>();
  for (const txn of customer.transactions) {
    if (txn.sourceSide !== 'CUSTOMER') continue;
    const amount = Math.max(txn.debit, txn.credit);
    if (!amount || !(paymentTypes.includes(txn.voucherType) || txn.voucherType === 'OTHER' || /bank|payment|reversal|journal/i.test(txn.particulars || ''))) continue;
    const narrationKey = normalizeNarration(txn.narration || txn.particulars).replace(/\b(TO|BY)\b/g, '').trim();
    const referenceContext = txn.chequeNo || refKey(txn);
    const context = referenceContext
      ? [txn.partyName || '', txn.date || '', amount.toFixed(2), referenceContext].join('|')
      : [txn.partyName || '', txn.date || '', amount.toFixed(2), narrationKey].join('|');
    txn.nettingGroupKey = context;
    groups.set(context, [...(groups.get(context) || []), txn]);
  }
  const netZero: NormalizedTxn[] = [];
  for (const group of groups.values()) {
    const debit = group.reduce((s, t) => s + t.debit, 0);
    const credit = group.reduce((s, t) => s + t.credit, 0);
    if (group.length > 1 && within(debit, credit, tolerance)) {
      for (const txn of group) {
        txn.isNetZeroReversal = true;
        txn.voucherType = 'REVERSAL';
        txn.parserNotes = [...(txn.parserNotes || []), 'Customer payment reversal netted to zero'];
        netZero.push(txn);
      }
    }
  }
  return netZero;
}
export function reconcile(rdc: ParseResult, customer: ParseResult, options: ReconcileOptions): ReconcileResult {
  const netZeroReversals = applyCustomerNetZeroReversals(customer, options.paymentTolerance);
  const activeCustomer = customer.transactions.filter(t => !t.isNetZeroReversal);
  const outsidePeriodCustomerTxns = activeCustomer.filter(t => isOutsidePeriod(t.date, options.periodStart, options.periodEnd));
  const customerInPeriod = activeCustomer.filter(t => !isOutsidePeriod(t.date, options.periodStart, options.periodEnd));
  const rdcInPeriod = rdc.transactions.filter(t => !isOutsidePeriod(t.date, options.periodStart, options.periodEnd));
  const usedRdc = new Set<string>();
  const usedCust = new Set<string>();
  const matches: MatchRow[] = [];
  const possibleMatches: MatchRow[] = [];
  const tryMatch = (rdcTxn: NormalizedTxn, candidates: NormalizedTxn[], types: VoucherType[], dateTolerance: number, amountTolerance: number) => {
    const rref = refKey(rdcTxn);
    const amount = absSigned(rdcTxn);
    let best: { txn: NormalizedTxn; confidence: number; reason?: string } | undefined;
    for (const c of candidates) {
      if (usedCust.has(c.id) || !types.includes(c.voucherType)) continue;
      const cref = refKey(c);
      const sameRef = !!(rref && cref && rref === cref);
      const amountOk = within(amount, absSigned(c), amountTolerance);
      const dateOk = daysBetween(rdcTxn.date, c.date) <= dateTolerance;
      if (sameRef && amountOk) return { txn: c, confidence: 100, reason: c.extractedReferences?.includes(c.referenceNo || '') ? 'Reference found in narration' : 'Reference matched' };
      if (amountOk && dateOk) best = { txn: c, confidence: 72, reason: 'Amount and date near; review required' };
    }
    return best;
  };
  for (const r of rdcInPeriod) {
    const types = invoiceTypes.includes(r.voucherType) ? invoiceTypes : tdsTypes.includes(r.voucherType) ? tdsTypes : paymentTypes.includes(r.voucherType) ? paymentTypes : creditTypes.includes(r.voucherType) ? creditTypes : [];
    if (!types.length) continue;
    const found = tryMatch(r, customerInPeriod, types, paymentTypes.includes(r.voucherType) ? options.paymentDateToleranceDays : options.invoiceDateToleranceDays, paymentTypes.includes(r.voucherType) ? options.paymentTolerance : options.invoiceTolerance);
    if (found && found.confidence >= 75) {
      usedRdc.add(r.id); usedCust.add(found.txn.id);
      matches.push(matchRow({ matchStatus: 'MATCHED', rdcTxn: r, customerTxn: found.txn, rdcAmount: r.signedAmountRdcView, customerAmount: found.txn.signedAmountRdcView, difference: r.signedAmountRdcView - found.txn.signedAmountRdcView, confidence: found.confidence, remarks: found.reason }));
    } else if (found) {
      possibleMatches.push(matchRow({ matchStatus: 'POSSIBLE', reasonCode: 'POSSIBLE_MATCH_REVIEW_REQUIRED', rdcTxn: r, customerTxn: found.txn, rdcAmount: r.signedAmountRdcView, customerAmount: found.txn.signedAmountRdcView, difference: r.signedAmountRdcView - found.txn.signedAmountRdcView, confidence: found.confidence, remarks: found.reason }));
    }
  }
  const unmatchedRdc = rdcInPeriod.filter(t => !usedRdc.has(t.id) && !['OTHER'].includes(t.voucherType)).map(t => matchRow({ reasonCode: reasonForRdc(t), rdcTxn: t, rdcAmount: t.signedAmountRdcView, difference: t.signedAmountRdcView, confidence: t.parseConfidence, remarks: 'Present in RDC only' }));
  const unmatchedCustomer = customerInPeriod.filter(t => !usedCust.has(t.id) && !['OTHER'].includes(t.voucherType)).map(t => matchRow({ reasonCode: reasonForCustomer(t), customerTxn: t, customerAmount: t.signedAmountRdcView, difference: -t.signedAmountRdcView, confidence: t.parseConfidence, remarks: 'Present in customer only' }));
  const outsidePeriodCustomer = outsidePeriodCustomerTxns.map(t => matchRow({ matchStatus: 'INFO', reasonCode: 'OUTSIDE_RDC_PERIOD_PRESENT_IN_CUSTOMER', customerTxn: t, customerAmount: t.signedAmountRdcView, difference: -t.signedAmountRdcView, confidence: t.parseConfidence, remarks: 'Customer ledger item outside selected RDC period' }));
  const openingClosing = openingClosingRows(rdc, customer);
  const tdsCompare = [...matches, ...unmatchedRdc, ...unmatchedCustomer].filter(m => [m.rdcTxn?.voucherType, m.customerTxn?.voucherType].some(v => v && tdsTypes.includes(v)));
  const journalEntries = customer.transactions.filter(t => t.voucherType.startsWith('JOURNAL') || t.parserNotes?.includes('SOURCE_VOUCHER_TYPE_JOURNAL'));
  const summaryLines = buildSummary(rdc, customer, [...unmatchedRdc, ...unmatchedCustomer, ...outsidePeriodCustomer], netZeroReversals, options);
  const cards = { matchedCount: matches.length, possibleCount: possibleMatches.length, unmatchedRdcCount: unmatchedRdc.length, unmatchedCustomerCount: unmatchedCustomer.length, outsidePeriodCustomerCount: outsidePeriodCustomer.length, netZeroReversalCount: netZeroReversals.length, journalEntriesConsidered: journalEntries.length, tdsExceptionCount: tdsCompare.filter(t => t.matchStatus !== 'MATCHED').length, unexplainedDifference: summaryLines.at(-1)?.amount || 0 };
  return { options, rdc, customer: { ...customer, transactions: activeCustomer }, matches, possibleMatches, unmatchedRdc, unmatchedCustomer, outsidePeriodCustomer, netZeroReversals, tdsCompare, journalEntries, openingClosing, summaryLines, parserLog: [...rdc.parserLog, ...customer.parserLog], cards };
}
function reasonForRdc(t: NormalizedTxn): ReasonCode {
  if (t.parserNotes?.includes('LOW_PARSE_CONFIDENCE_REFERENCE_REVIEW')) return 'LOW_PARSE_CONFIDENCE_REFERENCE_REVIEW';
  if (t.parseConfidence < 75) return 'LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED';
  if (tdsTypes.includes(t.voucherType)) return 'TDS_NOT_FOUND';
  return 'MISSING_IN_CUSTOMER';
}
function reasonForCustomer(t: NormalizedTxn): ReasonCode {
  if (t.parserNotes?.includes('LOW_PARSE_CONFIDENCE_REFERENCE_REVIEW')) return 'LOW_PARSE_CONFIDENCE_REFERENCE_REVIEW';
  if (t.parserNotes?.includes('LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED') || t.parseConfidence < 75) return 'LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED';
  if (t.voucherType === 'JOURNAL_TDS') return 'TDS_JOURNAL_NOT_IN_RDC';
  if (t.voucherType === 'JOURNAL_INVOICE') return 'JOURNAL_INVOICE_NOT_IN_RDC';
  if (t.voucherType === 'JOURNAL_ADJUSTMENT') return 'JOURNAL_ADJUSTMENT_REVIEW';
  return 'MISSING_IN_RDC';
}
function openingClosingRows(rdc: ParseResult, customer: ParseResult) {
  const rows: MatchRow[] = [];
  const openingDiff = (rdc.balances.opening || 0) - (customer.balances.opening || 0);
  if (Math.abs(openingDiff) > 1) rows.push(matchRow({ reasonCode: 'OPENING_BALANCE_MISMATCH', rdcAmount: rdc.balances.opening, customerAmount: customer.balances.opening, difference: openingDiff, confidence: 100, remarks: 'Opening balances stored separately' }));
  const closingDiff = (rdc.balances.closing || 0) - (customer.balances.closing || 0);
  if (Math.abs(closingDiff) > 1) rows.push(matchRow({ reasonCode: 'CLOSING_BALANCE_MISMATCH', rdcAmount: rdc.balances.closing, customerAmount: customer.balances.closing, difference: closingDiff, confidence: 100, remarks: 'Closing balances stored separately' }));
  return rows;
}
function buildSummary(rdc: ParseResult, customer: ParseResult, exceptions: MatchRow[], netZero: NormalizedTxn[], options: ReconcileOptions): SummaryLine[] {
  const rdcBal = rdc.balances.closing ?? rdc.transactions.reduce((s,t)=>s+t.signedAmountRdcView, rdc.balances.opening || 0);
  const custBal = customer.balances.closing ?? customer.transactions.filter(t=>!t.isNetZeroReversal).reduce((s,t)=>s+t.signedAmountRdcView, customer.balances.opening || 0);
  const lines: SummaryLine[] = [
    { sign: '', particular: 'Balance As per RDC', amount: rdcBal },
    { sign: '', particular: 'Balance As per ' + options.partyName, amount: custBal },
    { sign: '', particular: 'Difference', amount: rdcBal - custBal, remarks: 'RDC receivable - Customer receivable-view balance' },
  ];
  const grouped = new Map<string, MatchRow[]>();
  for (const e of exceptions) grouped.set(e.reasonCode || 'LOW_PARSE_CONFIDENCE', [...(grouped.get(e.reasonCode || 'LOW_PARSE_CONFIDENCE') || []), e]);
  for (const [reason, rows] of grouped) {
    const amount = rows.reduce((s,r)=>s+r.difference,0);
    if (Math.abs(amount) <= 1) continue;
    lines.push({ sign: amount >= 0 ? 'Add' : 'Less', particular: particularFor(reason as ReasonCode), amount: Math.abs(amount), remarks: remarkFor(reason as ReasonCode), reasonCode: reason as ReasonCode });
  }
  if (netZero.length) lines.push({ sign: '', particular: 'Customer payment reversal / debit-credit netted to zero', amount: 0, remarks: 'Customer reversal netted to zero', reasonCode: 'CUSTOMER_PAYMENT_REVERSAL_NET_ZERO' });
  const explained = lines.slice(3).reduce((s,l)=>s+(l.sign === 'Add' ? l.amount : l.sign === 'Less' ? -l.amount : 0),0);
  lines.push({ sign: '', particular: 'Unexplained Difference', amount: (rdcBal - custBal) - explained, remarks: 'After grouped Add/Less reconciling lines' });
  return lines;
}
function particularFor(reason: ReasonCode) {
  return ({ MISSING_IN_CUSTOMER: 'Invoice/payment present in RDC not booked by customer', MISSING_IN_RDC: 'Entry accounted by customer but not in RDC', OUTSIDE_RDC_PERIOD_PRESENT_IN_CUSTOMER: 'Outside RDC period present in customer ledger', TDS_NOT_FOUND: 'TDS entry not found in customer ledger', TDS_JOURNAL_NOT_IN_RDC: 'TDS deducted by customer through Journal not in RDC', JOURNAL_INVOICE_NOT_IN_RDC: 'Purchase invoices booked through Journal not in RDC', JOURNAL_ADJUSTMENT_REVIEW: 'Journal adjustment requires review', LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED: 'Reference truncated or not confidently extracted', LOW_PARSE_CONFIDENCE_REFERENCE_REVIEW: 'Reference partial or AI review required', CUSTOMER_PAYMENT_REVERSAL_NET_ZERO: 'Customer payment reversal netted to zero' } as Record<string,string>)[reason] || reason.replace(/_/g, ' ');
}
function remarkFor(reason: ReasonCode) {
  return ({ OUTSIDE_RDC_PERIOD_PRESENT_IN_CUSTOMER: 'Not mixed with normal unmatched customer items', TDS_JOURNAL_NOT_IN_RDC: 'Journal TDS considered in TDS compare', JOURNAL_INVOICE_NOT_IN_RDC: 'Journal invoice considered, not ignored', LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED: 'Send to review; do not auto-match below confidence 75', LOW_PARSE_CONFIDENCE_REFERENCE_REVIEW: 'AI/parser found only partial evidence; human approval required' } as Record<string,string>)[reason] || '';
}
