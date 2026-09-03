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
ok(d.count === 6, `六个桶全部进场(实得 ${d.count};feel 和已了结的都在)`, d.count);
ok(d.glyphs === 144, `字符不够 144 时拿装饰字符填满(实得 ${d.glyphs})`, d.glyphs);
ok(d.edges === 4, `/api/network 那四条边都接上了(实得 ${d.edges})`, d.edges);
ok(await pg.evaluate(() => window.__drift.node(0).interactive === true), '前面那些是真记忆,可点');
ok(await pg.evaluate(() => window.__drift.node(143).interactive === false), '填充的装饰字符不可点');
ok(await pg.evaluate(() => document.getElementById('hTitle').textContent === 'Drift'), '大标题是 Drift');
ok(await pg.evaluate(() => document.getElementById('hSub').textContent === '记忆乱流'), '副标题是记忆乱流');
ok(await pg.evaluate(() => getComputedStyle(document.getElementById('loading')).display === 'none'), '「正在把记忆铺开…」已经收掉');

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
const near = await pg.$$eval('#cNear button', bs => bs.map(x => x.textContent));
ok(near.length === 1 && near[0].includes('真·搭记忆库'), `「离它最近的记忆」列出了相邻的桶(实得 ${near.length} 条)`, near.join('|'));
ok(near[0].includes('82%'), '相似度显示成百分比');

console.log('E. 卡片里点邻居 → 跳过去;点 ✕ → 松开');
await pg.click('#cNear button');
await pg.waitForFunction(`document.getElementById('cName').textContent==='真·搭记忆库'`, null, { timeout:8000 });
ok(await pg.evaluate(() => window.__drift.locked()) === 'b02', '锁定跟着换到了邻居那颗');
const near2 = await pg.$$eval('#cNear button', bs => bs.length);
ok(near2 === 3, `b02 有三个邻居,都列出来了(实得 ${near2})`, near2);
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
ok(d2.count === 6, '/api/network 回 500 时,六个桶照样铺出来了');
ok(d2.edges === 0, '拿不到边就当没有边,不炸');
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
    return {
      canvas:[px[0], px[1], px[2]],
      bodyBg:getComputedStyle(document.body).backgroundColor,
      headInk:getComputedStyle(document.querySelector('#head h1')).color,
      signal:getComputedStyle(document.documentElement).getPropertyValue('--drift-signal').trim(),
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
ok(dark.bodyBg !== light.bodyBg, '页面底色两套不一样');
ok(dark.headInk !== light.headInk, '标题的字色两套不一样');
ok(dark.errs.length === 0 && light.errs.length === 0, '两套配色下都零报错',
   [...dark.errs, ...light.errs].join(' | '));

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
