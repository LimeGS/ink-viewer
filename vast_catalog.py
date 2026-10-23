"""Read-only discovery of existing Vast visual artifacts. Writes only deployment indexes."""
import argparse, collections, hashlib, json, math, os, re, time
from pathlib import Path
from PIL import Image
import master_inventory as master

ROOTS = [Path('/workspace/operations/vesuvius'), Path('/root/v8in/cand/hcnet')]
CANONICAL = Path('/workspace/catalog')
SKIP = {'.git','__pycache__','environment','env','.venv','vendor','source','uv-cache',
        'site-packages','build','browsers','node_modules','runtime','raw','camadas',
        'volumes','layers','python','include','lib','bin','code','controller_code',
        'hecate_code','public_models','display_code','repo'}
IMAGE_SUFFIXES={'.png','.jpg','.jpeg'}
Image.MAX_IMAGE_PIXELS=1_000_000_000

def allowed(path):
    p=Path(path).resolve()
    return any(p.is_relative_to(r.resolve()) for r in ROOTS+[CANONICAL])

def sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()

def write(path,value):
    p=Path(path);p.parent.mkdir(parents=True,exist_ok=True)
    tmp=p.with_suffix(p.suffix+'.new');tmp.write_text(json.dumps(value,ensure_ascii=False))
    os.replace(tmp,p)

def build_v5_index(runs, catalog=CANONICAL):
    """Publish existing scores only for the exact catalog runs shown by this deployment."""
    catalog = Path(catalog).resolve()
    canonical = [r for r in runs if r.get('canonicalCatalog')]
    rolls = collections.defaultdict(set)
    for run in canonical:
        rolls[run['catalogMeta']['lam']].add(run['scroll'])
    models, missing, errors = {}, [], []
    for run in canonical:
        try:
            sidecar = (catalog / (run['sourceDirectory'] + '.json')).resolve()
            if not sidecar.is_relative_to(catalog):
                raise ValueError('Sidecar outside the canonical catalog')
            doc = json.loads(sidecar.read_text())
            segment, roll, model = run['catalogMeta']['lam'], run['scroll'], run['catalogMeta']['modelo']
            if (doc.get('segment'), doc.get('sample'), (doc.get('model') or {}).get('name')) != (segment, roll, model):
                raise ValueError('Sidecar segment, scroll or model does not match the displayed run')
            score = (doc.get('scores') or {}).get('v5')
            if not score:
                missing.append(run['id'])
                continue
            value = score.get('max')
            if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError('Invalid measured v5 score')
            if score.get('modelo', model) != model:
                raise ValueError('Score model does not match the displayed run')
            key = roll + '/' + segment if len(rolls[segment]) > 1 else segment
            measured = {k: v for k, v in score.items() if k != 'por_modelo'}
            measured.update(modelo=model, rollo=roll, id=run['id'], sidecar=str(sidecar.relative_to(catalog)))
            by_model = models.setdefault(key, {})
            if model not in by_model or value > by_model[model]['max']:
                by_model[model] = measured
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
            errors.append({'run': run.get('id'), 'error': str(e)})
    laminas = {key: dict(max(values.values(), key=lambda score: score['max']), por_modelo=values)
               for key, values in models.items()}
    return {'que': 'Existing v5 measurements from the exact displayed catalog run sidecars; no inference.',
            'generado': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'canonical_root': str(catalog), 'laminas': laminas, 'unscored_runs': missing, 'errors': errors}

