// 记忆乱流页的浏览器演练:靠 run.sh 起两个假 OB 再跑本文件(别直接 node 它)
const { chromium } = await import(process.env.PW + '/playwright/index.mjs');
let pass = 0, fail = 0;
const ok = (c, m, extra) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗', m, extra ?? '')); };
const OB   = process.env.OB_URL   || `http://127.0.0.1:${process.env.PORT || 8811}`;
const NONET= process.env.NONET_URL|| `http://127.0.0.1:${(+(process.env.PORT || 8811)) + 1}`;
const PASS = process.env.PASS || 'test123';

const b = await chromium.launch({ executablePath:process.env.CHROME, args:['--no-sandbox'] });
// 主场跑深色;浅色单独在 J 段验(这一页跟着系统深浅色走)
const ctx = await b.newContext({ viewport:{ width:1000, height:800 }, deviceScaleFactor:1, colorScheme:'dark' });
const pg = await ctx.newPage();
const errs = [];
pg.on('pageerror', e => errs.push(e.message));

// 全程记下页面发出去的每一个请求:①不许有外部请求 ②不许有写操作
const requests = [];
pg.on('request', r => requests.push({ url:r.url(), method:r.method() }));

console.log('A. 没登录 → 请你输口令(不是悄悄把记忆铺出来)');
await pg.goto(`${OB}/turbulence`);
await pg.waitForFunction('document.getElementById("gate").classList.contains("on")', null, { timeout:30000 });
ok(true, '口令门出来了');
ok(await pg.evaluate(() => !window.__drift), '没登录时一个字符都没铺');
ok((await pg.content()).indexOf('真·相遇那天') === -1, '页面里搜不到任何真实记忆');
await pg.fill('#gPass', 'wrongpass');   // 纯英文的错口令:含中文的会撞上 OB 已知的那个 500(见 INTERNALS 1.9 末尾)
await pg.click('#gGo');
await pg.waitForFunction(`document.getElementById('gErr').textContent.length>0`, null, { timeout:8000 }).catch(() => {});
ok(await pg.textContent('#gErr') === '口令不对', '口令错 → 就地说一声,不放行');
ok(await pg.evaluate(() => !window.__drift), '口令错时仍然一个字符都没有');

console.log('B. 口令对 → 场铺出来');
await pg.fill('#gPass', PASS);
await pg.click('#gGo');
await pg.waitForFunction('window.__drift', null, { timeout:30000 });
const d = await pg.evaluate(() => ({ ob:window.__drift.ob, count:window.__drift.count,
  glyphs:window.__drift.glyphs, edges:window.__drift.edges }));
ok(await pg.evaluate(() => !document.getElementById('gate').classList.contains('on')), '口令门收起来了');
ok(d.ob === true, '走的是 OB 的真数据');
ok(d.count === 7, `七个桶全部进场(实得 ${d.count};feel、已了结、超长标题那条都在)`, d.count);
ok(d.glyphs === 144, `字符不够 144 时拿装饰字符填满(实得 ${d.glyphs})`, d.glyphs);
// ⚠️ 边有两种:6 条来自 /api/network(相似度),另外的来自「共享标签」(前端现算)。
// 别写死总数会变的那个 —— 这儿钉「相似度那六条都在,而且确实多出了标签边」。
ok(d.edges > 6, `两种边都接上了(相似度 6 条 + 共享标签若干,实得 ${d.edges})`, d.edges);
ok(await pg.evaluate(() => window.__drift.node(0).interactive === true), '前面那些是真记忆,可点');
ok(await pg.evaluate(() => window.__drift.node(143).interactive === false), '填充的装饰字符不可点');
ok(await pg.evaluate(() => document.getElementById('hTitle').textContent === 'Drift'), '大标题是 Drift');
ok(await pg.evaluate(() => document.getElementById('hSub').textContent === '记忆乱流'), '副标题是记忆乱流');
ok(await pg.evaluate(() => getComputedStyle(document.getElementById('loading')).display === 'none'), '「正在把记忆铺开…」已经收掉');

