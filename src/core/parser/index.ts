import path from 'path';
import fs from 'fs';
import { parseExcelFile } from './excel';
import { extractSpacedText, parsePdfFile } from './pdf';
import type { ParseResult } from '../types';

export async function parseLedger(filePath: string, side: 'RDC' | 'CUSTOMER'): Promise<ParseResult> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return parsePdfFile(filePath, side);
  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') return parseExcelFile(filePath, side);
  throw new Error('Unsupported file type: ' + ext);
}

/**
 * Raw document text for the AI rescue parser: geometry-spaced text for PDFs,
 * tab-joined cell rows for Excel/CSV.
 */
export async function extractRawText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    try {
      return await extractSpacedText(fs.readFileSync(filePath));
    } catch {
      const pdf = (await import('pdf-parse')).default as any;
      const data = await pdf(fs.readFileSync(filePath));
      return String(data.text || '');
    }
  }
  const XLSX = await import('xlsx');
  // raw:true for CSV keeps original date strings (see parseExcelFile).
  const wb = XLSX.read(fs.readFileSync(filePath), /\.csv$/i.test(filePath) ? { type: 'buffer', raw: true } : { cellDates: true, type: 'buffer' });
  const out: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, defval: '', raw: false });
    for (const row of rows) {
      const line = (row as unknown[]).map(v => String(v ?? '').trim()).join('\t').replace(/\t+$/g, '');
      if (line.trim()) out.push(line);
    }
  }
  return out.join('\n');
}
