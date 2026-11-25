import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const [endpoint, scratch] = process.argv.slice(2);
if (!endpoint || !scratch) throw new Error('Pass the WebView2 debugging endpoint and isolated test workspace.');

const browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
const context = browser.contexts()[0];
const sleepUntil = async (check) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const item = await check();
    if (item) return item;
    await delay(120);
  }
  throw new Error('等待桌面工作区超时');
};
const isWidget = (target) => target.url().includes('window=todo');
const main = await sleepUntil(() => context.pages().find((target) => target.url().includes('tauri.localhost') && !isWidget(target)));
main.setDefaultTimeout(14000);
const dialog = () => main.getByRole('dialog').last();
const button = (parent, name) => parent.getByRole('button', { name, exact: true });
const nav = (name) => button(main.locator('.sidebar'), name);
async function openTodos() {
  await nav('小工具').click();
  await button(main, '展开 待办事项').click();
}
const identifier = Date.now().toString(36);
const candidate = '浮窗验收 ' + identifier;
const job = '招聘验收岗位 ' + identifier;
const interview = '面试验收 ' + identifier;
const quick = '悬浮新增 ' + identifier;
const expired = '逾期验收 ' + identifier;

function inputDate(timestamp) {
  const value = new Date(timestamp);
  const [y, month, d, h, minute] = [value.getFullYear(), value.getMonth() + 1, value.getDate(), value.getHours(), value.getMinutes()]
    .map((part) => String(part).padStart(2, '0'));
  return y + '-' + month + '-' + d + 'T' + h + ':' + minute;
}

