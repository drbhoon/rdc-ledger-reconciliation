import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[A-Za-z0-9-]+$/.test(id)) return new NextResponse('Invalid report id', { status: 400 });
  const reportPath = path.join(process.cwd(), 'reports', id + '_reconciliation.xlsx');
  if (!fs.existsSync(reportPath)) return new NextResponse('Report not found', { status: 404 });
  const bytes = fs.readFileSync(reportPath);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="' + path.basename(reportPath) + '"',
    },
  });
}
