/* ===== filtros pro (12-sep-2026) =====
   Extiende los filtros visuales del visor SIN tocar su codigo: agrega campos a FX, controles al
   panel, paletas, y redefine las funciones de dibujo (lutDe, fxLut, defsPanes, fxCompuesto,
   fxDibujar, fxAUI, fxPintarPresets) para que TODO pase por filtros SVG (GPU, sin el tope de
   40 Mpx del canvas) con una sola cadena:

     imagen -> [unsharp | pasa-alto | pasa-banda (DoG)] -> [borde] -> LUT -> [mezcla con el crudo]

   LUT (tabla de 256): niveles (negro/blanco o percentiles automaticos) -> gamma -> brillo/contraste
   -> curva S (sigmoide alrededor de un centro) -> posterizar -> invertir -> umbral -> falso color.

   Que ayuda al ojo con tinta tenue, y por que esta cada cosa:
   - niveles por percentil: el mapa usa 10 % del rango; estirar p2-p98 es lo primero que hay que hacer.
   - pasa-alto / DoG: sacan el fondo lento (variacion de iluminacion del render) y dejan el trazo, que
     tiene ~25-45 px de ancho a 8,64 um; el DoG con radio 6 (sigma 6 / 18) esta afinado a eso.
   - tras pasa-alto/DoG la imagen vive alrededor de 0,5 (gris medio): la ventana de niveles va 96-160, no los
     percentiles del crudo (que quedarian planos).
   - curva S: contraste concentrado alrededor del nivel del fondo, sin quemar extremos.
   - paletas perceptuales (viridis/magma/cividis) y divergente (azul bajo / rojo alto alrededor del
     centro): el ojo separa mejor tonos que grises.
   - relieve / laplaciano / isolineas: bordes y mesetas; sirven para decidir si una mancha tiene forma.
   - parpadeo: alterna filtrado/crudo a 2,5 Hz; el sistema visual detecta lo que cambia mucho mejor que
     lo que esta quieto. */
