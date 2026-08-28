// 真浏览器演练：起一个本地 chess-web，用 chromium 走一遍完整流程。
//
// **playwright 刻意不进 package.json** —— 它是一次性验证工具，服务本身用不到
// （照 dwell-bridge/tools/make-icons.mjs 的同一条规矩）。
// 跑法见 ./e2e-run.sh。
//
// ⚠️ 两条踩过的坑（dwell 手册记过同款，这儿又踩了一遍）：
//   ① 上一轮的服务会占着端口不退，新的那个 EADDRINUSE 静默退出，
//      于是你打在旧服务上、看到的是旧行为。**换端口比 pkill 可靠。**
//   ② 游戏自带的「知道了」弹层会挡住下一次点击，是游戏本来的行为，
//      演练里要先把它关掉再往下走。
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = +(process.env.PORT || 8796), PASS = 'miaian99';
const srv = spawn('node', ['/home/user/Ombre-Brain/chess-web/server.js'],
  { env: { ...process.env, PORT: String(PORT), CHESS_PASS: PASS }, stdio: 'inherit' });
await new Promise(r => setTimeout(r, 900));

const base = `http://127.0.0.1:${PORT}`;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await b.newContext({ viewport: { width: 430, height: 880 } });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', e => errs.push(String(e)));

let bad = 0;
const chk = (n, c) => { console.log((c ? '  ✓ ' : '  ✗ ') + n); if (!c) bad++; };

// 1. 没登录
await p.goto(base + '/flight-chess-popup.html');
chk('没登录 → 看到登录页', await p.locator('input[name=pass]').count() === 1);
chk('没登录 → 看不到棋盘', await p.locator('#boardPath').count() === 0);

// 2. 登录
await p.fill('input[name=pass]', PASS);
await Promise.all([p.waitForNavigation(), p.click('form button')]);
await p.goto(base + '/flight-chess-popup.html');
await p.waitForSelector('#btnRoll');
chk('登录后 → 棋盘出来了', await p.locator('#boardPath').count() === 1);
chk('补丁已装载 (__yanCopyReady)', await p.evaluate(() => !!window.__yanCopyReady));
chk('常驻「发给晏」按钮在', (await p.locator('text=发给晏').count()) >= 1);

// 3. 我掷 —— 面板该出现，用的是「我停在」的措辞
await p.click('#btnRoll');
await p.waitForSelector('#yanCopyPanel', { state: 'visible', timeout: 3000 });
let t = await p.locator('#yanCopyPanel pre').textContent();
chk('我掷后弹出面板', !!t);
chk('我停 → 措辞是「我停在第 N 格」', /^【飞行棋】我停在第 \d+ 格。/.test(t));
chk('我停 → 说清谁接受', /本格由(我|你)接受。/.test(t));
chk('我停 → 带格子原文', /格子内容：/.test(t) && t.split('格子内容：')[1].trim().length > 0);
console.log('   ── 我停那格实际文案 ──\n' + t.split('\n').map(s => '   | ' + s).join('\n'));

// 我的面板 vs 游戏自带的「知道了」弹层：确认两者能共存、我的在上面点得到
chk('游戏自带的事件弹层也在（没被我盖掉）', await p.locator('#eventLayer.show').count() === 1);
await p.screenshot({ path: (process.env.SHOT_DIR || '.') + '/both-layers.png' });

// 关掉面板
await p.click('#yanCopyPanel button[aria-label=关闭]');
chk('× 能关掉面板', !(await p.locator('#yanCopyPanel').isVisible()));

// 关掉游戏自带的弹层（不然它挡着下一次点击——这是游戏本来的行为）
await p.click('#eventLayer button:has-text("知道了")');
await p.waitForTimeout(200);

// 4. 到你了 —— 该用游戏自带的 injectPrompt
await p.click('#btnAi');
await p.waitForSelector('#yanCopyPanel', { state: 'visible', timeout: 3000 });
t = await p.locator('#yanCopyPanel pre').textContent();
chk('小机停 → 用游戏自带的注入词', t.startsWith('【飞行棋事件 · 已自动掷完 · 必须执行】'));
chk('小机停 → 含「禁止再讨论掷骰」', /禁止再讨论掷骰/.test(t));
chk('小机停 → 含格子原文', /格子内容：/.test(t));
console.log('   ── 小机停那格实际文案 ──\n' + t.split('\n').map(s => '   | ' + s).join('\n'));

await p.click('#eventLayer button:has-text("知道了")').catch(()=>{});
await p.waitForTimeout(200);

// 5. 复制
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
await p.click('#yanCopyPanel button:has-text("复制")');
await p.waitForTimeout(400);
const tip = await p.locator('#yanCopyPanel p').textContent();
chk('点复制后有回执', /已复制|长按/.test(tip));
console.log('   回执:', tip);

// 5b. 复制成功后面板该自己收起，把掷骰按钮让出来
await p.waitForTimeout(1900);
chk('复制成功后面板自动收起', !(await p.locator('#yanCopyPanel').isVisible()));
chk('收起后掷骰按钮点得到', await p.locator('#btnRoll').isEnabled() || await p.locator('#btnAi').isEnabled());
await p.locator('text=发给晏').first().click();
await p.waitForTimeout(300);
chk('「发给晏」能把面板叫回来', await p.locator('#yanCopyPanel').isVisible());
await p.click('#yanCopyPanel button[aria-label=关闭]');

// 6. 游戏本身没被搞坏
const st = await p.evaluate(() => ({
  posText: document.getElementById('posText').textContent,
  saved: !!localStorage.getItem('flight_chess_progress'),
  prog: JSON.parse(localStorage.getItem('flight_chess_progress') || '{}'),
}));
console.log('   进度条显示:', st.posText, '| 存档:', JSON.stringify(st.prog));
chk('棋子真的走了', (st.prog.playerPos > 0 || st.prog.aiPos > 0));
chk('存档照常写', st.saved);
chk('页面零报错', errs.length === 0);
if (errs.length) console.log(errs);

// 7. 最小化浮窗还在
await p.evaluate(() => window.minimizePopup && window.minimizePopup());
await p.waitForTimeout(300);
chk('最小化后浮窗出现（float-window.js 没被打坏）', await p.locator('#floatBar').isVisible());

await p.screenshot({ path: (process.env.SHOT_DIR || '.') + '/chess-panel.png', fullPage: false });
await b.close(); srv.kill();
console.log(bad ? `\n${bad} 项没过` : '\n真浏览器全过');
process.exit(bad ? 1 : 0);
