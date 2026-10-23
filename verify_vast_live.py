"""Read-only live checks against the actual Vast deployment and source files."""
import argparse, hashlib, io, json, sqlite3, urllib.error, urllib.parse, urllib.request
from pathlib import Path
from PIL import Image

def main():
    p=argparse.ArgumentParser();p.add_argument('--site',required=True);a=p.parse_args();site=Path(a.site)
    base='http://127.0.0.1:8798'
    def get(path):
        with urllib.request.urlopen(base+path,timeout=60) as f:return json.load(f)
    def body(path,method='GET'):
        with urllib.request.urlopen(urllib.request.Request(base+path,method=method),timeout=60) as f:return f.read(),dict(f.headers)
    info=get('/api/origen');assert info['origen']=='/workspace/catalog';assert info['canonical_root']=='/workspace/catalog';assert info['layout']=='catalog';assert not info['escritura']
    listing=get('/api/inventario?kind=segment&limit=1');assert listing['total']==963
    c=sqlite3.connect(site/'cache/catalog/_viewer/master-inventory.sqlite');allruns=[(k,s,json.loads(b)) for k,s,b in c.execute('SELECT key,segment_key,data FROM runs')]
    canonical=[r for r in allruns if r[2].get('canonicalCatalog')]
    selected=canonical[:2]+[r for r in allruns if Path(r[2].get('vastAsset','')).name in ['MAN32kfine_p98_g1.0_on_CT.png','FT3fine_horiz_on_CT.png']]
    results=[];links=[]
    for key,sk,r in selected:
        depth='0' if '0' in r['frames'] else next(iter(r['frames']))
        for contrast in r['availableContrasts']:
            mi=get('/api/inventario-mapa?'+urllib.parse.urlencode({'run':key,'depth':depth,'contrast':contrast}));assert mi['available'],mi
            if r.get('canonicalCatalog'):assert Path(mi['path']).is_relative_to('/workspace/catalog')
            b,h=body(mi['url']);assert h['X-Fuente']=='local'
            digest=hashlib.sha256(b).hexdigest();assert digest==hashlib.sha256(Path(mi['path']).read_bytes()).hexdigest()
            with Image.open(io.BytesIO(b)) as im:assert list(im.size)==mi['dimensions']
            results.append({'path':mi['path'],'url':mi['url'],'sha256':digest,'dimensions':mi['dimensions'],'contrast':contrast,'origin':'local'})
        q={'inventario':sk,'run':key,'depth':depth,'contrast':'fixed'}
        links.append({'name':r['label'],'source_path':mi['path'],'url':base+'/all-gallery/index.html#'+urllib.parse.urlencode(q)})
    masks=get('/api/mascaras-canonicas')['records'];assert len(masks)==10
    mask_results=[]
    for m in masks:
        for asset in m['assets']:
            b,h=body(asset['url']);assert hashlib.sha256(b).hexdigest()==asset['sha256']
            ni=get('/api/inventario-nativa?'+urllib.parse.urlencode({'mask':m['id'],'role':asset['role']}));assert ni['dimensions']==[4221,4061]
            mask_results.append({'id':m['id'],'role':asset['role'],'path':ni['path'],'sha256':asset['sha256']})
    # Attempting to pair unrelated local masks with a canonical map must be rejected.
    rejected=get('/api/inventario-overlay?'+urllib.parse.urlencode({'run':canonical[0][0],'mask':masks[0]['id'],'depth':'0','contrast':'fixed'}));assert not rejected['eligible']
    registry=json.loads((site/'cache/_viewer/vast-assets.json').read_text());missing=[]
    for key,sk,r in allruns:
        ap=r.get('vastAsset')
        if ap and registry['assets'][ap]['state']=='MISSING':
            depth=next(iter(r['frames']));mi=get('/api/inventario-mapa?'+urllib.parse.urlencode({'run':key,'depth':depth,'contrast':'fixed'}));assert not mi['available'] and mi['state']=='MISSING'
            missing.append({'path':ap,'reason':mi['reason'],'url':base+'/all-gallery/index.html#'+urllib.parse.urlencode({'inventario':sk,'run':key,'depth':depth,'contrast':'fixed'})})
    assert len(missing)==4
    mesh_detail=get('/api/inventario/'+canonical[0][1]);assert mesh_detail['catalog_path'].startswith('/workspace/catalog/')
    for res in mesh_detail['resources']:
        if res['state']=='AVAILABLE':
            b,h=body(res['url'],method='HEAD');assert int(h['Content-Length'])==Path(res['path']).stat().st_size
    for path in ['/api/origen','/api/mascara-par/test']:
        try:body(path,method='POST');raise AssertionError('Write accepted')
        except urllib.error.HTTPError as e:assert e.code==405
    socket_result={}
    import socket
    for port in [46537,8798]:
        s=socket.socket();socket_result[str(port)]=s.connect_ex(('127.0.0.1',port))==0;s.close()
    assert all(socket_result.values())
    out={'status':'PASS','canonical_root':info['origen'],'index_cache':info['index_cache'],'canonical_segments':listing['total'],
        'canonical_runs':len(canonical),'maps':results,'mask_assets_hash_verified':len(mask_results),'mask_results':mask_results,
        'unverified_overlay_rejected':rejected,'missing':missing,'mesh_resources_head_verified':mesh_detail['resources'],
        'writes_rejected':True,'ports':socket_result,'links':links,'browser_check':'pending Mac UI verification'}
    (site/'LIVE_VERIFICATION.json').write_text(json.dumps(out,ensure_ascii=False,indent=2))
    print(json.dumps({k:out[k] for k in ['status','canonical_root','index_cache','canonical_segments','canonical_runs','mask_assets_hash_verified','writes_rejected','ports','links','missing']},ensure_ascii=False))

if __name__=='__main__':main()
