/* ===== Preview browsing; annotation always uses the full-resolution image =====
   The full-res PNG (2-3 MB, 5-20 s over this link) is no longer loaded automatically. show() is wrapped: without HD it
   fetches the 1/4 preview (~30 KB), asks the proxy for the exact PNG size (/api/dims, 24 header bytes) and upscales the
   preview to that size on a canvas, so fit/zoom/panes/label masks see a full-size image. The "HD" button loads the real
   PNG for the current lamina; annotation locks HD on and waits for image/mask readiness before editing. */
(function(){
 const $=id=>document.getElementById(id);const KEY='vesuvius.hd';window.HD=localStorage.getItem(KEY)==='1';
 if(typeof show!=='function'||typeof group==='undefined'&&false){console.warn('hd: show() missing');return}
 const DIMS={};const dims=async rel=>{if(DIMS[rel])return DIMS[rel];const r=await fetch('/api/dims/'+rel.split('/').map(encodeURIComponent).join('/'));if(!r.ok)throw new Error('dims '+r.status);return DIMS[rel]=await r.json()};
 const show0=show;const previews=new Map();let previewPixels=0;
 // Retain only a few decoded-size equivalents; cached previews keep exact native dimensions.
 function remember(key,entry){previews.set(key,entry);previewPixels+=entry.w*entry.h;
  while(previews.size>1&&(previews.size>3||previewPixels>32e6)){
   const k=previews.keys().next().value,v=previews.get(k);previews.delete(k);previewPixels-=v.w*v.h;URL.revokeObjectURL(v.url)}
 }
 show=function(reset=false){
  if(typeof etiqOn!=='undefined'&&etiqOn){window.HD=true;paint_()}
  if(window.HD||!group)return show0(reset);
  if(!group.catalogMeta)for(const o of $('contrast').options)o.disabled=false;ensureContrast();
  let n=Number(slider.value),dir=projection?group.maximum:group.frames[n];
  // ponytail: TIFF uses the exact PNG path; add header dimensions if full-map latency matters.
  if(/\.tiff?$/i.test(dir||''))return show0(reset);
  $('offset').value=projection?'Max.':group.catalogMeta?.depthKnown===false?'Map':signed(n);pintarBanda(n);syncHash();
  $('prev').disabled=projection||n<=Number(slider.min);$('next').disabled=projection||n>=Number(slider.max);slider.disabled=projection||group.catalogMeta?.depthKnown===false;$('projection').hidden=!projection;$('max').classList.toggle('active',projection);$('max').setAttribute('aria-pressed',String(projection));
  let token=++request;$('notice').hidden=false;im.style.opacity='.3';
  if(!dir){$('notice').textContent='This centre is not available yet';im.hidden=true;$('download').removeAttribute('href');return}
  const png=mapUrl(dir,$('contrast').value),rel=png.replace('../',''),lo=mapUrl(dir,$('contrast').value,4);   /* dir is ../<col>/...: keep it for the <img>, strip it for /api/dims */
  $('notice').textContent='Loading preview…';
  const display=(u,W,H)=>{const changed=im.naturalWidth!==W||im.naturalHeight!==H;
    im.onload=()=>{if(token!==request)return;if(reset||changed||fitted)fit();else paint();fxPedir(true)};
    im.src=u;im.hidden=false;im.style.opacity=$('chkMapa').checked?$('mapOp').value:0;$('notice').hidden=true;$('download').href=png;
    im.alt=group.id+' · '+(projection?'maximum across depths':'centre '+signed(n))+' · preview';$('title').textContent=group.id+' · '+W+' × '+H+' px · preview (HD off)';
    /* 25-sep: con la vista traspuesta (orientacion de vista, index.html) el ancho y el alto en pantalla se cruzan */
    if(reset||changed||fitted){const[Wv,Hv]=typeof oriDims==='function'?oriDims(oriEf(group),W,H):[W,H];zoom=Math.min(vp.clientWidth/Wv,vp.clientHeight/Hv)*.96;x=(vp.clientWidth-Wv*zoom)/2;y=(vp.clientHeight-Hv*zoom)/2;fitted=true;paint()}
    trasFrame(W,H)};
  const cached=previews.get(rel);
  if(cached){previews.delete(rel);previews.set(rel,cached);display(cached.url,cached.w,cached.h);return}
  // Read the header concurrently with the JPEG, not after its load event.
  const known=group.frameDimensions?.[projection?'max':String(n)]?.[$('contrast').value];
  const size=Array.isArray(known)&&known.length===2&&known.every(v=>Number.isInteger(v)&&v>0)?
   Promise.resolve({w:known[0],h:known[1]}):Promise.race([dims(rel),new Promise((_,reject)=>setTimeout(()=>reject(new Error('dims timeout')),2500))]).catch(()=>null);
  const l=new Image();l.decoding='async';l.fetchPriority='high';
  l.onload=async()=>{if(token!==request)return;const dimensions=await size;if(token!==request)return;
   // A rounded preview cannot establish the physical raster: fall back to the exact PNG.
   if(!dimensions){show0(reset);return}
   const W=dimensions.w,H=dimensions.h,c=document.createElement('canvas');c.width=W;c.height=H;
   c.getContext('2d').drawImage(l,0,0,W,H);
   c.toBlob(b=>{c.width=c.height=0;if(token!==request||!b)return;
    const u=URL.createObjectURL(b);remember(rel,{url:u,w:W,h:H});display(u,W,H)},'image/jpeg',0.92)};

  l.onerror=()=>{if(token!==request)return;show0(reset)};   /* the HD path clears the loading state itself */   /* no preview: fall back to the HD path */
  l.src=lo};
 /* toolbar button */
 const b=document.createElement('button');b.id='hdBtn';b.textContent='HD';b.title='Load the full-resolution PNG for the laminae you open (slow over this link). Off = instant 1/4 previews upscaled.';
 const paint_=()=>{b.classList.toggle('active',window.HD);b.setAttribute('aria-pressed',String(window.HD));b.disabled=typeof etiqOn!=='undefined'&&etiqOn;b.title=b.disabled?'Full resolution is required while annotating':'Load full-resolution images. Preview mode is available when annotation is closed.'};
 window.requireAnnotationHD=v=>{if(v){window.HD=true;localStorage.setItem(KEY,'1')}paint_();if(v&&group&&!window.annotationImageReady())show(false)};
 b.onclick=()=>{if(typeof etiqOn!=='undefined'&&etiqOn)return;window.HD=!window.HD;localStorage.setItem(KEY,window.HD?'1':'0');paint_();if(group)show(false)};paint_();
 const anchor=$('render');anchor&&anchor.parentElement&&anchor.parentElement.insertBefore(b,anchor);
 console.log('hd: modo '+(window.HD?'HD':'preview'));
})();
