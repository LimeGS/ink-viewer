/* ===== Label extras (12-Sep-2026): user-chosen display colours for ink / no-ink =====
   The stored mask keeps its encoding (green = ink, red = no ink; etiquetar.js classifies by G > R), so the colour
   choice is DISPLAY ONLY: an SVG feColorMatrix maps the two stored colours to the two chosen ones on #mask and on
   the per-pane mirrors. Persisted in localStorage. */
(function(){
 const $=id=>document.getElementById(id);const KEY='vesuvius.etiq.colores';const G=[60,220,90],R=[230,60,60];   // stored colours (COLOR in etiquetar.js)
 let C={tinta:'#3cdc5a',no:'#e63c3c'};try{Object.assign(C,JSON.parse(localStorage.getItem(KEY)||'{}'))}catch(e){}
 const NS='http://www.w3.org/2000/svg';const svg=document.querySelector('svg[aria-hidden]')||document.querySelector('svg');
 const f=document.createElementNS(NS,'filter');f.id='maskRecolor';f.setAttribute('color-interpolation-filters','sRGB');const cm=document.createElementNS(NS,'feColorMatrix');cm.setAttribute('type','matrix');f.append(cm);
 (svg.querySelector('defs')||svg).append(f);
 const st=document.createElement('style');st.textContent='#panel .fila{display:flex;flex-wrap:wrap;gap:4px}#panel .fila button{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;padding:4px 6px}#panel .capaRow span{min-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}#mask,.pane .pm{filter:url(#maskRecolor)}#etiqColores{display:flex;gap:10px;align-items:center;margin:4px 0}#etiqColores input{width:28px;height:22px;padding:0;border:1px solid #344254;background:#0b1016}';document.head.append(st);
 const hex=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16));
 function matriz(){const A=hex(C.tinta),B=hex(C.no);const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];const gg=dot(G,G),gr=dot(G,R),rr=dot(R,R),det=gg*rr-gr*gr;
  // u,v in span{G,R}: u·G=1,u·R=0 ; v·G=0,v·R=1  -> M = A u^T + B v^T maps G->A, R->B
  const u=[0,1,2].map(i=>(rr*G[i]-gr*R[i])/det),v=[0,1,2].map(i=>(-gr*G[i]+gg*R[i])/det);
  const M=[0,1,2].map(i=>[0,1,2].map(j=>A[i]*u[j]+B[i]*v[j]));
  cm.setAttribute('values',M.map(r=>r.map(x=>x.toFixed(4)).join(' ')+' 0 0').join(' ')+' 0 0 0 1 0');
  const bt=$('mTinta'),bn=$('mNo');if(bt)bt.style.background=C.tinta;if(bn)bn.style.background=C.no;if(bt)bt.style.color='#000';if(bn)bn.style.color='#000'}
 const fila=document.createElement('div');fila.id='etiqColores';fila.innerHTML='<span style="opacity:.6;font-size:11px">colours</span> <label title="Display colour for ink">ink <input type="color" id="colTinta"></label> <label title="Display colour for no-ink">no ink <input type="color" id="colNo"></label> <button id="colReset" title="Back to green / red">↺</button>';
 const ancla=$('mTinta')&&$('mTinta').closest('.fila');if(ancla)ancla.after(fila);else ($('panel')||document.body).append(fila);
 $('colTinta').value=C.tinta;$('colNo').value=C.no;
 const guardar=()=>{localStorage.setItem(KEY,JSON.stringify(C));matriz()};
 $('colTinta').oninput=e=>{C.tinta=e.target.value;guardar()};$('colNo').oninput=e=>{C.no=e.target.value;guardar()};
 $('colReset').onclick=()=>{C={tinta:'#3cdc5a',no:'#e63c3c'};$('colTinta').value=C.tinta;$('colNo').value=C.no;guardar()};
 matriz();
 /* masks made before 12-sep were keyed by sheet only; the working key is now sheet|c<N>. If the new key has nothing,
    fall back to the old per-sheet mask (once per depth, it is then saved under the new key). */
 if(typeof restaurar==='function'){const restaurar0=restaurar;
  /* guarded restore: a slow IndexedDB read from a depth you already left must never draw on the next depth's canvas */
  restaurar=async function(nombre){if(await canonicalMaskMode())return;const destino=destinoMascara();const b0=await idb('readonly',s=>s.get(nombre),destino.database).catch(()=>null);if(!destinoVigente(destino)||H.nombre!==nombre)return;
   const dibujarLocal=async b=>{const bm=await createImageBitmap(b);try{if(!destinoVigente(destino)||!mascaraVacia())return false;
    if(bm.width!==destino.w||bm.height!==destino.h){msg('Stored mask dimensions differ: nothing restored');return false}mctx.drawImage(bm,0,0);dirty=true;return true}finally{if(bm.close)bm.close()}};
   if(b0)await dibujarLocal(b0);
   if(!destinoVigente(destino))return;
   if(!mascaraVacia())return;
   /* 15-sep: a mask painted on a model view whose gallery was not yet recognised as this sheet (e.g. *_r7j_t before the regex
      change) was saved under the gallery id: try those keys and migrate the first hit to the sheet key */
   if(typeof window.clavesLegado==='function'){for(const k of window.clavesLegado(nombre)){const bk=await idb('readonly',s=>s.get(k),destino.database).catch(()=>null);if(!bk)continue;if(!H||H.nombre!==nombre)return;
     if(!await dibujarLocal(bk))return;pendiente=true;if(typeof autoguardar==='function')autoguardar();
     if(typeof msg==='function')msg('mask recovered from '+k+' (saved again under this sheet)');return}}
   const viejo=nombre.replace(/\|c[^|]*$/,'');if(viejo===nombre)return;
   const b=await idb('readonly',s=>s.get(viejo),destino.database).catch(()=>null);if(!b||!H||H.nombre!==nombre)return;
   if(!await dibujarLocal(b))return;pendiente=true;if(typeof autoguardar==='function')autoguardar();if(typeof espejarMascara==='function')espejarMascara();
   await idb('readwrite',s=>s.delete(viejo),destino.database).catch(()=>{});   /* one-time migration: the old per-sheet mask now lives ONLY at this depth */
   if(typeof msg==='function')msg('mask restored from the per-sheet label ('+viejo+') into this depth')}}
