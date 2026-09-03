// 假的 OB:只为记忆乱流那页用,行为照着 server.py 的
// /api/buckets、/api/network、/api/bucket/{id}、/auth/login 抄。
// 为什么要假 OB:真 OB 上是所有者的真实记忆,测试不该碰(同 tests/galaxy-e2e/)。
import http from 'node:http';
import fs from 'node:fs';

const B = [
  {id:'b01',name:'真·相遇那天',  type:'permanent',domain:['恋爱'],   importance:10,pinned:true, resolved:false,content_preview:'PLACEHOLDER'},
  {id:'b02',name:'真·搭记忆库',  type:'dynamic',  domain:['编程','AI'],importance:8,pinned:false,resolved:false,content_preview:'预览二'},
  {id:'b03',name:'真·某个晚安',  type:'dynamic',  domain:['日常'],   importance:5, pinned:false,resolved:false,content_preview:'预览三'},
  {id:'b04',name:'真·旧事',      type:'dynamic',  domain:['回忆'],   importance:3, pinned:false,resolved:true, content_preview:'预览四'},
  {id:'b05',name:'真·他的自省',  type:'feel',     domain:['自省'],   importance:6, pinned:false,resolved:false,content_preview:'预览五'},
  {id:'b06',name:'真·没有域的桶',type:'dynamic',  domain:[],         importance:7, pinned:false,resolved:false,content_preview:'预览六'},
];
const FULL = {
  b01:'相遇那天的全文。末尾这句只有取到全文才看得见：★全文到此★',
  b02:'搭记忆库全文', b03:'晚安全文', b04:'旧事全文', b05:'自省全文', b06:'无域全文',
};
// 照 /api/network 的形状:{nodes, edges},edges 是 {source,target,similarity}
const EDGES = [
  {source:'b01',target:'b02',similarity:0.82},
  {source:'b02',target:'b03',similarity:0.64},
  {source:'b03',target:'b06',similarity:0.55},
  {source:'b05',target:'b02',similarity:0.71},
];

const auth = (process.env.AUTH ?? '1') === '1';   // AUTH=0 → 要先登录
const PORT = +process.env.PORT || 8811;

http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x');

  if (u.pathname === '/turbulence') {
    // 测试专用:把上飘速度调成 0,好让点击落得准。
    // ⚠️ 只替换测试时发出去的那份 HTML,turbulence.html 本身一个字不动(同 galaxy 那套)。
    let h = fs.readFileSync('turbulence.html', 'utf8');
    h = h.replace(/driftSpeed:\s*0\.004725/, 'driftSpeed:     0');
    r.writeHead(200, {'content-type':'text/html'});
    return r.end(h);
  }

  if (u.pathname === '/auth/login' && q.method === 'POST') {
    let b = '';
    q.on('data', d => b += d);
    return q.on('end', () => {
      let pwd = '';
      try { pwd = JSON.parse(b).password || ''; } catch {}
      if (pwd !== 'test123') { r.writeHead(401, {'content-type':'application/json'}); return r.end('{"error":"密码错误"}'); }
      r.writeHead(200, {'content-type':'application/json','set-cookie':'ombre_session=ok; Path=/; HttpOnly'});
      r.end('{"ok":true}');
    });
  }

  const logged = (q.headers.cookie || '').includes('ombre_session=ok');
  if (!auth && !logged) { r.writeHead(401, {'content-type':'application/json'}); return r.end('{"error":"Unauthorized"}'); }

  if (u.pathname === '/api/buckets') {
    r.writeHead(200, {'content-type':'application/json'});
    return r.end(JSON.stringify(B));
  }
  if (u.pathname === '/api/network') {
    // NONET=1 模拟「连线这条接口挂了」:页面应当照样把场铺出来,只是不亮线
    if (process.env.NONET === '1') { r.writeHead(500); return r.end('{"error":"boom"}'); }
    r.writeHead(200, {'content-type':'application/json'});
    return r.end(JSON.stringify({nodes:B.map(b => ({id:b.id})), edges:EDGES}));
  }
  const m = u.pathname.match(/^\/api\/bucket\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!FULL[id]) { r.writeHead(404); return r.end('{}'); }
    r.writeHead(200, {'content-type':'application/json'});
    return r.end(JSON.stringify({id, metadata:{}, content:FULL[id]}));
  }
  r.writeHead(404); r.end();
}).listen(PORT, () => console.error('fake-ob on', PORT));
