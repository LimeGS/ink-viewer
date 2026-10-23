/* ===== v5 per-depth bar under the depth slider (12-Sep-2026) =====
   Informational only: one cell per depth centre, coloured by the lamina's v5 legibility at that depth
   (legibilidad.json por_centro; max over faces). White outline = the depth being viewed. */
(function(){
 const $=id=>document.getElementById(id);const wrap=$('depthWrap'),sl=$('depth'),im=$('map');
 if(!wrap||!sl||!im||typeof LEG==='undefined'){console.warn('hist_v5: viewer globals missing');return}
 const st=document.createElement('style');st.textContent='#depthWrap{display:flex;flex-direction:column;gap:3px}#v5hist{display:flex;gap:1px;height:8px;cursor:default}#v5hist i{flex:1;border-radius:1px;background:#182230}#v5hist i.cur{outline:1px solid #fff;outline-offset:-1px}';
 document.head.append(st);
 const bar=document.createElement('div');bar.id='v5hist';bar.title='v5 legibility per depth (informational, not clickable)';wrap.append(bar);
 const lamOf=id=>id.replace(/__base\d+$/,'').replace(/__(fwd|rev)$/,'');
 const mix=(p,q,k)=>p.map((v,i)=>Math.round(v+(q[i]-v)*k));
 const col=s=>{if(s==null)return '#182230';const t=Math.max(0,Math.min(1,s/0.6));const a=[16,35,58],b=[31,138,112],c=[255,209,102];const r=t<.5?mix(a,b,t*2):mix(b,c,(t-.5)*2);return 'rgb('+r.join(',')+')'};
 function pintar(){if(typeof group==='undefined'||!group)return;
  const name=group.catalogMeta?.lam||lamOf(group.id);
  const record=LEG[group.scroll+'/'+name]||LEG[name]||{};
  const score=group.catalogMeta?record.por_modelo?.[group.catalogMeta.modelo]:record;
  const pc={...(score?.por_centro||{})},centre=score?.mejor_centro;
  if(centre!=null&&centre!==''&&Number.isInteger(+centre)&&Number.isFinite(score?.max)){
   const key=(+centre<0?'-':'+')+String(Math.abs(+centre)).padStart(2,'0');
   if(!(key in pc))pc[key]=score.max;
  }
  const cur=+sl.value;bar.innerHTML='';
  for(const c of Object.keys(group.frames).map(Number).sort((a,b)=>a-b)){   /* the lamina's real centres (some step by 2) */const k=(c<0?'-':'+')+String(Math.abs(c)).padStart(2,'0');const s=pc[k];const i=document.createElement('i');i.style.background=col(s);
   i.title='c'+(c>0?'+':'')+c+(s!=null?' · v5 '+(+s).toFixed(3):' · no score');if(c===cur)i.classList.add('cur');bar.append(i)}}
 window.v5HistRepintar=pintar;
 new MutationObserver(pintar).observe(im,{attributes:true,attributeFilter:['src']});sl.addEventListener('input',pintar);pintar();
})();
