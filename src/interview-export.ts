import { invoke } from '@tauri-apps/api/core';
import { CATEGORIES, LEVELS, SOURCES, type GuideInput } from './interview-api';

export type ExportFormat = 'pdf' | 'docx' | 'txt';
export type ExportOptions = { format: ExportFormat; detailed: boolean; showCandidate: boolean; showDate: boolean; candidateName?: string };
type Line = { text: string; role: 'title' | 'meta' | 'question' | 'detail' | 'space' };

function outline(input: GuideInput, options: ExportOptions): Line[] {
  const name = options.candidateName?.trim();
  const mask = !options.showCandidate && name ? new RegExp(name.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'), 'gi') : undefined;
  const lines: Line[] = [];
  const add = (text: string, role: Line['role'] = 'detail') => lines.push({ text: mask ? text.replace(mask, '候选人') : text, role });
  add(input.title.trim() || '面试提纲', 'title');
  add('面试岗位　' + (input.selection.jobTitle.trim() || '待填写'), 'meta');
  if (options.showCandidate && name) add('候选人　' + name, 'meta');
  if (options.showDate && input.interviewDate) add('面试日期　' + input.interviewDate, 'meta');
  for (const [index, question] of input.questions.entries()) {
    add('', 'space');
    add(String(index + 1) + '. ' + question.question.trim(), 'question');
    if (options.detailed) {
      add(CATEGORIES[question.category] + ' · ' + LEVELS[question.difficulty], 'meta');
      const details = [
        ['考察能力', question.competency], ['考察要点', question.evaluationPoints], ['追问', question.followUp],
        ['参考思路', question.referenceAnswer], ['出题依据', SOURCES[question.source.kind] + (question.source.evidence ? ' · ' + question.source.evidence : '')],
        ['回答摘要', question.answerSummary], ['待核实事项', question.verification], ['面试官备注', question.interviewerNotes],
      ];
      for (const [label, text] of details) if (text.trim()) add(label + '　' + text.trim());
    }
    add('面试记录　________________________________________________');
    add('　　　　　________________________________________________');
  }
  return lines;
}

const encoder = new TextEncoder();
const PAGE_WIDTH = 1240;
const PAGE_HEIGHT = 1754;
const MARGIN = 96;
const A4 = '595.28 841.89';
const lineStyle = {
  title: { size: 46, height: 68, weight: 700, color: '#20204b', ink: '20204B' },
  meta: { size: 24, height: 39, weight: 400, color: '#566080', ink: '566080' },
  question: { size: 31, height: 47, weight: 650, color: '#20204b', ink: '20204B' },
  detail: { size: 26, height: 40, weight: 400, color: '#333950', ink: '333950' },
  space: { size: 18, height: 22, weight: 400, color: '#333950', ink: '333950' },
};

function wrapped(ctx: CanvasRenderingContext2D, text: string) {
  const output: string[] = [];
  const width = PAGE_WIDTH - MARGIN * 2;
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.match(/[\p{Script=Han}]|[^\s\p{Script=Han}]+|\s/gu) ?? []) {
      if (ctx.measureText(line + word).width <= width) { line += word; continue; }
      if (line.trim()) output.push(line.trimEnd());
      line = '';
      for (const char of word.trimStart()) {
        if (ctx.measureText(line + char).width > width) { output.push(line); line = ''; }
        line += char;
      }
    }
    output.push(line);
  }
  return output;
}

function imagePdf(images: Uint8Array[]) {
  const parts: Uint8Array[] = [];
  const offsets: number[] = [0];
  let length = 0;
  function append(data: string | Uint8Array) {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    parts.push(bytes); length += bytes.length;
  }
  function object(body: string, data?: Uint8Array) {
    const id = offsets.length;
    offsets.push(length);
    append(id + ' 0 obj\n' + body);
    if (data) { append('\nstream\n'); append(data); append('\nendstream'); }
    append('\nendobj\n');
  }
  append('%PDF-1.4\n%'); append(new Uint8Array([226, 227, 207, 211, 10]));
  object('<< /Type /Catalog /Pages 2 0 R >>');
  object('<< /Type /Pages /Count ' + images.length + ' /Kids [' + images.map((_, index) => (3 + index * 3) + ' 0 R').join(' ') + '] >>');
  for (const [index, bytes] of images.entries()) {
    const id = 3 + index * 3;
    object(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4}] /Resources << /XObject << /PageImage ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
    const contents = encoder.encode('q\n595.28 0 0 841.89 0 0 cm\n/PageImage Do\nQ');
    object('<< /Length ' + contents.length + ' >>', contents);
    object(`<< /Type /XObject /Subtype /Image /Width ${PAGE_WIDTH} /Height ${PAGE_HEIGHT} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>`, bytes);
  }
  const xref = length;
  append('xref\n0 ' + offsets.length + '\n0000000000 65535 f \n' + offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join(''));
  append('trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
  const pdf = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { pdf.set(part, offset); offset += part.length; }
  return pdf;
}

