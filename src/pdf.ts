import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { ParseStatus } from './api';

GlobalWorkerOptions.workerSrc = worker;
const assets = new URL('./pdf-assets/', document.baseURI).href;
const charLimit = 180_000;

export function openPdf(data: Uint8Array<ArrayBuffer>) {
  return getDocument({
    data, cMapUrl: assets + 'cmaps/', cMapPacked: true, standardFontDataUrl: assets + 'standard_fonts/',
    wasmUrl: assets + 'wasm/', iccUrl: assets + 'iccs/', enableXfa: false,
    maxImageSize: 16_000_000, canvasMaxAreaInBytes: 64_000_000,
  });
}

function pageText(items: TextItem[]) {
  let text = '';
  let previous: TextItem | undefined;
  for (const item of items) {
    if (previous && !previous.hasEOL && previous.str && item.str && !/\s$/u.test(text) && !/^\s/u.test(item.str)) {
      const gap = item.transform[4] - previous.transform[4] - previous.width;
      if (Math.abs(item.transform[5] - previous.transform[5]) > Math.max(2, Math.abs(previous.height) * .45)) text += '\n';
      else if (gap > Math.max(.75, Math.abs(previous.height) * .13)) text += ' ';
    }
    text += item.str + (item.hasEOL ? '\n' : '');
    previous = item;
  }
  return text.trim();
}

export interface PdfTextPage { page: number; text: string }

export async function extractPdf(bytes: Uint8Array<ArrayBuffer>, preservePageBoundaries = false): Promise<{
  text: string; status: ParseStatus; pages: PdfTextPage[];
}> {
  // PDF.js transfers ownership of worker input. Keep the original bytes for import.
  const task = openPdf(bytes.slice());
  let text = '';
  const pages: PdfTextPage[] = [];
  let timer = 0;
  try {
    const read = async () => {
      const pdf = await task.promise;
      let partial = pdf.numPages > 100;
      for (let page = 1; page <= Math.min(100, pdf.numPages); page++) {
        const current = await pdf.getPage(page);
        const content = await current.getTextContent();
        const value = pageText(content.items.filter((item): item is TextItem => 'str' in item));
        if (value) {
          const separator = text ? (preservePageBoundaries ? '\n\f\n' : '\n\n') : '';
          const available = Math.max(0, charLimit - text.length - separator.length);
          if (available > 0) pages.push({ page, text: value.slice(0, available) });
          text += separator + value;
        }
        current.cleanup();
        if (text.length > charLimit) { partial = true; break; }
      }
      return partial;
    };
    const partial = await Promise.race([
      read(),
      new Promise<boolean>((_, reject) => { timer = window.setTimeout(() => reject(new Error('PDF timeout')), 15_000); }),
    ]);
    return { text: text.slice(0, charLimit), status: !text ? 'empty' : partial ? 'partial' : 'complete', pages };
  } catch {
    return { text: text.slice(0, charLimit), status: text ? 'partial' : 'failed', pages };
  } finally {
    window.clearTimeout(timer);
    void task.destroy().catch(() => {});
  }
}
