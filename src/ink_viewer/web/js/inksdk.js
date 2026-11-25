/* Optional ink-sdk jobs (server: ink_viewer/server/inksdk_job.py). The "Run model" button appears only when
   /api/inksdk reports ink-sdk available and the source accepts writes. It runs a public model on the surface
   volume of the open catalog segment; the new map is filed beside the annotations and the page reloads to show it.
   Reads the viewer's shared `group`; adds no other global state than window.inksdkJobs. */
(function(){
 const $id=id=>document.getElementById(id);
 const getJSON=url=>fetch(url).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json()});
 const state={vols:[],interval:3000,reload:()=>location.reload()};
 const meta=()=>typeof group!=='undefined'&&group&&group.catalogMeta;
 const say=text=>{$id('inksdkEstado').textContent=text};
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

 async function init(){
  let info;
  try{info=await getJSON('/api/inksdk')}catch(e){return false}
  if(!info||!info.disponible||!info.escritura)return false;
  const button=document.createElement('button');
  button.id='inksdkBtn';button.textContent='Run model';
  button.title='Run a public ink model (ink-sdk) on the surface volume of the open segment';
  // ui_modos.js regroups the toolbar, so insert beside 'Open PNG' wherever it now lives.
  const anchor=$id('download');
  if(anchor)anchor.parentNode.insertBefore(button,anchor);else document.querySelector('.toolbar').appendChild(button);
  const box=document.createElement('dialog');box.id='inksdkDlg';
  box.innerHTML='<form method="dialog"><h3>Run model on this segment</h3>'
   +'<label>Surface volume <select id="inksdkVol"></select></label> '
   +'<label>Model <select id="inksdkPerfil"></select></label>'
   +'<p id="inksdkEstado" role="status"></p>'
   +'<menu><button id="inksdkRun" type="button">Run</button><button value="cancel">Close</button></menu></form>';
  document.body.appendChild(box);
  button.addEventListener('click',abrir);
  $id('inksdkRun').addEventListener('click',correr);
  return true;
 }

 function perfiles(){
  const v=state.vols.find(v=>v.name===$id('inksdkVol').value),models=$id('inksdkPerfil');
  models.innerHTML='';
  for(const p of v.perfiles)models.add(new Option(p,p));
  $id('inksdkRun').disabled=!v.perfiles.length;
  say(v.perfiles.length?'':'No model reads '+v.res+' µm.');
 }

 async function abrir(){
  const m=meta(),vols=$id('inksdkVol');
  vols.innerHTML='';$id('inksdkPerfil').innerHTML='';$id('inksdkRun').disabled=true;
  $id('inksdkDlg').showModal();
  if(!m||!m.lam||!m.scroll){say('Open a catalog segment first.');return}
  say('Looking for surface volumes…');
  try{state.vols=await getJSON('/api/inksdk/volumenes?rollo='+encodeURIComponent(m.scroll)+'&segmento='+encodeURIComponent(m.lam))}
  catch(e){state.vols=[];say('Could not list surface volumes: '+(e&&e.message||e));return}
  if(!Array.isArray(state.vols)||!state.vols.length){state.vols=[];say('This segment has no surface-volumes/ in the source.');return}
  for(const v of state.vols)vols.add(new Option(v.name,v.name));
  vols.onchange=perfiles;perfiles();
 }

 async function correr(){
  const m=meta(),run=$id('inksdkRun');
  run.disabled=true;say('Queued…');
  const response=await fetch('/api/inksdk/trabajos',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({rollo:m.scroll,segmento:m.lam,volumen:$id('inksdkVol').value,perfil:$id('inksdkPerfil').value})});
  const job=await response.json();
  if(!response.ok){say('Error: '+(job.error||response.status));run.disabled=false;return}
  return seguir(job.id);
 }

 const ESTADOS={'en cola':'Queued…',copiando:'Copying the surface volume…',inferencia:'Running the model…'};
 async function seguir(id){
  for(;;){
   const job=(await getJSON('/api/inksdk/trabajos')).find(j=>j.id===id);
   if(!job){say('The job is no longer known to the server.');$id('inksdkRun').disabled=false;return}
   if(job.estado==='listo'){say('Done: '+job.mapas.length+' maps. Reloading…');state.reload();return}
   if(job.estado==='error'){say('Error: '+job.error);$id('inksdkRun').disabled=false;return}
   say(ESTADOS[job.estado]||job.estado);
   await sleep(state.interval);
  }
 }

 window.inksdkJobs={init,abrir,correr,seguir,state,ready:init()};
})();