async function pdf(lines: Line[]) {
  const canvas = document.createElement('canvas');
  canvas.width = PAGE_WIDTH; canvas.height = PAGE_HEIGHT;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('无法初始化 PDF 排版。');
  const ctx = context;
  const images: Uint8Array[] = [];
  let y = MARGIN;
  const reset = () => { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT); y = MARGIN; };
  async function finishPage() {
    ctx.fillStyle = '#566080'; ctx.font = '22px "Segoe UI", sans-serif'; ctx.textBaseline = 'top';
    ctx.fillText(String(images.length + 1), PAGE_WIDTH - MARGIN - 18, PAGE_HEIGHT - 65);
    const image = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PDF 页面转换失败。')), 'image/jpeg', 0.93);
    });
    images.push(new Uint8Array(await image.arrayBuffer()));
    reset();
  }
  reset();
  for (const [index, line] of lines.entries()) {
    const style = lineStyle[line.role];
    const font = `${style.weight} ${style.size}px "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif`;
    ctx.font = font;
    for (const [lineIndex, row] of wrapped(ctx, line.text).entries()) {
      const keepWithNext = line.role === 'question' && lineIndex === 0 && index < lines.length - 1 ? 42 : 0;
      if (y + style.height + keepWithNext > PAGE_HEIGHT - MARGIN) await finishPage();
      ctx.font = font; ctx.fillStyle = style.color; ctx.textBaseline = 'top';
      ctx.fillText(row, MARGIN, y);
      y += style.height;
    }
  }
  if (y > MARGIN) await finishPage();
  return imagePdf(images);
}

const xml = (text: string) => text.replace(/[\u0000-\u0008\u000B-\u001F\uFFFE\uFFFF]/g, '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

async function docx(lines: Line[]) {
  const { default: Zip } = await import('jszip');
  const archive = new Zip();
  archive.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  archive.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const paragraphs = lines.map(({ text, role }) => {
    const style = lineStyle[role];
    const content = text.split(/\r?\n/).map((part) => '<w:t xml:space="preserve">' + xml(part) + '</w:t>').join('<w:br/>');
    return `<w:p><w:pPr>${role === 'question' ? '<w:keepNext/>' : ''}<w:spacing w:after="100"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Segoe UI" w:eastAsia="Microsoft YaHei"/><w:color w:val="${style.ink}"/><w:sz w:val="${Math.round(style.size * .96)}"/>${style.weight >= 650 ? '<w:b/>' : ''}</w:rPr>${content}</w:r></w:p>`;
  }).join('');
  archive.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paragraphs + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1100" w:right="1100" w:bottom="1100" w:left="1100" w:header="450" w:footer="450" w:gutter="0"/></w:sectPr></w:body></w:document>');
  return archive.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function renderInterviewExport(input: GuideInput, options: ExportOptions) {
  if (!input.questions.length || input.questions.some(({ question }) => !question.trim())) throw new Error('请先填写面试题目。');
  const lines = outline(input, options);
  if (options.format === 'pdf') return pdf(lines);
  if (options.format === 'docx') return docx(lines);
  return encoder.encode('\uFEFF' + lines.map(({ text }) => text).join('\r\n') + '\r\n');
}

export async function exportInterview(input: GuideInput, options: ExportOptions) {
  const bytes = await renderInterviewExport(input, options);
  const packet = new Uint8Array(bytes.length + 1);
  packet[0] = { pdf: 1, docx: 2, txt: 3 }[options.format];
  packet.set(bytes, 1);
  return invoke<string | null>('export_interview_document', packet);
}
