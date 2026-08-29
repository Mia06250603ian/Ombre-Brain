// 假的 OB:只为测银河页面用,行为照着 server.py 的 /api/buckets 和 /api/bucket/{id} 抄
import http from 'node:http'; import fs from 'node:fs';
const B=[
 {id:'b01',name:'真·相遇那天',type:'permanent',domain:['恋爱'],importance:10,pinned:true,created:'2026-01-01T20:00:00+08:00',content_preview:'PLACEHOLDER'},
 {id:'b02',name:'真·搭记忆库',type:'dynamic',domain:['编程','AI'],importance:8,pinned:false,created:'2026-02-08T14:00:00+08:00',content_preview:'预览二'},
 {id:'b03',name:'真·某个晚安',type:'dynamic',domain:['日常'],importance:5,pinned:false,created:'2026-03-20T23:40:00+08:00',content_preview:'预览三'},
 {id:'b04',name:'真·旧事',type:'archive',domain:['回忆'],importance:3,pinned:false,created:'2026-04-02T10:00:00+08:00',content_preview:'预览四'},
 {id:'b05',name:'真·他的自省',type:'feel',domain:['自省'],importance:6,pinned:false,created:'2026-05-02T21:00:00+08:00',content_preview:'预览五'},
 {id:'b06',name:'真·没有域的桶',type:'dynamic',domain:[],importance:7,pinned:false,created:'2026-06-10T15:00:00+08:00',content_preview:'预览六'},
];
const FULL={b01:'相遇那天的全文。这段是为了把正文撑到 200 字以上，好让预览截断，这段是为了把正文撑到 200 字以上，好让预览截断，这段是为了把正文撑到 200 字以上，好让预览截断，这段是为了把正文撑到 200 字以上，好让预览截断，这段是为了把正文撑到 200 字以上，好让预览截断，这段是为了把正文撑到 200 字以上，好让预览截断，这段是为了把正文撑到 200 字以上，好让预览截断，这段是为了把正文撑到 200 字以上，好让预览截断，这段是为了把正文撑到 200 字以上，好让预览截断，末尾这句只有取到全文才看得见：★全文到此★',b02:'{"core_facts":["事实一","事实二"]}',b03:'晚安全文',b04:'旧事全文',b05:'自省全文',b06:'无域全文'};
const VENDOR=process.env.VENDOR;
for(const b of B) if(FULL[b.id]) b.content_preview=FULL[b.id].slice(0,200);   // 照 OB 的做法:列表只给 200 字预览
const auth=(process.env.AUTH??'1')==='1';
http.createServer((q,r)=>{
  const u=new URL(q.url,'http://x');
  if(u.pathname==='/galaxy'){
    // 测试专用:把 CDN 换成本地 three(容器里浏览器上不了网),字体那几行去掉。
    // 只在测试里替换,galaxy.html 本身一个字不改。
    let h=fs.readFileSync('galaxy.html','utf8');
    h=h.replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.160\.0\/build\/three\.module\.js/g,'/vendor/build/three.module.js')
       .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.160\.0\/examples\/jsm\//g,'/vendor/examples/jsm/')
       .replace(/<link href="https:\/\/cdn\.jsdelivr[^>]*>/g,'');
    r.writeHead(200,{'content-type':'text/html'});return r.end(h);
  }
  if(u.pathname.startsWith('/vendor/')){
    const f=VENDOR+u.pathname.slice('/vendor'.length);
    if(!fs.existsSync(f)){r.writeHead(404);return r.end();}
    r.writeHead(200,{'content-type':'text/javascript'});return r.end(fs.readFileSync(f));
  }
  if(u.pathname==='/auth/login'&&q.method==='POST'){
    let b=''; q.on('data',d=>b+=d); return q.on('end',()=>{
      let pwd=''; try{pwd=JSON.parse(b).password||''}catch{}
      if(pwd!=='test123'){r.writeHead(401,{'content-type':'application/json'});return r.end('{"error":"密码错误"}');}
      r.writeHead(200,{'content-type':'application/json','set-cookie':'ombre_session=ok; Path=/; HttpOnly'});
      r.end('{"ok":true}');
    });
  }
  const logged=(q.headers.cookie||'').includes('ombre_session=ok');
  if(!auth&&!logged){r.writeHead(401,{'content-type':'application/json'});return r.end('{"error":"Unauthorized"}');}
  if(process.env.NOAPI==='1'){r.writeHead(404);return r.end();}
  if(u.pathname==='/api/buckets'){r.writeHead(200,{'content-type':'application/json'});return r.end(JSON.stringify(B));}
  const m=u.pathname.match(/^\/api\/bucket\/(.+)$/);
  if(m){const id=decodeURIComponent(m[1]);if(!FULL[id]){r.writeHead(404);return r.end('{}');}
    r.writeHead(200,{'content-type':'application/json'});return r.end(JSON.stringify({id,metadata:{},content:FULL[id]}));}
  r.writeHead(404); r.end();
}).listen(+process.env.PORT||8791, ()=>console.error('fake-ob on', process.env.PORT||8791));