/* ===== PERF (12-sep): the label core copied the WHOLE 20-Mpx mask on every stroke start (getImageData 80 MB),
    counted every pixel after every stroke, and the viewer PNG-encoded the mask into localStorage. Replaced by
    GPU copies (drawImage) and 1/4-scale counts. Same behaviour, ~10x less main-thread time. ===== */
 let prevC=null,cntC=null;
 const lienzo=(ref,w,h)=>{if(!ref||ref.width!==w||ref.height!==h){ref=document.createElement('canvas');ref.width=w;ref.height=h}return ref};
 if(typeof prepararUndo==='function'){
  prepararUndo=function(){if(!mctx)return;prevC=lienzo(prevC,mask.width,mask.height);const g=prevC.getContext('2d',{willReadFrequently:true});g.clearRect(0,0,mask.width,mask.height);g.drawImage(mask,0,0);previo=true};
  guardarUndo=function(){if(!previo||!bbox)return;const b=[Math.max(0,bbox[0]),Math.max(0,bbox[1]),Math.min(H.w,bbox[2]),Math.min(H.h,bbox[3])];const w=b[2]-b[0],h=b[3]-b[1];
   if(w<=0||h<=0){previo=null;return}const antes=prevC.getContext('2d',{willReadFrequently:true}).getImageData(b[0],b[1],w,h);undoS.push({b,antes});if(undoS.length>20)undoS.shift();previo=null};
  contar=function(){clearTimeout(tCont);tCont=setTimeout(()=>{const el=document.querySelector('#stats');if(!el||!H||!mctx)return;const f=4,w=Math.ceil(H.w/f),h=Math.ceil(H.h/f);cntC=lienzo(cntC,w,h);
   const g=cntC.getContext('2d',{willReadFrequently:true});g.clearRect(0,0,w,h);g.drawImage(mask,0,0,w,h);const d=g.getImageData(0,0,w,h).data;let t=0,n=0;
   for(let i=0;i<d.length;i+=4){if(d[i+3]<128)continue;d[i+1]>d[i]?t++:n++}t*=f*f;n*=f*f;const cm2=p=>H.um_px?'  '+(p*(H.um_px*1e-4)**2).toFixed(3)+' cm2':'';
   el.textContent=`${H.nombre}  ${H.w}x${H.h}\nink     ~${t.toLocaleString()} px${cm2(t)}\nno ink   ~${n.toLocaleString()} px${cm2(n)}\nunlabelled ~${(H.w*H.h-t-n).toLocaleString()} px`},600)}}
 window.mascaraVacia=function(){if(!mctx||!mask.width)return true;const w=64,h=64;cntC=lienzo(cntC,w,h);const g=cntC.getContext('2d',{willReadFrequently:true});g.clearRect(0,0,w,h);g.drawImage(mask,0,0,w,h);const d=g.getImageData(0,0,w,h).data;for(let i=3;i<d.length;i+=4)if(d[i]>0)return false;return true};
