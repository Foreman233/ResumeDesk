import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import JSZip from 'jszip';

const records = [
  { file: '01-Lin-Qiao.pdf', heading: 'LIN QIAO', role: 'DATA ANALYST', lines: [
    'Name: Lin Qiao', 'Current Role: Data Analyst', 'lin.qiao@example.invalid',
    'Use SQL and Excel to track product metrics.', 'Python for weekly cohort reports.', 'Visualization with Tableau.',
  ] },
  { file: '02-Zhou-Tao.pdf', heading: 'ZHOU TAO', role: 'REPORTING SPECIALIST', lines: [
    'Name: Zhou Tao', 'Current Role: Reporting Specialist', 'zhou.tao@example.invalid',
    'Use SQL to consolidate regional sales figures.', 'Use Microsoft Excel for reporting and variance checks.',
  ] },
  { file: '03-Ning-Yu.pdf', heading: 'NING YU', role: 'ANALYTICS ENGINEER', lines: [
    'Name: Ning Yu', 'Current Role: Analytics Engineer', 'ning.yu@example.invalid',
    'Extract metrics with SQL and Python.', 'Version analysis scripts with Git.', 'Maintain quality checks in a shared dashboard.',
  ] },
  { file: '04-Qiao-CN.pdf', heading: '乔示例', role: '数据分析师', lines: [
    '姓名：乔示例', '当前职位：数据分析师', '邮箱：qiao.cn@example.invalid',
    '构建用户留存数据平台，使用 SQL 和电子表格。', '参与市场调研和月度复盘。',
  ] },
  { file: '05-Fang-Demo.docx', heading: '方样例', role: '项目助理', lines: [
    '姓名：方样例', '当前职位：项目助理', '邮箱：fang.demo@example.invalid',
    '负责市场调研与项目管理。', '用 Power BI 制作团队报告。',
  ] },
];

const ascii = (text) => /^[\x20-\x7E]*$/.test(text);
const pdfLiteral = (text) => '(' + text.replace(/[\\()]/g, '\\$&') + ')';
const pdfUnicode = (text) => '<' + Buffer.from(text, 'utf16le').swap16().toString('hex').toUpperCase() + '>';
const textAt = (text, size, x, y, color) =>
  'BT /' + (ascii(text) ? 'H' : 'C') + ' ' + size + ' Tf ' + color + ' rg 1 0 0 1 ' + x + ' ' + y +
  ' Tm ' + (ascii(text) ? pdfLiteral(text) : pdfUnicode(text)) + ' Tj ET';
const stream = (text) => '<< /Length ' + Buffer.byteLength(text) + ' >>\nstream\n' + text + '\nendstream';

function pdf(record) {
  const title = record.heading;
  const first = [
    '0.13 0.16 0.28 rg 0 600 595 242 re f',
    '0.63 0.57 0.98 rg 49 748 36 3 re f',
    textAt(title, 37, 48, 690, '1 1 1'),
    textAt(record.role, 13, 50, 655, '0.76 0.75 0.92'),
    textAt('CANDIDATE PROFILE', 10, 50, 580, '0.35 0.31 0.69'),
    ...record.lines.slice(0, 3).map((line, index) => textAt(line, 13, 50, 547 - index * 24, '0.18 0.20 0.30')),
    '0.88 0.89 0.94 RG 50 465 m 545 465 l S',
    textAt('SELECTED EXPERIENCE', 10, 50, 436, '0.35 0.31 0.69'),
    ...record.lines.slice(3).map((line, index) => textAt(line, 13, 50, 402 - index * 27, '0.18 0.20 0.30')),
    textAt('FICTIONAL RESUMEDESK SAMPLE  /  1', 9, 50, 48, '0.42 0.45 0.58'),
  ].join('\n');
  const second = [
    '0.92 0.91 0.99 rg 0 690 595 152 re f',
    textAt('PROJECT NOTES', 21, 50, 750, '0.19 0.17 0.35'),
    textAt('Practice file for page navigation and zoom.', 13, 50, 650, '0.20 0.23 0.38'),
    textAt('FICTIONAL RESUMEDESK SAMPLE  /  2', 9, 50, 48, '0.42 0.45 0.58'),
  ].join('\n');
  const characters = [...new Set([title, record.role, ...record.lines].join('').split('').filter((x) => !ascii(x)))];
  const cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /ResumeDeskUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
    (characters.length ? characters.length + ' beginbfchar\n' + characters.map((c) => pdfUnicode(c) + ' ' + pdfUnicode(c)).join('\n') + '\nendbfchar\n' : '') +
    'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
  const fonts = '/Resources << /Font << /H 5 0 R /C 6 0 R >> >>';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /MediaBox [0 0 595 842] /Parent 2 0 R ' + fonts + ' /Contents 10 0 R >>',
    '<< /Type /Page /MediaBox [0 0 595 842] /Parent 2 0 R ' + fonts + ' /Contents 11 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [7 0 R] /ToUnicode 9 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 8 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>',
    stream(cmap), stream(first), stream(second),
  ];
  let body = '%PDF-1.7\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'; }
  const xref = Buffer.byteLength(body);
  return Buffer.from(body + 'xref\n0 ' + offsets.length + '\n0000000000 65535 f \n' +
    offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
}

async function docx(record) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    record.lines.map((line) => '<w:p><w:r><w:t>' + escape(line) + '</w:t></w:r></w:p>').join('') +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export async function makeFixtures(path) {
  await mkdir(path, { recursive: true });
  return Promise.all(records.map(async (record) => {
    const target = join(path, record.file);
    await writeFile(target, record.file.endsWith('.docx') ? await docx(record) : pdf(record));
    return target;
  }));
}

export async function makeImportFixtures(path) {
  await mkdir(path, { recursive: true });
  const combined = join(path, '06-Combined-Resumes.docx');
  const manual = join(path, '07-Manual-Resume.docx');
  await writeFile(combined, await docx({ lines: [
    '姓名：叶示例', '当前职位：质量分析师', '邮箱：ye.resume@example.invalid', '熟悉质量追踪工具。',
    '姓名：彭样例', '当前职位：报告专员', '邮箱：peng.resume@example.invalid', '擅长维护月度经营简报。',
  ] }));
  await writeFile(manual, await docx({ lines: [
    '姓名：不自动提取样例', '当前职位：合规专员', '邮箱：manual.resume@example.invalid', '复查方法以独立关键词测试为准。',
  ] }));
  return [combined, manual];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dest = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../demo/', import.meta.url));
  for (const path of await makeFixtures(dest)) console.log(path);
}
