import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const [phase, endpoint, scratch] = process.argv.slice(2);
if (!['first', 'restart'].includes(phase) || !endpoint || !scratch) {
  throw new Error('Pass first or restart, the WebView2 endpoint, and the isolated test directory.');
}
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0].pages().find((target) => target.url().includes('tauri.localhost') && !target.url().includes('window=todo'));
assert.ok(page, 'native main window is open');
page.setDefaultTimeout(15000);
const button = (name, parent = page) => parent.getByRole('button', { name, exact: true });
const nav = (name) => button(name, page.locator('.sidebar'));
const dialog = () => page.getByRole('dialog').last();
const hub = () => page.locator('.widget-hub');
const card = (id) => hub().locator('[data-widget="' + id + '"]');
const workspace = (name) => hub().getByRole('region', { name: name + '展开视图' });
const details = () => workspace('资料库').getByRole('region', { name: '资料详情' });
const invoke = (command, args) => page.evaluate(
  ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args },
);
const rpc = (action, fields = {}) => invoke('dispatch', { request: { action, ...fields } });
const todo = (action, fields = {}) => rpc('todo', { operation: { action, ...fields } });
const knowledge = (action, fields = {}) => rpc('knowledge', { operation: { action, ...fields } });
const rules = (change) => invoke('set_quick_control', { change });
const normalize = (value) => value.replace(/\\/g, '/').toLowerCase();
const fileName = '工具资料验证.txt';
const keyword = 'WIDGET-HUB-SOURCE';
const scratchFixture = join(scratch, 'tool-hub-fixture.json');

async function waitFor(check, label) {
  const deadline = Date.now() + 14000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}
async function openHub() {
  await nav('小工具').click();
  await hub().getByRole('heading', { name: '小工具', exact: true }).waitFor();
}
function dateInput(timestamp) {
  const time = new Date(timestamp);
  const [year, month, day, hour, minute] = [time.getFullYear(), time.getMonth() + 1, time.getDate(), time.getHours(), time.getMinutes()]
    .map((value) => String(value).padStart(2, '0'));
  return year + '-' + month + '-' + day + 'T' + hour + ':' + minute;
}