(function(){
 if(typeof FXDEF==='undefined'||typeof PANES==='undefined'){console.warn('filtros_pro: visor sin FX');return}
 const NS='http://www.w3.org/2000/svg';
 /* ---- campos nuevos (persisten en localStorage por la misma via que los viejos) ---- */
 const NUEVOS={negro:0,blanco:255,auto:'',curva:0,centro:0.5,poster:0,pasaalto:0,pasaGan:4,dog:0,dogRadio:6,dogGan:3,borde:'',mezcla:100};
 Object.assign(FXDEF,NUEVOS); for(const k in NUEVOS)if(!(k in FX))FX[k]=NUEVOS[k];
 FXCLAVES.length=0; Object.keys(FXDEF).filter(k=>k!=='abierto').forEach(k=>FXCLAVES.push(k));
 /* ---- paletas ---- */
 Object.assign(PAL,{
  magma:[[0,0,4],[28,16,68],[79,18,123],[129,37,129],[181,54,122],[229,80,100],[251,135,97],[254,194,135],[252,253,191]],
  cividis:[[0,32,77],[26,51,102],[60,71,110],[89,92,114],[118,114,120],[149,136,116],[182,159,106],[216,183,88],[255,234,70]],
  turbo:[[48,18,59],[70,105,224],[40,180,226],[28,225,164],[112,247,87],[195,236,45],[253,194,35],[237,111,16],[122,4,3]],
  diverge:[[33,102,172],[103,169,207],[209,229,240],[247,247,247],[253,219,199],[239,138,98],[178,24,43]],
  hot:[[0,0,0],[87,0,0],[172,0,0],[255,0,0],[255,85,0],[255,170,0],[255,255,0],[255,255,128],[255,255,255]]});
 /* ---- histograma de la imagen visible (512 px de ancho, cacheado por src) ---- */
 let HIST={src:'',h:null,pct:{}};
 function fxHist(){
  const src=im&&im.src; if(!src||!im.naturalWidth)return null;
  if(HIST.src===src&&HIST.h)return HIST.h;
  const scale=Math.min(1,512/Math.max(im.naturalWidth,im.naturalHeight));
  const w=Math.max(1,Math.round(im.naturalWidth*scale)),h=Math.max(1,Math.round(im.naturalHeight*scale));
  const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');
  let d;try{g.drawImage(im,0,0,w,h);d=g.getImageData(0,0,w,h).data}catch(e){return null}
  const H=new Float64Array(256);let n=0;
  for(let i=0;i<d.length;i+=4){if(d[i+3]<128)continue;H[d[i]]++;n++}
  const pct={};if(n){let acc=0,q=[1,2,5,10,90,95,98,99],j=0;
   for(let v=0;v<256&&j<q.length;v++){acc+=H[v];while(j<q.length&&acc/n>=q[j]/100){pct['p'+q[j]]=v;j++}}}
  HIST={src,h:H,n,pct};return H}
 const fxPct=p=>{fxHist();return HIST.pct[p]};
 /* ---- niveles efectivos (auto por percentil pisa negro/blanco) ---- */
 function niveles(fx){
  let lo=+fx.negro,hi=+fx.blanco;
  if(fx.auto){const a={p1:['p1','p99'],p2:['p2','p98'],p5:['p5','p95'],p10:['p10','p90']}[fx.auto];
   if(a){const l=fxPct(a[0]),h=fxPct(a[1]);if(l!=null&&h!=null&&h>l){lo=l;hi=h}}}
  if(hi<=lo)hi=lo+1;return[lo/255,hi/255]}
 /* ---- LUT unica para SVG (floats) y canvas (Uint32) ---- */
 function lutPro(fx){
  const g=Math.max(.01,+fx.gamma),br=+fx.brillo,co=+fx.contraste,um=+fx.umbral/255,pal=PAL[fx.paleta],
        [lo,hi]=niveles(fx),k=+fx.curva,c0=+fx.centro,ps=+fx.poster|0,out=[];
  const sig=k>0?(t=>{const s=x=>1/(1+Math.exp(-k*(x-c0)));const a=s(0),b=s(1);return (s(t)-a)/(b-a||1)}):null;
  for(let v=0;v<256;v++){let t=v/255;
   t=(t-lo)/(hi-lo); t=t<0?0:t>1?1:t;
   if(g!==1)t=Math.pow(t,1/g);
   t=(t*br-.5)*co+.5;
   t=t<0?0:t>1?1:t;
   if(sig)t=sig(t);
   if(ps>=2)t=Math.min(1,Math.floor(t*ps)/(ps-1));
   if(fx.invertir)t=1-t;
   if(fx.umbralOn)t=t>=um?1:0;
   let r,gg,b;
   if(pal){const x=t*(pal.length-1),q=Math.min(pal.length-2,x|0),f=x-q;
    r=(pal[q][0]+(pal[q+1][0]-pal[q][0])*f)/255;gg=(pal[q][1]+(pal[q+1][1]-pal[q][1])*f)/255;b=(pal[q][2]+(pal[q+1][2]-pal[q][2])*f)/255}
   else r=gg=b=t;
   out.push([r,gg,b])}
  return out}
 window.lutDe=function(fx){const o=lutPro(fx),l=[[],[],[]];o.forEach(([r,g,b])=>{l[0].push(r.toFixed(4));l[1].push(g.toFixed(4));l[2].push(b.toFixed(4))});return l};
 window.fxLut=function(){const o=lutPro(FX),l=new Uint32Array(256);o.forEach(([r,g,b],v)=>{l[v]=((r*255)&255)|(((g*255)&255)<<8)|(((b*255)&255)<<16)});return l};
 /* ---- composicion: ajustes globales encima del preset de cada cuadrante ---- */
 window.fxCompuesto=function(base){
  const o=Object.assign({},FXDEF,base);
  o.gamma=(+o.gamma)*(+FX.gamma); o.brillo=(+o.brillo)*(+FX.brillo); o.contraste=(+o.contraste)*(+FX.contraste);
  if(FX.invertir)o.invertir=!o.invertir;
  if(FX.umbralOn){o.umbralOn=true;o.umbral=+FX.umbral}
  if(FX.paleta)o.paleta=FX.paleta;
  if(+FX.local>0){o.local=+FX.local;o.radio=+FX.radio}
  if(+FX.negro!==0)o.negro=+FX.negro; if(+FX.blanco!==255)o.blanco=+FX.blanco; if(FX.auto)o.auto=FX.auto;
  if(+FX.curva>0){o.curva=+FX.curva;o.centro=+FX.centro}
  if(+FX.poster>=2)o.poster=+FX.poster;
  if(+FX.pasaalto>0){o.pasaalto=+FX.pasaalto;o.pasaGan=+FX.pasaGan}
  if(+FX.dog>0){o.dog=1;o.dogRadio=+FX.dogRadio;o.dogGan=+FX.dogGan}
  if(FX.borde)o.borde=FX.borde;
  o.mezcla=(+o.mezcla)*(+FX.mezcla)/100;
  return o};
 /* ---- cadena SVG ---- */
 const el=(t,a)=>{const e=document.createElementNS(NS,t);for(const k in a)e.setAttribute(k,a[k]);return e};
 function armarFiltro(id,fxc){
  const f=el('filter',{id,'color-interpolation-filters':'sRGB',x:'-5%',y:'-5%',width:'110%',height:'110%'});
  let src='SourceGraphic';
  if(+fxc.local>0){f.append(el('feGaussianBlur',{in:src,stdDeviation:+fxc.radio,result:'bl'}),
   el('feComposite',{in:src,in2:'bl',operator:'arithmetic',k1:0,k2:1+ +fxc.local,k3:-fxc.local,k4:0,result:'uns'}));src='uns'}
  /* g*src - g*blur + 0.5 with k4 on feComposite also hits ALPHA (0.5 -> premultiplied clipping = white): move the
     offset and the negative gain into a linear transfer of the blur so the composite's alpha sums to >= 1 */
  const neg=(inp,g,res)=>{const ct=el('feComponentTransfer',{in:inp,result:res});['R','G','B'].forEach(c=>ct.append(el('feFunc'+c,{type:'linear',slope:-g,intercept:0.5})));return ct};
  if(+fxc.pasaalto>0){const g=+fxc.pasaGan;f.append(el('feGaussianBlur',{in:src,stdDeviation:+fxc.pasaalto,result:'pa'}),neg('pa',g,'pan'),
   el('feComposite',{in:src,in2:'pan',operator:'arithmetic',k1:0,k2:g,k3:1,k4:0,result:'hp'}));src='hp'}
  if(+fxc.dog>0){const r=+fxc.dogRadio,g=+fxc.dogGan;
   f.append(el('feGaussianBlur',{in:src,stdDeviation:r,result:'d1'}),el('feGaussianBlur',{in:src,stdDeviation:r*3,result:'d2'}),neg('d2',g,'d2n'),
    el('feComposite',{in:'d1',in2:'d2n',operator:'arithmetic',k1:0,k2:g,k3:1,k4:0,result:'dog'}));src='dog'}
  if(fxc.borde){const K={relieve:'-2 -1 0 -1 1 1 0 1 2',lap:'0 -1 0 -1 4 -1 0 -1 0',sobel:'-1 -2 -1 0 0 0 1 2 1'}[fxc.borde];
   if(K){f.append(el('feConvolveMatrix',{in:src,order:3,kernelMatrix:K,divisor:1,bias:fxc.borde==='emboss'?0:0.5,preserveAlpha:'true',result:'bd'}));src='bd'}}
  const l=lutDe(fxc),ct=el('feComponentTransfer',{in:src,result:'lut'});
  ['R','G','B'].forEach((c,k)=>ct.append(el('feFunc'+c,{type:'table',tableValues:l[k].join(' ')})));f.append(ct);
  const m=Math.max(0,Math.min(1,(+fxc.mezcla)/100));
  if(m<1)f.append(el('feComposite',{in:'lut',in2:'SourceGraphic',operator:'arithmetic',k1:0,k2:m,k3:1-m,k4:0}));
  return f}
 function defsRaiz(){let d=$('panesDefs');
  if(!d){const svg=document.querySelector('svg[aria-hidden]')||document.querySelector('svg');d=el('defs',{id:'panesDefs'});svg&&svg.append(d)}return d}
 window.defsPanes=function(){const d=defsRaiz();if(!d)return;d.innerHTML='';
  PANES.forEach((p,i)=>d.append(armarFiltro('fxPane'+i,fxCompuesto(p.fx))));
  d.append(armarFiltro('fxSolo',fxCompuesto({})))};
 /* ---- vista unica: misma cadena SVG, sin canvas ---- */
 const neutro=()=>FXCLAVES.every(k=>{const q=FXDEF[k];return typeof q==='boolean'?!!FX[k]===q:(typeof q==='number'?+FX[k]===q:FX[k]===q)});
 window.fxDibujar=function(){
  const cv=$('fx');fxDentro=true;
  cv.style.display='none';stage.classList.remove('fxon');fxG=fxA=fxOut=null;
  if(neutro()){stage.style.setProperty('--fx','none');fxEstado('');fxDentro=false;pintarHist();return}
  defsPanes();stage.style.setProperty('--fx','url(#fxSolo)');
  const a=[];if(FX.auto){const[lo,hi]=niveles(FX);a.push('levels '+Math.round(lo*255)+'–'+Math.round(hi*255))}
  fxEstado((a.length?a.join(' · ')+' · ':'')+'SVG/GPU');fxDentro=false;pintarHist()};
 /* ---- controles nuevos en el panel ---- */
 const P=$('filtros');
 const fila=document.createElement('div');fila.id='filtrosPro';fila.style.cssText='display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;width:100%;margin-top:4px';
 fila.innerHTML=
  '<label title="Level mapped to black (trims the background)">black <input type="range" id="fNegro" min="0" max="254" step="1" value="0"><output id="vNegro">0</output></label>'+
  '<label title="Level mapped to white (stretches the highs)">white <input type="range" id="fBlanco" min="1" max="255" step="1" value="255"><output id="vBlanco">255</output></label>'+
  '<label title="Automatic levels by percentile of the visible image: override black/white">auto <select id="fAuto"><option value="">—</option><option value="p1">p1–p99</option><option value="p2">p2–p98</option><option value="p5">p5–p95</option><option value="p10">p10–p90</option></select></label>'+
  '<canvas id="fxHist" width="256" height="36" title="Histogram of the visible image; marks = effective black/white" style="background:#0b1016;border:1px solid #344254;border-radius:4px"></canvas>'+
  '<span class="sep"></span>'+
  '<label title="Sigmoid: concentrates contrast around the centre (0 = off)">S-curve <input type="range" id="fCurva" min="0" max="24" step="0.5" value="0"><output id="vCurva">0.0</output></label>'+
  '<label title="S-curve centre (background level, 0–1)">centre <input type="range" id="fCentro" min="0.05" max="0.95" step="0.01" value="0.5"><output id="vCentro">0.50</output></label>'+
  '<label title="Quantizes to N levels (0 = off): plateaus and isolines">posterize <input type="range" id="fPoster" min="0" max="16" step="1" value="0"><output id="vPoster">0</output></label>'+
  '<span class="sep"></span>'+
  '<label title="Subtracts the smoothed background (sigma in px, 0 = off) and amplifies the residual: only the fine detail remains">high-pass <input type="range" id="fPasaalto" min="0" max="60" step="1" value="0"><output id="vPasaalto">0</output> px · gain <input type="range" id="fPasaGan" min="1" max="12" step="0.5" value="4"><output id="vPasaGan">4.0</output></label>'+
  '<label title="Difference of Gaussians sigma / 3·sigma: boosts structures the width of a stroke"><input type="checkbox" id="fDog"> band-pass <input type="range" id="fDogRadio" min="2" max="30" step="1" value="6"><output id="vDogRadio">6</output> px · gain <input type="range" id="fDogGan" min="1" max="8" step="0.5" value="3"><output id="vDogGan">3.0</output></label>'+
  '<label>edge <select id="fBorde"><option value="">—</option><option value="emboss">emboss</option><option value="lap">Laplacian</option><option value="sobel">sobel</option></select></label>'+
  '<span class="sep"></span>'+
  '<label title="Filter intensity: 100 = filtered only, 0 = raw">blend <input type="range" id="fMezcla" min="0" max="100" step="5" value="100"><output id="vMezcla">100</output>%</label>'+
  '<button id="fBlink" type="button" title="Alternates filtered / raw at 2.5 Hz: the eye detects what changes (key B)">blink</button>';
 P.append(fila);
 [['fNegro','negro','num'],['fBlanco','blanco','num'],['fAuto','auto','str'],['fCurva','curva','num'],['fCentro','centro','num'],['fPoster','poster','num'],
  ['fPasaalto','pasaalto','num'],['fPasaGan','pasaGan','num'],['fDog','dog','bool'],['fDogRadio','dogRadio','num'],['fDogGan','dogGan','num'],['fBorde','borde','str'],['fMezcla','mezcla','num']].forEach(x=>FXCTL.push(x));
 [['vNegro','negro',0],['vBlanco','blanco',0],['vCurva','curva',1],['vCentro','centro',2],['vPoster','poster',0],['vPasaalto','pasaalto',0],['vPasaGan','pasaGan',1],['vDogRadio','dogRadio',0],['vDogGan','dogGan',1],['vMezcla','mezcla',0]].forEach(x=>FXOUT.push(x));
 const refrescar=()=>{fxGuardar();fxAUI();fxPedir();if(PANES&&PANES.length){defsPanes();pintarPanes()}fxPintarPresets()};
 FXCTL.slice(-13).forEach(([id,k,t])=>{const e=$(id),ev=t==='num'?'oninput':'onchange';
  e[ev]=ev2=>{FX[k]=t==='bool'?(ev2.target.checked?1:0):(t==='str'?ev2.target.value:+ev2.target.value);refrescar()}});
 /* el checkbox de DoG guarda 0/1 en FX.dog */
 const fxAUI0=window.fxAUI;
 window.fxAUI=function(){FXCTL.forEach(([id,k,t])=>{const e=$(id);if(!e)return;if(t==='bool')e.checked=!!(+FX[k]||FX[k]===true);else e.value=FX[k]});
  FXOUT.forEach(([id,k,d])=>{const e=$(id);if(e)e.textContent=(+FX[k]).toFixed(d)});
  $('filtros').hidden=!FX.abierto;$('filtrosBtn').classList.toggle('active',FX.abierto);
  $('filtrosBtn').setAttribute('aria-pressed',String(FX.abierto));$('filtrosBtn').setAttribute('aria-expanded',String(FX.abierto));
  const n=FXCLAVES.filter(k=>{const q=FXDEF[k];return typeof q==='boolean'?!!FX[k]!==q:(typeof q==='number'?+FX[k]!==q:FX[k]!==q)}).length;
  $('filtrosBtn').textContent=n?'Filters ('+n+')':'Filters';pintarHist()};
 function pintarHist(){const c=$('fxHist');if(!c)return;const g=c.getContext('2d');g.clearRect(0,0,256,36);
  const H=fxHist();if(!H)return;let mx=0;for(let v=1;v<255;v++)mx=Math.max(mx,H[v]);if(!mx)return;
  g.fillStyle='#4f8b86';for(let v=0;v<256;v++){const y=Math.min(1,Math.log1p(H[v])/Math.log1p(mx))*34;g.fillRect(v,36-y,1,y)}
  const[lo,hi]=niveles(FX);g.fillStyle='#ffb347';g.fillRect(Math.round(lo*255),0,1,36);g.fillRect(Math.round(hi*255),0,1,36)}
 /* ---- parpadeo ---- */
 let blink=0;const st=document.createElement('style');st.textContent='.parpadeo #stage img,.parpadeo .pane img{filter:none!important}';document.head.append(st);
 const togglBlink=()=>{if(blink){clearInterval(blink);blink=0;document.body.classList.remove('blink');$('fBlink').classList.remove('active');return}
  $('fBlink').classList.add('active');blink=setInterval(()=>document.body.classList.toggle('blink'),200)};
 $('fBlink').onclick=togglBlink;
 document.addEventListener('keydown',e=>{if(e.key==='b'&&!e.ctrlKey&&!e.metaKey&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))togglBlink()});
 /* ---- presets, agrupados ---- */
 const GRUPOS=[
  ['Basics',[
   {t:'Raw',d:'Everything neutral: the map as it came out of the model. The honest starting point.',fx:{}},
   {t:'Auto levels',d:'Stretches p2–p98 of the visible image to black–white. The first thing to do: the map uses a fraction of the range.',fx:{auto:'p2'}},
   {t:'Soft boost',d:'Gamma 1.6 and a touch of contrast over auto levels. For sweeping a whole lamina.',fx:{auto:'p2',gamma:1.6,contraste:1.2,brillo:1.05}}]],
  ['Contrast',[
   {t:'S-curve',d:'Sigmoid k=8 centred on the background level, over p2–p98 levels. Concentrates contrast where faint ink lives without burning the extremes.',fx:{auto:'p2',curva:8,centro:0.5}},
   {t:'High contrast',d:'Hard contrast and low gamma. To confirm a shape already seen, not to discover it.',fx:{contraste:2.2,gamma:0.85}},
   {t:'Threshold',d:'Binarizes at 140. One question only: is the stroke continuous or scattered blobs?',fx:{umbralOn:true,umbral:140}},
   {t:'Soft threshold',d:'Very steep sigmoid (k=20): almost binary but with a graded edge; shows how sure the model is near the cut.',fx:{curva:20,centro:0.55}}]],
  ['Stroke (frequency)',[
   {t:'Fine stroke',d:'Unsharp mask, radius 8. Separates the stroke from the background when ink is faint; also boosts the render weave.',fx:{local:1.6,radio:8,contraste:1.3}},
   {t:'High-pass',d:'Subtracts the smoothed background (σ 20 px) and amplifies the residual: removes the slow render illumination and keeps only the fine detail.',fx:{pasaalto:20,pasaGan:6,negro:96,blanco:160}},
   {t:'Stroke band-pass',d:'Difference of Gaussians σ6/σ18, tuned to a stroke width (25–45 px at 8.64 µm). Anything not that size disappears.',fx:{dog:1,dogRadio:6,dogGan:6,negro:96,blanco:160}},
   {t:'Emboss',d:'Turns edges into shading. Good for seeing whether a blob has a defined outline.',fx:{borde:'emboss'}},
   {t:'Laplacian',d:'Second derivative: edges only. Letters show as double outlines; noise as grain.',fx:{borde:'lap',contraste:1.6}}]],
  ['False color',[
   {t:'Viridis',d:'Perceptually uniform: colour jumps = real intensity jumps.',fx:{paleta:'viridis',gamma:1.2}},
   {t:'Inferno',d:'More range in the highs: makes the maxima pop over a muted background.',fx:{paleta:'inferno',contraste:1.4}},
   {t:'Magma',d:'Like inferno but softer in the mids, over auto levels.',fx:{paleta:'magma',auto:'p2'}},
   {t:'Turbo',d:'High-contrast rainbow: maximum tone separation; not uniform, exploration only.',fx:{paleta:'turbo',auto:'p2'}},
   {t:'Diverging',d:'Blue = below the centre, red = above, white = background (p5–p95). Shows what sits above and below the background.',fx:{paleta:'diverge',auto:'p5'}},
   {t:'Isolines',d:'6 levels + Laplacian: contour lines of the map. A letter gives nested closed contours.',fx:{poster:6,borde:'lap',contraste:2}}]],
  ['Other',[
   {t:'Inverted',d:'Dark ink on light: how the eye reads.',fx:{invertir:true,gamma:1.3}},
   {t:'Inverted high-pass',d:'High-pass + inverted: dark strokes on a flat light background, closest to reading paper.',fx:{invertir:true,pasaalto:20,pasaGan:6,negro:96,blanco:160}}]]];
 FXPRESETS.length=0;GRUPOS.forEach(([g,ps])=>ps.forEach(p=>{p.g=g;FXPRESETS.push(p)}));
 window.fxPintarPresets=function(){const c=$('fxPresets');if(!c)return;c.innerHTML='';c.removeAttribute('style');
  let g0='',section=null;FXPRESETS.forEach(p=>{
   if(p.g!==g0){g0=p.g;section=document.createElement('div');section.className='fxPresetGroup';const heading=document.createElement('h4');heading.textContent=g0;section.append(heading);c.append(section)}
   const b=document.createElement('button');b.textContent=p.t;b.title=p.d;
   if(fxPresetActivo(p))b.classList.add('on');
   b.onclick=()=>{const ab=FX.abierto;const fx=Object.assign({},FX,p.fx,{abierto:ab});
    if(PANES&&PANES.length){fxObjetivos().forEach(i=>{PANES[i].fx=Object.assign({},PANES[i].fx,p.fx)});FX=Object.assign({},fx);fxGuardar();fxAUI();fxPedir();defsPanes();pintarPanes()}
    else{FX=fx;fxGuardar();fxAUI();fxPedir()}
    fxPintarPresets()};
   section.append(b)})};
 fetch('alias_presets.json',{cache:'no-store'}).then(r=>r.ok?r.json():{}).then(d=>{window.PRESET_ALIAS=d}).catch(()=>{});
 window.fxArmarFiltro=armarFiltro; window.fxNiveles=niveles; window.fxLutPro=lutPro;   /* para super_mosaico.js */
 /* ---- low-friction additions: advanced rows collapsed, named favourites (FX + panes), pane hover toolbar ---- */
 (function(){
  const FAVKEY='vesuvius.filtros.favoritos.v1';let FAV={};try{FAV=JSON.parse(localStorage.getItem(FAVKEY)||'{}')}catch(e){}
  const bar=document.createElement('div');bar.id='fxBar';bar.style.cssText='display:flex;gap:8px;align-items:center;width:100%;margin:2px 0';
  bar.innerHTML='<span>Favourites</span><span id="fxFavs"></span><button id="fxFavSave" type="button" title="Save the current global adjustments + panes under a name">Save setup…</button>';
  $('filtros').append(bar);
  const pintarFav=()=>{const c=$('fxFavs');c.innerHTML='';Object.keys(FAV).sort().forEach(n=>{const b=document.createElement('button');b.type='button';b.textContent=n;b.title='click: apply · shift+click: delete';
   b.onclick=e=>{if(e.shiftKey){delete FAV[n];localStorage.setItem(FAVKEY,JSON.stringify(FAV));pintarFav();return}
    const f=FAV[n];FX=Object.assign({},FXDEF,f.fx,{abierto:FX.abierto});PANES=(f.panes||[]).map(p=>({t:p.t,fx:Object.assign({},FXDEF,p.fx)}));fxGuardar();fxAUI();fxPedir();defsPanes();pintarPanes();fxPintarPresets();if(typeof fit==='function')fit()};c.append(b)})};
  $('fxFavSave').onclick=()=>{const n=prompt('Name for this filter setup (global adjustments + panes):');if(!n)return;FAV[n]={fx:Object.assign({},FX),panes:PANES.map(p=>({t:p.t,fx:p.fx}))};localStorage.setItem(FAVKEY,JSON.stringify(FAV));pintarFav()};
  pintarFav();
  /* pane toolbar on hover: remove / make main */
  const css=document.createElement('style');css.textContent='.pane .tb{position:absolute;right:6px;bottom:6px;display:none;gap:4px;z-index:4}.pane:hover .tb{display:flex}.pane .tb button{font:11px ui-monospace,monospace;background:#0b1016cc;color:#c9d6e2;border:1px solid #344254;border-radius:4px;padding:1px 6px;cursor:pointer}';document.head.append(css);
  const pintarPanes0=window.pintarPanes;
  window.pintarPanes=function(){pintarPanes0.apply(this,arguments);document.querySelectorAll('#panes .pane').forEach((d,i)=>{if(d.querySelector('.tb'))return;const tb=document.createElement('div');tb.className='tb';
   const bm=document.createElement('button');bm.textContent='main';bm.title='Keep only this pane';bm.onclick=e=>{e.stopPropagation();PANES=[PANES[i]];defsPanes();pintarPanes();fxPintarPresets();fit()};
   const bx=document.createElement('button');bx.textContent='×';bx.title='Remove this pane';bx.onclick=e=>{e.stopPropagation();PANES.splice(i,1);defsPanes();pintarPanes();fxPintarPresets();fit()};
   tb.append(bm,bx);d.append(tb)})};
 })();
 /* ---- zoom en modo cuadrantes: el ancla del zoom (rueda o botones +/-) llegaba en coordenadas del
    viewport entero, pero x,y son relativas a UN cuadrante (fit() encuadra en cajaUtil): con zoom la imagen
    se iba fuera del cuadrante y los 4 quedaban negros. Se convierte el ancla al cuadrante bajo el cursor. */
 const scaleTo0=window.scaleTo;
 window.scaleTo=function(z,cx,cy){
  if(PANES&&PANES.length){const[w,h]=cajaUtil(),W=vp.clientWidth,H=vp.clientHeight,n=PANES.length;
   if(cx==null||cy==null){cx=w/2;cy=h/2}
   else if(typeof window.aPanel==='function')[cx,cy]=window.aPanel(cx,cy);   /* 25-sep: corte arrastrable entre columnas de mapas (index.html) */
   else{const abajo=n>=3&&cy>=H/2,der=(n===2||n===4||(n===3&&!abajo))&&cx>=W/2;
    cx-=der?W/2:0;cy-=abajo?H/2:0}}
  return scaleTo0(z,cx,cy)};
 /* ---- arranque: reconstruir con la cadena nueva ---- */
 new MutationObserver(()=>{HIST.src='';pintarHist()}).observe(im,{attributes:true,attributeFilter:['src']});
 im.addEventListener('load',()=>{HIST.src='';if(FX.auto||PANES.some(p=>p.fx.auto)){fxPedir();if(PANES.length){defsPanes()}}pintarHist()});
 /* el deep link (&paneles=) se aplico antes de que existieran los presets nuevos: re-resolverlo */
 try{const u0=((performance.getEntriesByType('navigation')[0]||{}).name)||location.href;   /* el visor ya reescribio el hash: usar la URL con la que se llego */
  const pv=new URLSearchParams((u0.split('#')[1]||'')).get('paneles');
  if(pv){const q=decodeURIComponent(pv).split(',').map(t=>t.trim()).filter(Boolean).slice(0,4);
   const AL=(window.PRESET_ALIAS||{});const nuevos=q.map(t=>{t=AL[t]||t;const d=FXPRESETS.find(z=>z.t.toLowerCase()===t.toLowerCase());return d?{t:d.t,fx:Object.assign({},FXDEF,d.fx)}:null}).filter(Boolean);
   if(nuevos.length>PANES.length)PANES=nuevos}}catch(e){}
 fxAUI();fxPintarPresets();if(PANES&&PANES.length){defsPanes();pintarPanes();if(typeof fit==='function')fit()}fxPedir();
 console.log('filtros_pro: activo, '+FXPRESETS.length+' presets');
})();
