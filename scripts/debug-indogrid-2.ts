/** Why do libraries see 17 pages when the viewer reports 74? */
import fs from 'fs';
const FILE = './test-data-230726/Customer The Indogrid 30Jun26.pdf';
(async () => {
  const buf = fs.readFileSync(FILE);
  console.log('bytes:', buf.length);
  const head = buf.subarray(0, 1024).toString('latin1');
  console.log('header:', JSON.stringify(head.slice(0, 60)));
  const text = buf.toString('latin1');
  const countPageObjs = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const countPagesObjs = (text.match(/\/Type\s*\/Pages/g) || []).length;
  const countCount = [...text.matchAll(/\/Count\s+(\d+)/g)].map(m => m[1]);
  const objStm = (text.match(/\/Type\s*\/ObjStm/g) || []).length;
  const linearized = /\/Linearized/.test(text);
  const encrypt = /\/Encrypt/.test(text);
  const startxrefs = (text.match(/startxref/g) || []).length;
  const eofs = (text.match(/%%EOF/g) || []).length;
  const images = (text.match(/\/Subtype\s*\/Image/g) || []).length;
  console.log({ countPageObjs, countPagesObjs, counts: countCount.slice(0, 10), objStm, linearized, encrypt, startxrefs, eofs, images });
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(buf, { ignoreEncryption: true, throwOnInvalidObject: false });
  console.log('pdf-lib pages:', doc.getPageCount());
  const pdf = (await import('pdf-parse')).default as any;
  const d = await pdf(buf);
  console.log('pdf-parse numpages:', d.numpages, 'text len:', String(d.text || '').length);
})();
