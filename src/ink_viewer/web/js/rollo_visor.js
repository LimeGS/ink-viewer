/* Per-scroll physical scale comes from the selected dataset. Missing scale stays unknown. */
(function(){
 var pedido=new URLSearchParams(location.search).get('rollo');
 var porOrigen=window.VISOR_ORIGEN?.scroll||window.ROLLO_SERVIDOR?.scroll;
 var rollo=(pedido&&/^PHerc[0-9A-Za-z]+$/.test(pedido))?pedido:porOrigen||'PHerc1447';
 window.ROLLO=rollo;window.ROLLO_CORTO=rollo.replace(/^PHerc/,'');
 var cache=new Map(Object.entries(window.VISOR_BOOTSTRAP?.rollos||{})),srv=window.ROLLO_SERVIDOR||null;
 if(srv&&srv.scroll)cache.set(srv.scroll,srv);
 window.visorRolloDe=function(g){return g?.scroll||g?.catalogMeta?.scroll||
  Object.values(g?.frames||{}).map(f=>/catalog\/(PHerc[0-9A-Za-z]+)\//.exec(f)?.[1]).find(Boolean)||window.VISOR_METADATA?.scroll||rollo};
 window.visorMetadataRollo=function(r){
  if(cache.has(r))return cache.get(r);
  var d={scroll:r,voxel_um:null};
  /* The same metadata endpoint serves startup and in-page scroll switches. Never reuse another scroll's scale. */
  if(!window.VISOR_STATIC && /^PHerc[0-9A-Za-z]+$/.test(r)){
  try{var x=new XMLHttpRequest();x.open('GET','/api/rollo.js?rollo='+encodeURIComponent(r),false);x.send();
   if(x.status===200){var t=x.responseText.replace(/^\s*window\.ROLLO_SERVIDOR=/,'').replace(/;\s*$/,'');var info=JSON.parse(t);
    if(info&&info.scroll===r)d=info;}}catch(e){}
  }
  cache.set(r,d);return d;
 };
 window.visorActivarRollo=function(r){
  var d=window.visorMetadataRollo(r),p=d.paso_hoja_um;
  window.ROLLO=r;window.ROLLO_CORTO=r.replace(/^PHerc/,'');window.ROLLO_JSON=d;
  window.VOXEL_UM=Number.isFinite(+d.voxel_um)&&+d.voxel_um>0?+d.voxel_um:null;
  window.PASO_HOJA_UM=window.VOXEL_UM&&Array.isArray(p)&&p.length===2&&p.every(function(x){return +x>0})&&+p[0]<=+p[1]?[+p[0],+p[1]]:null;
 };
 window.visorUmPorPixel=function(g){
  for(var v of [g?.um_por_px,g?.catalogMeta?.um_por_px])if(v!=null&&v!==''&&Number.isFinite(+v)&&+v>0)return +v;
  var d=window.visorMetadataRollo(window.visorRolloDe(g));return Number.isFinite(+d.voxel_um)&&+d.voxel_um>0?+d.voxel_um:null;
 };
 window.visorActivarRollo(rollo);
})();
