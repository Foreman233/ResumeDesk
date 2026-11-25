import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import Zip from 'jszip';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const requireFromPdf = createRequire(require.resolve('pdfjs-dist/package.json'));

test('interview export creates private-by-default TXT, valid OOXML and paginated Chinese PDF', async () => {
  const server = await createServer({ logLevel: 'error', server: { middlewareMode: true, watch: null, hmr: false } });
  const { createCanvas } = requireFromPdf('@napi-rs/canvas');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const oldDocument = globalThis.document;
  globalThis.document = { createElement(tag) {
    assert.equal(tag, 'canvas');
    const canvas = createCanvas(1, 1);
    canvas.toBlob = (callback, type, quality) => callback(new Blob([canvas.toBuffer(type, Math.round(quality * 100))], { type }));
    return canvas;
  } };
  try {
    const { renderInterviewExport } = await server.ssrLoadModule('/src/interview-export.ts');
    const question = {
      category: 'technical', difficulty: 'medium', question: '林演示如何用 SQL 复核用户留存率？',
      competency: '指标核算与 <SQL> 设计', source: { kind: 'resume', evidence: '用户留存分析' },
      followUp: '如何处理重复记录？', evaluationPoints: '口径一致', referenceAnswer: '使用去重和窗口函数',
      interviewerNotes: '核对原始指标', answerSummary: '', verification: '',
    };
    const guide = { title: '林演示一面提纲', selection: { jobTitle: '数据分析师' }, interviewDate: '2028-02-29', questions: [question] };
    const safeOptions = { showCandidate: false, showDate: false, candidateName: '林演示' };
    const short = new TextDecoder().decode(await renderInterviewExport(guide, { ...safeOptions, format: 'txt', detailed: false }));
    assert.match(short, /候选人如何用 SQL 复核用户留存率/);
    assert.match(short, /面试记录/);
    assert.doesNotMatch(short, /林演示|2028-02-29|追问|考察能力|核对原始指标/);

    const bytes = await renderInterviewExport(guide, { ...safeOptions, format: 'docx', detailed: true, showCandidate: true, showDate: true });
    const archive = await Zip.loadAsync(bytes, { checkCRC32: true });
    const document = await archive.file('word/document.xml').async('string');
    assert.ok(archive.file('_rels/.rels') && archive.file('[Content_Types].xml'));
    assert.match(document, /林演示/);
    assert.match(document, /面试岗位/);
    assert.match(document, /2028-02-29/);
    assert.match(document, /指标核算与 &lt;SQL&gt; 设计/);
    assert.match(document, /如何处理重复记录/);

    const many = { ...guide, questions: Array.from({ length: 21 }, () => question) };
    const rawPdf = await renderInterviewExport(many, { ...safeOptions, format: 'pdf', detailed: true });
    const pdf = await getDocument({ data: rawPdf, useSystemFonts: false }).promise;
    assert.ok(pdf.numPages > 1);
    const first = await pdf.getPage(1);
    const viewer = first.getViewport({ scale: 0.5 });
    const surface = createCanvas(Math.ceil(viewer.width), Math.ceil(viewer.height));
    await first.render({ canvasContext: surface.getContext('2d'), viewport: viewer }).promise;
    assert.ok(surface.getContext('2d').getImageData(0, 0, surface.width, surface.height).data.some((value, i) => i % 4 === 0 && value < 180));
    await pdf.destroy();
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
    await server.close();
  }
});
