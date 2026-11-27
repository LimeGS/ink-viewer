/* ===== etiq_2509 (25-sep-2026): corregir a mano las mascaras AUTOMATICAS de las laminas de entrenamiento de r3b/r3f =====
   Corridas del catalogo <seg>_{base,r3f,r3b}_etiq (campana_1447_20260924): BASE / r3f / r3b sobre el render de la cadena
   r3b_vc3d (VC3D 1 px = 1 voxel, 36 capas, orientacion de lectura), la MISMA grilla que las propuestas v3 regeneradas ahi.
   Su lamina de etiquetas es '<seg>__vc3d_lectura' y no el segmento pelado: el segmento ya tiene propuestas y etiquetas en
   OTRA grilla (render_sv del 13-sep: otra escala y otra orientacion) y compartir carpeta las mezclaria.
     automatica (el visor NUNCA la escribe)
       catalog/<rollo>/segments/<seg>/labels/por-profundidad/_propuestas/<seg>__vc3d_lectura/c±NN/<seg>__vc3d_lectura_{inklabels,supervision_mask}.png
     corregida (la escribe el visor al pintar: 'save to S3', 20 s despues del ultimo trazo; el proxy la pone en work-3)
       catalog/<rollo>/segments/<seg>/labels/por-profundidad/<seg>__vc3d_lectura/c±NN/...   la de trabajo, por profundidad
       catalog/<rollo>/segments/<seg>/labels/etiquetas/<seg>__vc3d_lectura/...              la ultima guardada
       catalog/<rollo>/segments/<seg>/labels/.history/...                                     cada version reemplazada
     (<rollo> = la muestra de la ruta del mapa; en campana_1447_20260924, PHerc1447)
   Lo que agrega (solo a esas corridas; el resto del visor no cambia):
   1. las tres corridas de una lamina comparten el lienzo de la mascara (IndexedDB '<seg>__vc3d_lectura|c<N>');
   2. al abrir una profundidad con el lienzo vacio carga la corregida de work-3 si existe; si no, la automatica. Cargar no
      guarda nada: la corregida nace con el primer trazo;
   3. 'import proposal' queda deshabilitado ahi (la automatica ya se carga sola; re-importarla sobre una correccion
      volveria a pintar la tinta borrada);
   4. marca r3f_etiq / r3b_etiq como entrenados con estas laminas (aviso CONTAMINATED y '⚠ training' del visor);
   5. guardado: el visor sube el lienzo 20 s despues de CUALQUIER pointerup en modo etiqueta (tambien al mover la vista con el
      boton derecho) y, al cambiar de lamina con trazos pendientes, sube el lienzo viejo con el nombre de la lamina nueva.
      Para estas laminas se corta en fetch: no sube una profundidad que nadie edito (no hay entrada en IndexedDB ni trazo en
      esta sesion: la automatica no se copia como «corregida») ni un PNG con otras medidas que las de la lamina;
   6. el par debe ser PNG opaco binario de la grilla exacta; una máscara inválida bloquea la carga. */
