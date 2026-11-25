/* Labeling by crop (server: /api/mapa/...?recorte=x,y,w,h). A map too large to label whole opens as a reduced,
   browse-only view; "Label a crop" turns the next click on it into a full-resolution window of SIZE px a side that
   labels like any map. Its mask pair is saved apart (labels/.../recorte-x<x>-y<y>-<w>x<h>) with the window in its
   provenance, and its browser canvas has its own key, so crops never overwrite each other or the whole map.
   "Whole map" goes back to the reduced view. viewer.js, corte.js, etiquetar.js and etiq_herramientas.js read the
   window through window.recorteVista. */
(function(){
 const SIZE=4096,$id=id=>document.getElementById(id);
 const state={crop:null,reduced:null,picking:false,down:null};
 const lam=()=>typeof group!=='undefined'&&group&&(group.catalogMeta&&group.catalogMeta.lam||group.id)||null;
 const say=t=>{if(typeof msg==='function')msg(t)};
 const redraw=()=>{if(typeof show==='function')show(true)};
 function paintButton(){const b=$id('recorteBtn');if(!b)return;
  b.hidden=!state.crop&&!state.reduced;b.classList.toggle('active',state.picking);b.setAttribute('aria-pressed',String(state.picking));
  b.textContent=state.crop?'Whole map':state.picking?'Click the map…':'Label a crop'}
 /* full-map pixel window around a click on the reduced view */
 function windowAt(p,full,reduced){const w=Math.min(SIZE,full.w),h=Math.min(SIZE,full.h),
   at=(v,size,total)=>Math.max(0,Math.min(total-size,Math.round(v-size/2)));
  return {x:at(p[0]*full.w/reduced.w,w,full.w),y:at(p[1]*full.h/reduced.h,h,full.h),ancho:w,alto:h,ancho_mapa:full.w,alto_mapa:full.h}}
 async function pick(p){const r=state.reduced;state.picking=false;paintButton();if(!r)return;
  const response=await fetch('/api/dims/'+r.url.split('?')[0].replace(/^\/api\/mapa\//,''));
  const full=response.ok?await response.json():null;
  if(!full||!(full.w>0&&full.h>0)){say('Crop unavailable: the map size could not be read');return}
  state.crop={...windowAt(p,full,r),lam:lam()};say('Loading a full-resolution crop…');redraw()}
 function init(){
  const button=document.createElement('button');button.id='recorteBtn';button.hidden=true;
  button.title='Label a full-resolution window of a map too large to label whole';
  const anchor=$id('download');if(anchor)anchor.parentNode.insertBefore(button,anchor);else document.querySelector('.toolbar').appendChild(button);
  button.addEventListener('click',()=>{if(state.crop){state.crop=null;redraw();return}state.picking=!state.picking;paintButton()});
  const vp=$id('viewport');
  if(vp){vp.addEventListener('pointerdown',e=>{state.down=[e.clientX,e.clientY]},true);
   vp.addEventListener('click',e=>{if(!state.picking||!state.down||Math.abs(e.clientX-state.down[0])+Math.abs(e.clientY-state.down[1])>4)return;
    if(typeof rp==='function')pick(rp(e))})}
  paintButton();return true}
 window.recorteVista={state,windowAt,pick,init,
  /* viewer.js: start of show(); another segment drops the crop */
  showing(){if(state.crop&&state.crop.lam!==lam())state.crop=null},
  /* viewer.js: the reduced view is on screen ({url,w,h}) or a full-resolution image is (null) */
  reduced(r){state.reduced=r||null;if(r)state.picking=state.picking&&!state.crop;paintButton()},
  /* viewer.js: a crop that fails to load falls back to the reduced view */
  failed(){if(!state.crop)return false;state.crop=null;say('The crop could not be loaded; back to the reduced view');return true},
  /* only maps of the cropped segment (other models in compare panes too), never those of other segments */
  query:frame=>state.crop&&String(frame||'').includes('/segments/'+state.crop.lam+'/')?'&recorte='+[state.crop.x,state.crop.y,state.crop.ancho,state.crop.alto].join(','):'',
  /* canvas key part, placed before |c<depth> so the depth-stripping owner check (vetoGuardado) still matches */
  key:()=>state.crop?'|r'+state.crop.x+','+state.crop.y:'',
  info:()=>state.crop?{x:state.crop.x,y:state.crop.y,ancho:state.crop.ancho,alto:state.crop.alto,ancho_mapa:state.crop.ancho_mapa,alto_mapa:state.crop.alto_mapa}:null,
  title:()=>state.crop?' · crop at '+state.crop.x+', '+state.crop.y+' of '+state.crop.ancho_mapa+' × '+state.crop.alto_mapa:'',
  ready:init()};
})();
