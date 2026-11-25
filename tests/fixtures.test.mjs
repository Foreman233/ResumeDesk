import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { makeFixtures } from './make-fixtures.mjs';

test('generates five distinct fictional documents with valid cross references', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resumedesk-fixtures-'));
  try {
    const files = await makeFixtures(dir);
    assert.equal(files.length, 5);
    const data = await Promise.all(files.map((file) => readFile(file)));
    assert.equal(new Set(data.map((file) => file.toString('base64'))).size, files.length);
    for (const bytes of data.slice(0, 4)) {
      const text = bytes.toString();
      assert.ok(text.startsWith('%PDF-1.7'));
      assert.ok(text.includes('/Count 2'));
      const start = Number(text.match(/startxref\n(\d+)/)[1]);
      assert.equal(bytes.subarray(start, start + 4).toString(), 'xref');
      const offsets = text.slice(start).match(/\d{10} 00000 n/g);
      offsets.forEach((entry, number) => {
        const offset = Number(entry.slice(0, 10));
        assert.ok(bytes.subarray(offset, offset + 10).toString().startsWith((number + 1) + ' 0 obj'));
      });
    }
    const docx = await JSZip.loadAsync(data[4]);
    const document = await docx.file('word/document.xml').async('string');
    assert.match(document, /市场调研与项目管理/);
    assert.match(document, /example\.invalid/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
