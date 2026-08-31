// dashboard.html 的真浏览器演练。只读:不碰线上 OB,连的是隔壁 fake-ob.mjs。
// 跑法:bash tests/dashboard-ui/run.sh
// 照 galaxy-e2e 的办法:playwright 装在 $WORK 里,ESM 不认 NODE_PATH,只能按路径 import
const { chromium } = await import(process.env.PW + '/playwright/index.mjs');

const BASE = process.env.BASE || 'http://127.0.0.1:8801';
const SHOTS = process.env.SHOTS || '/tmp/dashboard-ui';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ← ' + extra : '')); }
};

const browser = await chromium.launch({ executablePath: process.env.CHROME });

for (const scheme of ['light', 'dark']) {
  console.log('\n== ' + scheme + ' ==');
  const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e));
  // 外部字体(fonts.googleapis)在这个容器里连不上,那是测试环境不是页面的毛病 —— 只忽略它。
  page.on('requestfailed', q => { if (!/fonts\.(googleapis|gstatic)\.com/.test(q.url())) errors.push('请求失败: ' + q.url()); });
  page.on('response', r => { if (r.status() >= 400) errors.push('HTTP ' + r.status() + ' ' + r.url()); });
  page.on('console', m => { if (m.type() === 'error' && !/net::ERR|status of 40/.test(m.text())) errors.push(m.text()); });

  await page.goto(BASE + '/dashboard', { waitUntil: 'networkidle' });
  await page.waitForSelector('.bucket-row');

  ok('没有 JS 报错', errors.length === 0, errors.join(' | '));
  ok('登录遮罩已收起', !(await page.locator('#auth-overlay').isVisible()));
  ok('统计行有数', /桶 ·/.test(await page.locator('#stats').innerText()));
  ok('六张卡片', (await page.locator('.bucket-row').count()) === 6);

  // 卡片的三层结构(效果图那种):标题行 / 摘要 / 底行
  const card = page.locator('.bucket-row').first();
  ok('卡片有标题行', await card.locator('.row-top .name').isVisible());
  ok('卡片有时间', /前|刚刚|\d/.test(await card.locator('.row-top .time').innerText()));
  ok('卡片有摘要', (await card.locator('.preview').innerText()).length > 10);
  ok('摘要最多两行', await card.locator('.preview').evaluate(el => {
    const cs = getComputedStyle(el);
    return parseFloat(cs.height) <= parseFloat(cs.lineHeight) * 2 + 1;
  }));
  ok('底行有 domain', (await card.locator('.row-bottom .domain').innerText()).includes('社交'));
  ok('底行有情绪条', await card.locator('.row-bottom .v-bar .v-dot').isVisible());

  // 记忆银河入口
  const gal = page.locator('a.hbtn[href="/galaxy"]');
  ok('顶栏有「记忆银河」入口', await gal.isVisible());
  ok('入口指向 /galaxy', (await gal.getAttribute('href')) === '/galaxy');
  ok('入口是链接不是请求', (await gal.evaluate(el => el.tagName)) === 'A');

  // 配色:必须落在官端色板上,而且深浅两套要真的不同
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const fg = await page.evaluate(() => getComputedStyle(document.body).color);
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  const wantBg = scheme === 'light' ? 'rgb(250, 249, 245)' : 'rgb(20, 20, 19)';   // gray-050 / gray-950
  const wantFg = scheme === 'light' ? 'rgb(20, 20, 19)' : 'rgb(250, 249, 245)';
  const wantAccent = scheme === 'light' ? '#d97757' : '#c46849';                   // clay / clay-dark
  ok('底色 = 官端 ' + (scheme === 'light' ? 'gray-050' : 'gray-950'), bg === wantBg, bg);
  ok('字色 = 官端反色', fg === wantFg, fg);
  ok('强调色 = 官端 clay', accent === wantAccent, accent);
  ok('color-scheme 跟着系统', (await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)) === scheme);

  // 手机上筛选药丸排一行横滑,不许换行把列表挤下去
  ok('药丸一行横滑', await page.locator('.filters').evaluate(el =>
    getComputedStyle(el).flexWrap === 'nowrap' && el.scrollWidth > el.clientWidth));

  // 页面不许横向滚动(手机上最容易翻车的一条)
  ok('没有横向滚动', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

  await page.screenshot({ path: SHOTS + '/list-' + scheme + '.png', fullPage: false });

  // 筛选:点「钉选」应当只剩三张
  await page.locator('.filter-btn[data-filter="pinned"]').click();
  await page.waitForTimeout(400);   // 药丸底色有 0.18s 过渡,早了会量到中间色
  ok('筛选「钉选」剩三张', (await page.locator('.bucket-row').count()) === 3);
  const wantChip = scheme === 'light' ? 'rgb(217, 119, 87)' : 'rgb(196, 104, 73)';
  const gotChip = await page.locator('.filter-btn.active').evaluate(el => getComputedStyle(el).backgroundColor);
  ok('选中的药丸是实心强调色', gotChip === wantChip, gotChip);
  await page.locator('.filter-btn[data-filter="all"]').click();

  // 详情抽屉
  await page.locator('.bucket-row').first().click();
  await page.waitForTimeout(300);
  ok('详情抽屉打开', await page.locator('#detail-panel.open').isVisible());
  ok('详情抽屉满屏宽(手机)', await page.locator('#detail-panel').evaluate(el => el.getBoundingClientRect().width >= window.innerWidth - 1));
  await page.screenshot({ path: SHOTS + '/detail-' + scheme + '.png' });
  await page.locator('#detail-panel .close-btn').click();
  await page.waitForTimeout(300);

  // 记忆网络:画布颜色是现读变量的,深色下不该还是浅色
  await page.locator('.tab[data-tab="network"]').click();
  await page.waitForTimeout(600);
  const canvasPx = await page.evaluate(() => {
    const c = document.getElementById('network-canvas');
    const d = c.getContext('2d').getImageData(2, 2, 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  ok('画布底色跟着深浅色走', scheme === 'light' ? canvasPx[0] > 200 : canvasPx[0] < 60, canvasPx.join(','));
  await page.screenshot({ path: SHOTS + '/network-' + scheme + '.png' });

  // 其余标签页各开一次,看有没有炸
  for (const t of ['breath', 'letters', 'config', 'import', 'settings']) {
    await page.locator('.tab[data-tab="' + t + '"]').click();
    await page.waitForTimeout(250);
  }
  ok('六个标签页轮一遍无报错', errors.length === 0, errors.join(' | '));

  // 宽屏再看一眼
  await page.locator('.tab[data-tab="list"]').click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(200);
  ok('宽屏内容居中收窄', await page.evaluate(() => {
    const c = document.querySelector('#list-view');
    return c.getBoundingClientRect().width <= 1100;
  }));
  // 顶栏标题 / 标签 / 卡片,三者左边缘要在同一条竖线上
  ok('宽屏左边缘对齐', await page.evaluate(() => {
    const l = s => Math.round(document.querySelector(s).getBoundingClientRect().left);
    const a = l('.header h1'), b = l('.tab'), c = l('.bucket-row');
    return Math.abs(a - c) <= 1 && Math.abs(b - c) <= 1;
  }));
  await page.screenshot({ path: SHOTS + '/wide-' + scheme + '.png' });

  await ctx.close();
}

await browser.close();
console.log('\n通过 ' + pass + ',失败 ' + fail);
process.exit(fail ? 1 : 0);