console.log('B2. 有出口能回后台');
// ⚠️ 这一页可以被加到手机主屏,那种模式下连浏览器的返回按钮都没有 —— 没这颗就只能杀掉重开。
// ⚠️⚠️ 本文件的 ok() 是「条件在前、说明在后」。2026-09-03 这四条一度写反了
//    (说明写在前面 → 条件永远是个非空字符串 → 全是假绿,什么都没测)。**别再弄反。**
ok(await pg.locator('#exit').isVisible(), '左上角有出口');
ok((await pg.getAttribute('#exit', 'href')) === '/dashboard', '出口指向 /dashboard');
ok((await pg.evaluate(() => document.getElementById('exit').tagName)) === 'A', '出口是链接不是 JS 跳转');
ok(!!(await pg.getAttribute('#exit', 'aria-label')), '出口有 aria-label(它只有图标)');
// 所有者要「做成隐藏的」:不许做成有底色的按钮,平时也不许太显眼
ok(await pg.evaluate(() => {
  const cs = getComputedStyle(document.getElementById('exit'));
  const bg = cs.backgroundColor;
  return (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') && parseFloat(cs.borderTopWidth) === 0;
}), '出口是隐蔽的:没底色没描边');
ok(await pg.evaluate(() =>
  parseFloat(getComputedStyle(document.getElementById('exit')).opacity) < 0.45),
  '出口平时很淡(不透明度 <0.45)');
// 看着淡不等于难按:热区仍要够大
ok(await pg.locator('#exit').evaluate(el => {
  const r = el.getBoundingClientRect(); return r.width >= 40 && r.height >= 40;
}), '热区够大(≥40px)');

console.log('C. 画布真的在画,而且是深色底');
const px = await pg.evaluate(() => {
  const c = document.getElementById('canvas');
  const x = c.getContext('2d').getImageData(2, 2, 1, 1).data;
  return [x[0], x[1], x[2]];
});
ok(px[0] < 20 && px[2] < 30, `底色是深的(实得 rgb(${px.join(',')}))`, px.join(','));
// ⚠️ 数「和底色不一样的像素」,不是「亮像素」:平时那些字符的透明度只有 .28~.45,
// 叠在 #01050a 上普遍到不了 rgb 40,拿亮度当门槛会把整片场判成空的(第一版就栽在这儿)。
const painted = await pg.evaluate(() => {
  const c = document.getElementById('canvas');
  const x = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < x.length; i += 4) if (x[i] > 3 || x[i+1] > 7 || x[i+2] > 12) n++;
  return n;
});
ok(painted > 5000, `场上确实画了东西(${painted} 个像素和底色不同)`, painted);
await pg.waitForTimeout(900);
ok(/^[0-9]+$/.test((await pg.textContent('#mFps')).trim()), 'FPS 读数在跳 = 动画真的在转');

console.log('D. 点中一颗 → 卡片浮出来,正文是取回来的全文');
await pg.evaluate(() => window.__drift.lockAt(0));
await pg.waitForSelector('#card.on', { timeout:8000 });
ok(await pg.textContent('#cName') === '真·相遇那天', '卡片标题是那颗桶的名字');
ok((await pg.textContent('#cKind')).includes('CORE'), 'pinned + importance 10 → 认成核心层');
await pg.waitForFunction(`document.getElementById('cBody').textContent.includes('★全文到此★')`, null, { timeout:8000 });
ok(true, '正文是点中之后才去取的全文,不是 200 字预览');
ok((await pg.textContent('#cTags')).includes('恋爱'), 'domain 变成标签显示出来了');
// 2026-09-03 所有者:「不要那么有安卓味,按苹果 ui 设计走」。钉三条,别改回去:
ok(await pg.$eval('#cTags', n => n.closest('#card header') !== null),
   '标签在标题正下方(卡片抬头里),不在正文底下');
