/* Cross-section (server: ink_viewer/server/corte.py). The "Cross-section" button turns on a mode where a click on
   the map opens a CT slice through that point with the segment's mesh drawn on it: a curve that follows the layers
   sits on the sheet, one that cuts across them jumped to another sheet. The map must name its CT volume
   (-volume-<id>- in the catalog name). Uses viewer.js's rp() for the original-grid point (zoom, panes and flips). */
(function(){
 const $id=id=>document.getElementById(id);
 const state={on:false,down:null,last:null};
 const meta=()=>typeof group!=='undefined'&&group?group:null;
 const frameOf=g=>g&&(g.maximum||Object.values(g.frames||{})[0])||'';
 const volumeOf=g=>{const m=/-volume-(\d{14})-/.exec(frameOf(g));return m?m[1]:null};
 const scanOf=g=>{const m=/-(\d+(?:\.\d+)?)um-(\d+(?:\.\d+)?)m-(\d+)keV-volume-/.exec(frameOf(g));return m?{res:m[1],dist:m[2],kev:m[3]}:{}};
 const say=text=>{$id('corteEstado').textContent=text};

 function init(){
  const button=document.createElement('button');
  button.id='corteBtn';button.textContent='Cross-section';button.setAttribute('aria-pressed','false');
  button.title='Click a point on the map to see the CT slice through it with the mesh drawn on top';
  const anchor=$id('download');
  if(anchor)anchor.parentNode.insertBefore(button,anchor);else document.querySelector('.toolbar').appendChild(button);
  const box=document.createElement('dialog');box.id='corteDlg';
  box.innerHTML='<form method="dialog"><h3>Cross-section</h3><p id="corteEstado" role="status"></p>'
   +'<img id="corteImg" alt="CT slice through the point, mesh in orange, point in cyan" hidden>'
   +'<menu><button value="close">Close</button></menu></form>';
  document.body.appendChild(box);
  button.addEventListener('click',()=>alternar(!state.on));
  const vp=$id('viewport');
  if(vp){
   vp.addEventListener('pointerdown',e=>{state.down=[e.clientX,e.clientY]},true);
   vp.addEventListener('click',e=>{if(!state.on||!state.down)return;
    if(Math.abs(e.clientX-state.down[0])+Math.abs(e.clientY-state.down[1])>4)return;   // a drag, not a click
    if(typeof rp==='function')mostrar(rp(e))});
  }
  return true;
 }

 function alternar(on){
  state.on=on;const b=$id('corteBtn');b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));
 }

 async function mostrar(p){
  const g=meta(),box=$id('corteDlg'),img=$id('corteImg');
  img.hidden=true;if(!box.open)box.show();
  const m=g&&g.catalogMeta,volume=volumeOf(g);
  if(!m||!m.lam||!m.scroll){say('Open a catalog segment first.');return}
  if(!volume){say('This map does not name its CT volume, so the mesh and CT cannot be matched.');return}
  const crop=globalThis.recorteVista&&globalThis.recorteVista.info(),[u,v]=p.map((n,i)=>Math.round(n)+(crop?[crop.x,crop.y][i]:0));   // a crop maps back to the whole map
  const q=new URLSearchParams({rollo:m.scroll,segmento:m.lam,volumen:volume,u,v});
  if(typeof curW!=='undefined'&&curW){q.set('w',crop?crop.ancho_mapa:curW);q.set('h',crop?crop.alto_mapa:curH)}
  for(const [k,val] of Object.entries(scanOf(g)))q.set(k,val);   // lets sources without listings (HTTP) be read
  say('Reading the CT around ('+u+', '+v+')…');
  const response=await fetch('/api/corte?'+q);
  if(!response.ok){const j=await response.json().catch(()=>({}));say('No cross-section: '+(j.error||response.status));return}
  const info=JSON.parse(response.headers.get('X-Corte')||'{}');
  img.src=URL.createObjectURL(await response.blob());img.hidden=false;
  state.last=info;
  say('Map ('+u+', '+v+') → CT z '+Math.round(info.z)+'. Orange: the mesh in this slice; cyan: the point.'+(info.proportional?' Map-to-mesh mapping is proportional (sizes did not match the mesh scale).':''));
 }

 window.corteVista={init,alternar,mostrar,volumeOf,scanOf,state,ready:init()};
})();
