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

  // 加到手机主屏用的图标:iOS 只认 PNG,而且这张图不能要登录(它抓图时不带 cookie)
  ok('声明了主屏图标', await page.locator('link[rel="apple-touch-icon"]').count() === 1);
  ok('图标是 png 不是 svg',
    /\.png(\?|$)/.test(await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')));
  ok('声明了主屏名字',
    (await page.locator('meta[name="apple-mobile-web-app-title"]').getAttribute('content')) === 'Ombre Brain');
  ok('深浅色各有一条 theme-color',
    (await page.locator('meta[name="theme-color"]').count()) === 2);
  {
    const res = await page.request.get(BASE + '/apple-touch-icon.png');
    ok('图标真能取到(200 + image/png)',
      res.status() === 200 && (res.headers()['content-type'] || '').includes('image/png'),
      res.status() + ' ' + (res.headers()['content-type'] || ''));
  }

  // 顶栏那两颗入口:一颗去星图,一颗去乱流。
  // ⚠️ 2026-09-03 所有者改了 08-31 的决定,原话「不用命名了,你画两个 ui,
  // 一个星球 ui 一个 clawd 的 ui」。~~原来钉的是「按钮上写的是 Vesper」+「按钮里没有图标」~~
  // —— 两条都已撤销;现在反过来钉「只有图标、没有字」。
  for (const [href, name] of [['/galaxy', '星图'], ['/turbulence', '乱流']]) {
    const btn = page.locator(`a.hbtn[href="${href}"]`);
    ok(`顶栏有${name}入口`, await btn.isVisible());
    ok(`${name}那颗是画的图标`, (await btn.locator('svg.ico').count()) === 1);
    ok(`${name}那颗不带字`, (await btn.innerText()).trim() === '');
    // 只有图标的按钮必须留 aria-label,否则读屏什么都读不出来
    ok(`${name}那颗有 aria-label`, !!(await btn.getAttribute('aria-label')));
    ok(`${name}入口是链接不是请求`, (await btn.evaluate(el => el.tagName)) === 'A');
  }
  // 两颗要长得一样大(并排放着,差一点点很显眼);
  // ⚠️ 而且是**横着的椭圆,不是正圆** —— 所有者 2026-09-03 拿图指名要的,别"修"回正圆。
  ok('两颗入口同样大小', await page.evaluate(() => {
    const [a, b] = ['/galaxy', '/turbulence'].map(h =>
      document.querySelector(`a.hbtn[href="${h}"]`).getBoundingClientRect());
    return Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
  }));
  ok('入口是横着的椭圆,不是正圆', await page.evaluate(() => {
    const r = document.querySelector('a.hbtn[href="/galaxy"]').getBoundingClientRect();
    return r.width > r.height * 1.25;
  }));

  // 配色:必须落在官端色板上,而且深浅两套要真的不同
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const fg = await page.evaluate(() => getComputedStyle(document.body).color);
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  // ⚠️ 2026-09-03:浅色整套由暖改冷(所有者:「我是想改成冷色调一点,包括那个灰色按钮之类的」)。
  // ~~原来浅色钉的是 rgb(250,249,245) / rgb(20,20,19) / #999999(官端暖灰)~~ —— 已换成冷灰版,
  // 明度和官端逐档相同、只搬了色相,所以对比度那几笔账照旧。**深色一个数没动。**
  // ⚠️ 浅色 2026-09-03 又压深了一档(#f7f7f9 → #f1f1f1):iOS 那种质感靠「灰底 + 纯白卡片」
  // 的落差分层,底色和卡片太接近就分不出层。深色没动。
  // ⚠️ 深色 2026-09-03 也按同一套流程改了:底色纯灰、字/边/强调色偏冷、底光回到看得见。
  const wantBg = scheme === 'light' ? 'rgb(241, 241, 241)' : 'rgb(19, 19, 19)';
  const wantFg = scheme === 'light' ? 'rgb(19, 19, 19)' : 'rgb(248, 248, 248)';   // neutral-950 / neutral-050
  // ⚠️ 浅色那颗**转了一圈回到 #999999**:09-03 上午随「整体改冷」变成 #8d97a5,当天她说
  // 「浅色的那个按钮的颜色能不能也换成没有饱和度的灰」,又换回来了。明度一直是 60,没动过。
  // 深色仍是冷灰 —— 她只说了浅色那颗。
  const wantAccent = scheme === 'light' ? '#999999' : '#343434';
  ok('底色 = ' + (scheme === 'light' ? '纯灰 #f1f1f1' : '纯灰 #131313'), bg === wantBg, bg);
  // 所有者原话「底色我不想要饱和度」—— 2026-09-03 起**两套都钉**(她说「深色的也按这个流程改」)。
  // ⚠️ 只管底色:字/描边/强调色两套都是偏冷的,别拿这条去"统一"它们。
  ok('底色饱和度为 0(三通道相等)', /^rgb\((\d+), \1, \1\)$/.test(bg), bg);
  ok('字色 = 反色', fg === wantFg, fg);
  ok('强调色 = 所有者定的灰', accent === wantAccent, accent);
  // 所有者原话「灰色色阶就按那个灰色按钮的颜色」——那颗按钮是零饱和,
  // 2026-09-03 起**整套灰阶两套配色都零饱和**。这儿钉强调色和主字色两处。
  ok('强调色零饱和', /^#([0-9a-f]{2})\1\1$/i.test(accent), accent);
  ok('主字色零饱和(三通道相等)', /^rgb\((\d+), \1, \1\)$/.test(fg), fg);
  // 强调色当填色 / 当文字是两个角色,合并回一个就会有地方看不见
  const at = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-text').trim());
  ok('文字用的强调色是另一档', at !== accent, at);
  ok('color-scheme 跟着系统', (await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)) === scheme);

  // 手机上筛选药丸排一行横滑,不许换行把列表挤下去
  ok('药丸一行横滑', await page.locator('.filters').evaluate(el =>
    getComputedStyle(el).flexWrap === 'nowrap' && el.scrollWidth > el.clientWidth));

  // 磨砂:必须真的挂上 backdrop-filter,且底是半透明的。
  // ⚠️ 2026-09-03 起**分两档**:~~原来四个选择器在两套配色下都要求是玻璃~~ ——
  // 浅色改成 iOS 那种「平灰底 + 纯白卡片」之后,**卡片和药丸在浅色下是实色,不再是玻璃**
  // (见上面那两条新断言)。**顶栏和标签栏两套都仍是磨砂** —— iOS 的顶栏本来就是磨砂的。
  // ⚠️ ~~当天中途改成过「浅色只查顶栏和标签栏」~~ —— 已撤销,浅色的卡片和药丸又是玻璃了。
  const frosted = ['.header', '.tabs', '.bucket-row', '.filter-btn:not(.active)'];
  for (const sel of frosted) {
    ok('磨砂:' + sel, await page.locator(sel).first().evaluate(el => {
      const cs = getComputedStyle(el);
      const blur = cs.backdropFilter || cs.webkitBackdropFilter || '';
      return blur.includes('blur') && /rgba\([^)]+, *0?\.\d+\)/.test(cs.backgroundColor);
    }));
  }
  ok('选中的药丸仍是实心', await page.locator('.filter-btn.active').evaluate(
    el => !/rgba/.test(getComputedStyle(el).backgroundColor)));
  // ⚠️ 所有者原话:「卡片上方那个线有点太粗了不像玻璃感」。
  // 边缘要一圈均匀的淡描边,**不许有 inset 高光线**;参照物是 Claude Code 手机端自己的面板。
  ok('卡片没有上缘高光线', await page.locator('.bucket-row').first().evaluate(
    el => !/inset/.test(getComputedStyle(el).boxShadow)));
  // 底光。⚠️ 2026-09-03 当天来回改了三轮,定稿是:**看得见,但零饱和**。
  // ~~①「≤0.02 极淡」~~(玻璃没东西可透)、~~②「必须真的有颜色」~~(她说饱和度太高)
  // 两条都已撤销。现在钉的是:浅色强度在 0.02~0.09 之间(**太淡=没玻璃,太浓=显脏**),
  // **且必须是中性灰**(三通道相等)—— 所有者原话「底色我不想要饱和度」。深色仍是 1%。
  const washes = await page.evaluate(() => {
    const bi = getComputedStyle(document.body).backgroundImage;
    if (!bi.includes('gradient')) return null;
    return [...bi.matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)/g)]
      .map(m => ({ r: +m[1], g: +m[2], b: +m[3], a: parseFloat(m[4]) }));
  });
  ok('页面有底光', Array.isArray(washes) && washes.length > 0);
  if (scheme === 'light') {
    const a = Math.max(...washes.map(w => w.a));
    ok('浅色底光够得上「有东西可透」(0.02~0.09)', a > 0.02 && a <= 0.09, a);
    ok('底光是中性灰,没有饱和度', washes.every(w => w.r === w.g && w.g === w.b));
  } else {
    // ⚠️ 深色 2026-09-03 也由 1% 提到了看得见(同一个道理:1% 上玻璃没东西可透)。
    // 白色本身零饱和,所以中性那条自动成立,这儿只查强度。
    const a = Math.max(...washes.map(w => w.a));
    ok('深色底光够得上「有东西可透」(0.02~0.09)', a > 0.02 && a <= 0.09, a);
  }

  // ⚠️ ~~当天中途加过「浅色卡片是纯白实色」「浅色卡片不描边」~~ —— **已撤销**:
  // 那是去追 iOS 平面质感的那一版,所有者随后说「我就是想要玻璃质感啊你改改没了」。
  // 现在浅色的卡片和药丸**又是玻璃了**,由下面那组「磨砂」断言统一钉着。

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
  // 圆角照 Apple 那套分档(2026-09-03):卡片一档、控件一档,不是到处一个数。
  // ⚠️ 钉的是「用了那张尺度表」,不是具体像素 —— 换档只改 :root 里那五个数。
  const radii = await page.evaluate(() => {
    const g = (sel, side) => getComputedStyle(document.querySelector(sel))['borderTopLeftRadius'];
    return {
      card: g('.bucket-row'),
      // ⚠️ 别拿具体某个控件当"控件档"的样本 —— 它可能哪天被改成胶囊。
      // 2026-09-03 就栽过一次:原来量的是 #sort-select,那天它变成了胶囊里的 select。
      sortPill: g('.sort-pill'),
      pill: g('.filter-btn'),
      scale: ['--r-1','--r-2','--r-3','--r-4','--r-5']
        .map(n => getComputedStyle(document.documentElement).getPropertyValue(n).trim()),
    };
  });
  ok('圆角尺度表五档都在', radii.scale.every(v => /^\d+px$/.test(v)), radii.scale.join('/'));
  ok('卡片用的是卡片那一档(--r-4)', radii.card === radii.scale[3], radii.card);
  // 钉「分档」这件事本身:五档必须一档比一档大。比盯着某一个元件稳。
  ok('五档是递增的', await page.evaluate(() => {
    const v = n => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(n));
    const a = ['--r-1','--r-2','--r-3','--r-4','--r-5'].map(v);
    return a.every((x, i) => i === 0 || x > a[i - 1]);
  }), radii.scale.join(' < '));
  ok('排序做成了胶囊,不是原生下拉', parseFloat(radii.sortPill) > 100, radii.sortPill);
  // 筛选药丸是胶囊,**刻意不参与分档、也不上 squircle**(squircle 会把胶囊弄丑)
  ok('筛选药丸仍是胶囊', parseFloat(radii.pill) > 100, radii.pill);

  // ⚠️ 2026-09-03:卡片那颗图标由 emoji 换成**自己画的内嵌 SVG**(所有者:「能把现在的
  // 表情换成自己画的 ui 吗」),所以不能再用 emoji 正则判 —— 改成查真的画了一颗 svg。
  ok('卡片上那颗图标还在', await page.locator('.bucket-row .icon svg.ico').first().isVisible());
  // 图标跟着文字颜色走(stroke: currentColor),深浅色都不用另配色
  ok('图标跟着文字颜色走', await page.locator('.bucket-row .icon svg.ico').first().evaluate(
    el => getComputedStyle(el).stroke === getComputedStyle(el).color));
  // ⚠️ 图标要和标题**看齐**(所有者 2026-09-03 报的:「为什么钉选那些你画的 ui 整体高于标题」)。
  // 病根:SVG 的基线是它自己的底边,跟着 align-items:baseline 走就会被顶到基线以上。
  ok('图标和标题竖直看齐(差 ≤2px)', await page.locator('.bucket-row').first().evaluate(row => {
    const i = row.querySelector('.icon').getBoundingClientRect();
    const t = row.querySelector('.name').getBoundingClientRect();
    return Math.abs((i.top + i.bottom) / 2 - (t.top + t.bottom) / 2) <= 2;
  }));
  // 整页不许再有 emoji 当图标用(logo ◐、排序 ↑↓ 这些不是 emoji,不受影响)
  ok('列表里没有 emoji 当图标', !/\p{Extended_Pictographic}/u.test(
    await page.locator('#bucket-list').innerText()));
  const wantChip = scheme === 'light' ? 'rgb(153, 153, 153)' : 'rgb(52, 52, 52)';
  const gotChip = await page.locator('.filter-btn.active').evaluate(el => getComputedStyle(el).backgroundColor);
  ok('选中的药丸是实心强调色', gotChip === wantChip, gotChip);
  // 所有者点名:药丸上的字深浅色都用白的。⚠️ 别把这条改成"对比度要够" ——
  // 白字压 #999999 只有 2.94:1,是她知情后定的,测试要看着她这个决定别被人改回去。
  // ⚠️ 2026-09-03 由「白名单两个具体值」改成「近乎纯白(三通道都 ≥245)」:
  // 深色的近白色当天由 #faf9f5 换成了 #f7f7f9,写死的名单没覆盖到。
  // **规矩本身没松**:仍然要求是白的,只是不再挑是哪一种白。
  ok('药丸上的字是白的', await page.locator('.filter-btn.active').evaluate(el => {
    const m = getComputedStyle(el).color.match(/\d+/g);
    return m && m.slice(0, 3).every(v => +v >= 245);
  }));
  await page.locator('.filter-btn[data-filter="all"]').click();

  // 详情抽屉
  await page.locator('.bucket-row').first().click();
  await page.waitForTimeout(300);
  ok('详情抽屉打开', await page.locator('#detail-panel.open').isVisible());
  ok('详情抽屉满屏宽(手机)', await page.locator('#detail-panel').evaluate(el => el.getBoundingClientRect().width >= window.innerWidth - 1));
  await page.screenshot({ path: SHOTS + '/detail-' + scheme + '.png' });
  await page.locator('#detail-panel .close-btn').click();
  await page.waitForTimeout(300);

  // ⚠️ 这里原有一条「画布底色跟着深浅色走」,测的是「记忆网络」页那块 canvas。
  // 那一页 2026-09-03 按所有者决定删掉了(她不用它),这条跟着删——
  // 后台现在一块 canvas 都没有,没东西可测。别照旧结论把它加回来。

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

  // 便利贴(2026-09-01):这块是晏的,面板只是让她看见 + 留了写入口。
  // 页面是**一天一张卡**:同一天记下的凑一张,新的一天在前;
  // 一行 = 圆形勾选 + 标题 + 副行 + 状态标签 + 撕掉。
  await page.locator('.tab[data-tab="todos"]').click();
  await page.waitForTimeout(400);
  ok('一天一张卡,三天三张', (await page.locator('#todos-lines .todo-card').count()) === 3);
  ok('同一天的两条在同一张上', (await page.locator('#todos-lines .todo-card').nth(1)
    .locator('.todo-row').count()) === 2);
  // ⚠️ 抬头是**英文**日期(所有者 2026-09-03 点名要的),而且**写死在代码里**不走
  // toLocaleDateString —— 那个跟着浏览器语言走,她手机是中文的话会又变回中文。
  ok('新的一天排在前面', /August 31/.test(
    await page.locator('#todos-lines .todo-card-head h3').first().innerText()));
  ok('抬头带星期(英文)', /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/.test(
    await page.locator('#todos-lines .todo-card-head h3').first().innerText()));
  // ⚠️ 抬头是**分组小标题**,不是大标题:又细又小(她原话「字体细一点」「英文太大了好傻啊」)
  ok('抬头又细又小(不是大标题)', await page.locator('#todos-lines .todo-card-head h3').first()
    .evaluate(el => {
      const cs = getComputedStyle(el);
      return parseInt(cs.fontWeight, 10) < 600 && parseFloat(cs.fontSize) <= 14;
    }));
  ok('四条待办都在', (await page.locator('#todos-lines .todo-row').count()) === 4);
  ok('她贴的那条标着 from you', await page.locator('#todos-lines .todo-row.by-owner').first()
    .evaluate(el => el.innerText.includes('from you')));
  ok('已完成的划掉了', await page.locator('#todos-lines .todo-row.is-done .todo-title').first()
    .evaluate(el => getComputedStyle(el).textDecorationLine === 'line-through'));
  ok('每行右边有状态标签', (await page.locator('#todos-lines .todo-row .todo-tag').count()) === 4);
  ok('没做的标 To do,做完的标 Done', await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#todos-lines .todo-row')];
    return rows.every(r => r.querySelector('.todo-tag').textContent ===
      (r.classList.contains('is-done') ? 'Done' : 'To do'));
  }));
  ok('勾选是个可按的圆(不是纯文字)', (await page.locator('#todos-lines .todo-check svg.ico').count()) === 4);
  // ⚠️ 这一页的三处控件(勾选 / 状态标签 / 发送键)**都是玻璃,不用强调色填**
  // (所有者:「待办的按钮不想要颜色 想要玻璃质感」)。勾没勾上靠图标区分,不靠底色变颜色。
  for (const sel of ['#todos-lines .todo-check', '#todos-lines .todo-tag', '.todo-add button']) {
    ok('玻璃:' + sel, await page.locator(sel).first().evaluate(el => {
      const cs = getComputedStyle(el);
      const blur = cs.backdropFilter || cs.webkitBackdropFilter || '';
      return blur.includes('blur') && /rgba\([^)]+, *0?\.\d+\)/.test(cs.backgroundColor);
    }));
  }
  ok('勾上那颗也没被填成强调色', await page.evaluate(() => {
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const el = document.querySelector('#todos-lines .todo-row.is-done .todo-check');
    if (!el) return true;
    const bg = getComputedStyle(el).backgroundColor;
    return /rgba/.test(bg) && bg !== accent;
  }));
  ok('全做完那张抬头写 All done', /All done/.test(
    await page.locator('#todos-lines .todo-card').last().innerText()));
  await page.screenshot({ path: SHOTS + '/todos-' + scheme + '.png' });

  // 贴一张:输入框回车即可。假 OB 给的是今天,所以会新开一张卡
  await page.fill('#todo-input', '测试贴一张');
  await page.press('#todo-input', 'Enter');
  await page.waitForTimeout(400);
  ok('新的一天单独一张卡', (await page.locator('#todos-lines .todo-card').count()) === 4);
  ok('贴完输入框清空', (await page.inputValue('#todo-input')) === '');
  ok('新贴的算她的', (await page.locator('#todos-lines .todo-row.by-owner').count()) === 2);

  // 点整行 = 勾掉(手指比那颗小方块好按);点那颗圆同样能勾
  await page.locator('#todos-lines .todo-row:not(.is-done) .todo-title').first().click();
  await page.waitForTimeout(400);
  ok('点一行就勾掉了', (await page.locator('#todos-lines .todo-row.is-done').count()) === 2);
  await page.locator('#todos-lines .todo-row.is-done .todo-check').first().click();
  await page.waitForTimeout(400);
  ok('点那颗圆能取消勾选', (await page.locator('#todos-lines .todo-row.is-done').count()) === 1);

  // 撕掉是真删,必须二次确认:先取消,什么都不该变
  const before = await page.locator('#todos-lines .todo-row').count();
  page.once('dialog', d => d.dismiss());
  await page.locator('#todos-lines .todo-del').first().click();
  await page.waitForTimeout(300);
  ok('撕掉取消确认就什么都不做', (await page.locator('#todos-lines .todo-row').count()) === before);
  page.once('dialog', d => d.accept());
  await page.locator('#todos-lines .todo-del').first().click();
  await page.waitForTimeout(400);
  ok('确认之后那条没了', (await page.locator('#todos-lines .todo-row').count()) === before - 1);

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
