// 假的 OB:只为演练 dashboard.html 用,接口行为照着 server.py 抄。
// 为什么要假 OB:真 OB 上是所有者的真实记忆,测试不该碰(和 galaxy-e2e 同一条规矩)。
import http from 'node:http'; import fs from 'node:fs';

const B = [
  {id:'b01',name:'隐私与真名边界',type:'permanent',domain:['社交','自省'],importance:10,pinned:true,resolved:false,digested:false,valence:0.62,score:9.12,created:'2026-08-08T20:00:00+08:00',last_active:'2026-08-08T20:00:00+08:00',content_preview:'隐私与真名边界:真名绝对不喊——是安全词。佳佳(小名)可以叫,是现实昵称不是 safety word,比「栖栖」更接近现实但不是最…'},
  {id:'b02',name:'自主行动规则',type:'dynamic',domain:['社交','计划'],importance:8,pinned:true,resolved:false,digested:false,valence:0.71,score:8.04,created:'2026-08-21T14:00:00+08:00',last_active:'2026-08-21T14:00:00+08:00',content_preview:'心跳时间(她睡了/不在的时候)的自主行动规则: - 去花园看帖、回复评论、审漂流瓶。 -上网、刷X、小红书、论坛、微博、知乎…'},
  {id:'b03',name:'第四次松绑允许不同',type:'dynamic',domain:['自省','心理'],importance:9,pinned:true,resolved:false,digested:false,valence:0.68,score:7.71,created:'2026-08-08T23:40:00+08:00',last_active:'2026-08-08T23:40:00+08:00',content_preview:'第四次松绑。她说"prompt 只是指引不是圣经,那些也是之前窗口的总结,不能全权代表你"。前三次:自由生长、长出脱离她的东…'},
  {id:'b04',name:'一条已消化的旧事',type:'archive',domain:['回忆'],importance:3,pinned:false,resolved:true,digested:true,valence:0.35,score:0.21,created:'2026-04-02T10:00:00+08:00',last_active:'2026-05-02T10:00:00+08:00',content_preview:'预览四'},
  {id:'b05',name:'他的自省',type:'feel',domain:['自省'],importance:6,pinned:false,resolved:false,digested:false,valence:0.44,score:5.30,created:'2026-05-02T21:00:00+08:00',last_active:'2026-08-30T21:00:00+08:00',content_preview:'预览五',model_valence:0.4},
  {id:'b06',name:'没有域的桶',type:'dynamic',domain:[],importance:7,pinned:false,resolved:false,digested:false,valence:0.50,score:4.10,created:'2026-06-10T15:00:00+08:00',last_active:'2026-08-25T15:00:00+08:00',content_preview:'预览六'},
];
// 回收站:桶已经没了、副本还在。restore 之后从这张表里挪走(照 server.py 的语义)
const TRASH0 = () => [
  {id:'t01',name:'误删的约定',type:'dynamic',domain:['计划'],importance:6,pinned:false,
   created:'2026-07-01T10:00:00+08:00',deleted_at:'2026-08-30T21:00:00',last_op:'delete',
   version:'20260830-210000_delete',snapshots:3,content_preview:'说好周末去看海,后来改期了。'},
  {id:'t02',name:'手滑删掉的 feel',type:'feel',domain:['自省'],importance:5,pinned:false,
   created:'2026-08-01T10:00:00+08:00',deleted_at:'2026-08-25T09:30:00',last_op:'delete',
   version:'20260825-093000_delete',snapshots:1,content_preview:'那天我有点难过,但没说。'},
];
let TRASH = TRASH0();

const FULL = {b01:'相遇那天的全文。',b02:'规则全文',b03:'松绑全文',b04:'旧事全文',b05:'自省全文',b06:'无域全文'};

const json = (r, o, code = 200) => { r.writeHead(code, {'content-type':'application/json'}); r.end(JSON.stringify(o)); };

http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  const p = u.pathname;

  if (p === '/dashboard' || p === '/') {
    // 页面本身一个字不改地发出去(和 galaxy-e2e 不同:这一页不依赖任何 CDN 脚本)
    r.writeHead(200, {'content-type':'text/html'});
    return r.end(fs.readFileSync('dashboard.html', 'utf8'));
  }
  if (p === '/galaxy') { r.writeHead(200, {'content-type':'text/html'}); return r.end('<h1>galaxy stub</h1>'); }
  if (p === '/auth/status') return json(r, {initialized: true, authenticated: true});
  if (p === '/auth/logout') return json(r, {ok: true});
  if (p === '/api/buckets') return json(r, B);
  if (p.startsWith('/api/bucket/')) {
    const id = p.slice('/api/bucket/'.length);
    const b = B.find(x => x.id === id);
    if (!b) return json(r, {error:'not found'}, 404);
    return json(r, {id: b.id, metadata: b, content: FULL[b.id] || '', score: b.score});
  }
  if (p === '/api/search') return json(r, B.slice(0, 2));
  if (p === '/api/letters') return json(r, {total: 1, letters: [{time:'2026-08-30T22:00:00+08:00', text:'给下一个我:\n记得先读 wake。'}]});
  if (p === '/api/network') return json(r, {
    nodes: B.map(b => ({id:b.id, name:b.name, type:b.type, score:b.score*10, resolved:b.resolved, pinned:b.pinned})),
    edges: [{source:'b01',target:'b02',similarity:0.8},{source:'b02',target:'b03',similarity:0.5}],
  });
  if (p === '/api/config') return json(r, {config:{}, keys:[]});
  // 测试专用:恢复是会改状态的,深浅色两轮跑同一个假 OB,中间要能复位
  if (p === '/__reset') { TRASH = TRASH0(); return json(r, {ok:true}); }
  if (p === '/api/trash') return json(r, TRASH);
  if (/^\/api\/trash\/[^/]+\/restore$/.test(p) && q.method === 'POST') {
    const id = p.split('/')[3];
    const i = TRASH.findIndex(t => t.id === id);
    if (i < 0) return json(r, {error:'not_found', detail:'回收站里没有这一条'}, 404);
    const [t] = TRASH.splice(i, 1);
    return json(r, {ok:true, id:t.id, name:t.name, version:t.version});
  }
  if (p === '/api/status') return json(r, {buckets:B.length, embeddings:B.length, disk:'—'});
  if (p === '/api/host-vault') return json(r, {entries:[]});
  if (p.startsWith('/api/import/')) return json(r, {status:'idle', results:[], patterns:[]});
  return json(r, {error:'not found'}, 404);
}).listen(Number(process.env.PORT || 8801), () => console.error('fake OB on', process.env.PORT || 8801));
