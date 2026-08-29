// 测试专用的一层薄代理:把请求原样转给真 OB,只做两件事——
//   ① /galaxy 的 HTML 里把 three 的 CDN 地址换成本地(容器里浏览器上不了网)
//   ② /vendor/* 发本地那份 three
// 除此之外一个字节都不改(cookie、状态码、头全透传),所以测的仍是真 OB 的行为。
import http from 'node:http'; import fs from 'node:fs';
const OB=process.env.OB||'http://127.0.0.1:8801', VENDOR=process.env.VENDOR;
http.createServer((q,r)=>{
  if(q.url.startsWith('/vendor/')){
    const f=VENDOR+q.url.slice('/vendor'.length);
    if(!fs.existsSync(f)){r.writeHead(404);return r.end();}
    r.writeHead(200,{'content-type':'text/javascript'});return r.end(fs.readFileSync(f));
  }
  const body=[]; q.on('data',d=>body.push(d)); q.on('end',()=>{
    const u=new URL(q.url,OB);
    const p=http.request({hostname:u.hostname,port:u.port,path:u.pathname+u.search,
      method:q.method,headers:{...q.headers,host:u.host}},res=>{
      const buf=[]; res.on('data',d=>buf.push(d)); res.on('end',()=>{
        let out=Buffer.concat(buf);
        if(q.url.startsWith('/galaxy')){
          out=Buffer.from(out.toString('utf8')
            .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.160\.0\/build\/three\.module\.js/g,'/vendor/build/three.module.js')
            .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.160\.0\/examples\/jsm\//g,'/vendor/examples/jsm/')
            .replace(/<link href="https:\/\/cdn\.jsdelivr[^>]*>/g,''));
          const h={...res.headers}; delete h['content-length'];
          r.writeHead(res.statusCode,h); return r.end(out);
        }
        r.writeHead(res.statusCode,res.headers); r.end(out);
      });
    });
    p.on('error',()=>{r.writeHead(502);r.end()});
    if(body.length)p.write(Buffer.concat(body));
    p.end();
  });
}).listen(+process.env.PORT||8803,()=>console.error('proxy →',OB));
