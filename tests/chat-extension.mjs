import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const [endpoint, scratch] = process.argv.slice(2);
if (!endpoint || !scratch) throw new Error('Pass the WebView2 endpoint and explicit test workspace.');
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0].pages().find((target) => target.url().includes('tauri.localhost') && !target.url().includes('window=todo'));
page.setDefaultTimeout(15000);
const nav = (name) => page.locator('.sidebar').getByRole('button', { name, exact: true });
const button = (name, parent = page) => parent.getByRole('button', { name, exact: true });
const dialog = () => page.getByRole('dialog').last();
const consent = /我已核对发送内容/;
const invoke = (command, payload) => page.evaluate(
  ({ command, payload }) => window.__TAURI_INTERNALS__.invoke(command, payload), { command, payload },
);
const rpc = (action, fields = {}) => invoke('dispatch', { request: { action, ...fields } });
const prefs = (key, value) => invoke('set_quick_control', { change: { key, value } });
const requests = [];
const answers = [
  '## 面试准备\n\n| 技能 | 核实内容 |\n|---|---|\n| SQL | 查询方案 |',
  '继续核实数据来源和质量。',
  '资料事实：样例使用 SQL [1]。\n\n建议核实：请确认产出和分工。',
];
const mock = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const data = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(data);
  if (!data.stream) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const frame = (content) => 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\r\n\r\n';
  const answer = answers.shift() ?? '继续测试';
  res.write(frame(answer.slice(0, 10)));
  await delay(250);
  res.end(frame(answer.slice(10)) + 'data: [DONE]\r\n\r\n');
});

async function sendConfirmed(name = '发送', remember = false) {
  const requestCount = requests.length;
  await button(name).click();
  await dialog().getByRole('heading', { name: '核对 AI 发送内容' }).waitFor();
  assert.equal(requests.length, requestCount, 'unconfirmed preview did not send a request');
  const required = dialog().getByRole('checkbox', { name: consent });
  if (await required.isVisible()) {
    assert.equal(await button('确认并发送', dialog()).isDisabled(), true);
    await required.check();
  }
  if (remember) await dialog().getByRole('checkbox', { name: '不再提示' }).check();
  await button('确认并发送', dialog()).click();
}

try {
  const initial = await rpc('settings');
  const normalize = (file) => file.replace(/\\/g, '/').toLowerCase();
  assert.ok(normalize(initial.dataPath).startsWith(normalize(scratch).replace(/\/$/, '') + '/'), 'refusing a non-fixture workspace');
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  await rpc('save_ai', { input: { settings: {
    baseUrl: 'http://127.0.0.1:' + mock.address().port + '/v1', model: 'fixture-chat', timeoutSeconds: 15,
  }, apiKey: 'fixture-token-not-real' } });
  await invoke('test_ai', { id: 'chat-fixture-test' });
  await prefs('aiEnabled', true);
  await prefs('confirmAiSend', true);

  await nav('HR AI 助手').click();
  await button('新建对话').click();
  await page.getByLabel('输入消息').fill('设计 SQL 面试问题');
  await sendConfirmed('发送', true);
  await page.getByRole('table').getByText('查询方案').waitFor();
  assert.equal(requests[1].stream, true);
  assert.equal(requests[1].messages.at(-1).content, '设计 SQL 面试问题');
  console.log('PASS ordinary chat explicitly sends only the typed question and renders streamed Markdown tables');

  await nav('工作台').click();
  const quick = page.getByRole('switch', { name: 'AI 发送前始终确认' });
  await quick.waitFor();
  assert.equal(await quick.getAttribute('aria-checked'), 'false');
  await button('完整设置').click();
  assert.equal(await quick.getAttribute('aria-checked'), 'false');
  await nav('HR AI 助手').click();
  await page.getByLabel('输入消息').fill('再给一个核实角度');
  await button('发送').click();
  await page.getByText('继续核实数据来源和质量。', { exact: true }).waitFor();
  assert.equal(requests[2].messages.filter((item) => item.role === 'user').length, 2);
  console.log('PASS dashboard and Settings share persisted options, and ordinary multi-turn chat can omit extra confirmation');

  await button('招聘资料问答').click();
  await button('新建对话').click();
  await button('选择招聘资料').click();
  await dialog().getByRole('checkbox', { name: 'Ning Yu', exact: true }).check();
  await button('应用选择（1）', dialog()).click();
  await page.getByLabel('输入消息').fill('该候选人的 SQL 经历是什么？');
  await sendConfirmed('预览发送');
  await page.getByText(/样例使用 SQL/).waitFor();
  const material = JSON.parse(requests[3].messages.at(-1).content);
  assert.ok(material.context.some((item) => item.text.includes('Extract metrics with SQL')));
  assert.doesNotMatch(JSON.stringify(material), /example\.invalid|Ning Yu|Zhou Tao|Lin Qiao/i);
  await page.getByText(/本次发送的资料/).waitFor();
  console.log('PASS workspace chat still requires consent and uses only selected, redacted excerpts with source records');

  await nav('工作台').click();
  await page.getByRole('switch', { name: 'AI 功能', exact: true }).click();
  await assert.rejects(invoke('test_ai', { id: 'blocked-chat-test' }), /AI 功能已关闭/);
  assert.equal(requests.length, 4);
  await nav('HR AI 助手').click();
  await button('新建对话').click();
  await page.getByText('AI 功能已关闭。', { exact: true }).waitFor();
  console.log('PASS AI switch blocks real backend request entry points');

  await prefs('desktopNotifications', false);
  await prefs('interviewReminders', true);
  const title = '调度验收 ' + Date.now();
  const operation = {
    action: 'save', input: { title, category: 'interview', priority: 'normal',
      interviewAt: Math.floor(Date.now() / 1000) + 5, reminderMinutes: 0 },
  };
  const saved = await rpc('todo', { operation });
  await page.getByText(/项面试提醒已到时间/).waitFor();
  const list = await rpc('todo', { operation: { action: 'list' } });
  assert.ok(list.find((todo) => todo.id === saved.id)?.notifiedAt);
  console.log('PASS Rust runtime scheduler delivers and records a due reminder outside the To-do page');
} finally {
  mock.closeAllConnections();
  mock.close();
  await browser.close().catch(() => {});
}