def build(site):
    site=Path(site);data=site/'cache';idx=data/'catalog/_viewer';idx.mkdir(parents=True,exist_ok=True)
    errors=[];images=set();metadata={};skipped=collections.Counter();mesh_dirs=set()
    def load(p):
        p=Path(p)
        if not allowed(p):return None
        key=str(p)
        if key not in metadata:
            try:
                if p.stat().st_size>4*1024*1024:return None
                value=json.loads(p.read_text())
                metadata[key]=value if isinstance(value,dict) else None
            except FileNotFoundError:metadata[key]=None
            except (OSError,ValueError) as e:errors.append({'path':key,'error':str(e)});metadata[key]=None
        return metadata[key]
    for root in ROOTS:
        if not root.is_dir():errors.append({'path':str(root),'error':'Root absent'});continue
        for d,ds,fs in os.walk(root,followlinks=False,onerror=lambda e:errors.append({'error':str(e)})):
            for n in ds:
                if n.endswith('.tifxyz') and allowed(Path(d)/n):mesh_dirs.add((Path(d)/n).resolve())
            if {'x.tif','y.tif','z.tif'}.issubset(fs):mesh_dirs.add(Path(d).resolve())
            ds[:]=[n for n in ds if n not in SKIP and not n.startswith('.') and not n.endswith(('.zarr','.camadas','.tifxyz'))]
            for n in fs:
                p=Path(d)/n
                if p.suffix.lower() in IMAGE_SUFFIXES or (p.suffix.lower() in {'.tif','.tiff'} and ('published' in n or 'inklabels' in n or 'supervision' in n)):
                    if allowed(p):images.add(p.resolve())
    assets={};runs=[];masks=[];used=set();families=collections.Counter()
    def inspect(p,expected=None):
        p=Path(p).resolve();key=str(p)
        if key in assets:return assets[key]
        a={'path':key,'expected_sha256':expected,'state':'AVAILABLE'}
        try:
            st=p.stat()
            if not p.is_file():raise ValueError('Not a file')
            a.update(bytes=st.st_size,mtime_ns=st.st_mtime_ns,sha256=sha(p))
            with Image.open(p) as im:
                a.update(dimensions=list(im.size),mode=im.mode,pages=getattr(im,'n_frames',1))
            if expected and expected!=a['sha256']:a['state']='HASH_MISMATCH'
        except FileNotFoundError:a.update(state='MISSING',bytes=0,sha256='')
        except (OSError,ValueError,Image.DecompressionBombError) as e:a.update(state='UNREADABLE',error=str(e),bytes=0,sha256='')
        assets[key]=a;return a
    def sidecar(p):
        stems=[p.stem]
        for suffix in ['_on_CT','_map','_map_horiz','_on_CT_horiz']:
            if p.stem.endswith(suffix):stems.append(p.stem[:-len(suffix)])
        for stem in stems:
            q=p.with_name(stem+'.json')
            if q.is_file() and (m:=load(q)) is not None:return q,m
        for name in ['receipt.json','resumen.json','render.json']:
            q=p.parent/name
            if q.is_file() and (m:=load(q)) is not None:return q,m
        return None,{}
    def declarations(receipt):
        result={}
        for name,value in (receipt.get('outputs') or {}).items():
            if isinstance(value,str) and re.fullmatch('[a-f0-9]{64}',value):result[name]=value
        for f in receipt.get('files') or []:
            if isinstance(f,dict) and f.get('path'):result[f['path']]=f.get('sha256')
        return result
    def evidence(p,mp,m):
        result={'source_path':str(p),'receipt_path':str(mp) if mp else None,'receipt':m,
                'automatic_orientation_transform':False,'registration':'unverified'}
        refs={};mesh={}
        inp=m.get('input_manifest')
        if isinstance(inp,dict):inp=inp.get('path')
        if isinstance(inp,str) and allowed(inp) and (v:=load(inp)) is not None:
            result['input_manifest']={'path':inp,'metadata':v}
            for f in v.get('files') or []:
                if isinstance(f,dict) and '.tifxyz/' in f.get('path',''):
                    mesh[f['path']]=f.get('sha256')
        result['mesh_files_declared']=mesh
        for key in ['centre','depth','ct_layer','direction','orientation','orientacion','rot_deg',
                    'geometry_version','physical_qualification','render_receipt_sha256','input_manifest_sha256']:
            if key in m:result[key]=m[key]
        if 'ct_layer' in m:
            result.update(depth_known=True,depth_kind='ct_layer',depth_label='Capa CT '+str(m['ct_layer']))
        elif 'centre' in m or 'depth' in m:
            result.update(depth_known=True,depth_kind='surface_offset',depth_label='Centro '+str(m.get('centre',m.get('depth'))))
        else:result.update(depth_known=False,depth_kind='unknown',depth_label='Profundidad sin declarar')
        return result
    # Real local pairs; retain original pixels and provenance. No guessed registration.
    for p in sorted(images):
        if p.name!='I.png':continue
        partner=p.with_name('S.png');pair=[p]+([partner] if partner in images else [])
        used.update(pair);records=[]
        for role,q in zip(['I','S'],pair):
            a=inspect(q);records.append(dict(role=role,canonical=str(q),source=str(q),bytes=a['bytes'],sha256=a['sha256']))
        dep=re.fullmatch(r'c([+-]\d+)',p.parent.name);depth=int(dep[1]) if dep else None
        dataset=next((x for x in p.parents if (x/'labels').is_dir()),p.parent)
        originals=[]
        prov=dataset/'provenance/original'
        if prov.is_dir():
            for q in sorted(prov.glob('*.json')):
                if (d:=load(q)) is not None:originals.append({'path':str(q),'metadata':d})
        masks.append({'id':master.identifier(*[a['sha256'] for a in records],str(p)),
            'roll':'unknown','segment':None,'declared_surface':dataset.name,'depth':depth,
            'series':dataset.name,'type':'Manual local · procedencia conservada',
            'unit':'I/S' if len(pair)==2 else 'ink_only','association':'pending_registration',
            'assets':records,'I':str(p),'S':str(partner) if len(pair)==2 else None,
            'localEvidence':{'original_metadata':originals,'registration':'No hay evidencia de la misma cuadrícula con los mapas actuales; inspección nativa.'}})
    candidates=set(images-used)
    # Include declared PNG outputs that are absent, rather than silently dropping them.
    for p in sorted(candidates):
        mp,m=sidecar(p)
        for name in declarations(m):
            q=Path(name) if name.startswith('/') else p.parent/name
            if q.suffix.lower() in IMAGE_SUFFIXES and allowed(q):candidates.add(q)
    for p in sorted(candidates):
        mp,m=sidecar(p);decl=declarations(m);expected=decl.get(p.name,decl.get(str(p)))
        a=inspect(p,expected);ev=evidence(p,mp,m)
        roll=m.get('scroll') or m.get('roll') or 'unknown'
        if not re.fullmatch(r'PHerc[A-Za-z0-9]+',str(roll)):roll='unknown'
        label=str(p.relative_to(next(r for r in ROOTS if p.is_relative_to(r))))
        family='hcnet' if p.is_relative_to(ROOTS[1]) else '/'.join(Path(label).parts[:3])
        name=m.get('segment') or family+' · '+p.parent.name
        kind='map_association_pending'
        entry={'roll':roll,'name':name,'kind':kind}
        rid='vast-'+master.identifier(str(p));frame='../catalog/_vast/'+master.identifier(str(p))
        depth=m.get('centre',m.get('depth',m.get('ct_layer',0)))
        if not isinstance(depth,int):depth=0
        run={'id':rid,'label':label,'scroll':roll,'frames':{str(depth):frame},
            'availableContrasts':['fixed'],'frameContrasts':{frame:['fixed']},
            'catalogMeta':{'lam':name,'modelo':str(m.get('model_id') or m.get('model') or m.get('family') or p.stem),
                           'fam':family,'scroll':roll,'depthKnown':ev['depth_known'],'originalContrast':True,
                           'physicalScaleVerified':False,'projectionOnly':False,
                           'cara':{'forward':'fwd','reverse':'rev'}.get(m.get('direction'),'unknown')},
            'mapAvailable':a['state']=='AVAILABLE','maskAvailable':False,'renderGrid':{},
            'meshAssociation':{'status':'UNVERIFIED','basis':'Local receipts retained; no registration inferred'},
            'vastEntry':entry,'sourceDirectory':str(p.parent),
            'localEvidence':ev,'vastAsset':str(p)}
        runs.append(run);families[family]+=1
    meshes={}
    for p in sorted(mesh_dirs):
        resources=[]
        for n in ['x.tif','y.tif','z.tif','meta.json']:
            q=p/n;rel='catalog/_vast-mesh/'+master.identifier(str(p))+'/'+n
            state='MISSING';size=0
            try:
                st=q.stat()
                with q.open('rb'):pass
                state='AVAILABLE';size=st.st_size
                assets[str(q)]={'path':str(q),'state':state,'bytes':size,'mtime_ns':st.st_mtime_ns,'sha256':None,'kind':'mesh_resource'}
            except FileNotFoundError:pass
            except OSError as e:state='UNREADABLE';errors.append({'path':str(q),'error':str(e)})
            resources.append({'name':n,'state':state,'bytes':size,'path':str(q),'url':'/'+rel if state=='AVAILABLE' else None})
        rollmatch=re.search(r'(PHerc[A-Za-z0-9]+)',p.name);roll=rollmatch[1] if rollmatch else 'unknown'
        key=master.identifier(roll,p.name+' · '+master.identifier(str(p))[:8],'mesh_local')
        meshes[key]={'key':key,'roll':roll,'segment':p.name+' · '+master.identifier(str(p))[:8],
                     'kind':'mesh_local','catalog_path':str(p),'resources':resources,'mesh_metadata':load(p/'meta.json')}
    registry={'schema':'vast-local-assets.v1','roots':list(map(str,ROOTS)),
              'assets':assets,'routes':{master.frame_path(next(iter(r['frames'].values()))):r['vastAsset'] for r in runs}}
    registry['meshes']=meshes
    for m in meshes.values():
        for r in m['resources']:
            if r['url']:registry['routes'][r['url'][1:]]=r['path']
    write(data/'_viewer/index-info.json',{'schema':'vesuvius.viewer-index.v1','layout':'docroot','scroll':None})
    write(data/'_viewer/manifest.json',runs);write(idx/'manifest.json',runs)
    write(idx/'canonical-masks.json',{'schema':'canonical-masks.v1','records':masks})
    write(data/'_viewer/vast-assets.json',registry)
    summary=master.build(data/'catalog')
    summary['coverage']='Existing local PNG/JPEG visual artifacts and published 2D TIFF maps; local I/S masks. Declared missing PNG outputs retained. Volumes, CT slices, TIFXYZ coordinates, dependencies and code screenshots excluded.'
    import sqlite3
    summary['mesh_entries']=len(meshes);summary['entries']+=len(meshes)
    with sqlite3.connect(idx/master.DB_NAME) as c:
        for m in meshes.values():c.execute('INSERT OR IGNORE INTO segments(key,roll,segment,kind) VALUES(?,?,?,?)',(m['key'],m['roll'],m['segment'],m['kind']))
        c.execute('UPDATE metadata SET value=? WHERE key="summary"',(master.dump(summary),))
    coverage={'utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'master_commit':'cebedb4059bc1e246c1bbef5a385358ec7e670d5',
              'summary':summary,'asset_states':dict(collections.Counter(a['state'] for a in assets.values())),
              'map_images':len(runs),'mesh_entries':len(meshes),'mask_pairs':len(masks),'mask_files':sum(len(m['assets']) for m in masks),
              'families':dict(families),'errors':errors,'excluded_directory_names':sorted(SKIP),
              'scanned_roots':list(map(str,ROOTS)),'source_copies':0,'new_inference':False}
    write(site/'coverage.json',coverage);return coverage

