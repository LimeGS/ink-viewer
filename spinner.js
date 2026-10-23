/* ===== loading spinners with a seconds counter (14-sep-2026) =====
   One big spinner over the viewport while the main image loads, and one per pane in the model
   mosaic, each with the elapsed seconds in the middle. Hooks the existing signals only: the
   'Loading image…' notice + the <img> load/error events of the stage and of every pane. */
(function(){
 const st=document.createElement('style');st.textContent=
  '.spin[hidden]{display:none!important}.spin{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:5}'+
  '.spin .ring{position:relative;width:96px;height:96px;border-radius:50%;border:6px solid #2b3a4b;border-top-color:#64ddd1;animation:spin 1s linear infinite;box-shadow:0 0 0 6px #090e14aa}'+
  '.spin .sec{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:700 22px ui-monospace,monospace;color:#bff5f0;text-shadow:0 0 6px #000}'+
  '.spin.chico .ring{width:64px;height:64px;border-width:5px}.spin.chico .sec{font-size:16px}'+
  '@keyframes spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.spin .ring{animation-duration:3s}}';
 document.head.append(st);
 function crear(host,chico,img){const d=document.createElement('div');d.className='spin'+(chico?' chico':'');d.hidden=true;
  const r=document.createElement('div');r.className='ring';const s=document.createElement('div');s.className='sec';s.textContent='0 s';d.append(r,s);host.append(d);
  let t0=0,timer=null;
  const listo=()=>img?(!img.getAttribute('src')||(img.complete&&img.naturalWidth>0)):false;   // no img: the caller decides
  const off=()=>{if(d.hidden)return;clearInterval(timer);timer=null;d.hidden=true};
  const on=()=>{if(listo())return off();if(!d.hidden)return;t0=performance.now();d.hidden=false;s.textContent='0 s';
   timer=setInterval(()=>{if(listo())return off();s.textContent=Math.round((performance.now()-t0)/1000)+' s'},250)};
  if(img){img.addEventListener('load',off);img.addEventListener('error',off);
   new MutationObserver(()=>{listo()?off():on()}).observe(img,{attributes:true,attributeFilter:['src']})}
  return{on,off,el:d}}
 /* main image: the viewer writes 'Loading image…' into #notice and clears it on load */
 const vp=document.getElementById('viewport'),notice=document.getElementById('notice'),im=document.getElementById('map')||document.querySelector('#stage img');
 if(vp&&notice){
  /* the main image keeps its old src while a hidden loader downloads the new one, so the <img>
     never looks "loading": the viewer's own 'Loading…' notice is the signal. Self-healing: the
     tick turns it off as soon as the notice no longer says loading, or in the mosaic. */
  const S=crear(vp,false,null);
  const enMosaico=()=>typeof PANES!=='undefined'&&PANES&&PANES.length>1;
  /* the viewer hides the notice on load but leaves its text as 'Loading image…' (and when the new
     src equals the old one the <img> fires no load event at all): a hidden notice is never 'loading' */
  const cargando=()=>!notice.hidden&&/loading/i.test(notice.textContent)&&!enMosaico();
  new MutationObserver(()=>{cargando()?S.on():S.off()}).observe(notice,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['hidden']});
  /* a new image landing on the stage ends the wait no matter what the notice says: the preview
     fallback path of the viewer can leave 'Loading image…' behind when the _lo previews are missing */
  if(im){im.addEventListener('load',()=>{S.off();if(/loading/i.test(notice.textContent))notice.textContent=''})}
  setInterval(()=>{if(!cargando())S.off()},300)}
 /* panes: each <img> gets its own spinner, started when its src changes and it is not complete yet */
 const panes=document.getElementById('panes');
 if(panes){const vistos=new WeakMap();
  function armar(g){if(vistos.has(g))return;vistos.set(g,crear(g.parentElement,true,g))}
  new MutationObserver(()=>panes.querySelectorAll('.pane img').forEach(armar)).observe(panes,{childList:true,subtree:true});
  panes.querySelectorAll('.pane img').forEach(armar)}
})();
