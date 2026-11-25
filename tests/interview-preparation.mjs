import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import Zip from 'jszip';

const [phase, endpoint, scratch] = process.argv.slice(2);
assert.ok(['first', 'restart'].includes(phase) && endpoint && scratch, 'Use an isolated native QA process');
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0].pages().find((item) => item.url().includes('tauri.localhost') && !item.url().includes('window=todo'));
assert.ok(page, 'the native primary window is open');
page.setDefaultTimeout(15000);
const button = (name, root = page) => root.getByRole('button', { name, exact: true });
const nav = (name) => button(name, page.locator('.sidebar'));
const modal = () => page.getByRole('dialog').last();
const widget = () => page.getByRole('region', { name: '面试准备展开视图' });
const questionField = (index) => widget().locator('.interview-question').nth(index).locator('textarea').first();
const invoke = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const rpc = (action, fields = {}) => invoke('dispatch', { request: { action, ...fields } });
const guides = (action, fields = {}) => rpc('interview', { operation: { action, ...fields } });
const quick = (key, value) => invoke('set_quick_control', { change: { key, value } });
const normal = (path) => path.replace(/\\/g, '/').toLowerCase();
const log = (text) => console.log('PASS ' + text);

async function seedResume(target, version, content) {
  const bytes = await readFile(new URL('../demo/05-Fang-Demo.docx', import.meta.url));
  const zip = await Zip.loadAsync(bytes);
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    content.map((line) => '<w:p><w:r><w:t>' + line + '</w:t></w:r></w:p>').join('') + '</w:body></w:document>');
  const data = await zip.generateAsync({ type: 'uint8array' });
  const meta = new TextEncoder().encode(JSON.stringify({ name: `面试演示-${version}.docx`, target, text: '', status: 'complete' }));
  const packet = new Uint8Array(4 + meta.length + data.length);
  new DataView(packet.buffer).setUint32(0, meta.length, true);
  packet.set(meta, 4); packet.set(data, 4 + meta.length);
  return page.evaluate((data) => window.__TAURI_INTERNALS__.invoke('import_document', Uint8Array.from(data)), [...packet]);
}

