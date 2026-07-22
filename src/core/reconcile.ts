import { v4 as uuid } from 'uuid';
import { within } from './amount';
import { daysBetween, isOutsidePeriod } from './date';
import { collapseReference, normalizeNarration } from './reference';
import type { MatchRow, NormalizedTxn, ParseResult, ReconcileOptions, ReconcileResult, ReasonCode, SummaryLine, VoucherType } from './types';
const invoiceTypes: VoucherType[] = ['INVOICE','JOURNAL_INVOICE','DEBIT_NOTE'];
const paymentTypes: VoucherType[] = ['RECEIPT','PAYMENT'];
const tdsTypes: VoucherType[] = ['TDS','JOURNAL_TDS'];
const creditTypes: VoucherType[] = ['CREDIT_NOTE'];
function absSigned(t: NormalizedTxn) { return Math.abs(t.signedAmountRdcView); }
function refKey(t: NormalizedTxn) { return t.normalizedReferenceNo || t.extractedReferences?.[0] || ''; }
const collapsedCache = new WeakMap<NormalizedTxn, string>();
function collapsedKey(t: NormalizedTxn) {
  let c = collapsedCache.get(t);
  if (c === undefined) { c = collapseReference(refKey(t)); collapsedCache.set(t, c); }
  return c;
}
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
/**
 * Some customers print the RDC account in "receivable view" (invoices Dr) and
 * others in "payable view" (invoices Cr). Detect orientation from the parsed
 * invoices and normalise everything to the RDC-receivable view so signs are
 * consistent (e.g. Synergia's credit-side purchases).
 */
function normalizeCustomerOrientation(customer: ParseResult, rdc?: ParseResult): boolean {
  const invoices = customer.transactions.filter(t => ['INVOICE', 'JOURNAL_INVOICE'].includes(t.voucherType));
  if (!invoices.length) return false;
  const invoiceSum = invoices.reduce((s, t) => s + t.signedAmountRdcView, 0);
  // The counterparty's polarity must AGREE WITH THE RDC SIDE, not with a
  // fixed receivable assumption: in a customer (receivable) recon RDC
  // invoices are positive, but in a vendor (payable) recon — e.g. Dalmia
  // Cement, where RDC is the buyer — invoices are negative on BOTH sides.
  const rdcInvoiceSum = (rdc?.transactions ?? []).filter(t => t.voucherType === 'INVOICE').reduce((s, t) => s + t.signedAmountRdcView, 0);
  const wantPositive = rdc && Math.abs(rdcInvoiceSum) > 0 ? rdcInvoiceSum > 0 : true;
  const flipped = wantPositive ? invoiceSum < 0 : invoiceSum > 0;
  if (flipped) {
    for (const t of customer.transactions) t.signedAmountRdcView = -t.signedAmountRdcView;
    customer.parserLog.push({ sourceFile: customer.transactions[0]?.sourceFile || 'customer', level: 'info', message: 'Customer ledger printed in receivable view; transaction signs normalized to RDC view', confidence: 90 });
  }
  // Balance signs can be printed in either convention independent of the row
  // signs (e.g. a credit closing balance that is a positive RDC receivable).
  // Choose the opening/closing sign combination that best satisfies
  // opening + Σrows = closing; keep the parsed signs unless an alternative is
  // decisively (10x) better.
  const sum = customer.transactions.filter(t => !t.isNetZeroReversal).reduce((s, t) => s + t.signedAmountRdcView, 0);
  const { opening, closing } = customer.balances;
  if (closing != null) {
    let best = { op: opening ?? 0, cl: closing, gap: Math.abs((opening ?? 0) + sum - closing) };
    for (const op of opening != null ? [opening, -opening] : [0]) {
      for (const cl of [closing, -closing]) {
        const gap = Math.abs(op + sum - cl);
        if (gap < best.gap / 10) best = { op, cl, gap };
      }
    }
    if (best.cl !== closing || (opening != null && best.op !== opening)) {
      customer.parserLog.push({ sourceFile: customer.transactions[0]?.sourceFile || 'customer', level: 'info', message: `Customer balance sign normalized (opening ${opening} -> ${best.op}, closing ${closing} -> ${best.cl}) to satisfy opening + rows = closing`, confidence: 85 });
      if (opening != null) customer.balances.opening = best.op;
      customer.balances.closing = best.cl;
    }
    // If the export omits the opening balance entirely (common in Tally
    // period extracts), derive it so the statement stays internally
    // consistent — flagged as derived, not verified.
    if (customer.balances.opening == null) {
      customer.balances.opening = (customer.balances.closing ?? 0) - sum;
      customer.parserLog.push({ sourceFile: customer.transactions[0]?.sourceFile || 'customer', level: 'warn', message: `Customer opening balance not printed in ledger; derived as closing - transactions = ${customer.balances.opening.toFixed(2)} (unverified)`, confidence: 60 });
    }
  }
  return flipped;
}

