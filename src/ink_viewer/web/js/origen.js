/* Configure the local proxy; credentials stay in the AWS SDK, never in the browser. */
(function(){
 let cfg=window.VISOR_BOOTSTRAP?.origen||null;
 if(!cfg)try{const x=new XMLHttpRequest();x.open('GET','/api/origen',false);x.send();if(x.status===200)cfg=JSON.parse(x.responseText)}catch(e){}
 window.VISOR_ORIGEN=cfg;
 window.visorKey=k=>cfg&&cfg.id?k+'@'+cfg.id:k;
 /* Server messages are already English; kept as the single place that formats them for the UI. */
 window.visorTexto=t=>String(t||'');
 window.visorPuedeGuardar=!cfg||cfg.escritura;
 if(!cfg)return;
 const originalFetch=window.fetch.bind(window);
 window.fetch=(input,init={})=>{
  const url=new URL(input instanceof Request?input.url:input,location.href);
  if(url.origin===location.origin){const headers=new Headers(init.headers||(input instanceof Request?input.headers:undefined));headers.set('X-Visor-Origen',cfg.id);init=Object.assign({},init,{headers})}
  return originalFetch(input,init);
 };
 document.addEventListener('DOMContentLoaded',()=>{
  const style=document.createElement('style');style.textContent=
   '#origenActual{min-width:0;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:auto}'+
   '#origenAbrir{flex:none}#origenDialog{width:min(520px,calc(100vw - 24px));max-height:90dvh;overflow:auto;color:inherit;background:#101922;border:1px solid #405064;border-radius:8px;padding:20px}'+
   '#origenDialog::backdrop{background:#0009}#origenDialog h2{font-size:18px;margin:0 0 16px}#origenForm{display:grid;gap:14px}'+
   '#origenForm label{display:grid;gap:6px;min-width:0}#origenForm input,#origenForm select{font:inherit;width:100%;min-width:0;color:inherit;background:#182330;border:1px solid #405064;border-radius:6px;padding:9px}'+
   '#origenForm .check{display:flex;align-items:center;gap:8px}#origenForm input[type=checkbox]{width:16px;height:16px;accent-color:#60d4c6}#origenS3{display:grid;gap:14px}#origenS3[hidden]{display:none}'+
   '#origenAcciones{display:flex;justify-content:flex-end;gap:8px}#origenError{color:#ffb4ac;overflow-wrap:anywhere;min-height:18px;margin:0}'+
   '@media(max-width:700px){#origenActual{max-width:160px;margin-left:0}#origenDialog{padding:16px}}';document.head.append(style);
  const current=document.createElement('span');current.id='origenActual';current.className='muted';current.textContent=cfg.tipo==='none'?'No source':cfg.tipo.toUpperCase()+' · '+cfg.origen;current.title=cfg.origen+(cfg.escritura?" · annotations enabled":" · read-only");
  const button=document.createElement('button');button.id='origenAbrir';button.textContent="Change source";button.title="Configure data source";document.querySelector('header').append(current,button);
  const dialog=document.createElement('dialog');dialog.id='origenDialog';dialog.setAttribute('aria-labelledby','origenTitulo');
  dialog.innerHTML="<h2 id=\"origenTitulo\">Data source</h2><form id=\"origenForm\">"+
   "<label>Type<select id=\"origenTipo\" aria-label=\"Type\"><option value=\"local\">Local folder</option><option value=\"http\">HTTP / HTTPS</option><option value=\"s3\">S3</option></select></label>"+
   "<label><span id=\"origenEtiqueta\">Folder</span><input id=\"origenRuta\" type=\"text\" required spellcheck=\"false\" autocomplete=\"off\"></label>"+
   "<div id=\"origenS3\" hidden><label>AWS profile<input id=\"origenPerfil\" type=\"text\" spellcheck=\"false\" autocomplete=\"off\"></label><label>S3-compatible endpoint<input id=\"origenEndpoint\" type=\"url\" placeholder=\"https://s3.example.com\" spellcheck=\"false\" autocomplete=\"off\"></label><label>Region<input id=\"origenRegion\" type=\"text\" placeholder=\"us-east-1\" spellcheck=\"false\" autocomplete=\"off\"></label></div>"+
   "<label class=\"check\"><input id=\"origenGuardar\" type=\"checkbox\">Save annotations to a local folder</label>"+
   "<label>Annotation folder<input id=\"origenAnotaciones\" type=\"text\" spellcheck=\"false\" autocomplete=\"off\" disabled></label>"+
   "<p id=\"origenError\" role=\"status\" aria-live=\"polite\"></p><div id=\"origenAcciones\"><button id=\"origenCancelar\" type=\"button\">Cancel</button><button id=\"origenAplicar\" type=\"submit\">Apply</button></div></form>";
  document.body.append(dialog);
  const el=id=>document.getElementById(id);
  function tipo(){const t=el('origenTipo').value;el('origenS3').hidden=t!=='s3';el('origenEtiqueta').textContent=t==='local'?'Carpeta':t==='s3'?"Bucket and prefix":"Base URL";el('origenRuta').placeholder=t==='local'?'/ruta/datos':t==='s3'?'s3://bucket/prefijo':'https://servidor/datos'}
  el('origenTipo').onchange=tipo;
  el('origenGuardar').onchange=()=>{el('origenAnotaciones').disabled=!el('origenGuardar').checked;el('origenAnotaciones').required=el('origenGuardar').checked};
  button.onclick=()=>{el('origenTipo').value=cfg.tipo==='none'?'local':cfg.tipo;el('origenRuta').value=cfg.origen;el('origenPerfil').value=cfg.perfil||'';el('origenEndpoint').value=cfg.endpoint||'';el('origenRegion').value=cfg.region||'';el('origenAnotaciones').value=cfg.anotaciones||'';el('origenGuardar').checked=!!cfg.anotaciones;el('origenGuardar').onchange();el('origenError').textContent='';tipo();dialog.showModal()};
  el('origenCancelar').onclick=()=>dialog.close();
  el('origenForm').onsubmit=async event=>{
   event.preventDefault();const apply=el('origenAplicar');apply.disabled=true;el('origenError').textContent="Validating source...";
   const s3=el('origenTipo').value==='s3',origen=el('origenRuta').value.trim();
   try{
    const inferred=origen.startsWith('s3://')?'s3':/^https?:\/\//.test(origen)?'http':'local';if(inferred!==el('origenTipo').value)throw new Error("The path does not match the selected source type");
    const data={origen,perfil:s3?el('origenPerfil').value.trim():'',endpoint:s3?el('origenEndpoint').value.trim():'',region:s3?el('origenRegion').value.trim():'',anotaciones:el('origenGuardar').checked?el('origenAnotaciones').value.trim():''};
    const response=await fetch('/api/origen',{method:'POST',headers:{'Content-Type':'application/json','X-Visor-Config':cfg.token},body:JSON.stringify(data)});
    const result=await response.json();if(!response.ok)throw new Error(result.error||"Could not configure the source");
    location.assign('/all-gallery/index.html');
   }catch(e){el('origenError').textContent=visorTexto(e.message);apply.disabled=false}
  };
 });
})();