/* ===== import a PROPOSED mask (tutorial 5: predictions -> conservative labels -> human edit) for the current depth ===== */
 const bi=document.createElement('button');bi.id='impProp';bi.textContent='import proposal';bi.title='Load the automatic proposal for this lamina and depth from the selected source: ink where strokes are repeatable, no-ink on clean background. Then edit with the brush and save.';
 bi.onclick=async()=>{const destino=destinoMascara();if(!destino||!mascaraLista()){msg('Wait for the full-resolution image and mask');return}
  const lam=destino.grupo?(typeof meta==='function'?meta(destino.grupo).lam:destino.grupo.id):null;const seg=(typeof segId==='function')?segId(lam):lam;const cen=(destino.nombre.match(/\|c(.+)$/)||[])[1];
  const c=cen==='max'?'cmax':('c'+(cen>=0?'+':'-')+String(Math.abs(+cen)).padStart(2,'0'));bi.disabled=true;bi.textContent='loading...';
  try{const ruta=typeof segRuta==='function'&&destino.grupo?segRuta(destino.grupo):null;
   const par=await obtenerParMascara(seg,cen,ruta&&ruta.base,true);
   const out=await leerParMascara(par.blobs,destino.w,destino.h);
   if(!destinoVigente(destino))throw new Error('mask changed during loading');
   if(!await confirmarMetadatosMascara(par.blobs,destino.info,'Proposal import'))return;
   if(!destinoVigente(destino))throw new Error('mask changed during loading');
   conservarEdiciones(out,destino.ctx.getImageData(0,0,destino.w,destino.h));
   if(reemplazarMascara(out,destino))msg('proposal imported for '+c+' (all existing ink and non-ink strokes kept; Ctrl+Z undoes)')}
  catch(e){msg('no proposal for this depth ('+String(e).slice(0,60)+')');bi.textContent='no proposal for this depth';setTimeout(()=>{bi.textContent='import proposal'},3000)}finally{bi.disabled=false}};
 const anc=$('mTinta')&&$('mTinta').closest('.fila');if(anc)anc.after(bi);
 /* PROPS_ETIQ: which laminae have proposals; the button says so instead of silently doing nothing */
 let PROPS_E=new Set();const refrescarProp=()=>{const lam=(typeof group!=='undefined'&&group)?(typeof meta==='function'?meta(group).lam:group.id):null;const seg=lam&&(typeof segId==='function')?segId(lam):lam;
  const hay=seg&&(PROPS_E.has(seg)||PROPS_E.has(lam));bi.disabled=!hay;bi.textContent=hay?'import proposal':'no proposal for this lamina';bi.title=hay?'Load the automatic proposal for this depth (ink where strokes are repeatable, no-ink on clean background), then edit and save.':'Proposals exist only for laminae marked 📋 in the explorer'};
 fetch('/api/propuestas',{cache:'no-store'}).then(r=>r.ok?r.json():[]).then(l=>{PROPS_E=new Set(l);refrescarProp()}).catch(()=>{});
 new MutationObserver(refrescarProp).observe($('map'),{attributes:true,attributeFilter:['src']});
 /* auto 'save to S3' 20 s after the last stroke (the official pair goes to Virginia without remembering the button) */
 let autoS3=0;const vp=$('viewport');
 vp&&vp.addEventListener('pointerup',()=>{if(typeof etiqOn==='undefined'||!etiqOn)return;clearTimeout(autoS3);autoS3=setTimeout(()=>{const b=$('guardarMascaraServidor')||[...document.querySelectorAll('#panel button')].find(x=>/^save to S3$|^saving\.\.\.$|^guardar \(work-3\)$|^guardando…$/.test(x.textContent));if(b&&!b.disabled){b.click();if(typeof s3Pend!=='undefined')s3Pend=false}},20000)});
})();