let server;
try {
  const settings = await rpc('settings');
  assert.ok(normal(settings.dataPath).startsWith(normal(scratch).replace(/\/$/, '') + '/'), 'refusing a non-test workspace');
  if (phase === 'first') {
    const first = await seedResume({ kind: 'new' }, '早期', ['姓名：面试演示甲', '邮箱：interview@example.invalid', '使用 SQL 计算留存指标']);
    const newer = await seedResume({ kind: 'candidate', id: first.ownerId }, '最新版', ['姓名：面试演示甲', 'Tableau 报表探索']);
    assert.equal(newer.ownerId, first.ownerId);
    const job = await rpc('save_job', { input: { title: '面试验收岗位', department: '示例', jd: '需要使用 Power BI 建立留存看板', status: 'open' } });
    const application = await rpc('link_application', { candidateId: first.ownerId, jobId: job });
    await quick('aiEnabled', false);
    await nav('候选人库').click();
    await page.getByLabel('搜索候选人', { exact: true }).fill('面试演示甲');
    await page.locator('.candidate-row').filter({ hasText: '面试演示甲' }).click();
    await button('准备面试问题').click();
    await widget().getByText('面试演示甲', { exact: true }).last().waitFor();
    await widget().getByLabel('简历版本').selectOption(String(first.documentId));
    assert.equal(await widget().getByLabel('面试岗位与申请').inputValue(), 'a:' + application);
    await widget().getByLabel('提纲名称').fill('本地面试提纲验收');
    await widget().getByLabel('面试日期').fill('2028-02-29');
    assert.equal(await button('生成面试问题', widget()).isEnabled(), false);
    await button('手动加题', widget()).click();
    await questionField(0).fill('请描述指标计算的步骤。');
    await button('手动加题', widget()).click();
    await questionField(1).fill('需要核对哪些数据来源？');
    await button('上移第 2 题', widget()).click();
    assert.equal(await questionField(0).inputValue(), '需要核对哪些数据来源？');
    const firstQuestion = widget().locator('.interview-question').first();
    await firstQuestion.getByText('面试记录', { exact: true }).click();
    await firstQuestion.getByLabel('回答摘要').fill('虚构候选人回答');
    await button('保存提纲', widget()).click();
    await page.getByText('面试提纲已保存', { exact: true }).waitFor();
    const [manual] = await guides('list', { query: '本地面试提纲验收' });
    assert.equal(manual.questionCount, 2);
    const saved = await guides('get', { id: manual.id });
    assert.equal(saved.input.selection.resumeId, first.documentId);
    assert.equal(saved.input.questions[0].answerSummary, '虚构候选人回答');

    await widget().getByLabel('提纲名称').fill('未保存改名');
    await nav('小工具').click();
    await button('新建面试提纲').click();
    await modal().getByText('放弃未保存的修改？').waitFor();
    await button('取消', modal()).click();
    assert.equal(await widget().getByLabel('提纲名称').inputValue(), '未保存改名');
    await widget().getByLabel('提纲名称').fill('本地面试提纲验收');
    await button('复制提纲', widget()).click();
    await widget().getByLabel('提纲名称').fill('AI 面试提纲验收');
    log('candidate shortcut, selected resume and linked application, local editor, records, ordering and draft protection');

    const requests = [];
    server = createServer(async (request, response) => {
      let body = '';
      for await (const part of request) body += part;
      const { messages } = JSON.parse(body);
      let content = 'OK';
      if (messages[1].content !== 'OK?') {
        const options = JSON.parse(messages[1].content);
        requests.push(options);
        const chosen = requests.length === 1 ? options.slots.slice(0, -1) : options.slots;
        content = JSON.stringify({ questions: chosen.map((slot, index) => ({ ...slot,
          question: `你会如何检验第 ${requests.length}-${index + 1} 种留存口径？`, competency: '指标核实',
          source: { kind: 'resume', evidence: '使用 SQL 计算留存指标' }, followUp: '如何解释差异？', evaluationPoints: '口径一致',
        })) });
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    await quick('aiEnabled', true);
    await quick('confirmAiSend', false);
    await rpc('save_ai', { input: { settings: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'interview-fixture', timeoutSeconds: 5 }, apiKey: 'fixture-interview' } });
    await invoke('test_ai', { id: 'interview-fixture-connection' });
    await nav('设置').click();
    await nav('小工具').click();
    await button('展开 面试准备').click();
    await widget().getByLabel('目标题数').fill('6');
    await widget().getByRole('region', { name: '生成设置' }).getByLabel('问题难度').selectOption('basic');
    await button('重新生成提纲', widget()).click();
    await button('重新生成', modal()).click();
    await modal().getByText('核对面试资料发送范围', { exact: true }).waitFor();
    await modal().getByLabel('记住此模型和资料范围的授权').check();
    await button('确认发送并生成', modal()).click();
    await widget().getByText(/本次取得 5 \/ 6/).waitFor();
    assert.equal(requests[0].count, 6);
    assert.match(requests[0].sources.jd, /Power BI/);
    assert.doesNotMatch(JSON.stringify(requests[0]), /面试演示甲|@example\.invalid|Tableau/);
    await button('补充 1 题', widget()).click();
    await widget().getByText('已补充 1 道题。', { exact: true }).waitFor();
    assert.equal(await widget().locator('.interview-question').count(), 6);
    await button('重新生成第 1 题', widget()).click();
    await widget().getByText('已重新生成此题，面试记录已保留。', { exact: true }).waitFor();
    assert.equal(requests.length, 3);
    await button('保存提纲', widget()).click();
    await page.getByText('面试提纲已保存', { exact: true }).waitFor();
    await button('导出', widget()).click();
    await modal().getByText('导出面试提纲', { exact: true }).waitFor();
    assert.equal(await modal().getByLabel('显示候选人姓名').isChecked(), false);
    await button('取消', modal()).click();
    await page.screenshot({ path: `${scratch}/interview-preparation.png` });
    log('verified mock provider, exact scope, partial count, supplement, single-item regeneration and export choices');
  } else {
    await nav('小工具').click();
    await button('展开 面试准备').click();
    await button('历史提纲', widget()).click();
    await modal().getByLabel('搜索提纲').fill('本地面试提纲验收');
    await modal().getByRole('button', { name: /本地面试提纲验收/ }).click();
    await questionField(0).waitFor();
    assert.equal(await widget().getByLabel('提纲名称').inputValue(), '本地面试提纲验收');
    assert.equal(await questionField(0).inputValue(), '需要核对哪些数据来源？');
    const start = Date.now();
    while (!(await guides('list', { query: 'AI 面试提纲验收' })).some((item) => item.questionCount === 6) && Date.now() - start < 2000) await delay(30);
    assert.ok((await guides('list', { query: 'AI 面试提纲验收' })).some((item) => item.questionCount === 6));
    log('saved manual and AI interview guides reopened after restarting the Windows process');
  }
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await browser.close();
}
