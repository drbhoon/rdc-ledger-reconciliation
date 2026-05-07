import path from 'path';
import { parseExcelFile } from './excel';
import { parsePdfFile } from './pdf';
import type { ParseResult } from '../types';
export async function parseLedger(filePath: string, side: 'RDC' | 'CUSTOMER'): Promise<ParseResult> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return parsePdfFile(filePath);
  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') return parseExcelFile(filePath, side);
  throw new Error('Unsupported file type: ' + ext);
}
