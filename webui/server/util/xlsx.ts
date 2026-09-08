// 零依赖 XLSX 写入器（基于 writeZip；inline strings，无需共享字符串表）
// 用于「Excel 清单」导出（M4 export-publish §1）
import { writeZip } from './zip.ts';

export type XlsxCell = string | number | boolean | null;
export interface XlsxSheet {
  name: string;
  rows: XlsxCell[][];
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function colName(col: number): string {
  let n = col + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetXml(rows: XlsxCell[][]): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  out.push('<sheetData>');
  rows.forEach((row, r) => {
    const cells: string[] = [];
    row.forEach((cell, c) => {
      const ref = colName(c) + (r + 1);
      if (cell === null || cell === undefined || cell === '') return;
      if (typeof cell === 'number') {
        cells.push(`<c r="${ref}"><v>${cell}</v></c>`);
      } else if (typeof cell === 'boolean') {
        cells.push(`<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`);
      } else {
        cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(String(cell))}</t></is></c>`);
      }
    });
    if (cells.length) out.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  });
  out.push('</sheetData>');
  out.push('</worksheet>');
  return out.join('');
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf fontId="0" numFmtId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf fontId="0" numFmtId="0"/>
    <xf fontId="1" numFmtId="0" applyFont="1"/>
  </cellXfs>
</styleSheet>`;

/** 生成 .xlsx Buffer（多 sheet 表） */
export function writeXlsx(sheets: XlsxSheet[]): Buffer {
  // 表头行（索引 0）由 sheetXmlBoldFirst 加粗渲染
  const entries = new Array<{ name: string; data: string; stored?: boolean }>();

  entries.push({ name: '[Content_Types].xml', data: contentTypes(sheets) });
  entries.push({ name: '_rels/.rels', data: rootRels });
  entries.push({ name: 'xl/workbook.xml', data: workbookXml(sheets) });
  entries.push({ name: 'xl/_rels/workbook.xml.rels', data: workbookRels(sheets.length) });
  entries.push({ name: 'xl/styles.xml', data: STYLES });
  sheets.forEach((s, i) => {
    entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXmlBoldFirst(s.rows) });
  });

  return writeZip(entries as any);
}

function sheetXmlBoldFirst(rows: XlsxCell[][]): string {
  // 第一行是表头（加粗样式 1）
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>');
  rows.forEach((row, r) => {
    const cells: string[] = [];
    row.forEach((cell, c) => {
      const ref = colName(c) + (r + 1);
      const style = r === 0 ? ' s="1"' : '';
      if (cell === null || cell === undefined || cell === '') return;
      if (typeof cell === 'number') cells.push(`<c r="${ref}"${style}><v>${cell}</v></c>`);
      else if (typeof cell === 'boolean') cells.push(`<c r="${ref}"${style} t="b"><v>${cell ? 1 : 0}</v></c>`);
      else cells.push(`<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(String(cell))}</t></is></c>`);
    });
    if (cells.length) out.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  });
  out.push('</sheetData></worksheet>');
  return out.join('');
}

const contentTypes = (sheets: XlsxSheet[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
</Types>`;

const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const workbookXml = (sheets: XlsxSheet[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}
  </sheets>
</workbook>`;

const workbookRels = (n: number) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  ${Array.from({ length: n }, (_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
</Relationships>`;
