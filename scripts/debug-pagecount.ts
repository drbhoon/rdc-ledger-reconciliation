import fs from 'fs';
const file = './test-data-210726/Customer The Indogrid 30Jun26.pdf';
(async () => {
  const pdf = (await import('pdf-parse')).default as any;
  const data = await pdf(fs.readFileSync(file));
  console.log('pdf-parse numpages:', data.numpages, 'numrender:', data.numrender, 'text chars:', String(data.text || '').length);
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(fs.readFileSync(file), { ignoreEncryption: true });
  console.log('pdf-lib pages:', doc.getPageCount());
  const sizes = doc.getPages().slice(0, 5).map(p => `${Math.round(p.getWidth())}x${Math.round(p.getHeight())}`);
  console.log('first page sizes:', sizes.join(', '));
})();
