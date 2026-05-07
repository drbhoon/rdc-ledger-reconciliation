import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { NextResponse } from 'next/server';
import { inr } from '@/core/amount';

type SummaryLine = { sign: string; particular: string; amount: number; remarks?: string };

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[A-Za-z0-9-]+$/.test(id)) return new NextResponse('Invalid summary id', { status: 400 });
  const summaryPath = path.join(process.cwd(), 'reports', id + '_summary.json');
  if (!fs.existsSync(summaryPath)) return new NextResponse('Summary not found', { status: 404 });
  const result = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as { partyName?: string; summaryLines?: SummaryLine[] };
  const lines = result.summaryLines || [];
  const pdf = await renderSummaryPdf(String(result.partyName || 'Customer'), lines);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="summary-reconciliation-' + id + '.pdf"',
    },
  });
}

function renderSummaryPdf(partyName: string, lines: SummaryLine[]) {
  return new Promise<Buffer>((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.font('Helvetica-Bold').fontSize(15).text('Reconciliation RDC vs ' + partyName, { align: 'center' });
    doc.moveDown(1);
    const widths = [50, 245, 95, 150];
    let y = doc.y;
    drawRow(doc, y, widths, ['Sign', 'Particular', 'Amount', 'Remarks'], true);
    y += 26;
    doc.font('Helvetica').fontSize(8);
    for (const line of lines) {
      const rowHeight = Math.max(24, doc.heightOfString(line.particular || '', { width: widths[1] - 8 }) + 12, doc.heightOfString(line.remarks || '', { width: widths[3] - 8 }) + 12);
      if (y + rowHeight > 800) { doc.addPage(); y = 36; }
      drawRow(doc, y, widths, [line.sign || '', line.particular || '', inr(Number(line.amount || 0)), line.remarks || ''], /Difference/.test(line.particular || ''), rowHeight);
      y += rowHeight;
    }
    doc.end();
  });
}

function drawRow(doc: PDFKit.PDFDocument, y: number, widths: number[], cells: string[], highlighted = false, height = 24) {
  let x = 36;
  if (highlighted) doc.rect(x, y, widths.reduce((a,b)=>a+b,0), height).fill('#fff200');
  doc.fillColor('#20242c').font(highlighted ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
  for (let i = 0; i < cells.length; i++) {
    doc.rect(x, y, widths[i], height).stroke('#d7dde6');
    doc.text(cells[i], x + 4, y + 7, { width: widths[i] - 8, align: i === 2 ? 'right' : 'left' });
    x += widths[i];
  }
}
