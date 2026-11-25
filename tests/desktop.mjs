import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import manifest from '../package.json' with { type: 'json' };
import { makeFixtures, makeImportFixtures } from './make-fixtures.mjs';

const [part, endpoint, scratch] = process.argv.slice(2);
if (!['first', 'restart'].includes(part) || !endpoint || !scratch) throw new Error('Use tests/desktop.ps1 to run desktop QA.');
const fixtures = await makeFixtures(join(scratch, 'fixtures'));
const log = (text) => console.log('PASS ' + text);
const pauseFor = async (check, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(180);
  }
  throw new Error('Timed out waiting for condition');
};
await pauseFor(async () => fetch(endpoint + '/json/version').then((r) => r.ok).catch(() => false));
const browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
const context = browser.contexts()[0];
let page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 20000 });
const isMainPage = (target) => !target.isClosed()
  && /tauri\.localhost|127\.0\.0\.1:1420/.test(target.url())
  && !target.url().includes('window=todo');
await pauseFor(() => {
  page = context.pages().find(isMainPage) ?? page;
  return isMainPage(page);
});
page.setDefaultTimeout(14000);
const button = (name, parent = page) => parent.getByRole('button', { name, exact: true });
const nav = (name) => button(name, page.locator('.sidebar'));
const dialog = () => page.getByRole('dialog');
const row = (name) => page.locator('.candidate-row').filter({ hasText: name });
async function createJob(name, jd) {
  await button('新建岗位', page.locator('.heading-actions')).click();
  await dialog().getByLabel('岗位名称').fill(name);
  await dialog().getByLabel('招聘部门').fill('演示部');
  await dialog().getByLabel('岗位描述（JD）').fill(jd);
  await button('保存岗位', dialog()).click();
  await dialog().waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name, exact: true }).waitFor();
}

async function chooseImportFiles(files, trigger) {
  await button(trigger, page.locator('.heading-actions')).click();
  await dialog().getByLabel('选择简历文件').setInputFiles(files);
}
async function waitForImportResult() {
  await dialog().locator('button:enabled').filter({ hasText: /^完成$/ }).waitFor({ state: 'visible' });
}
async function importFiles(files, trigger) {
  await chooseImportFiles(files, trigger);
  await button('核对导入（' + files.length + '）', dialog()).click();
  await button('确认导入', dialog()).click();
  await waitForImportResult();
}

