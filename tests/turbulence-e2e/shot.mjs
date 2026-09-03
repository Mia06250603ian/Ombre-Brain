// 出效果图:手机宽度下把详情卡拍下来(深浅各一张),给所有者看。
// 用法:PORT=8811 bash -c '…' —— 见同目录 run.sh 的起法,或:
//   WORK=/tmp/turbulence-e2e PW=$WORK/node_modules PORT=8811 CHROME=… node tests/turbulence-e2e/shot.mjs
// 只连假 OB,不碰线上。
const { chromium } = await import(process.env.PW + '/playwright/index.mjs');
const OB   = process.env.OB_URL || `http://127.0.0.1:${process.env.PORT || 8811}`;
const PASS = process.env.PASS || 'test123';
const OUT  = process.env.OUT || '/tmp/turbulence-shot';

const b = await chromium.launch({ executablePath:process.env.CHROME, args:['--no-sandbox'] });
for (const scheme of ['light', 'dark']) {
  const ctx = await b.newContext({ viewport:{ width:390, height:844 }, deviceScaleFactor:3, colorScheme:scheme });
  const pg = await ctx.newPage();
  await pg.goto(`${OB}/turbulence`);
  await pg.waitForFunction('document.getElementById("gate").classList.contains("on")', null, { timeout:30000 });
  await pg.fill('#gPass', PASS);
  await pg.click('#gGo');
  await pg.waitForFunction('window.__drift', null, { timeout:30000 });
  await pg.evaluate(() => window.__drift.lockAt(0));
  await pg.waitForTimeout(600);
  await pg.screenshot({ path:`${OUT}-${scheme}.png` });
  console.log(`${OUT}-${scheme}.png`);
  await ctx.close();
}
await b.close();
