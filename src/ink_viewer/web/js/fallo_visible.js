/* Cuando una imagen no carga, el visor dejaba la anterior en pantalla y solo ponia
   'load failed' en letra chica: se confunde con un mapa real. Esto tapa el area con
   un cartel inequivoco y el URL que fallo. ponytail: overlay unico, sin estado extra. */
(function(){
  const $=id=>document.getElementById(id);
  const im=$('map')||$('im'), stage=$('stage')||(im&&im.parentElement);
  if(!im||!stage)return;
  const cap=document.createElement('div');
  cap.id='falloCarga'; cap.hidden=true;
  cap.style.cssText='position:absolute;inset:0;display:none;flex-direction:column;align-items:center;'+
    'justify-content:center;gap:10px;background:#1a0d10;color:#ff9aa4;z-index:40;'+
    'font:600 20px ui-sans-serif,system-ui,sans-serif;text-align:center;padding:24px;pointer-events:none';
  cap.innerHTML="<div style=\"font-size:38px\">⚠︎</div><div id=\"falloQue\">Could not load the image</div>"+
    '<div id="falloUrl" style="font:400 12px ui-monospace,monospace;color:#c98c93;word-break:break-all;max-width:80%"></div>';
  if(getComputedStyle(stage).position==='static')stage.style.position='relative';
  stage.appendChild(cap);
  const mostrar=u=>{ $('falloUrl').textContent=u||''; cap.hidden=false;cap.style.display='flex';
    im.style.visibility='hidden';
    document.querySelectorAll('.pane img, #lowres').forEach(g=>g.style.visibility='hidden'); };
  const ocultar=()=>{ cap.hidden=true;cap.style.display='none'; };
  const previa=u=>/_lo8?\.jpg(\?|$)/.test(u||'');   /* la vista previa .jpg puede faltar a proposito: no es un fallo */
  im.addEventListener('error',()=>{const u=im.currentSrc||im.src; if(!previa(u))mostrar(u)});
  im.addEventListener('load',ocultar);
  // paneles: cada <img> de .pane avisa por su cuenta
  new MutationObserver(ms=>{ for(const m of ms) for(const n of m.addedNodes){
      if(n.tagName==='IMG'&&n.closest('.pane')){ n.addEventListener('error',()=>{const u=n.currentSrc||n.src; if(!previa(u))mostrar(u)}); n.addEventListener('load',ocultar); } } })
    .observe(document.body,{childList:true,subtree:true});
  window.falloCargaVisible=()=>!cap.hidden;
})();
