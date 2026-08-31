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

  await fetch(BASE + '/__reset');   // 上一轮把回收站里的一条恢复掉了,复位再来
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
  // 情绪条改成强调色深浅渐变后,两端必须还分得出来(深色下 #343434 压 #1a1918 只有 1.48:1)
  ok('情绪条两端有区别', await card.locator('.v-bar').evaluate(el => {
    const bg = getComputedStyle(el).backgroundImage;
    const stops = bg.match(/rgba?\([^)]+\)/g) || [];
    return stops.length >= 2 && stops[0] !== stops[stops.length - 1];
  }));

  // 星图入口
  const gal = page.locator('a.hbtn[href="/galaxy"]');
  ok('顶栏有星图入口', await gal.isVisible());
  ok('按钮上写的是 Vesper', (await gal.innerText()).trim() === 'Vesper');
  ok('按钮里没有图标', (await gal.locator('span, img, svg').count()) === 0);
  ok('入口指向 /galaxy', (await gal.getAttribute('href')) === '/galaxy');
  ok('入口是链接不是请求', (await gal.evaluate(el => el.tagName)) === 'A');

  // 配色:必须落在官端色板上,而且深浅两套要真的不同
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const fg = await page.evaluate(() => getComputedStyle(document.body).color);
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  const wantBg = scheme === 'light' ? 'rgb(250, 249, 245)' : 'rgb(20, 20, 19)';   // gray-050 / gray-950
  const wantFg = scheme === 'light' ? 'rgb(20, 20, 19)' : 'rgb(250, 249, 245)';
  const wantAccent = scheme === 'light' ? '#999999' : '#343434';   // 所有者 2026-08-31 定的中性灰
  ok('底色 = 官端 ' + (scheme === 'light' ? 'gray-050' : 'gray-950'), bg === wantBg, bg);
  ok('字色 = 官端反色', fg === wantFg, fg);
  ok('强调色 = 所有者定的灰', accent === wantAccent, accent);
  // 强调色当填色 / 当文字是两个角色,合并回一个就会有地方看不见
  const at = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-text').trim());
  ok('文字用的强调色是另一档', at !== accent, at);
  ok('color-scheme 跟着系统', (await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)) === scheme);

  // 手机上筛选药丸排一行横滑,不许换行把列表挤下去
  ok('药丸一行横滑', await page.locator('.filters').evaluate(el =>
    getComputedStyle(el).flexWrap === 'nowrap' && el.scrollWidth > el.clientWidth));

  // 玻璃质感:顶栏/标签/卡片都得真的挂上 backdrop-filter,且底是半透明的
  for (const sel of ['.header', '.tabs', '.bucket-row', '.filter-btn:not(.active)']) {
    ok('玻璃:' + sel, await page.locator(sel).first().evaluate(el => {
      const cs = getComputedStyle(el);
      const blur = cs.backdropFilter || cs.webkitBackdropFilter || '';
      return blur.includes('blur') && /rgba\([^)]+, *0?\.\d+\)/.test(cs.backgroundColor);
    }));
  }
  ok('选中的药丸仍是实心', await page.locator('.filter-btn.active').evaluate(
    el => !/rgba/.test(getComputedStyle(el).backgroundColor)));

  // 页面不许横向滚动(手机上最容易翻车的一条)
  ok('没有横向滚动', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

  await page.screenshot({ path: SHOTS + '/list-' + scheme + '.png', fullPage: false });
  // 滚一段再拍:毛玻璃要有东西从底下过才看得出来
  await page.mouse.wheel(0, 420);
  await page.waitForTimeout(300);
  await page.screenshot({ path: SHOTS + '/scrolled-' + scheme + '.png' });
  // 顶栏是 sticky、标签栏不是:两个都 top:0 会叠在一起透出鬼影
  ok('滚动后顶栏还在、标签栏已滑走', await page.evaluate(() => {
    const h = document.querySelector('.header').getBoundingClientRect();
    const t = document.querySelector('.tabs').getBoundingClientRect();
    return Math.abs(h.top) < 1 && t.top < h.top;   // 标签栏得跟着内容滑走,不能也钉在 0
  }));
  await page.mouse.wheel(0, -420);
  await page.waitForTimeout(200);

  // 筛选:点「钉选」应当只剩三张
  await page.locator('.filter-btn[data-filter="pinned"]').click();
  await page.waitForTimeout(400);   // 药丸底色有 0.18s 过渡,早了会量到中间色
  ok('筛选「钉选」剩三张', (await page.locator('.bucket-row').count()) === 3);
  // 筛选药丸整排不要表情;卡片上那颗状态图标要留着
  ok('药丸一个表情都没有',
    !/\p{Extended_Pictographic}/u.test(await page.locator('#filters').innerText()));
  ok('卡片上那颗图标还在',
    /\p{Extended_Pictographic}/u.test(await page.locator('.bucket-row .icon').first().innerText()));
  const wantChip = scheme === 'light' ? 'rgb(153, 153, 153)' : 'rgb(52, 52, 52)';
  const gotChip = await page.locator('.filter-btn.active').evaluate(el => getComputedStyle(el).backgroundColor);
  ok('选中的药丸是实心强调色', gotChip === wantChip, gotChip);
  // 所有者点名:药丸上的字深浅色都用白的。⚠️ 别把这条改成"对比度要够" ——
  // 白字压 #999999 只有 2.94:1,是她知情后定的,测试要看着她这个决定别被人改回去。
  ok('药丸上的字是白的', await page.locator('.filter-btn.active').evaluate(
    el => ['rgb(255, 255, 255)', 'rgb(250, 249, 245)'].includes(getComputedStyle(el).color)));
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

  // 回收站
  await page.locator('.tab[data-tab="trash"]').click();
  await page.waitForTimeout(400);
  ok('回收站列出两条', (await page.locator('#trash-list .trash-row').count()) === 2);
  ok('回收站显示删除时间', /^删于 /.test(await page.locator('#trash-list .time').first().innerText()));
  ok('回收站卡片不可点', await page.locator('#trash-list .trash-row').first().evaluate(
    el => getComputedStyle(el).cursor === 'default'));
  ok('回收站显示副本份数', /份副本/.test(await page.locator('#trash-list .domain').first().innerText()));
  await page.screenshot({ path: SHOTS + '/trash-' + scheme + '.png' });
  // 恢复要二次确认:先取消,不能有任何变化
  page.once('dialog', d => d.dismiss());
  await page.locator('#trash-list .letter-btn').first().click();
  await page.waitForTimeout(250);
  ok('取消确认就什么都不做', (await page.locator('#trash-list .trash-row').count()) === 2
    && (await page.locator('#trash-list .letter-btn').count()) === 2);
  // 再来一次,这回确认
  page.once('dialog', d => d.accept());
  await page.locator('#trash-list .letter-btn').first().click();
  await page.waitForTimeout(500);
  ok('恢复后当场给回执', /已放回记忆库/.test(await page.locator('#trash-list .letter-msg').first().innerText()));
  ok('恢复后那条的按钮没了', (await page.locator('#trash-list .letter-btn').count()) === 1);

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