def build_canonical(site):
    """Inventory the real canonical root, keeping all generated indexes outside it."""
    import sqlite3
    from fuentes import Fuente
    from generar_manifest import construir
    site=Path(site);cache=site/'cache';idx=cache/'catalog/_viewer'
    regpath=cache/'_viewer/vast-assets.json';registry=json.loads(regpath.read_text())
    runs=[r for r in json.loads((cache/'_viewer/manifest.json').read_text()) if not r.get('canonicalCatalog')]
    source=Fuente(str(CANONICAL));canonical_runs,report=construir(source,verificar_mallas=False)
    segments={};image_states=collections.Counter();canonical_routes=0;errors=[]
    def asset(p,route,expected=None):
        p=Path(p).resolve();a={'path':str(p),'route':route,'kind':'canonical_resource','expected_sha256':expected,'sha256':None,'state':'AVAILABLE'}
        try:
            st=p.stat();a.update(bytes=st.st_size,mtime_ns=st.st_mtime_ns)
            with p.open('rb'):pass
            if p.suffix.lower() in {'.png','.jpg','.jpeg'}:
                with Image.open(p) as im:a.update(dimensions=list(im.size),mode=im.mode,pages=getattr(im,'n_frames',1))
        except FileNotFoundError:a.update(state='MISSING',bytes=0)
        except (OSError,ValueError) as e:a.update(state='UNREADABLE',bytes=0,error=str(e));errors.append({'path':str(p),'error':str(e)})
        registry['assets'][str(p)]=a;registry['routes'][route]=str(p)
        return a
    for roll in sorted(CANONICAL.glob('PHerc*')):
        folder=roll/'segments'
        if not folder.is_dir():continue
        for seg in sorted(folder.iterdir()):
            if not seg.is_dir() or seg.is_symlink():continue
            resources=[];entry={}
            ep=seg/'catalog-entry.json'
            if ep.is_file():
                try:entry=json.loads(ep.read_text())
                except (OSError,ValueError) as e:errors.append({'path':str(ep),'error':str(e)})
            declared=entry.get('mesh_inputs_sha256') or {}
            for q in [ep]+[seg/'mesh/tifxyz'/n for n in ['x.tif','y.tif','z.tif','meta.json']]:
                route='catalog/'+str(q.relative_to(CANONICAL));a=asset(q,route,declared.get(q.name))
                resources.append({'name':str(q.relative_to(seg)),'state':a['state'],'bytes':a['bytes'],'path':str(q),'url':'/'+quote_path(route) if a['state']=='AVAILABLE' else None})
            key=master.identifier(roll.name,seg.name,'segment')
            segments[key]={'catalog_path':str(seg),'canonical_root':str(CANONICAL),'resources':resources,'mesh_metadata':entry,
                           'key':key,'roll':roll.name,'segment':seg.name,'kind':'segment'}
            ink=seg/'ink-detection'
            if ink.is_dir():
                for p in ink.iterdir():
                    if p.is_file() and p.suffix.lower() in {'.png','.jpg','.jpeg'}:
                        route='catalog/'+str(p.relative_to(CANONICAL));a=asset(p,route);image_states[a['state']]+=1;canonical_routes+=1
                previews=ink/'downsampled'
                if previews.is_dir():
                    for p in previews.iterdir():
                        if p.is_file() and p.suffix.lower() in {'.png','.jpg','.jpeg'}:
                            route='catalog/'+str(p.relative_to(CANONICAL));asset(p,route)
    for run in canonical_runs:
        run['canonicalCatalog']=True
        sm=next((re.search(r'catalog/([^/]+)/segments/([^/]+)/',f) for f in run['frames'].values()),None)
        if not sm:continue
        roll,name=sm[1],sm[2];sk=master.identifier(roll,name,'segment');seg=CANONICAL/roll/'segments'/name
        run['vastEntry']={'roll':roll,'name':name,'kind':'segment'}
        receipt_metadata=[]
        for f in run['frames'].values():
            for contrast in run['availableContrasts']:
                rel=master.frame_path(f,contrast);p=CANONICAL/rel.removeprefix('catalog/')
                if str(p) not in registry['assets']:
                    a=asset(p,rel);image_states[a['state']]+=1
                    preview=p.parent/'downsampled'/(p.stem+'-ds4.jpg')
                    if preview.is_file():
                        pr='catalog/'+str(preview.relative_to(CANONICAL));asset(preview,pr);a['preview']=str(preview)
        # Receipts are retained as evidence, including historical origin paths;
        # every served image route resolves exclusively to its actual local file.
        ink=seg/'ink-detection'
        if ink.is_dir():
            stem=Path(master.frame_path(next(iter(run['frames'].values())))).stem
            stem=re.sub(r'-c[+-]\d+$','',stem)
            receipt_dir=ink/(stem+'.receipts')
            for suffix in ['run','c+00']:
                d=receipt_dir/suffix
                if d.is_dir():
                    for p in d.glob('*.json'):
                        if p.stat().st_size<2*1024*1024:
                            try:receipt_metadata.append({'path':str(p),'metadata':json.loads(p.read_text())})
                            except (OSError,ValueError) as e:errors.append({'path':str(p),'error':str(e)})
        run['localEvidence']={'canonical_root':str(CANONICAL),'catalog_path':str(seg),
            'catalog_entry':segments[sk]['mesh_metadata'],'run_receipts':receipt_metadata,
            'meshAssociation':run.get('meshAssociation'),'renderGrid':run.get('renderGrid'),
            'depth_known':run['catalogMeta'].get('depthKnown'),'depth_kind':'surface_offset',
            'automatic_orientation_transform':False,'registration':'Only catalog membership is established; physical qualification remains as declared.'}
    runs=canonical_runs+runs
    write(cache/'_viewer/legibilidad-auto.json',build_v5_index(runs))
    registry['canonical_root']=str(CANONICAL);registry['segments']=segments
    write(regpath,registry);write(cache/'_viewer/manifest.json',runs);write(idx/'manifest.json',runs)
    summary=master.build(cache/'catalog')
    with sqlite3.connect(idx/master.DB_NAME) as c:
        for e in segments.values():c.execute('INSERT OR IGNORE INTO segments(key,roll,segment,kind) VALUES(?,?,?,?)',(e['key'],e['roll'],e['segment'],e['kind']))
        for e in registry.get('meshes',{}).values():c.execute('INSERT OR IGNORE INTO segments(key,roll,segment,kind) VALUES(?,?,?,?)',(e['key'],e['roll'],e['segment'],e['kind']))
        summary.update(segments=len(segments),mesh_entries=len(registry.get('meshes',{})),entries=c.execute('SELECT count(*) FROM segments').fetchone()[0],
            rolls=[r[0] for r in c.execute('SELECT DISTINCT roll FROM segments ORDER BY roll')],canonical_root=str(CANONICAL),
            coverage='All existing /workspace/catalog segment directories and their local maps; separate supplementary Vast visuals/masks. Missing files and unverified physical registration retained.')
        c.execute('UPDATE metadata SET value=? WHERE key="summary"',(master.dump(summary),))
    cov=json.loads((site/'coverage.json').read_text());cov.update(canonical_root=str(CANONICAL),summary=summary,
        canonical_segments=len(segments),canonical_runs=len(canonical_runs),canonical_original_images=canonical_routes,
        canonical_image_states=dict(image_states),canonical_report=report,canonical_errors=errors,
        active_index_cache=str(cache),source_copies=0)
    write(site/'coverage.json',cov)
    print(json.dumps({k:cov[k] for k in ['canonical_root','canonical_segments','canonical_runs','canonical_original_images','canonical_image_states','summary','canonical_errors']}))

def quote_path(path):
    from urllib.parse import quote
    return quote(path,safe='/')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--site',required=True);args=p.parse_args();build(args.site);build_canonical(args.site)
