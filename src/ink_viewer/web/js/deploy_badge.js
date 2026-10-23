/* Identify a preview without adding anything to ordinary viewer deployments. */
fetch('/api/deploy').then(r=>r.ok?r.json():null).then(info=>{
 if(!info||!info.preview)return;
 const show=()=>{
  const badge=document.createElement('span');badge.id='viewerPreview';badge.textContent='PREVIEW · '+info.site;
  badge.title='Code '+info.commit+' · assets '+info.origin+' · annotations are separate from production';
  badge.style.cssText='position:fixed;bottom:4px;right:12px;z-index:10000;padding:3px 8px;border:1px solid #d9a441;border-radius:4px;background:#302718;color:#f7dba9;font:11px system-ui;pointer-events:none';
  document.body.append(badge);
 };
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',show,{once:true});else show();
}).catch(()=>{});
