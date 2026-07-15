export type SourceSide = 'RDC' | 'CUSTOMER';
export type VoucherType =
  | 'INVOICE' | 'RECEIPT' | 'PAYMENT' | 'TDS' | 'OPENING' | 'CLOSING'
  | 'JOURNAL_INVOICE' | 'JOURNAL_TDS' | 'JOURNAL_ADJUSTMENT'
  | 'DEBIT_NOTE' | 'CREDIT_NOTE' | 'REVERSAL' | 'OTHER';

export type ReasonCode =
  | 'OPENING_BALANCE_MISMATCH' | 'CLOSING_BALANCE_MISMATCH' | 'MISSING_IN_CUSTOMER'
  | 'MISSING_IN_RDC' | 'OUTSIDE_RDC_PERIOD_PRESENT_IN_CUSTOMER' | 'AMOUNT_MISMATCH'
  | 'DATE_MISMATCH' | 'PAYMENT_AMOUNT_MISMATCH' | 'PAYMENT_ALLOCATION_MISMATCH'
  | 'TDS_NOT_FOUND' | 'TDS_JOURNAL_NOT_IN_RDC' | 'JOURNAL_INVOICE_NOT_IN_RDC'
  | 'REFERENCE_MISMATCH' | 'DUPLICATE_REFERENCE_RDC' | 'DUPLICATE_REFERENCE_CUSTOMER'
  | 'POSSIBLE_MATCH_REVIEW_REQUIRED' | 'LOW_PARSE_CONFIDENCE'
  | 'LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED' | 'LOW_PARSE_CONFIDENCE_REFERENCE_REVIEW'
  | 'CUSTOMER_PAYMENT_REVERSAL_NET_ZERO'
  | 'PERIOD_SCOPE_MISMATCH' | 'JOURNAL_ADJUSTMENT_REVIEW';

export type NormalizedTxn = {
  id: string;
  sourceSide: SourceSide;
  sourceFile: string;
  sourceSheet?: string;
  sourceRow: number | string;
  sourcePage?: number;
  partyName?: string;
  date?: string;
  voucherType: VoucherType;
  voucherNo?: string;
  referenceNo?: string;
  normalizedReferenceNo?: string;
  extractedReferences?: string[];
  parentVoucherNo?: string;
  chequeNo?: string;
  allocationType?: 'New Ref' | 'Agst Ref' | 'Inferred' | '';
  particulars?: string;
  narration?: string;
  debit: number;
  credit: number;
  signedAmountRdcView: number;
  amountOriginalSign?: 'Dr' | 'Cr' | '';
  nettingGroupKey?: string;
  isNetZeroReversal?: boolean;
  parseConfidence: number;
  parserNotes?: string[];
  aiExtractedReferences?: string[];
  aiSuggestedVoucherType?: VoucherType;
  aiConfidence?: number;
  aiReason?: string;
  userApproved?: boolean;
};

export type BalanceSet = { opening?: number; closing?: number; openingRows?: NormalizedTxn[]; closingRows?: NormalizedTxn[] };
export type ParseResult = { transactions: NormalizedTxn[]; balances: BalanceSet; parserLog: ParserLogRow[]; period?: { start?: string; end?: string } };
export type ParserLogRow = { sourceFile: string; sourceSheet?: string; sourcePage?: number; sourceRow?: string | number; level: 'info' | 'warn' | 'error'; message: string; confidence?: number };
export type ReconcileOptions = { partyName: string; periodStart: string; periodEnd: string; invoiceTolerance: number; paymentTolerance: number; invoiceDateToleranceDays: number; paymentDateToleranceDays: number };
export type MatchRow = { matchId: string; matchStatus: 'MATCHED' | 'POSSIBLE' | 'EXCEPTION' | 'INFO'; reasonCode?: ReasonCode; rdcTxn?: NormalizedTxn; customerTxn?: NormalizedTxn; rdcAmount?: number; customerAmount?: number; difference: number; confidence: number; remarks?: string };
export type SummaryLine = { sign: '' | 'Add' | 'Less'; particular: string; amount: number; remarks?: string; reasonCode?: ReasonCode; contribution?: number };
export type AiUsageStats = {
  enabled: boolean;
  model: string;
  rowsReviewed: number;
  referencesExtracted: number;
  journalRowsClassified: number;
  possibleMatchesSuggested: number;
  autoAccepted: number;
  requiresHumanReview: number;
};
export type ReconcileResult = { options: ReconcileOptions; rdc: ParseResult; customer: ParseResult; matches: MatchRow[]; possibleMatches: MatchRow[]; unmatchedRdc: MatchRow[]; unmatchedCustomer: MatchRow[]; outsidePeriodCustomer: MatchRow[]; netZeroReversals: NormalizedTxn[]; tdsCompare: MatchRow[]; journalEntries: NormalizedTxn[]; openingClosing: MatchRow[]; summaryLines: SummaryLine[]; parserLog: ParserLogRow[]; cards: Record<string, number | boolean | string>; aiUsage?: AiUsageStats };