(function(){
 const SUF='__vc3d_lectura',RX=/_etiq$/;
 const EDITADO={};   /* clave del lienzo -> hubo un trazo/edicion en esta sesion */
 const rutaSeg=g=>{for(const f of Object.values(g.frames||{})){const m=/catalog\/([^/]+)\/segments\/([^/]+)\/ink-detection\//.exec(f);if(m)return{seg:m[2],base:m[1]+'/segments/'+m[2],rollo:m[1]}}return null};
 const nuestras=[];   /* Recognize every scroll before building the multi-scroll explorer. */
 if(typeof manifest!=='undefined')for(const g of manifest){const cm=g.catalogMeta;if(!cm||!RX.test(cm.modelo||''))continue;
  const s=rutaSeg(g);if(!s)continue;cm.lam=s.seg+SUF;cm.etiq2509=s;nuestras.push(g)}
 const esNuestra=g=>!!(g&&g.catalogMeta&&g.catalogMeta.etiq2509);
 const claveEstado=nombre=>(typeof H!=='undefined'&&H?.scroll||window.ROLLO)+'|'+nombre;
 const ESTADO={};   /* clave del lienzo -> de donde salio la mascara al abrir */
 window.ETIQ2509={SUF,corridas:nuestras.map(g=>g.id),estado:ESTADO};
 const TXT={auto:'opened from the AUTOMATIC v3 proposal · strokes are saved as the corrected version',
            corr:'opened from your CORRECTED version in annotation storage · new strokes replace it, the old version stays in history',
            local:'opened from this browser (IndexedDB)',nada:'no mask at this depth (only the loaded depths have one)'};
 function marca(){let m=document.getElementById('etiqMarca');const vp=document.getElementById('viewport');if(!vp)return;
  if(!m){m=document.createElement('div');m.id='etiqMarca';m.setAttribute('role','status');
   m.style.cssText='position:absolute;left:12px;top:42px;z-index:4;pointer-events:none;background:#12324ae6;border:1px solid #4aa3d9;border-radius:6px;padding:2px 8px;font:12px ui-monospace,monospace;color:#cfe8f7;white-space:nowrap';vp.append(m)}
  const e=(typeof H!=='undefined'&&H)?ESTADO[claveEstado(H.nombre)]:null,on=typeof etiqOn!=='undefined'&&etiqOn&&esNuestra(typeof group!=='undefined'?group:null)&&e;
  m.hidden=!on;m.style.display=on?'block':'none';if(on)m.textContent='mask '+(cen(H.nombre)||'')+': '+TXT[e]}
 function cen(nombre){const m=/\|c(-?\d+)$/.exec(nombre||'');if(!m)return null;const c=+m[1];return 'c'+(c<0?'-':'+')+String(Math.abs(c)).padStart(2,'0')}
 async function par(lam,c,base,prop){
  try{return await obtenerParMascara(lam,Number(c.slice(1)),base,prop)}
  catch(e){if(/HTTP (404|204)$/.test(e.message))return null;throw e}}
 async function dibujar(p,destino){
  const out=await leerParMascara(p.blobs,destino.w,destino.h);
  if(!destinoVigente(destino)||!mascaraVacia())return null;
  if(!await confirmarMetadatosMascara(p.blobs,destino.info,'Automatic mask load'))return null;
  if(!destinoVigente(destino)||!mascaraVacia())return null;
  const image=destino.ctx.createImageData(destino.w,destino.h);image.data.set(out.data);
  let ni=0,nn=0;for(let i=0;i<out.data.length;i+=4)if(out.data[i+3]===255){if(esTinta(out.data,i))ni++;else nn++}
  destino.ctx.putImageData(image,0,0);dirty=true;
  if(typeof contar==='function')contar();if(typeof espejarMascara==='function')espejarMascara();
  return [ni,nn]}
 window.visorAliasCorridas=()=>{
  if(typeof alias!=='undefined')for(const g of nuestras)alias[g.id]={nombre:g.catalogMeta.lam,get w(){return curW},get h(){return curH},get um_px(){return window.visorUmPorPixel?visorUmPorPixel(g):null},capas:[]};
  if(typeof MEDIDO!=='undefined'&&MEDIDO)for(const g of nuestras.filter(g=>visorRolloDe(g)===MEDIDAS_DE)){
   for(const m of ['r3f_etiq','r3b_etiq']){CONTAM[m]=CONTAM[m]||new Set();CONTAM[m].add(g.catalogMeta.lam)}
   CONTAM_TXT[g.catalogMeta.lam]='TRAINING SHEET · r3f and r3b were trained on this sheet with its AUTOMATIC mask (the one being corrected): their maps here repeat what they learned. BASE never saw '+MEDIDAS_DE+'.';
  }
 };
 document.addEventListener(window.VISOR_STATIC?.readyEvent || 'DOMContentLoaded',()=>{
  /* 1. un lienzo por lamina y profundidad para las tres corridas (trasFrame: clave = hoja.nombre + '|c' + centro) */
  window.visorAliasCorridas();
  /* 2. carga de work-3 cuando el lienzo abre vacio */
  if(typeof restaurar==='function'){const r0=restaurar;
   restaurar=async function(nombre){
    const destino=destinoMascara();
    await r0(nombre);
    if(!destinoVigente(destino)||H.nombre!==nombre||!esNuestra(group)||nombre.split('|')[0]!==group.catalogMeta.lam)return;
    if(!mascaraVacia()){ESTADO[claveEstado(nombre)]=ESTADO[claveEstado(nombre)]||'local';marca();return}
    const c=cen(nombre);if(!c){ESTADO[claveEstado(nombre)]='nada';marca();return}
    const {base}=group.catalogMeta.etiq2509,lam=group.catalogMeta.lam;
    for(const [prop,e] of [[false,'corr'],[true,'auto']]){
     try{const p=await par(lam,c,base,prop);if(!destinoVigente(destino))return;
      if(!p)continue;if(!mascaraVacia())return;
      const n=await dibujar(p,destino);if(!n)return;
      ESTADO[claveEstado(nombre)]=e;marca();msg(c+': '+TXT[e]+' — ink '+n[0].toLocaleString()+' px, no-ink '+n[1].toLocaleString()+' px');return}
     catch(err){msg('Mask load BLOCKED: '+err.message);return}}
    ESTADO[claveEstado(nombre)]='nada';marca()}}
  /* 3. 'import proposal' fuera de juego en estas corridas */
  const bi=document.getElementById('impProp'),mapa=document.getElementById('map');
  const boton=()=>{if(bi&&esNuestra(group)){bi.disabled=true;bi.textContent='automatic mask loads on open';bi.title='These runs load the automatic v3 proposal (or your corrected version) by themselves when a depth opens. Importing again would re-paint the ink you erased.'}marca()};
  if(mapa)new MutationObserver(boton).observe(mapa,{attributes:true,attributeFilter:['src']});
  setTimeout(boton,1500);setInterval(marca,1000);
  /* 4. r3f y r3b se entrenaron con la mascara automatica de estas laminas. 25-sep generalizar-por-rollo: eso se sabe de las
     corridas _etiq de campana_1447_20260924, o sea solo en el visor del rollo con las medidas de index.html (MEDIDO); en
     otro rollo unas _etiq no traen esa marca (no se sabe con que se entrenaron: no se afirma nada). */
  /* 5. guardas de guardado para estas laminas (solo POST /api/mascara/<seg>__vc3d_lectura/...png; lo demas pasa igual) */
  const vp=document.getElementById('viewport');
  const marcar=()=>{try{if(H&&H.nombre&&H.nombre.split('|')[0].endsWith(SUF))EDITADO[claveEstado(H.nombre)]=true}catch(e){}};
  if(vp){vp.addEventListener('pointerdown',e=>{if(typeof etiqOn!=='undefined'&&etiqOn&&e.button===0&&!(typeof espacio!=='undefined'&&espacio)&&!e.target.closest('#panel'))marcar()},true)}
  if(typeof autoguardar==='function'){const ag0=autoguardar;autoguardar=function(){marcar();return ag0.apply(this,arguments)}}
  const f0=window.fetch.bind(window);
  window.fetch=async function(u,o){
   try{const url=typeof u==='string'?u:(u&&u.url)||'';const m=/\/api\/mascara\/([^/?]+)\/[^/?]+\.png(?:\?|$)/.exec(url);
    if(m&&o&&String(o.method||'').toUpperCase()==='POST'){const lam=decodeURIComponent(m[1]);
     if(lam.endsWith(SUF)){const seg=lam.slice(0,-SUF.length),q=new URLSearchParams(url.split('?')[1]||''),cq=q.get('c');
      const clave=lam+'|c'+(cq==null||cq===''?'max':cq);
      const owner=window.mascaraDueno,dimensions=owner&&owner.nombre===clave?[owner.w,owner.h]:(H&&H.nombre===clave?[H.w,H.h]:null);
      if(!dimensions)throw new Error('not saved: the mask owner is no longer mounted');
      if(o.body&&o.body.slice){const hd=new DataView(await o.body.slice(16,24).arrayBuffer());const w=hd.getUint32(0),h=hd.getUint32(4);
       if(w!==dimensions[0]||h!==dimensions[1])throw new Error('not saved: mask '+w+'x'+h+' differs from its frame '+dimensions.join('x'))}
      let hay=!!EDITADO[(q.get('rollo')||window.ROLLO)+'|'+clave];if(!hay){const b=await idb('readonly',s=>s.get(clave)).catch(()=>null);hay=!!b}
      if(!hay)throw new Error('nothing to save at '+(cen(clave)||'max')+': no edits (the automatic mask is not copied as corrected)')}}}
   catch(e){return Promise.reject(e)}
   return f0(u,o)};
 },{once:true});
})();