try {
  const normalize = (path) => path.replace(/\\/g, '/').toLowerCase();
  const settings = await main.evaluate(() => window.__TAURI_INTERNALS__.invoke('dispatch', { request: { action: 'settings' } }));
  assert.ok(normalize(settings.dataPath).startsWith(normalize(scratch).replace(/\/$/, '') + '/'), 'refusing a non-fixture workspace');
  if (await dialog().isVisible()) await main.keyboard.press('Escape');
  await nav('岗位管理').click();
  await button(main.locator('.heading-actions'), '新建岗位').click();
  await dialog().getByLabel('岗位名称').fill(job);
  await button(dialog(), '保存岗位').click();
  await main.getByRole('heading', { name: job, exact: true }).waitFor();

  await nav('候选人库').click();
  await button(main.locator('.heading-actions'), '新建候选人').click();
  await dialog().getByLabel('姓名', { exact: true }).fill(candidate);
  await button(dialog(), '保存候选人').click();
  await main.getByRole('heading', { name: candidate, exact: true }).waitFor();
  await main.getByRole('tab', { name: '候选人详情' }).click();
  await button(main, '关联岗位').click();
  await dialog().getByLabel('招聘岗位').selectOption({ label: job });
  await button(dialog(), '关联').click();
  await main.locator('.application-link').filter({ hasText: job }).click();

  await button(dialog(), '安排面试').click();
  await dialog().getByLabel('待办标题').fill(interview);
  await dialog().getByLabel('面试时间', { exact: true }).fill(inputDate(Date.now() + 48 * 3600 * 1000));
  await dialog().getByLabel('提醒时间').selectOption('custom');
  await dialog().getByLabel('提醒提前（分钟）').fill('45');
  await dialog().getByLabel('面试形式').selectOption('online');
  await dialog().getByLabel('会议链接').fill('https://example.invalid/meeting');
  await button(dialog(), '保存待办').click();
  await main.getByRole('dialog', { name: '编辑岗位申请' }).waitFor();
  await button(dialog(), '保存申请').click();

  await openTodos();
  const interviewRow = main.getByRole('article', { name: interview });
  await interviewRow.getByText('会议链接 https://example.invalid/meeting').waitFor();
  await interviewRow.getByRole('button', { name: candidate }).waitFor();
  await button(interviewRow, '编辑').click();
  assert.equal(await dialog().getByLabel('提醒提前（分钟）').inputValue(), '45');
  await button(dialog(), '保存待办').click();
  await dialog().waitFor({ state: 'hidden' });
  console.log('PASS linked interview is editable and preserves scheduled details/custom reminder lead');

  await button(interviewRow, job).click();
  await dialog().getByLabel('招聘阶段').selectOption('screened');
  await main.getByText('建议创建待办 · 邀约面试', { exact: true }).waitFor();
  await button(dialog(), '保存申请').click();
  await openTodos();
  assert.equal(await main.getByRole('article', { name: /^邀约面试/ }).filter({ hasText: candidate }).count(), 0);

  await button(main, '阶段规则').click();
  const rule = dialog().getByRole('checkbox', { name: '待面试 · 安排面试' });
  if (!await rule.isChecked()) await rule.click();
  await sleepUntil(() => rule.isChecked());
  await button(dialog(), '关闭').last().click();
  await button(interviewRow, job).click();
  await dialog().getByLabel('招聘阶段').selectOption('interview');
  await main.getByText('启用了此阶段规则，保存后将创建待办 · 安排面试', { exact: true }).waitFor();
  await button(dialog(), '保存申请').click();
  await openTodos();
  const automatic = main.getByRole('article', { name: '安排面试', exact: true }).filter({ hasText: candidate });
  await automatic.waitFor();
  await button(interviewRow, job).click();
  await button(dialog(), '保存申请').click();
  await openTodos();
  await automatic.waitFor();
  assert.equal(await automatic.count(), 1);
  console.log('PASS stage changes suggest follow-up by default and enabled rules insert just once');

  await button(main, '新建待办').click();
  await dialog().getByLabel('待办标题').fill(expired);
  await dialog().getByLabel('截止时间').fill(inputDate(Date.now() - 48 * 3600 * 1000));
  await button(dialog(), '保存待办').click();
  await main.getByRole('article', { name: expired }).waitFor();

  await button(main, '打开桌面待办').click();
  const widget = await sleepUntil(() => context.pages().find(isWidget));
  widget.setDefaultTimeout(14000);
  await widget.getByRole('heading', { name: '桌面待办', exact: true }).waitFor();
  await widget.getByRole('region', { name: '今日待办' }).waitFor();
  await widget.getByRole('region', { name: '即将面试' }).getByText(interview, { exact: true }).waitFor();
  await widget.getByRole('region', { name: '逾期待办' }).getByText(expired, { exact: true }).waitFor();
  assert.equal(await widget.locator('details').evaluate((node) => node.open), false);
  const pin = button(widget, '置顶');
  const pinnedBefore = await pin.getAttribute('aria-pressed');
  await pin.click();
  await sleepUntil(async () => (await pin.getAttribute('aria-pressed')) !== pinnedBefore);
  await pin.click();
  await sleepUntil(async () => (await pin.getAttribute('aria-pressed')) === pinnedBefore);

  await button(widget, '快速新建待办').click();
  await widget.getByLabel('待办标题').fill(quick);
  await button(widget, '添加').click();
  await main.getByRole('article', { name: quick }).waitFor();
  await button(widget, '完成待办 ' + quick).click();
  await main.getByRole('article', { name: quick }).waitFor({ state: 'hidden' });
  await widget.locator('details summary').click();
  await widget.locator('details').getByText(quick, { exact: true }).waitFor();
  console.log('PASS native floating sections, always-on-top toggle, add and completion synchronize with main');

  await widget.getByRole('region', { name: '即将面试' }).getByRole('button', { name: new RegExp(interview) }).last().click();
  await main.getByRole('dialog', { name: '编辑岗位申请' }).getByText(candidate + ' · ' + job).waitFor();
  await button(dialog(), '保存申请').click();
  await button(widget, '在主窗口管理').click();
  await main.getByRole('heading', { name: '待办事项', exact: true }).waitFor();

  await button(widget, '隐藏桌面待办').click();
  await button(main, '打开桌面待办').click();
  await widget.getByRole('region', { name: '即将面试' }).getByText(interview, { exact: true }).waitFor();
  console.log('PASS floating task deep link, return to management and hide/reopen retain state');
} finally {
  await browser.close().catch(() => {});
}
