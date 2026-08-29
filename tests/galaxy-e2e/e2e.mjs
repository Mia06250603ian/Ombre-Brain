// 浏览器演练:靠 run.sh 起两个假 OB 再跑本文件(别直接 node 它)
const { chromium } = await import(process.env.PW+'/playwright/index.mjs');
let pass=0,fail=0;
const ok=(c,m)=>{ c?(pass++,console.log('  ✓',m)):(fail++,console.log('  ✗',m)); };
const OB=process.env.OB_URL||`http://127.0.0.1:${process.env.PORT||8791}`;
const NOAPI=process.env.NOAPI_URL||`http://127.0.0.1:${(+(process.env.PORT||8791))+1}`;
const PASS=process.env.PASS||'test123';

const b=await chromium.launch({executablePath:process.env.CHROME,args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader']});
const ctx=await b.newContext({viewport:{width:1000,height:800},deviceScaleFactor:1});
const pg=await ctx.newPage();
const errs=[]; pg.on('pageerror',e=>errs.push(e.message));

console.log('A. 没登录 → 请你输口令（不是悄悄给你看示例数据）');
await pg.goto(`${OB}/galaxy`);
await pg.waitForFunction('document.getElementById("gate").classList.contains("on")',null,{timeout:30000});
ok(true,'口令门出来了');
ok(await pg.evaluate(()=>!window.__galaxy),'没登录时一颗星都没画');
ok((await pg.content()).indexOf('真·相遇那天')===-1,'页面里搜不到任何真实记忆');
await pg.fill('#gPass','wrongpass'); await pg.click('#gGo');   // 用纯英文的错口令:含中文的会撞上 OB 的已知毛病(见 run-real-ob.sh 的 G 段)
await pg.waitForFunction(`document.getElementById('gErr').textContent.length>0`,null,{timeout:8000}).catch(()=>{});
ok(await pg.textContent('#gErr')==='口令不对','口令错 → 就地说一声，不放行');
ok(await pg.evaluate(()=>!window.__galaxy),'口令错时仍然一颗星都没有');

console.log('B. 口令对 → 星图出来');
await pg.fill('#gPass', PASS); await pg.click('#gGo');
await pg.waitForFunction('window.__galaxy',null,{timeout:30000});
const g=await pg.evaluate(()=>({...window.__galaxy, coreName:window.__galaxy.core.name}));
ok(await pg.evaluate(()=>!document.getElementById('gate').classList.contains('on')),'口令门收起来了');
ok(g.ob===true,'走的是 OB 的真数据，不是内嵌示例');
ok(g.count===6,`六个桶全部变成星（实得 ${g.count}，feel 和 archive 都在）`);
ok(g.coreName==='真·相遇那天','created 最早的那条坐在银河正中心');
ok(await pg.evaluate(()=>window.__galaxy.star(5).domain==='未分类'),'domain 空的桶兜底成「未分类」，不会没颜色');
ok(await pg.evaluate(()=>window.__galaxy.star(1).domain==='编程'),'domain 是数组时取第一个');
ok(await pg.evaluate(()=>document.getElementById('hTitle').textContent==='Vesper'),'大标题是 Vesper');
ok(await pg.evaluate(()=>document.getElementById('hZh').textContent==='每一颗星都记得宇宙的方向'),'中文小字是新写的那句');
ok(await pg.evaluate(()=>getComputedStyle(document.getElementById('loading')).display==='none'),'「entering the galaxy…」已经收掉');

console.log('C. 点一颗星（真的点画布，走光线拾取）');
// 找一颗此刻朝向镜头、在屏幕内的星
const target=await pg.evaluate(()=>{
  for(let i=0;i<window.__galaxy.count;i++){
    const [x,y,front]=window.__galaxy.screenXY(i);
    if(front&&x>60&&x<940&&y>120&&y<600) return {i,x,y,name:window.__galaxy.star(i).name};
  } return null;});
ok(!!target,'找得到一颗在屏幕内的星'+(target?`（${target.name}）`:''));
if(target){
  await pg.mouse.move(target.x,target.y); await pg.mouse.down(); await pg.mouse.up();
  await pg.waitForFunction('document.getElementById("card").classList.contains("show")',null,{timeout:5000}).catch(()=>{});
  ok(await pg.evaluate(()=>document.getElementById('card').classList.contains('show')),'点中了 → 底部浮出记忆');
  const title=await pg.textContent('#cTitle');
  ok(title.length>0,`标题显示的是「${title}」`);
  // 正文是点开这一刻才去 OB 取的
  await pg.waitForFunction(`!document.getElementById('cBody').textContent.includes('预览')`,null,{timeout:5000}).catch(()=>{});
  const body=await pg.textContent('#cBody');
  // ⚠️ 别只验「有没有字」:预览也有字。必须验只有全文里才有的那句,
  //    否则接口 404 了、页面退回预览,测试照样绿(2026-08-29 真栽过一次)。
  ok(body.includes('★全文到此★'),`正文确实是点开后现取的全文（不是那 200 字预览）`);
  ok(!body.endsWith('…'),'不是「预览 + 省略号」那个兜底状态');
  if(title==='真·搭记忆库') ok(await pg.$$eval('.c-fact',n=>n.length)===2,'core_facts 渲染成带 ✦ 的列表');
  await pg.click('#scrim');
  ok(!await pg.evaluate(()=>document.getElementById('card').classList.contains('show')),'点空白处收回去');
}

console.log('C2. 再点一颗不在中心的星（core_facts 那条）');
// 让镜头停下来，转到目标星朝向镜头时再点
const i2=await pg.evaluate(()=>{for(let i=0;i<window.__galaxy.count;i++) if(window.__galaxy.star(i).name==='真·搭记忆库') return i; return -1;});
ok(i2>0,'找得到「真·搭记忆库」这颗，且不是中心那颗');
let hit=null;
for(let t=0;t<60&&!hit;t++){
  const [x,y,front]=await pg.evaluate(i=>window.__galaxy.screenXY(i),i2);
  if(front&&x>60&&x<940&&y>140&&y<560) hit=[x,y]; else await pg.waitForTimeout(250);
}
ok(!!hit,'等到它转进屏幕里');
if(hit){
  await pg.mouse.move(hit[0],hit[1]); await pg.mouse.down(); await pg.mouse.up();
  await pg.waitForFunction(`document.getElementById('cTitle').textContent==='真·搭记忆库'`,null,{timeout:6000}).catch(()=>{});
  ok(await pg.textContent('#cTitle')==='真·搭记忆库','点中的确实是它，不是旁边那颗');
  await pg.waitForFunction(`document.querySelectorAll('.c-fact').length===2`,null,{timeout:6000}).catch(()=>{});
  ok(await pg.$$eval('.c-fact',n=>n.length)===2,'core_facts 渲染成两条带 ✦ 的事实');
  ok(await pg.textContent('#cTag')==='重要记忆','importance 8 → 标成「重要记忆」');
  await pg.click('#scrim');
}

console.log('D. 根本连不上 OB（比如你双击本地文件）→ 不能崩，退回内嵌示例数据');
const pg2=await ctx.newPage(); const errs2=[]; pg2.on('pageerror',e=>errs2.push(e.message));
await pg2.goto(`${NOAPI}/galaxy`);
await pg2.waitForFunction('window.__galaxy',null,{timeout:30000});
const g2=await pg2.evaluate(()=>({...window.__galaxy}));
ok(g2.ob===false,'认出没接上 OB');
ok(g2.count===10,'退回内嵌的 10 颗示例星，页面照常出来');
ok(await pg2.evaluate(()=>!document.getElementById('gate').classList.contains('on')),'这种情况不弹口令门（没 OB 可登）');
ok(errs2.length===0,'零 JS 报错');

console.log('E. 通用');
ok(errs.length===0,'整页零 JS 报错'+(errs.length?`：${errs[0]}`:''));
ok(!(await pg.content()).includes('cloudflareinsights'),'页面里没有第三方统计信标');
if(process.env.SHOT) await pg.screenshot({path:process.env.SHOT});
await b.close();
console.log(`\n${pass} 项通过，${fail} 项失败`);
process.exit(fail?1:0);
