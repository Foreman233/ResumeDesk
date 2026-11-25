import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { makeFixtures } from './make-fixtures.mjs';

const [phase, endpoint, scratch] = process.argv.slice(2);
if (!['first', 'restart'].includes(phase) || !endpoint || !scratch) {
  throw new Error('Pass first or restart, the WebView2 endpoint, and the isolated test directory.');
}
const browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
const context = browser.contexts()[0];
const page = context.pages().find((target) => target.url().includes('tauri.localhost') && !target.url().includes('window=todo'));
assert.ok(page, 'native main window is open');
page.setDefaultTimeout(15000);
const button = (name, parent = page) => parent.getByRole('button', { name, exact: true });
const nav = (name) => button(name, page.locator('.sidebar'));
const dialog = () => page.getByRole('dialog').last();
const tab = (name) => page.getByRole('tab', { name, exact: true });
const source = (name) => page.getByRole('switch', { name, exact: true });
const searchInput = () => page.getByRole('textbox', { name: '搜索资料文件', exact: true });
const knowledgeDetails = () => page.getByRole('region', { name: '资料详情' });
const rpc = (action, fields = {}) => invoke('dispatch', { request: { action, ...fields } });
const knowledge = (action, fields = {}) => rpc('knowledge', { operation: { action, ...fields } });
const invoke = (command, payload) => page.evaluate(
  ({ command, payload }) => window.__TAURI_INTERNALS__.invoke(command, payload), { command, payload },
);
const normalized = (path) => path.replace(/\\/g, '/').toLowerCase();
const candidateName = '授权验收甲';
const policyName = '京城历史参考';
const modelRequests = [];
const searchRequests = [];
let searchBroken = false;
const provider = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (url.pathname === '/res/v1/web/search') {
    searchRequests.push({ query: url.searchParams.get('q'), token: request.headers['x-subscription-token'], body: request.headers['content-length'] });
    if (searchBroken) { response.writeHead(503); response.end('{}'); return; }
    response.end(JSON.stringify({ type: 'search', web: { results: [
      { title: '验收网页 <b>公开来源</b>', url: 'https://www.beijing.gov.cn/zhengce/', description: '虚构的实测检索摘要。' },
    ] } }));
    return;
  }
  assert.equal(url.pathname, '/v1/chat/completions');
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  modelRequests.push(body);
  if (!body.stream) {
    response.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
    return;
  }
  response.setHeader('Content-Type', 'text/event-stream');
  const raw = body.messages.at(-1).content;
  const question = raw.startsWith('{') ? JSON.parse(raw).question : raw;
  const delta = (content) => 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\r\n\r\n';
  response.end(delta('验收回复 · ' + question) + 'data: [DONE]\r\n\r\n');
});

async function waitFor(check, label, timeout = 13000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}
async function reply(question, confirmation = 'required', remember = false) {
  const response = () => page.getByText('验收回复 · ' + question, { exact: true });
  await page.getByLabel('输入消息').fill(question);
  await button('发送').click();
  if (confirmation === 'required') await confirm(remember);
  await response().waitFor();
  assert.equal(await dialog().isVisible(), false);
}
async function confirm(remember = false) {
  await dialog().getByRole('heading', { name: '核对 AI 发送内容' }).waitFor();
  const risk = dialog().getByRole('checkbox', { name: /我已核对发送内容/ });
  if (await risk.isVisible()) await risk.check();
  if (remember) await dialog().getByRole('checkbox', { name: '不再提示' }).check();
  await button('确认并发送', dialog()).click();
}
async function openLibrary() {
  await nav('小工具').click(); await button('展开 资料库').click();
  await page.getByRole('heading', { name: '资料库', exact: true }).waitFor();
}

