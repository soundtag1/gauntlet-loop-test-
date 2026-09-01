import {chromium} from 'playwright';
const b=await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
const p=await b.newPage({viewport:{width:640,height:360}});
p.on('pageerror',e=>console.log('[pageerror]',e.message));
p.on('console',m=>{ if(m.text().startsWith('[Props]')) console.log(m.text()); });
await p.goto('http://127.0.0.1:5177/index.html',{waitUntil:'load'});
await p.waitForFunction(()=>window.HARNESS&&window.HARNESS.ready,null,{timeout:180000});
console.log(JSON.stringify(await p.evaluate(()=>{
  const g=window.GAME.props.group; let tris=0, calls=0, rows=[];
  g.traverse(o=>{ if(o.isMesh||o.isLine){ calls++;
    const geo=o.geometry, n=o.isInstancedMesh?o.count:1;
    const t=geo.index?geo.index.count/3:(o.isLine? geo.attributes.position.count/2 : geo.attributes.position.count/3);
    tris+=t*n; rows.push([o.name,n,Math.round(t*n)]); }});
  return {calls,tris:Math.round(tris),rows};
}),null,1));
await b.close();