/** Same missing-opening derivation for the RDC side. */
function deriveMissingOpening(side: ParseResult, label: string) {
  if (side.balances.closing == null || side.balances.opening != null) return;
  const sum = side.transactions.reduce((s, t) => s + t.signedAmountRdcView, 0);
  side.balances.opening = side.balances.closing - sum;
  if (Math.abs(side.balances.opening) > 1) {
    side.parserLog.push({ sourceFile: side.transactions[0]?.sourceFile || label, level: 'warn', message: `${label} opening balance not printed in ledger; derived as closing - transactions = ${side.balances.opening.toFixed(2)} (unverified)`, confidence: 60 });
  }
}

/** opening + Σ(signed txns) − closing; ≈0 when parsing captured every row correctly. */
export function ledgerIntegrityGap(side: ParseResult): number | undefined {
  if (side.balances.closing == null) return undefined;
  const total = side.transactions.reduce((s, t) => s + t.signedAmountRdcView, side.balances.opening || 0);
  return total - side.balances.closing;
}

export function reconcile(rdc: ParseResult, customer: ParseResult, options: ReconcileOptions): ReconcileResult {
  normalizeCustomerOrientation(customer, rdc);
  deriveMissingOpening(rdc, 'RDC');
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
    const rcol = collapsedKey(rdcTxn);
    const amount = absSigned(rdcTxn);
    let best: { txn: NormalizedTxn; confidence: number; reason?: string } | undefined;
    let refBest: { txn: NormalizedTxn; confidence: number; reason?: string } | undefined;
    let colBest: { txn: NormalizedTxn; confidence: number; reason?: string; days: number } | undefined;
    for (const c of candidates) {
      if (usedCust.has(c.id) || !types.includes(c.voucherType)) continue;
      const cref = refKey(c);
      const crefs = c.extractedReferences || [];
      const rrefs = rdcTxn.extractedReferences || [];
      const sameRef = !!(rref && cref && rref === cref) || !!(rref && crefs.includes(rref)) || !!(cref && rrefs.includes(cref));
      const amountOk = within(amount, absSigned(c), amountTolerance);
      const days = daysBetween(rdcTxn.date, c.date);
      const dateOk = days <= dateTolerance;
      if (sameRef && amountOk) return { txn: c, confidence: 100, reason: 'Reference matched' };
      // Reference-first: a matching reference IS a match even when amounts
      // differ (the difference is reported), instead of dumping the pair into
      // both Unmatched sheets. This is what a manual VLOOKUP does.
      if (sameRef && !refBest) refBest = { txn: c, confidence: 88, reason: `Reference matched; amount differs by ${(amount - absSigned(c)).toFixed(2)} — verify amount` };
      // Truncated-reference tier: customers often book "7MU25BP1-6960" as
      // "7MU6960" (year+doc-type infix dropped). Collapsed refs equal AND
      // amount equal = a solid match; prefer the nearest date on collisions.
      if (rcol && rcol.length >= 5 && collapsedKey(c) === rcol && amountOk) {
        if (!colBest || days < colBest.days) colBest = { txn: c, confidence: 90, reason: `Truncated customer reference matched (${cref || rcol} = ${rref}) with equal amount`, days };
      }
      if (amountOk && dateOk && !best) best = { txn: c, confidence: 72, reason: 'Amount and date near; review required' };
    }
    return refBest || colBest || best;
  };
  for (const r of rdcInPeriod) {
    // Credit notes are often booked by customers as (negative) purchases or
    // journals, so let invoice-side matching span both buckets.
    const types = invoiceTypes.includes(r.voucherType) ? [...invoiceTypes, ...creditTypes]
      : tdsTypes.includes(r.voucherType) ? tdsTypes
      : paymentTypes.includes(r.voucherType) ? paymentTypes
      : creditTypes.includes(r.voucherType) ? [...creditTypes, ...invoiceTypes] : [];
    if (!types.length) continue;
    const found = tryMatch(r, customerInPeriod, types, paymentTypes.includes(r.voucherType) ? options.paymentDateToleranceDays : options.invoiceDateToleranceDays, paymentTypes.includes(r.voucherType) ? options.paymentTolerance : options.invoiceTolerance);
    if (found && found.confidence >= 75) {
      usedRdc.add(r.id); usedCust.add(found.txn.id);
      matches.push(matchRow({ matchStatus: 'MATCHED', rdcTxn: r, customerTxn: found.txn, rdcAmount: r.signedAmountRdcView, customerAmount: found.txn.signedAmountRdcView, difference: r.signedAmountRdcView - found.txn.signedAmountRdcView, confidence: found.confidence, remarks: found.reason }));
    } else if (found) {
      possibleMatches.push(matchRow({ matchStatus: 'POSSIBLE', reasonCode: 'POSSIBLE_MATCH_REVIEW_REQUIRED', rdcTxn: r, customerTxn: found.txn, rdcAmount: r.signedAmountRdcView, customerAmount: found.txn.signedAmountRdcView, difference: r.signedAmountRdcView - found.txn.signedAmountRdcView, confidence: found.confidence, remarks: found.reason }));
    }
  }
  // ── RDC-side receipt reversals ──────────────────────────────────────────
  // A REC that bounced is reversed by a REV on the same voucher; the pair nets
  // to zero and must not pollute matching or the unmatched sheets. Accounts
  // team: "REC and REV should be considered together".
  const rdcReversalNetted: NormalizedTxn[] = [];
  {
    const byVoucher = new Map<string, NormalizedTxn[]>();
    for (const r of rdcInPeriod) {
      if (!paymentTypes.includes(r.voucherType) || !r.voucherNo) continue;
      byVoucher.set(r.voucherNo, [...(byVoucher.get(r.voucherNo) || []), r]);
    }
    for (const group of byVoucher.values()) {
      if (group.length < 2) continue;
      const net = group.reduce((s, t) => s + t.signedAmountRdcView, 0);
      if (Math.abs(net) <= options.paymentTolerance) {
        for (const t of group) {
          usedRdc.add(t.id);
          t.parserNotes = [...(t.parserNotes || []), 'RDC receipt reversed (REC+REV net zero)'];
          rdcReversalNetted.push(t);
        }
      }
    }
  }

  // ── Grouped payment matching ────────────────────────────────────────────
  // Tally books ONE payment voucher allocated across many invoices (Agst Ref
  // children); RDC books ONE receipt for the whole cheque. Match the SUM of a
  // customer payment voucher's allocations to an RDC receipt (REC/REV),
  // comparing SIGNED amounts so a payment never pairs with a reversal.
  const paymentGroups = new Map<string, NormalizedTxn[]>();
  for (const c of customerInPeriod) {
    if (usedCust.has(c.id) || !paymentTypes.includes(c.voucherType)) continue;
    // Group ONLY allocation children under their parent voucher. Standalone
    // payment rows stay individual — voucherNo can be a non-unique label like
    // "PAYMENT" and must never merge unrelated payments into one group.
    const key = c.parentVoucherNo ? `P:${c.parentVoucherNo}` : c.id;
    paymentGroups.set(key, [...(paymentGroups.get(key) || []), c]);
  }
  for (const [voucher, group] of paymentGroups) {
    const signedTotal = group.reduce((s, t) => s + t.signedAmountRdcView, 0);
    const total = Math.abs(signedTotal);
    if (total < 0.01) continue;
    const groupDate = group[0].date;
    let receipt: NormalizedTxn | undefined;
    for (const r of rdcInPeriod) {
      if (usedRdc.has(r.id) || !paymentTypes.includes(r.voucherType)) continue;
      if (!within(signedTotal, r.signedAmountRdcView, options.paymentTolerance)) continue;
      if (daysBetween(groupDate, r.date) > options.paymentDateToleranceDays) continue;
      receipt = r;
      break;
    }
    if (!receipt) continue;
    usedRdc.add(receipt.id);
    for (const t of group) usedCust.add(t.id);
    matches.push(matchRow({
      matchStatus: 'MATCHED',
      rdcTxn: receipt,
      customerTxn: group[0],
      rdcAmount: receipt.signedAmountRdcView,
      customerAmount: group.reduce((s, t) => s + t.signedAmountRdcView, 0),
      difference: receipt.signedAmountRdcView - group.reduce((s, t) => s + t.signedAmountRdcView, 0),
      confidence: 95,
      remarks: group.length > 1
        ? `Customer payment voucher ${voucher} (${group.length} invoice allocations totalling ${total.toFixed(2)}) matched to RDC receipt ${receipt.voucherNo || ''}`
        : `Customer payment ${voucher} matched to RDC receipt ${receipt.voucherNo || ''} by amount`,
    }));
  }

  // Unmatched customer payment ALLOCATION children are re-aggregated to their
  // parent voucher so the report shows "PYT/38154  14,49,110" (one row per
  // payment, as in the customer's ledger) instead of dozens of invoice-level
  // allocation fragments with confusing references.
  const syntheticUnmatchedPayments: NormalizedTxn[] = [];
  {
    const leftover = new Map<string, NormalizedTxn[]>();
    for (const c of customerInPeriod) {
      if (usedCust.has(c.id) || !paymentTypes.includes(c.voucherType) || !c.parentVoucherNo) continue;
      leftover.set(c.parentVoucherNo, [...(leftover.get(c.parentVoucherNo) || []), c]);
    }
    for (const [voucher, group] of leftover) {
      if (group.length < 2 && !group[0].allocationType) continue;
      for (const t of group) usedCust.add(t.id);
      const debit = group.reduce((s, t) => s + t.debit, 0);
      const credit = group.reduce((s, t) => s + t.credit, 0);
      syntheticUnmatchedPayments.push({
        ...group[0],
        id: uuid(),
        voucherNo: voucher,
        referenceNo: voucher,
        normalizedReferenceNo: voucher,
        extractedReferences: [],
        allocationType: '',
        sourceRow: group.map(g => g.sourceRow).join(','),
        particulars: `Payment voucher ${voucher} (${group.length} invoice allocation${group.length > 1 ? 's' : ''})`,
        narration: (group[0].narration || '').split(' | ').slice(0, 3).join(' | '),
        debit, credit,
        signedAmountRdcView: group.reduce((s, t) => s + t.signedAmountRdcView, 0),
        parserNotes: [...(group[0].parserNotes || []), 'Aggregated unmatched payment allocations to voucher level'],
      });
    }
  }

  // OTHER rows WITH money (e.g. Dalmia's OTH fund transfers from the generic
  // adapter) must appear in the unmatched sheets — excluding them silently
  // leaks value out of the summary identity. Zero-amount OTHER rows stay out.
  const keepUnmatched = (t: NormalizedTxn) => t.voucherType !== 'OTHER' || Math.abs(t.signedAmountRdcView) > 0.005;
  // RDC entries OUTSIDE the selected period are part of the RDC balance but
  // were invisible to matching — surface them in their own bucket so the
  // statement still ties (mirror of the customer outside-period bucket).
  const outsidePeriodRdcRows = rdc.transactions
    .filter(t => isOutsidePeriod(t.date, options.periodStart, options.periodEnd) && Math.abs(t.signedAmountRdcView) > 0.005)
    .map(t => matchRow({ reasonCode: 'OUTSIDE_PERIOD_PRESENT_IN_RDC', rdcTxn: t, rdcAmount: t.signedAmountRdcView, difference: t.signedAmountRdcView, confidence: t.parseConfidence, remarks: 'RDC entry outside the selected reconciliation period' }));
  const unmatchedRdc = [
    ...rdcInPeriod.filter(t => !usedRdc.has(t.id) && keepUnmatched(t)).map(t => matchRow({ reasonCode: reasonForRdc(t), rdcTxn: t, rdcAmount: t.signedAmountRdcView, difference: t.signedAmountRdcView, confidence: t.parseConfidence, remarks: 'Present in RDC only' })),
    ...outsidePeriodRdcRows,
  ];
  const unmatchedCustomer = [
    ...customerInPeriod.filter(t => !usedCust.has(t.id) && keepUnmatched(t)),
    ...syntheticUnmatchedPayments,
  ].map(t => matchRow({ reasonCode: reasonForCustomer(t), customerTxn: t, customerAmount: t.signedAmountRdcView, difference: -t.signedAmountRdcView, confidence: t.parseConfidence, remarks: t.parserNotes?.includes('Aggregated unmatched payment allocations to voucher level') ? 'Customer payment voucher not matched to any RDC receipt' : 'Present in customer only' }));

  // ── Probable-match suggestions ───────────────────────────────────────────
  // Customers sometimes book invoices under fabricated reference numbers that
  // exist nowhere in RDC's books. When an unmatched customer invoice's AMOUNT
  // equals an unmatched RDC invoice's, suggest that RDC invoice (nearest date,
  // each RDC invoice suggested at most once) in the Unmatched_Customer sheet —
  // together with the customer row reference this pinpoints the probable pair
  // for the accounts team without auto-matching on amount alone.
  {
    const suggestible = unmatchedRdc.filter(m => m.rdcTxn && [...invoiceTypes, ...creditTypes].includes(m.rdcTxn.voucherType));
    const takenRdc = new Set<string>();
    const custRows = unmatchedCustomer
      .filter(m => m.customerTxn && [...invoiceTypes, ...creditTypes].includes(m.customerTxn.voucherType))
      .sort((a, b) => (a.customerTxn!.date || '').localeCompare(b.customerTxn!.date || ''));
    for (const m of custRows) {
      const c = m.customerTxn!;
      const amount = Math.abs(c.signedAmountRdcView);
      if (amount < 0.01) continue;
      let bestS: { r: NormalizedTxn; days: number } | undefined;
      for (const um of suggestible) {
        const r = um.rdcTxn!;
        if (takenRdc.has(r.id)) continue;
        if (!within(amount, Math.abs(r.signedAmountRdcView), options.invoiceTolerance)) continue;
        const days = daysBetween(c.date, r.date);
        if (days > 60) continue;
        if (!bestS || days < bestS.days) bestS = { r, days };
      }
      if (!bestS) continue;
      takenRdc.add(bestS.r.id);
      const r = bestS.r;
      m.suggestion = `${r.referenceNo || r.voucherNo || '?'} · ₹${Math.abs(r.signedAmountRdcView).toLocaleString('en-IN')} · ${r.date || ''} · RDC row ${r.sourceRow}`;
      // Mirror the hint on the RDC side so both teams see the same pairing.
      const rdcRow = suggestible.find(um => um.rdcTxn!.id === r.id);
      if (rdcRow) rdcRow.suggestion = `${c.referenceNo || c.voucherNo || '?'} · ₹${Math.abs(c.signedAmountRdcView).toLocaleString('en-IN')} · ${c.date || ''} · customer row ${c.sourceRow}`;
    }
  }
  const outsidePeriodCustomer = outsidePeriodCustomerTxns.map(t => matchRow({ matchStatus: 'INFO', reasonCode: 'OUTSIDE_RDC_PERIOD_PRESENT_IN_CUSTOMER', customerTxn: t, customerAmount: t.signedAmountRdcView, difference: -t.signedAmountRdcView, confidence: t.parseConfidence, remarks: 'Customer ledger item outside selected RDC period' }));
  const openingClosing = openingClosingRows(rdc, customer);
  const tdsCompare = [...matches, ...unmatchedRdc, ...unmatchedCustomer].filter(m => [m.rdcTxn?.voucherType, m.customerTxn?.voucherType].some(v => v && tdsTypes.includes(v)));
  const journalEntries = customer.transactions.filter(t => t.voucherType.startsWith('JOURNAL') || t.parserNotes?.includes('SOURCE_VOUCHER_TYPE_JOURNAL'));
  const summaryLines = buildSummary(rdc, customer, [...unmatchedRdc, ...unmatchedCustomer, ...outsidePeriodCustomer], netZeroReversals, options, matches);
  const rdcGap = ledgerIntegrityGap(rdc);
  const custGap = ledgerIntegrityGap(customer);
  // ── Per-run accuracy certificate (the production accuracy metric) ────────
  // A reconciliation is CERTIFIED when it is arithmetically airtight:
  //  1. both ledgers' parsed rows tie to their own stated closing balance
  //     (integrity gap within tolerance) — nothing was misread or missed;
  //  2. the reconciliation statement fully explains the RDC↔customer
  //     difference (unexplained difference within tolerance).
  // "Accuracy" is then measured, per run and across a sample, as the % of
  // runs certified. Anything not certified is flagged REVIEW REQUIRED rather
  // than presented as a finished reconciliation.
  const unexplained = summaryLines.at(-1)?.amount || 0;
  const rdcTied = rdcGap == null || Math.abs(rdcGap) <= 1;
  const custTied = custGap == null || Math.abs(custGap) <= 1;
  const explained = Math.abs(unexplained) <= 1;
  const rdcVolume = rdc.transactions.reduce((s, t) => s + Math.abs(t.signedAmountRdcView), 0);
  const matchedVolume = matches.reduce((s, m) => s + Math.abs(m.rdcAmount || 0), 0);
  const matchedCoveragePct = rdcVolume > 0 ? Math.round((matchedVolume / rdcVolume) * 10000) / 100 : 0;
  // Zero matches across two populated ledgers is a parsing/orientation
  // failure, not a finished reconciliation — it can still be arithmetically
  // self-consistent (everything dumped into Add/Less buckets), so it must be
  // blocked from certification explicitly ("never confidently wrong").
  const nothingMatched = matches.length === 0 && rdc.transactions.length >= 10 && customer.transactions.length >= 10;
  const certified = rdcTied && custTied && explained && !nothingMatched;
  const verdict = certified ? 'CERTIFIED' : 'REVIEW REQUIRED';
  if (nothingMatched) customer.parserLog.push({ sourceFile: customer.transactions[0]?.sourceFile || 'customer', level: 'error', message: 'Certification blocked: ZERO rows matched between the two ledgers — this points to a format/orientation parsing problem, not a genuine reconciliation. Review both ledgers.', confidence: 0 });
  const cards = { matchedCount: matches.length, possibleCount: possibleMatches.length, unmatchedRdcCount: unmatchedRdc.length, unmatchedCustomerCount: unmatchedCustomer.length, outsidePeriodCustomerCount: outsidePeriodCustomer.length, netZeroReversalCount: netZeroReversals.length, journalEntriesConsidered: journalEntries.length, tdsExceptionCount: tdsCompare.filter(t => t.matchStatus !== 'MATCHED').length, unexplainedDifference: unexplained, rdcLedgerIntegrityGap: Math.round((rdcGap || 0) * 100) / 100, customerLedgerIntegrityGap: Math.round((custGap || 0) * 100) / 100, matchedCoveragePct, certified, verdict };
  if (rdcGap != null && Math.abs(rdcGap) > 1) rdc.parserLog.push({ sourceFile: rdc.transactions[0]?.sourceFile || 'rdc', level: 'error', message: `RDC ledger integrity check FAILED: parsed rows differ from stated closing balance by ${rdcGap.toFixed(2)} — some rows were misread or missed`, confidence: 0 });
  if (custGap != null && Math.abs(custGap) > 1) customer.parserLog.push({ sourceFile: customer.transactions[0]?.sourceFile || 'customer', level: 'error', message: `Customer ledger integrity check FAILED: parsed rows differ from stated closing balance by ${custGap.toFixed(2)} — some rows were misread or missed`, confidence: 0 });
  return { options, rdc, customer: { ...customer, transactions: activeCustomer }, matches, possibleMatches, unmatchedRdc, unmatchedCustomer, outsidePeriodCustomer, netZeroReversals: [...netZeroReversals, ...rdcReversalNetted], tdsCompare, journalEntries, openingClosing, summaryLines, parserLog: [...rdc.parserLog, ...customer.parserLog], cards };
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
function buildSummary(rdc: ParseResult, customer: ParseResult, exceptions: MatchRow[], netZero: NormalizedTxn[], options: ReconcileOptions, matches: MatchRow[] = []): SummaryLine[] {
  const rdcBal = rdc.balances.closing ?? rdc.transactions.reduce((s,t)=>s+t.signedAmountRdcView, rdc.balances.opening || 0);
  const custBal = customer.balances.closing ?? customer.transactions.filter(t=>!t.isNetZeroReversal).reduce((s,t)=>s+t.signedAmountRdcView, customer.balances.opening || 0);
  const lines: SummaryLine[] = [
    { sign: '', particular: 'Balance As per RDC', amount: rdcBal },
    { sign: '', particular: 'Balance As per ' + options.partyName, amount: custBal },
    { sign: '', particular: 'Difference', amount: rdcBal - custBal, remarks: 'RDC receivable - Customer receivable-view balance' },
  ];
  // ── Accounts-team sign convention (validated on Balaji/Synergia/Talib) ──
  // Every reconciling line is DISPLAYED as (Customer amount − RDC amount):
  // sign = Add when that is positive, Less when negative. Internally each
  // line keeps its RDC−Customer contribution so the statement identity
  // Difference − Σcontribution = 0 (equivalently their check point:
  // Difference + Σ(Customer−RDC) = 0) always holds.
  const pushLine = (particular: string, rdcMinusCust: number, remarks?: string, reasonCode?: ReasonCode) => {
    const custMinusRdc = -rdcMinusCust;
    lines.push({
      sign: custMinusRdc >= 0 ? 'Add' : 'Less',
      particular,
      amount: Math.abs(custMinusRdc),
      remarks,
      reasonCode,
      contribution: rdcMinusCust,
    });
  };
  const openingDiff = (rdc.balances.opening ?? 0) - (customer.balances.opening ?? 0);
  if (Math.abs(openingDiff) > 1 && (rdc.balances.opening != null || customer.balances.opening != null)) {
    pushLine('Opening balance difference (Customer opening less RDC opening)', openingDiff, 'Customer opening minus RDC opening', 'OPENING_BALANCE_MISMATCH');
  }
  // Amount variances on reference-matched items (e.g. TDS/rounding/short booking).
  const matchedVariance = matches.reduce((s, m) => s + (m.difference || 0), 0);
  if (Math.abs(matchedVariance) > 1) {
    pushLine('Amount differences on reference-matched invoices/receipts', matchedVariance, 'Customer minus RDC on same-reference items; see Matched_Invoices Difference column', 'AMOUNT_MISMATCH');
  }
  const grouped = new Map<string, MatchRow[]>();
  for (const e of exceptions) grouped.set(e.reasonCode || 'LOW_PARSE_CONFIDENCE', [...(grouped.get(e.reasonCode || 'LOW_PARSE_CONFIDENCE') || []), e]);
  for (const [reason, rows] of grouped) {
    const amount = rows.reduce((s,r)=>s+r.difference,0);
    if (Math.abs(amount) <= 1) continue;
    pushLine(particularFor(reason as ReasonCode), amount, remarkFor(reason as ReasonCode), reason as ReasonCode);
  }
  // Surface parser integrity gaps so an unexplained difference is attributable.
  const rdcGap = ledgerIntegrityGap(rdc);
  if (rdcGap != null && Math.abs(rdcGap) > 1) pushLine('⚠ RDC ledger rows not fully captured by parser (integrity gap)', -rdcGap, 'Parsed RDC rows do not tie to the stated closing balance — treat this reconciliation as INCOMPLETE');
  const custGap = ledgerIntegrityGap(customer);
  if (custGap != null && Math.abs(custGap) > 1) pushLine('⚠ Customer ledger rows not fully captured by parser (integrity gap)', custGap, 'Parsed customer rows do not tie to the stated closing balance — treat this reconciliation as INCOMPLETE');
  if (netZero.length) lines.push({ sign: '', particular: 'Customer payment reversal / debit-credit netted to zero', amount: 0, remarks: 'Customer reversal netted to zero', reasonCode: 'CUSTOMER_PAYMENT_REVERSAL_NET_ZERO' });
  const explained = lines.slice(3).reduce((s,l)=>s+(l.contribution ?? (l.sign === 'Add' ? l.amount : l.sign === 'Less' ? -l.amount : 0)),0);
  lines.push({ sign: '', particular: 'Unexplained Difference', amount: (rdcBal - custBal) - explained, remarks: 'After grouped Add/Less reconciling lines' });
  return lines;
}
function particularFor(reason: ReasonCode) {
  return ({ MISSING_IN_CUSTOMER: 'Invoice/payment present in RDC not booked by customer', MISSING_IN_RDC: 'Entry accounted by customer but not in RDC', OUTSIDE_RDC_PERIOD_PRESENT_IN_CUSTOMER: 'Outside RDC period present in customer ledger', OUTSIDE_PERIOD_PRESENT_IN_RDC: 'Outside period present in RDC ledger', TDS_NOT_FOUND: 'TDS entry not found in customer ledger', TDS_JOURNAL_NOT_IN_RDC: 'TDS deducted by customer through Journal not in RDC', JOURNAL_INVOICE_NOT_IN_RDC: 'Purchase invoices booked through Journal not in RDC', JOURNAL_ADJUSTMENT_REVIEW: 'Journal adjustment requires review', LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED: 'Reference truncated or not confidently extracted', LOW_PARSE_CONFIDENCE_REFERENCE_REVIEW: 'Reference partial or AI review required', CUSTOMER_PAYMENT_REVERSAL_NET_ZERO: 'Customer payment reversal netted to zero' } as Record<string,string>)[reason] || reason.replace(/_/g, ' ');
}
function remarkFor(reason: ReasonCode) {
  return ({ OUTSIDE_RDC_PERIOD_PRESENT_IN_CUSTOMER: 'Not mixed with normal unmatched customer items', TDS_JOURNAL_NOT_IN_RDC: 'Journal TDS considered in TDS compare', JOURNAL_INVOICE_NOT_IN_RDC: 'Journal invoice considered, not ignored', LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED: 'Send to review; do not auto-match below confidence 75', LOW_PARSE_CONFIDENCE_REFERENCE_REVIEW: 'AI/parser found only partial evidence; human approval required' } as Record<string,string>)[reason] || '';
}