try {
  const settings = await rpc('settings');
  assert.ok(normalized(settings.dataPath).startsWith(normalized(scratch).replace(/\/$/, '') + '/'),
    'refusing to test a non-fixture database');
  const configFile = join(scratch, 'round-three-fixture.json');
  const fixtures = phase === 'restart' ? JSON.parse(await readFile(configFile, 'utf8')) : {};
  await new Promise((resolve, reject) => {
    provider.once('error', reject); provider.listen(fixtures.port ?? 0, '127.0.0.1', resolve);
  });
  const port = provider.address().port;
  const addr = 'http://127.0.0.1:' + port;

  if (phase === 'restart') {
    assert.deepEqual((await rpc('dashboard_layout')).widgets, fixtures.widgets);
    await nav('工作台').click();
    await page.locator('[data-widget]').first().waitFor();
    assert.equal(await page.locator('[data-widget]').first().getAttribute('data-widget'), 'controls');
    assert.equal(await page.locator('[data-widget=jobs]').count(), 0);
    assert.ok((await rpc('jobs')).some((item) => item.id === fixtures.job));
    assert.ok((await rpc('ai_consents')).remembered.some((entry) => entry.capability === 'general'));
    await nav('HR AI 助手').click();
    await page.getByLabel('输入消息').waitFor();
    assert.equal(await source('联网搜索').getAttribute('aria-checked'), 'false');
    await reply('重启之后继续同范围问答', 'none');
    assert.equal(searchRequests.length, 0);
    assert.equal(modelRequests.length, 1);
    await openLibrary();
    await searchInput().fill('京城社保缴费基数');
    await page.locator('.knowledge-file-row').filter({ hasText: policyName }).click();
    await knowledgeDetails().getByText('京城社保缴费基数', { exact: false }).waitFor();
    const originals = await makeFixtures(join(scratch, 'round-three-files'));
    const pdf = originals.find((item) => item.endsWith('.pdf'));
    const docx = originals.find((item) => item.endsWith('.docx'));
    await page.getByLabel('选择资料文件', { exact: true }).setInputFiles([pdf, docx]);
    await knowledgeDetails().getByRole('heading', { name: basename(pdf), exact: true }).waitFor();
    await button('预览 PDF').click();
    await knowledgeDetails().locator('canvas[data-rendered=yes]').waitFor();
    await button('下一页', knowledgeDetails()).click();
    await knowledgeDetails().locator('canvas[aria-label="PDF 第 2 页"][data-rendered=yes]').waitFor();
    await page.locator('.knowledge-file-row').filter({ hasText: basename(docx) }).click();
    await knowledgeDetails().getByText('索引已完成', { exact: true }).waitFor();
    await knowledgeDetails().locator('.knowledge-chunk').first().waitFor();
    console.log('PASS knowledge library imports actual PDF/DOCX files and renders real PDF canvas through page two');
    await nav('工作台').click();
    await button('自定义工作台').click(); await button('恢复默认布局').click(); await button('保存布局').click();
    await page.locator('[data-widget=overview]').waitFor();
    assert.equal(await page.locator('[data-widget]').first().getAttribute('data-widget'), 'overview');
    await page.locator('[data-widget=jobs]').waitFor();
    await button('自定义工作台').click();
    await page.getByLabel('招聘数据概览宽度', { exact: true }).selectOption('2');
    const resize = button('调整 招聘数据概览 尺寸');
    await resize.scrollIntoViewIfNeeded();
    const bounds = await resize.boundingBox();
    const gridWidth = await page.locator('.dashboard-widgets').evaluate((element) => element.clientWidth);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + gridWidth * .28, bounds.y + bounds.height / 2 + 104, { steps: 10 });
    await page.mouse.up();
    const overview = page.locator('[data-widget=overview]');
    await waitFor(async () => await overview.getAttribute('data-width') === '4' && await overview.getAttribute('data-height') === '2',
      'pointer resizing changes both dimensions');
    await button('取消编辑').click();
    assert.equal(await overview.getAttribute('data-height'), '1');
    console.log('PASS workbench corner handle changes width and height with pointer drag');
    console.log('PASS native process restart preserves remembered consent, knowledge source, reordered layout, and hidden-module data');
  } else {
    await rpc('save_ai', { input: { settings: settings.ai.settings, removeKey: true } });
    await invoke('set_quick_control', { change: { key: 'aiEnabled', value: true } });
    await invoke('set_quick_control', { change: { key: 'confirmAiSend', value: true } });
    const jobs = [];
    for (const title of ['三轮测试岗位 A', '三轮测试岗位 B']) {
      jobs.push(await rpc('save_job', { input: { title, department: '', jd: '样例岗位', status: 'open' } }));
    }
    const candidate = await rpc('save_candidate', { input: { name: candidateName, email: 'fixture-person@example.invalid', phone: '13812345678' } });
    const first = await rpc('link_application', { candidateId: candidate, jobId: jobs[0] });
    const second = await rpc('link_application', { candidateId: candidate, jobId: jobs[1] });
    await rpc('save_application', { id: first, stage: 'new', note: '保留的申请备注' });
    await rpc('todo', { operation: { action: 'save_rule', stage: 'screened', enabled: true } });
    await nav('候选人库').click();
    await page.getByLabel('搜索候选人').fill(candidateName);
    const candidateRow = page.locator('.candidate-row').filter({ hasText: candidateName });
    await candidateRow.waitFor();
    await page.getByLabel(candidateName + ' · 选择申请岗位', { exact: true }).selectOption(String(first));
    await page.getByLabel(candidateName + ' · 招聘状态', { exact: true }).selectOption('screened');
    await waitFor(async () => (await rpc('applications', { jobId: jobs[0] }))[0]?.stage === 'screened', 'stored quick stage');
    assert.equal((await rpc('applications', { jobId: jobs[0] }))[0].note, '保留的申请备注');
    assert.equal((await rpc('applications', { jobId: jobs[1] }))[0].stage, 'new');
    await candidateRow.click();
    await page.getByLabel('当前候选人 · 选择申请岗位', { exact: true }).selectOption(String(first));
    assert.equal(await page.getByLabel('当前候选人 · 招聘状态', { exact: true }).inputValue(), 'screened');
    await button('添加备注', page.locator('.candidate-quick-actions')).click();
    await dialog().getByLabel('招聘备注').fill('预览页面内新建备注');
    await button('保存备注', dialog()).click();
    await dialog().waitFor({ state: 'hidden' });
    await button('安排面试', page.locator('.candidate-quick-actions')).click();
    await dialog().getByRole('heading', { name: '安排面试', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByLabel('按岗位筛选').selectOption(String(jobs[0]));
    assert.equal(await page.getByLabel(candidateName + ' · 招聘状态', { exact: true }).inputValue(), 'screened');
    await rpc('save_application', { id: first, stage: 'screened', note: '保留的申请备注' });
    assert.equal((await rpc('todo', { operation: { action: 'list', filter: { applicationId: first } } })).length, 1);
    await page.getByLabel('按岗位筛选').selectOption('');
    await page.getByLabel(candidateName + ' · 选择申请岗位', { exact: true }).selectOption(String(second));
    await rpc('unlink_application', { id: second });
    await page.getByLabel(candidateName + ' · 招聘状态', { exact: true }).selectOption('hired');
    await page.getByRole('alert').getByText('找不到此岗位申请。').waitFor();
    await waitFor(async () => (await page.getByLabel(candidateName + ' · 招聘状态', { exact: true }).inputValue()) === 'screened', 'displayed stage rolled back');
    await nav('工作台').click();
    const progress = page.locator('[data-widget=progress]');
    await progress.getByText('初筛通过', { exact: true }).waitFor();
    assert.ok(Number(await progress.getByLabel('初筛通过数量').getAttribute('value')) >= 1);
    await page.getByRole('tab', { name: '最近浏览' }).click();
    await page.locator('[data-widget=candidates]').getByText(candidateName, { exact: true }).waitFor();
    console.log('PASS list/details stage controls select the right application, preserve notes, undo a real failed save, and update dashboard/rules');

    await openLibrary();
    await button('新建分类').click(); await dialog().getByLabel('分类名称').fill('本轮政策资料');
    await button('保存分类', dialog()).click(); await dialog().waitFor({ state: 'hidden' });
    await page.getByLabel('选择资料文件', { exact: true }).setInputFiles({
      name: '历史政策.txt', mimeType: 'text/plain', buffer: Buffer.from('京城社保缴费基数\n本件为历史资料验收，保留的证据标记 ROUND3-LOCAL。'),
    });
    await knowledgeDetails().getByText('索引已完成', { exact: true }).waitFor();
    const files = await knowledge('list', { filter: { query: '京城社保缴费基数' } });
    const documentId = files.items.find((item) => item.name === '历史政策.txt').id;
    assert.ok(documentId);
    const dropped = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(['虚构临时内容 DRAG-ROUND3'], '临时拖入.md', { type: 'text/markdown' }));
      return data;
    });
    await page.locator('.knowledge-page').dispatchEvent('drop', { dataTransfer: dropped });
    await knowledgeDetails().getByRole('heading', { name: '临时拖入.md', exact: true }).waitFor();
    await button('删除文件').click(); await button('确认删除', dialog()).click(); await dialog().waitFor({ state: 'hidden' });
    assert.equal((await knowledge('list', { filter: { query: 'DRAG-ROUND3' } })).total, 0);
    await searchInput().fill('京城社保缴费基数');
    await page.locator('.knowledge-file-row').filter({ hasText: '历史政策.txt' }).click();
    assert.equal(await button('询问此资料').isDisabled(), true);
    await button('编辑资料信息').click();
    await dialog().getByLabel('文件名称').fill(policyName); await dialog().getByLabel('标签', { exact: true }).fill('历史，规则');
    await dialog().getByLabel('适用地区').fill('北京市'); await dialog().getByLabel('发布机构').fill('虚构发布机关');
    await dialog().getByLabel('生效日期').fill('2020-01-01'); await dialog().getByLabel('失效日期').fill('2022-01-01');
    await dialog().getByRole('checkbox', { name: '允许 AI 引用这份资料' }).check();
    await button('保存资料', dialog()).click(); await dialog().waitFor({ state: 'hidden' });
    await knowledgeDetails().getByRole('heading', { name: policyName, exact: true }).waitFor();
    assert.equal((await rpc('ai_status')).hasKey, false);
    console.log('PASS offline file picking, drag-and-drop, classification/tag/policy edits, text search and index removal');

    await rpc('save_ai', { input: { settings: { baseUrl: addr + '/v1', model: 'round-three-fixture', timeoutSeconds: 12 }, apiKey: 'fixture-model-key' } });
    await invoke('test_ai', { id: 'round-three-connect' });
    await nav('HR AI 助手').click(); await button('新建对话').click();
    assert.equal(await source('联网搜索').getAttribute('aria-checked'), 'false');
    await page.getByLabel('输入消息').fill('首次普通问题'); await button('发送').click();
    await dialog().getByRole('checkbox', { name: '不再提示' }).check();
    await button('取消', dialog()).click();
    assert.equal((await rpc('ai_consents')).remembered.length, 0);
    assert.equal(modelRequests.length, 1);
    await reply('首次普通问题', 'required', true);
    await reply('同范围连续问题', 'none');
    assert.equal(searchRequests.length, 0);
    assert.equal(modelRequests.at(-1).messages.filter((item) => item.role === 'user').length, 2);
    await button('AI 设置').click(); await tab('隐私与授权').click();
    await page.getByRole('region', { name: '普通 AI 对话' }).getByText('已记住 1 项').waitFor();
    await button('重置所有 AI 授权').click();
    await page.getByRole('region', { name: '普通 AI 对话' }).getByText('等待确认').waitFor();
    await tab('联网搜索').click();
    await page.getByLabel('搜索 API 端点').fill(addr + '/res/v1/web/search');
    await page.getByLabel('搜索 API Key').fill('fixture-web-key');
    await button('保存搜索配置').click(); await page.getByText('已保存配置', { exact: true }).waitFor();
    await nav('HR AI 助手').click(); await reply('重置之后重新授权', 'required', true);
    console.log('PASS first-send, cancel-with-remember, repeated ordinary chat, and Settings reset are enforced end to end');

    await openLibrary();
    await page.locator('.knowledge-file-row').filter({ hasText: policyName }).click();
    await button('询问此资料').click();
    await page.getByText('已指定 1 份资料', { exact: true }).waitFor();
    await reply('京城社保缴费基数的历史材料', 'required', true);
    assert.equal(searchRequests.length, 0);
    const local = JSON.parse(modelRequests.at(-1).messages.at(-1).content);
    assert.ok(local.context.some((item) => item.type === '资料库' && item.text.includes('ROUND3-LOCAL') && item.policy.expiresOn === '2022-01-01'));
    await page.getByText(/本次发送的资料与引用/).last().click();
    await button('查看来源文件').last().click();
    await knowledgeDetails().getByRole('heading', { name: policyName, exact: true }).waitFor();
    await button('询问此资料').click();
    await page.getByText('已指定 1 份资料', { exact: true }).waitFor();
    const count = modelRequests.length;
    await page.getByLabel('输入消息').fill('火星火山玄武岩'); await button('发送').click();
    await page.getByText(/所选资料库中未找到与问题相关的已索引片段/).waitFor();
    assert.equal(modelRequests.length, count);

    await source('联网搜索').click();
    await page.getByLabel('公开搜索词').fill(candidateName + ' 京社保');
    await page.getByLabel('输入消息').fill('比较京城社保缴费基数'); await button('发送').click();
    await page.getByRole('alert').getByText(/搜索词包含本地候选人姓名/).waitFor();
    assert.equal(searchRequests.length, 0);
    await page.getByLabel('公开搜索词').fill('北京市 社保公开政策');
    await reply('比较京城社保缴费基数', 'required', true);
    assert.deepEqual(searchRequests, [{ query: '北京市 社保公开政策', token: 'fixture-web-key', body: undefined }]);
    const hybrid = JSON.parse(modelRequests.at(-1).messages.at(-1).content);
    assert.ok(hybrid.context.some((item) => item.type === '资料库' && item.text.includes('ROUND3-LOCAL')));
    assert.ok(hybrid.context.some((item) => item.type === '网页' && item.url === 'https://www.beijing.gov.cn/zhengce/'));
    const links = page.getByText(/本次发送的资料与引用/).last();
    if (!await page.getByText('检索时间', { exact: false }).last().isVisible()) await links.click();
    await button('https://www.beijing.gov.cn/zhengce/').waitFor();
    searchBroken = true;
    const beforeError = modelRequests.length;
    await page.getByLabel('公开搜索词').fill('北京市 政策');
    await page.getByLabel('输入消息').fill('再确认京城社保缴费基数'); await button('发送').click();
    await page.getByRole('alert').getByText(/联网搜索服务不可用/).waitFor();
    assert.equal(modelRequests.length, beforeError);
    console.log('PASS local RAG without hallucinated fallback, scoped expansion consent, public query filtering, and actual HTTP with labeled web sources/errors');

    await nav('工作台').click();
    await page.locator('[data-widget=knowledge]').getByText(policyName, { exact: true }).waitFor();
    await button('自定义工作台').click();
    await button('隐藏 资料库').click(); assert.equal(await page.locator('[data-widget=knowledge]').count(), 0);
    await button('添加模块', page.locator('.dashboard-editor-toolbar')).click();
    await button('添加 资料库', dialog()).click(); await button('完成', dialog()).click();
    await page.locator('[data-widget=knowledge]').waitFor();
    await page.getByLabel('招聘数据概览宽度', { exact: true }).selectOption('1');
    const target = page.locator('[data-widget=overview]');
    await button('移动 快捷控制中心').dragTo(target, { targetPosition: { x: 15, y: 33 } });
    await waitFor(async () => await page.locator('[data-widget]').first().getAttribute('data-widget') === 'controls', 'drag reordered widgets');
    await page.getByLabel('招聘数据概览高度', { exact: true }).selectOption('3');
    await button('隐藏 招聘岗位').click();
    await button('保存布局').click(); await button('自定义工作台').waitFor({ state: 'visible' });
    await waitFor(async () => (await rpc('dashboard_layout'))?.widgets?.[0]?.id === 'controls', 'stored layout');
    assert.equal(await page.locator('[data-widget=jobs]').count(), 0);
    await button('自定义工作台').click(); await button('恢复默认布局').click(); await button('取消编辑').click();
    assert.equal(await page.locator('[data-widget]').first().getAttribute('data-widget'), 'controls');
    assert.equal(await target.getAttribute('data-width'), '1');

    const cdp = await context.newCDPSession(page);
    try {
      for (const width of [950, 1460]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 860, deviceScaleFactor: 1, mobile: false });
        await waitFor(async () => await page.evaluate(() => window.innerWidth) === width, 'responsive viewport');
        const rects = await page.locator('[data-widget]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
        for (let a = 0; a < rects.length; a++) {
          for (let b = a + 1; b < rects.length; b++) {
            const [x, y] = [rects[a], rects[b]];
            assert.ok(x.right <= y.left + .5 || y.right <= x.left + .5 || x.bottom <= y.top + .5 || y.bottom <= x.top + .5, 'module boxes overlap');
          }
        }
      }
    } finally { await cdp.send('Emulation.clearDeviceMetricsOverride'); await cdp.detach(); }
    const layout = await rpc('dashboard_layout');
    await writeFile(configFile, JSON.stringify({ port, job: jobs[0], widgets: layout.widgets }), 'utf8');
    console.log('PASS workbench add, hide, drag, resize, save, cancel, and responsive non-overlap');
  }
} catch (error) {
  await page.screenshot({ path: join(scratch, 'round-three-' + phase + '-failure.png'), timeout: 6000 }).catch(() => {});
  throw error;
} finally {
  provider.closeAllConnections();
  provider.close();
  await browser.close().catch(() => {});
}