async function candidateDetails() {
  await page.getByRole('tab', { name: '候选人详情' }).click();
}
async function linkJob(name) {
  await button('关联岗位').click();
  await dialog().getByLabel('招聘岗位').selectOption({ label: name + ' · 演示部' });
  await button('关联', dialog()).click();
  await dialog().waitFor({ state: 'hidden' });
}
async function editApplication(name, stage, note) {
  await candidateDetails();
  await page.locator('.application-link').filter({ hasText: name }).click();
  await dialog().getByRole('heading', { name: '编辑岗位申请' }).waitFor();
  await dialog().getByLabel('招聘阶段').selectOption(stage);
  await dialog().getByLabel('HR 备注').fill(note);
  await button('保存申请', dialog()).click();
  await dialog().waitFor({ state: 'hidden' });
}
try {
  await page.getByRole('heading', { name: '招聘工作台' }).waitFor();
  await page.locator('.local-status').getByText('ResumeDesk ' + manifest.version, { exact: true }).waitFor();
  const settings = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('dispatch', { request: { action: 'settings' } }));
  const normalize = (path) => path.replace(/\\/g, '/').toLowerCase();
  assert.ok(normalize(settings.dataPath).startsWith(normalize(scratch).replace(/\/$/, '') + '/'), 'refusing a non-fixture workspace');
  await pauseFor(async () => /^\d+$/.test(await page.locator('.widget-stat').first().locator('strong').textContent()));
  if (part === 'first') {
    log('native Windows application opened with empty SQLite and no AI key');
    await page.screenshot({ path: join(scratch, 'dashboard.png') });
    await createJob('数据分析师', '必须具备 SQL 经验\nPower BI 优先');
    await createJob('报告专员', '分析例行经营报告。');
    await nav('候选人库').click();
    await importFiles(fixtures, '导入简历');
    assert.equal(await dialog().getByText('已导入', { exact: true }).count(), 5);
    await button('完成', dialog()).click();
    await row('Lin Qiao').click();
    await page.locator('canvas[data-rendered=yes]').waitFor();
    await page.screenshot({ path: join(scratch, 'library.png') });
    await button('下一页').click();
    await page.locator('canvas[aria-label="PDF 第 2 页"][data-rendered=yes]').waitFor();
    await button('放大').click();
    await page.locator('canvas[data-rendered=yes]').waitFor();
    await button('适应宽度').click();
    await button('最大化预览区域').click();
    await page.locator('.library-fullscreen').waitFor();
    await button('还原预览区域').click();
    log('batch import, real PDF canvas, next page, zoom and full-width preview');

    await importFiles([fixtures[0]], '导入简历');
    await dialog().getByText(/重复 · Lin Qiao/).waitFor();
    await button('完成', dialog()).click();
    await page.getByLabel('搜索候选人', { exact: true }).fill('数据平台');
    await page.locator('.list-count').getByText('1 位候选人').waitFor();
    await row('乔示例').waitFor();
    await page.getByLabel('搜索候选人', { exact: true }).fill('PYTHON');
    await page.locator('.list-count').getByText('2 位候选人').waitFor();
    await page.getByLabel('搜索候选人', { exact: true }).fill('项目管理');
    await row('方样例').click();
    await page.locator('.text-view pre').filter({ hasText: '市场调研与项目管理' }).waitFor();
    await page.getByLabel('搜索候选人', { exact: true }).fill('');
    log('hash duplicate and Chinese PDF/DOCX plus English case-insensitive search');
    await row('Lin Qiao').click();
    await candidateDetails();
    await linkJob('数据分析师');
    await linkJob('报告专员');
    await editApplication('数据分析师', 'interview', '约时间');
    await nav('候选人库').click();
    await row('Lin Qiao').click();
    await editApplication('报告专员', 'screened', '完成初筛');
    log('one candidate linked to two jobs and independent workflow stages');

    await nav('岗位管理').click();
    await page.locator('.job-row').filter({ hasText: '数据分析师' }).click();
    await button('编辑岗位').click();
    await dialog().getByLabel('岗位描述（JD）').fill('必须具备 SQL 经验\n验收中补充 JD 内容。');
    await button('保存岗位', dialog()).click();
    await dialog().waitFor({ state: 'hidden' });
    await page.locator('.job-description').getByText(/验收中补充 JD 内容/).waitFor();
    assert.equal(await button('分析岗位').count(), 0);
    log('job JD remains editable in the retained recruiting workflow');
  } else {
    const candidateCount = Number(await page.locator('.widget-stat').first().locator('strong').textContent());
    assert.ok(candidateCount >= 5, 'earlier candidates survive restart');
    await nav('候选人库').click();
    await row('Lin Qiao').click();
    await page.locator('canvas[data-rendered=yes]').waitFor();
    await candidateDetails();
    await page.locator('.application-link').filter({ hasText: '数据分析师' }).getByText('待面试').waitFor();
    await page.locator('.application-link').filter({ hasText: '报告专员' }).getByText('初筛通过').waitFor();
    await nav('岗位管理').click();
    await page.locator('.job-row').filter({ hasText: '数据分析师' }).click();
    await page.locator('.job-description').getByText(/验收中补充 JD 内容/).waitFor();
    log('restarted Windows process retains documents, application stages and edited JD');
    await nav('候选人库').click();
    await row('Lin Qiao').click();
    await candidateDetails();
    await button('删除候选人').click();
    await button('确认删除', dialog()).click();
    await row('Lin Qiao').waitFor({ state: 'hidden' });
    await page.locator('.list-count').getByText((candidateCount - 1) + ' 位候选人').waitFor();
    log('candidate deletion removes the record from the desktop library');

    const [combined, manual] = await makeImportFixtures(join(scratch, 'fixtures'));
    await chooseImportFiles([combined], '导入简历');
    await dialog().getByLabel('关联岗位').selectOption({ label: '数据分析师 · 演示部' });
    assert.equal(await dialog().getByLabel('自动解析候选人简历').isChecked(), true);
    await button('核对导入（1）', dialog()).click();
    await dialog().getByText('待核对 2 位候选人 · 1 份文件').waitFor();
    const firstCandidate = dialog().getByRole('group', { name: '候选人 1' });
    const secondCandidate = dialog().getByRole('group', { name: '候选人 2' });
    assert.equal(await firstCandidate.getByLabel('姓名').inputValue(), '叶示例');
    assert.equal(await secondCandidate.getByLabel('邮箱').inputValue(), 'peng.resume@example.invalid');
    await secondCandidate.getByLabel('姓名').fill('彭样例复核');
    await button('确认导入', dialog()).click();
    await waitForImportResult();
    await dialog().getByText('已导入 2 位', { exact: true }).waitFor();
    await button('完成', dialog()).click();
    for (const name of ['叶示例', '彭样例复核']) {
      await row(name).click();
      await candidateDetails();
      await page.locator('.application-link').filter({ hasText: '数据分析师' }).getByText('待初筛').waitFor();
    }
    log('one combined DOCX creates two reviewed candidates and links both to the selected job');

    await chooseImportFiles([manual], '导入简历');
    assert.equal(await dialog().getByLabel('关联岗位').inputValue(), '');
    await dialog().getByLabel('自动解析候选人简历').uncheck();
    await button('核对导入（1）', dialog()).click();
    assert.equal(await dialog().getByLabel('邮箱').inputValue(), '');
    await dialog().getByLabel('姓名').fill('手动建档样例');
    await button('确认导入', dialog()).click();
    await waitForImportResult();
    await button('完成', dialog()).click();
    await row('手动建档样例').click();
    await candidateDetails();
    await page.getByText('此候选人还没有关联岗位。').waitFor();
    log('manual import preserves the original without auto-filling details or creating an application');
  }
} catch (error) {
  await page.screenshot({ path: join(scratch, 'failure-' + part + '.png'), timeout: 6000 }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