const tagCss = await pg.$eval('#cTags .c-tag', n => {
  const s = getComputedStyle(n);
  return { bw:s.borderTopWidth, bg:s.backgroundColor, fg:s.color };
});
ok(tagCss.bw === '0px', '标签不描边(描边+实心那套是安卓味)', tagCss.bw);
ok(/^rgba\(/.test(tagCss.bg) && tagCss.bg !== 'rgba(0, 0, 0, 0)',
   '标签的底是同色的极淡一层,不是实心色块', tagCss.bg);
// 2026-09-03 所有者:「**我不要那个框**」。她朋友那版的卡上一个描边框都没有。别加回来:
const framed = await pg.evaluate(() => {
  const bad = [];
  for (const sel of ['#cClose', '#cNear button', '#cOpen']) {
    const n = document.querySelector(sel);
    if (n && parseFloat(getComputedStyle(n).borderTopWidth) > 0) bad.push(sel);
  }
  return bad;
});
ok(framed.length === 0, '✕ / 关联列表 / 「在面板里打开」三处都没有描边框', framed.join('|'));
// 「在面板里打开」是**真按钮**不是装饰:实心、灰底白字、点了真跳到那一条
const openCss = await pg.$eval('#cOpen', n => {
  const s = getComputedStyle(n);
  return { bg:s.backgroundColor, fg:s.color, href:n.getAttribute('href') };
});
ok(openCss.bg !== 'rgba(0, 0, 0, 0)', '「在面板里打开」是实心按钮,不是空心胶囊', openCss.bg);
{ const m = openCss.bg.match(/\d+/g).slice(0,3).map(Number);
  ok(m[0] === m[1] && m[1] === m[2], '底是零饱和的灰(她要的)', openCss.bg); }
ok(openCss.fg === 'rgb(255, 255, 255)', '字是白的(她要的)', openCss.fg);
ok(openCss.href === '/dashboard#bucket=b01',
   '⚠️ 它不是装饰:href 真的指向后台里的那一条', openCss.href);
// 日期:/api/buckets 是给 created 的,卡上就该有(2026-09-03 夹具漏了这个字段,她一眼看出来)
ok(/月/.test(await pg.textContent('#cTags')), '日期显示出来了', await pg.textContent('#cTags'));
// 「正文的部分是有一个和底色相近的玻璃质感框的」—— 正文是唯一保留框的一块,而且是玻璃不是描边
const bodyBox = await pg.$eval('#cBody', n => {
  const s = getComputedStyle(n);
  return { bw:s.borderTopWidth, bg:s.backgroundColor, r:parseFloat(s.borderTopLeftRadius),
           pad:parseFloat(s.paddingTop), blur:(s.backdropFilter || s.webkitBackdropFilter || '') };
});
ok(bodyBox.bw === '0px', '正文那块是玻璃,不是描边框', bodyBox.bw);
ok(/^rgba\(255, 255, 255/.test(bodyBox.bg), '正文那块的底是「把卡片底再提亮一点」的一层白', bodyBox.bg);
ok(bodyBox.r >= 10 && bodyBox.pad >= 10, `正文那块有圆角(${bodyBox.r}px)和内边距(${bodyBox.pad}px)`);
ok(/blur/.test(bodyBox.blur), '正文那块真的开了玻璃模糊', bodyBox.blur);
// ⚠️ 别钉「几条」「第一条是谁」—— 假 OB 的边一改这些就红,而那不是 bug
// (2026-09-03 给夹具加了条超长标题的桶,顺序就变了)。钉真正该成立的性质:
const near = await pg.$$eval('#cNear button', bs => bs.map(x => x.textContent));
ok(near.length > 0, `「离它最近的记忆」列出了相邻的桶(实得 ${near.length} 条)`, near.join('|'));
// ⚠️ 2026-09-03 改了:每条标的不再是「像 N%」,而是**是哪种关系** ——
// 和图上的实线/虚线、抬头的图例,三处对得上。
ok(await pg.$$eval('#cNear button em', es => es.length > 0 &&
  es.every(e => ['说的是相近的事', '共享同一个标签'].includes(e.textContent))),
  '每条都标着是哪种关系');
// 相似度那种排在共享标签前面(图上实线也比虚线显眼)
ok(await pg.$$eval('#cNear button em', es => {
  const v = es.map(e => e.textContent === '说的是相近的事' ? 0 : 1);
  return v.every((x, i) => i === 0 || x >= v[i - 1]);
}), '相似度那种排在共享标签前面');
ok(await pg.$eval('#cNear > b', e => /牵着 \d+ 条记忆/.test(e.textContent)),
  '抬头写清一共牵着几条');
ok(await pg.$eval('#cOpen', e => e.getAttribute('href').startsWith('/dashboard#bucket=')),
  '「在面板里打开」带着这条桶的 id 跳回后台');

console.log('D2. 超长标题不许把卡片撑破(2026-09-03 所有者在手机上撞到的)');
// 她的真实桶名长这样:`session_2026-07-01_一整句话`。假 OB 里 b07 就是专门撞这个的。
// 病根是 CSS 默认「格子不许比内容窄」,而标题是 nowrap 的 —— 详情卡会被撑出屏幕、✕ 被挤没。
{
  // ⚠️ **必须在手机宽度下测** —— 电脑宽度下长标题根本不会溢出,测了个寂寞
  // (2026-09-03 第一版就是在 1000px 下写的,那条断言永远绿不了/也永远抓不到问题)。
  await pg.setViewportSize({ width: 390, height: 844 });
  await pg.waitForTimeout(300);
  await pg.evaluate(() => window.__drift.clear());
  const idx = await pg.evaluate(() =>
    window.__drift ? [...Array(window.__drift.glyphs).keys()]
      .find(k => (window.__drift.node(k).id || '') === 'b07') : -1);
  ok(idx >= 0, '假 OB 里有那条超长标题的桶', idx);
  await pg.evaluate(k => window.__drift.lockAt(k), idx);
  await pg.waitForSelector('#card.on', { timeout: 8000 });
  await pg.waitForTimeout(300);
  ok(!(await pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)),
    '超长标题下页面没有被撑出横向滚动');
  ok(await pg.evaluate(() => {
    const c = document.getElementById('card').getBoundingClientRect();
    return c.right <= window.innerWidth + 1 && c.left >= -1;
  }), '详情卡没有超出屏幕');
  ok(await pg.evaluate(() => {
    const b = document.getElementById('cClose').getBoundingClientRect();
    return b.right <= window.innerWidth + 1 && b.width > 0;
  }), '右上角那颗 ✕ 还在屏幕里');
  ok(await pg.evaluate(() => {
    const t = document.getElementById('cName');
    return t.scrollWidth > t.clientWidth;   // 真的被省略号截断了
  }), '长标题是被省略号截断的,不是溢出去的');
  ok(await pg.evaluate(() => [...document.querySelectorAll('#cNear button')]
    .every(b => b.getBoundingClientRect().right <= window.innerWidth + 1)),
    '「离它最近的记忆」也没有溢出屏幕');
  await pg.evaluate(() => window.__drift.clear());
  await pg.setViewportSize({ width: 1000, height: 800 });   // 量完还回去,别影响后面几段
  await pg.waitForTimeout(300);
  await pg.evaluate(() => window.__drift.lockAt(0));
  await pg.waitForSelector('#card.on', { timeout: 8000 });
}

console.log('E. 卡片里点邻居 → 跳过去;点 ✕ → 松开');
// ⚠️ 同上:别写死「点完应该变成哪个名字」。读第一条邻居叫什么,再验卡片确实换成了它。
const firstNeighbour = await pg.$eval('#cNear button strong', e => e.textContent);
const firstId = await pg.$eval('#cNear button', e => e.dataset.id);
await pg.click('#cNear button');
await pg.waitForFunction(
  name => document.getElementById('cName').textContent === name,
  firstNeighbour, { timeout:8000 });
ok(await pg.evaluate(() => window.__drift.locked()) === firstId,
  `锁定跟着换到了邻居那颗(${firstNeighbour})`);
// 相似是双向的:跳过去之后,来的那一颗应该出现在新的邻居表里
ok(await pg.$$eval('#cNear button', (bs, back) => bs.some(b => b.dataset.id === back), 'b01'),
  '跳过去之后,来时那颗也在新的邻居表里(相似是双向的)');
await pg.click('#cClose');
ok(await pg.evaluate(() => !document.getElementById('card').classList.contains('on')), '✕ 之后卡片收掉了');
ok(await pg.evaluate(() => window.__drift.locked()) === null, '✕ 之后锁定也松开了');

console.log('F. 缩放按钮');
const s0 = await pg.evaluate(() => window.__drift.scale());
await pg.click('#controls button[data-action="in"]');
const s1 = await pg.evaluate(() => window.__drift.scale());
ok(s1 > s0, `＋ 放大了(${s0.toFixed(2)} → ${s1.toFixed(2)})`);
await pg.click('#controls button[data-action="reset"]');
const s2 = await pg.evaluate(() => window.__drift.scale());
ok(Math.abs(s2 - 1) < 0.001, '↺ 复位回 1.00×');
ok((await pg.textContent('#mZoom')).includes('×'), '右下角读数带倍数');

console.log('G. 只读 + 零外部请求(这一页的底线)');
const external = requests.filter(r => !r.url.startsWith(OB) && !r.url.startsWith('data:') && !r.url.startsWith('about:'));
ok(external.length === 0, `一个外部请求都没发(实得 ${external.length})`, external.map(r => r.url).join(' | '));
const writes = requests.filter(r => r.method !== 'GET' && !r.url.endsWith('/auth/login'));
ok(writes.length === 0, `除了登录,没发出过任何非 GET 请求(实得 ${writes.length})`, writes.map(r => r.method + ' ' + r.url).join(' | '));
const apis = [...new Set(requests.filter(r => r.url.includes('/api/')).map(r => r.url.replace(OB, '').split('?')[0]))];
const unexpected = apis.filter(p => !/^\/api\/(buckets|network|bucket\/)/.test(p));
ok(unexpected.length === 0, `只碰了已有的那三条接口(${apis.length} 条,没有新接口)`, unexpected.join(' | '));
const bucketsCalls = requests.filter(r => r.url.includes('/api/buckets')).length;
ok(bucketsCalls <= 2, `不轮询:整场只取了 ${bucketsCalls} 次 /api/buckets`, bucketsCalls);

console.log('H. 连线那条接口挂了 → 场照样铺得出来(降级,不白屏)');
const pg2 = await ctx.newPage();
const errs2 = [];
pg2.on('pageerror', e => errs2.push(e.message));
await pg2.goto(`${NONET}/turbulence`);
await pg2.waitForFunction('window.__drift', null, { timeout:30000 });
const d2 = await pg2.evaluate(() => ({ count:window.__drift.count, edges:window.__drift.edges }));
ok(d2.count === 7, '/api/network 回 500 时,桶照样铺出来了');
// ⚠️ 降级现在更强了:/api/network 挂掉只丢「说的是相近的事」那种线,
// **「共享同一个标签」那种照样在** —— 它是前端拿桶自带的 domain/tags 现算的,不依赖后端。
ok(d2.edges > 0, `连线接口挂了,共享标签那种线照样在(实得 ${d2.edges} 条)`, d2.edges);
ok(await pg2.$$eval('#cNear button em', es =>
  es.every(e => e.textContent === '共享同一个标签')),
  '这种情况下列出来的全是「共享同一个标签」');
await pg2.evaluate(() => window.__drift.lockAt(0));
await pg2.waitForSelector('#card.on', { timeout:8000 });
ok(await pg2.evaluate(() => document.getElementById('cNear').style.display === 'none'), '没有邻居时,「离它最近的记忆」那块自己藏起来');
ok(errs2.length === 0, '降级路径上零报错', errs2.join(' | '));

console.log('J. 跟着系统深浅色走');
// ⚠️ 画布是 JS 画的,不像页面上的框框能靠 CSS 自己变 —— 所以这一段专门钉「画布也跟着变」。
const readScheme = async (scheme) => {
  const c = await b.newContext({ viewport:{ width:1000, height:800 }, deviceScaleFactor:1, colorScheme:scheme });
  const p = await c.newPage();
  const e = [];
  p.on('pageerror', x => e.push(x.message));
  await p.goto(`${NONET}/turbulence`);            // 这个不用登录,省一步
  await p.waitForFunction('window.__drift', null, { timeout:30000 });
  await p.waitForTimeout(600);
  const out = await p.evaluate(() => {
    const cv = document.getElementById('canvas');
    const px = cv.getContext('2d').getImageData(2, 2, 1, 1).data;
    const root = getComputedStyle(document.documentElement);
    const v = n => root.getPropertyValue(n).trim();
    return {
      canvas:[px[0], px[1], px[2]],
      bodyBg:getComputedStyle(document.body).backgroundColor,
      headInk:getComputedStyle(document.querySelector('#head h1')).color,
      signal:v('--drift-signal'),
      trace:v('--drift-trace'),
      traceBoost:v('--drift-trace-boost'),
      inkBoost:v('--drift-ink-boost'),
    };
  });
  await p.evaluate(() => window.__drift.lockAt(0));
  await p.waitForSelector('#card.on', { timeout:8000 });
  await p.screenshot({ path:(process.env.SHOTS || '/tmp/turbulence-e2e') + '/乱流-' + scheme + '.png' });
  out.errs = e;
  await c.close();
  return out;
};
const dark = await readScheme('dark');
const light = await readScheme('light');
ok(dark.canvas[0] < 20 && dark.canvas[2] < 30, `深色下画布底是深的 rgb(${dark.canvas.join(',')})`, dark.canvas.join(','));
ok(light.canvas[0] > 200 && light.canvas[1] > 200, `浅色下画布底是浅的 rgb(${light.canvas.join(',')})`, light.canvas.join(','));
ok(dark.signal !== light.signal, `连线那个颜色两套不一样(深 ${dark.signal} / 浅 ${light.signal})`);
// ⚠️⚠️ 这两个值是**所有者 2026-09-03 在全色域取色器上亲手拖出来的**,钉死。
// ~~当天我先按「饱和度低」自己算过一版(125,153,185 / 61,85,113),她说「不是这种蓝」~~;
// ~~也写过一条「最大最小通道差 ≤70」的断言~~ —— 她拖出来的比那个艳,**是我的标准错了,不是她的色错了**。
// 要改先照 INTERNALS 1.12《怎么再调一次》给她取色器,别自己挑,也别把这两条改回"某种范围"。
ok(dark.signal === '150,180,253', `深色是她拖的那个(偏蓝紫)`, dark.signal);
ok(light.signal === '144,206,216', `浅色是她拖的那个(偏青)`, light.signal);
// 两套刻意不是同一个色相 —— 这是她拖出来的结果,别去"统一"
ok(dark.signal !== light.signal, '两套是两个不同的颜色,不是同一个色算出来的深浅');
ok(dark.bodyBg !== light.bodyBg, '页面底色两套不一样');
ok(dark.headInk !== light.headInk, '标题的字色两套不一样');
ok(dark.errs.length === 0 && light.errs.length === 0, '两套配色下都零报错',
   [...dark.errs, ...light.errs].join(' | '));

// ⚠️ 下面这四个数是所有者 2026-09-03 在校准台上**自己拖出来的**,不是随手写的默认值。
// 钉在这儿是为了拦「顺手改回原版 / 和 signal 统一」那类改动 —— 真要改,先拿新数给她看。
ok(dark.inkBoost === '1.85',   `深色字的浓度是她定的 1.85(实得 ${dark.inkBoost})`, dark.inkBoost);
ok(light.inkBoost === '1.4',   `浅色字的浓度是她定的 1.4(实得 ${light.inkBoost})`, light.inkBoost);
ok(dark.trace === '130,138,148' && light.trace === '110,108,102',
   `坠线是她挑的中性灰(深 ${dark.trace} / 浅 ${light.trace})`, dark.trace + ' / ' + light.trace);
ok(dark.trace !== dark.signal, '坠线和连线是两个颜色,没被合回去');
ok(dark.traceBoost === '1.55' && light.traceBoost === '0.85',
   `坠线浓度是她定的(深 ${dark.traceBoost} / 浅 ${light.traceBoost})`,
   dark.traceBoost + ' / ' + light.traceBoost);

console.log('K. 系统当场切换 → 画布立刻跟着换(不用刷新)');
const pg3 = await ctx.newPage();
await pg3.goto(`${NONET}/turbulence`);
await pg3.waitForFunction('window.__drift', null, { timeout:30000 });
await pg3.waitForTimeout(400);
const before = await pg3.evaluate(() => [...document.getElementById('canvas').getContext('2d').getImageData(2,2,1,1).data].slice(0,3));
await pg3.emulateMedia({ colorScheme:'light' });
await pg3.waitForTimeout(500);
const after = await pg3.evaluate(() => [...document.getElementById('canvas').getContext('2d').getImageData(2,2,1,1).data].slice(0,3));
ok(before[0] < 20 && after[0] > 200,
   `切到浅色,画布当场跟着换了(${before.join(',')} → ${after.join(',')})`, before + ' → ' + after);

console.log('I. 控制台');
ok(errs.length === 0, '整场零 JS 报错', errs.join(' | '));

await b.close();
console.log(`\n通过 ${pass},失败 ${fail}`);
process.exit(fail ? 1 : 0);