try {
  const settings = await rpc('settings');
  assert.ok(normalize(settings.dataPath).startsWith(normalize(scratch).replace(/\/$/, '') + '/'), 'refusing a non-fixture workspace');

  if (phase === 'first') {
    await nav('工作台').click();
    assert.equal(await nav('岗位解析').count(), 0);
    await page.evaluate(() => { window.location.hash = '#/analysis'; });
    await page.getByRole('heading', { name: '招聘工作台', exact: true }).waitFor();
    await page.evaluate(() => { window.location.hash = ''; });
    assert.equal(await page.locator('[data-widget=profiles]').count(), 0);
    await assert.rejects(rpc('local_profile', { jobId: 1, samples: [], useJd: true }));
    await assert.rejects(invoke('analyze_ai', { id: 'fixture-obsolete', payload: { sources: [] }, confirmed: true }));
    const dashboard = await rpc('dashboard_layout');
    const jobs = await rpc('jobs');
    const preserved = jobs.find((job) => job.title === '数据分析师');
    assert.match(preserved.jd, /验收中补充 JD 内容/);
    const assistant = await invoke('chat_dispatch', { request: { action: 'create', mode: 'workspace' } });
    const profile = await invoke('chat_dispatch', { request: { action: 'preview', draft: {
      conversation: assistant.id, question: '请列出岗位要求', candidateIds: [], jobIds: [preserved.id],
      includeHistory: false, redact: true,
    } } });
    assert.ok(profile.excerpts.some((item) => item.source.jobId === preserved.id && item.text.includes('验收中补充 JD 内容')));
    await invoke('chat_dispatch', { request: { action: 'dismiss', id: profile.id } });
    console.log('PASS old profiling navigation and IPC are gone; edited job JD remains available to scoped HR chat');

    await openHub();
    await card('todos').getByRole('heading', { name: '待办事项', exact: true }).waitFor();
    await card('knowledge').getByRole('heading', { name: '资料库', exact: true }).waitFor();
    const title = '工具中心卡片验收 ' + Date.now();
    await button('新建待办', card('todos')).click();
    await dialog().getByLabel('待办标题').fill(title);
    await dialog().getByLabel('截止时间').fill(dateInput(Date.now() + 8 * 60_000));
    await button('保存待办', dialog()).click();
    await dialog().waitFor({ state: 'hidden' });
    const task = (await todo('list', { filter: { query: title } }))[0];
    assert.ok(task);
    await button('完成待办 ' + title, card('todos')).click();
    await button('完成待办 ' + title, card('todos')).waitFor({ state: 'hidden' });
    assert.equal((await todo('get', { id: task.id })).status, 'completed');

    await card('knowledge').getByLabel('从卡片选择资料文件').setInputFiles({
      name: fileName, mimeType: 'text/plain', buffer: Buffer.from('小工具中心正文索引 ' + keyword),
    });
    await card('knowledge').getByText(fileName, { exact: true }).waitFor();
    const indexed = (await knowledge('list', { filter: { query: keyword } })).items[0];
    assert.equal(indexed.parseStatus, 'complete');
    await hub().getByLabel('搜索小工具', { exact: true }).fill('文件与知识');
    await card('todos').waitFor({ state: 'hidden' });
    await card('knowledge').getByLabel('卡片搜索资料').fill(keyword);
    await card('knowledge').getByText(fileName, { exact: true }).click();
    await details().getByRole('heading', { name: fileName, exact: true }).waitFor();
    await hub().getByRole('heading', { name: '小工具', exact: true }).waitFor();
    assert.equal(await nav('小工具').getAttribute('aria-current'), 'page');
    const searchText = '保留中的筛选条件';
    await workspace('资料库').getByLabel('搜索资料文件').fill(searchText);
    await button('编辑资料信息', details()).click();
    await dialog().getByRole('checkbox', { name: '允许 AI 引用这份资料' }).check();
    await button('保存资料', dialog()).click();
    await dialog().waitFor({ state: 'hidden' });
    await button('返回小工具中心').click();
    assert.equal(await hub().getByLabel('搜索小工具', { exact: true }).inputValue(), '文件与知识');
    assert.equal(await card('knowledge').getByLabel('卡片搜索资料').inputValue(), keyword);
    await button('展开 资料库').click();
    assert.equal(await workspace('资料库').getByLabel('搜索资料文件').inputValue(), searchText);
    await button('返回小工具中心').click();
    await hub().getByLabel('搜索小工具', { exact: true }).fill('');
    await card('knowledge').getByLabel('卡片搜索资料').fill('');
    await card('knowledge').getByRole('tab', { name: '最近使用' }).click();
    await card('knowledge').getByText(fileName, { exact: true }).waitFor();
    await button('询问 ' + fileName, card('knowledge')).click();
    await page.getByText('已指定 1 份资料', { exact: true }).waitFor();
    console.log('PASS tool cards create/complete tasks, upload/search indexed files, open scoped AI chat and preserve filters through expansion');

    await openHub();
    await button('管理小工具', hub().locator('.heading-actions')).click();
    await dialog().getByLabel('搜索可用小工具').fill('效率工具');
    await button('隐藏工具 待办事项', dialog()).click();
    await button('完成', dialog()).click();
    assert.equal(await card('todos').count(), 0);
    await button('添加模块', hub()).click();
    await button('添加 待办事项', dialog()).click();
    await button('完成', dialog()).click();
    await card('todos').waitFor();
    await button('移动 资料库', hub()).dragTo(card('todos'), { targetPosition: { x: 15, y: 18 } });
    await waitFor(async () => await hub().locator('[data-widget]').first().getAttribute('data-widget') === 'knowledge', 'drag changed tool order');
    await hub().getByLabel('资料库宽度', { exact: true }).selectOption('4');
    await hub().getByLabel('资料库高度', { exact: true }).selectOption('2');
    await button('隐藏 待办事项', hub()).click();
    await button('保存布局', hub()).click();
    await waitFor(async () => (await rpc('dashboard_layout', { surface: 'tools' }))?.widgets[0].width === 4, 'saved hub grid');
    assert.deepEqual(await rpc('dashboard_layout'), dashboard);
    assert.equal((await todo('get', { id: task.id })).status, 'completed');

    await rules({ key: 'desktopNotifications', value: false });
    await rules({ key: 'interviewReminders', value: true });
    const reminder = await todo('save', { input: { title: '隐藏任务时的面试提醒', category: 'interview', priority: 'normal',
      interviewAt: Math.floor(Date.now() / 1000) + 5, reminderMinutes: 0 } });
    await page.getByText(/项面试提醒已到时间/).waitFor();
    await waitFor(async () => Boolean((await todo('get', { id: reminder.id })).notifiedAt), 'runtime reminder while tile is hidden');
    assert.equal(await card('todos').count(), 0);
    await nav('工作台').click();
    await button('查看待办').click();
    await workspace('待办事项').waitFor();
    await button('返回小工具中心').click();
    await nav('工作台').click();
    await button('打开资料库').click();
    await workspace('资料库').waitFor();
    const saved = await rpc('dashboard_layout', { surface: 'tools' });
    await writeFile(scratchFixture, JSON.stringify({ saved, documentId: indexed.id, taskId: task.id }), 'utf8');
    console.log('PASS catalog, drag, resize, visibility, independent layouts and live background reminders');
  } else {
    const fixture = JSON.parse(await readFile(scratchFixture, 'utf8'));
    const dashboard = await rpc('dashboard_layout');
    await openHub();
    await card('knowledge').waitFor();
    assert.deepEqual(await rpc('dashboard_layout', { surface: 'tools' }), fixture.saved);
    assert.equal(await card('todos').count(), 0);
    assert.equal(await card('knowledge').getAttribute('data-width'), '4');
    assert.equal(await card('knowledge').getAttribute('data-height'), '2');
    assert.equal((await todo('get', { id: fixture.taskId })).status, 'completed');
    assert.ok((await knowledge('summary')).viewed.some((file) => file.id === fixture.documentId));
    await button('恢复默认布局', hub().locator('.heading-actions')).click();
    await card('todos').waitFor();
    assert.equal(await hub().locator('[data-widget]').first().getAttribute('data-widget'), 'todos');
    assert.deepEqual(await rpc('dashboard_layout'), dashboard);
    console.log('PASS tool layout, task and file history survive process restart; default reset is independent');
  }
} catch (error) {
  await page.screenshot({ path: join(scratch, 'tool-hub-' + phase + '-failure.png'), timeout: 6000 }).catch(() => {});
  throw error;
} finally {
  await browser.close().catch(() => {});
}
