const DIRECT_PATTERNS = [
  /\b\d{1,2}CH\d{2}ARS\d+\b/gi,
  /\b\d{1,2}CH\d{2}BP\d-?\d+\b/gi,
  /\b\d{1,2}CG\d{2}BP\d-?\d+\b/gi,
  /\b\d{1,2}CH\d{2}ARCM\d+\b/gi,
  /\b\d{1,2}CH\d{2}ARMN\d+\b/gi,
  /\b\d{1,2}[A-Z]{2,4}\d{2}ARS\d+\b/gi,
  /\b\d{1,2}[A-Z]{2,4}\d{2}BP\d-?\d+\b/gi,
  /\b\d{1,2}[A-Z]{2,4}\d{2}ARCM\d+\b/gi,
  /\b\d{1,2}[A-Z]{2,4}\d{2}ARMN\d+\b/gi,
];
const KEYWORD_PATTERN = /(?:Bill No|Invoice No|Inv No|D No|Ref|Against|Being Bill Booked Against Invoice No\.?)[\s:#-]*([A-Z0-9][A-Z0-9/ ._-]{4,40})/gi;
const TRUNCATED_PATTERN = /\b\d{1,2}[A-Z]{2}\d{2}[A-Z0-9]+[-/\.]*\s*(?:\.\.\.|…|$)/i;
export function normalizeReference(ref?: string) {
  return (ref || '').toUpperCase().trim().replace(/[\s/_]+/g, '').replace(/[^A-Z0-9-]/g, '').replace(/--+/g, '-');
}
export function extractReferences(fields: Array<string | undefined | null>) {
  const text = fields.filter(Boolean).join(' | ');
  const found = new Set<string>();
  for (const pattern of DIRECT_PATTERNS) for (const match of text.matchAll(pattern)) found.add(match[0].toUpperCase());
  for (const match of text.matchAll(KEYWORD_PATTERN)) {
    const candidate = (match[1] || '').split(/[|,;]/)[0].trim();
    for (const pattern of DIRECT_PATTERNS) for (const direct of candidate.matchAll(pattern)) found.add(direct[0].toUpperCase());
    if (!found.size && /\d{1,2}[A-Z]{2,4}\d{2}/i.test(candidate)) {
      // The keyword capture often fuses the amount and Dr/Cr onto the ref
      // ("New Ref 7MU6960 53690 cr"). Take the FIRST whitespace token that has
      // the reference shape (leading digits + letters + digits) and is not a
      // pure number — never string amount/Dr/Cr onto it. Amounts may be
      // comma-grouped OR plain (Tally), so we don't rely on stripping them.
      const tokens = candidate.split(/\s+/);
      const refTok = tokens.find(t => /^\d{1,2}[A-Z]{2,4}\d{2}[A-Z0-9/-]*$/i.test(t) && !/^\d+$/.test(t));
      const clean = (refTok || '').toUpperCase().replace(/[^A-Z0-9/-]/g, '');
      if (clean && clean.length >= 5 && clean.length <= 20 && /[A-Z]/.test(clean)) found.add(clean);
    }
  }
  return Array.from(found);
}
export function hasTruncatedReference(fields: Array<string | undefined | null>) {
  return TRUNCATED_PATTERN.test(fields.filter(Boolean).join(' | '));
}
export function normalizeNarration(value?: string) {
  return (value || '').toUpperCase().replace(/\b(DR|CR)\b/g, '').replace(/[0-9,]+\.\d{2}/g, '').replace(/[^A-Z0-9]+/g, ' ').trim().slice(0, 120);
}
export function extractChequeNo(fields: Array<string | undefined | null>) {
  const text = fields.filter(Boolean).join(' ');
  const direct = text.match(/\b(?:CHQ|CHEQUE|CH)\.?\s*(?:(?:NO)\.?|#|:|\.|-)?\s*([0-9]{4,12})\b/i);
  if (direct) return direct[1].toUpperCase();
  const match = text.match(/\b(?:UTR|NEFT|RTGS|REF)\s*(?:NO|#|:|\.|-)?\s*([A-Z0-9-]{4,24})\b/i);
  return match?.[1]?.toUpperCase();
}
