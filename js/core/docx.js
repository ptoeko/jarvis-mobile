// Документ Word (.docx), созданный ИИ агентом, без сторонних библиотек.
// Агент присылает структуру документа (заголовки, абзацы, списки, таблицы),
// файл собирается здесь, на телефоне, тем же модулем zip.js.
//
// Структура: { title, orientation: 'portrait'|'landscape',
//   blocks: [{ type: 'heading', text, level: 1..3 } | { type: 'paragraph', text, bold }
//          | { type: 'bullets', items: [...] } | { type: 'numbered', items: [...] }
//          | { type: 'table', headers: [...], rows: [[...]] }] }

import { createZip } from './zip.js';
import { xmlText } from './xlsx.js';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_BLOCKS = 2000;

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

// Текст с переносами строк → прогоны с <w:br/>.
function runs(text, { bold = false, size = null } = {}) {
  const props = `${bold ? '<w:b/>' : ''}${size ? `<w:sz w:val="${size}"/>` : ''}`;
  const rpr = props ? `<w:rPr>${props}</w:rPr>` : '';
  return String(text ?? '').split('\n').map((line, i) => `<w:r>${rpr}${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlText(line)}</w:t></w:r>`).join('');
}

function paragraph(text, { style = null, bold = false, numId = null, keepNext = false } = {}) {
  const ppr = [
    style ? `<w:pStyle w:val="${style}"/>` : '',
    keepNext ? '<w:keepNext/>' : '',
    numId ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>` : '',
  ].join('');
  return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${runs(text, { bold })}</w:p>`;
}

function cellXml(text, width, header) {
  const shade = header ? '<w:shd w:val="clear" w:color="auto" w:fill="D9E2EC"/>' : '';
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shade}</w:tcPr>${paragraph(text, { style: 'TableText', bold: header })}</w:tc>`;
}

function tableXml(headers, rows, pageWidth) {
  const cols = Math.max(headers.length, ...rows.map((r) => r.length), 1);
  const h = Array.from({ length: cols }, (_, i) => String(headers[i] ?? ''));
  const body = rows.map((r) => Array.from({ length: cols }, (_, i) => String(r?.[i] ?? '')));
  // Ширина столбцов — по длине содержимого, в сумме — ширина страницы.
  const weight = h.map((x, i) => Math.min(40, Math.max(4, x.length, ...body.map((r) => Math.max(...r[i].split('\n').map((l) => l.length))))));
  const total = weight.reduce((a, b) => a + b, 0);
  const widths = weight.map((w) => Math.floor((w / total) * pageWidth));
  const grid = `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
  const head = `<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${h.map((x, i) => cellXml(x, widths[i], true)).join('')}</w:tr>`;
  const rowsXml = body.map((r) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${r.map((x, i) => cellXml(x, widths[i], false)).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="Grid"/><w:tblW w:w="${pageWidth}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr>${grid}${head}${rowsXml}</w:tbl>${paragraph('')}`;
}

const list = (v) => (Array.isArray(v) ? v : []);

// Проверка и приведение структуры, присланной агентом.
export function normalizeDocument(doc) {
  const blocks = [];
  for (const b of list(doc?.blocks).slice(0, MAX_BLOCKS)) {
    const type = String(b?.type || 'paragraph');
    if (type === 'heading') blocks.push({ type, text: String(b.text ?? ''), level: Math.min(3, Math.max(1, Number(b.level) || 1)) });
    else if (type === 'bullets' || type === 'numbered') blocks.push({ type, items: list(b.items).map(String) });
    else if (type === 'table') blocks.push({ type, headers: list(b.headers).map(String), rows: list(b.rows).map((r) => list(r).map(String)) });
    else if (type === 'page_break') blocks.push({ type });
    else blocks.push({ type: 'paragraph', text: String(b?.text ?? ''), bold: !!b?.bold });
  }
  return {
    title: String(doc?.title ?? '').trim(),
    orientation: doc?.orientation === 'landscape' ? 'landscape' : 'portrait',
    blocks,
  };
}

export function documentXml(doc) {
  const d = normalizeDocument(doc);
  const landscape = d.orientation === 'landscape';
  // A4: 11906 × 16838 twip; поля 2 см слева, 1,5 см остальные.
  const [pw, ph] = landscape ? [16838, 11906] : [11906, 16838];
  const margins = { top: 850, right: 850, bottom: 850, left: 1134 };
  const textWidth = pw - margins.left - margins.right;
  const body = [];
  if (d.title) body.push(paragraph(d.title, { style: 'Title' }));
  for (const b of d.blocks) {
    if (b.type === 'heading') body.push(paragraph(b.text, { style: `Heading${b.level}`, keepNext: true }));
    else if (b.type === 'bullets') body.push(...b.items.map((t) => paragraph(t, { style: 'ListParagraph', numId: 1 })));
    else if (b.type === 'numbered') body.push(...b.items.map((t) => paragraph(t, { style: 'ListParagraph', numId: 2 })));
    else if (b.type === 'table') body.push(tableXml(b.headers, b.rows, textWidth));
    else if (b.type === 'page_break') body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    else body.push(paragraph(b.text, { bold: b.bold }));
  }
  const sect = `<w:sectPr><w:pgSz w:w="${pw}" w:h="${ph}"${landscape ? ' w:orient="landscape"' : ''}/>`
    + `<w:pgMar w:top="${margins.top}" w:right="${margins.right}" w:bottom="${margins.bottom}" w:left="${margins.left}" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body.join('')}${sect}</w:body></w:document>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman" w:eastAsia="Times New Roman"/><w:sz w:val="24"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:i/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="Grid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="000000"/></w:tblBorders><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}>
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`;

function coreXml(title, now) {
  const iso = now.toISOString().replace(/\.\d+Z$/, 'Z');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlText(title)}</dc:title><dc:creator>JARVIS</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>`;
}

// Собирает файл .docx. Возвращает Blob.
export async function buildDocx(doc, now = new Date()) {
  const zip = await createZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES, date: now },
    { name: '_rels/.rels', data: ROOT_RELS, date: now },
    { name: 'docProps/core.xml', data: coreXml(doc?.title || 'Документ', now), date: now },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS, date: now },
    { name: 'word/document.xml', data: documentXml(doc), date: now },
    { name: 'word/styles.xml', data: STYLES, date: now },
    { name: 'word/numbering.xml', data: NUMBERING, date: now },
  ]);
  return new Blob([zip], { type: DOCX_MIME });
}
