"""Catalog inventory and evidence-gated map/mask inspection. No scientific data writes."""
import argparse, collections, hashlib, io, json, os, re, sqlite3, threading, time
from pathlib import Path
from urllib.parse import quote, unquote
from contextlib import closing,contextmanager
import ink_viewer.server.canonical_masks as canonical

DB_NAME='master-inventory.sqlite'
_build_lock=threading.Lock()
_refresh_status={'state':'ready'}
_checked={}
_overlay_cache={}
_orientation_cache={}

def identifier(*parts):return hashlib.sha256('\0'.join(map(str,parts)).encode()).hexdigest()[:32]
def dump(x):return json.dumps(x,ensure_ascii=False,separators=(',',':'))
def root(source):
    if not source or source.tipo!='local':raise ValueError('El inventario maestro requiere el catálogo local')
    if hasattr(source,'vast_index_root'):return source.vast_index_root
    return Path(source.origen)/'catalog'
def fingerprints(cat):
    paths=[cat/'_viewer'/n for n in ('manifest.json','manifest-work3.json','canonical-masks.json','canonical-zarr-masks.json','orientacion_vista.json')]
    paths += [p/'segments' for p in cat.iterdir() if p.name.startswith('PHerc') and (p/'segments').is_dir()]
    return {str(p.relative_to(cat)):[p.stat().st_size,p.stat().st_mtime_ns] for p in paths if p.exists()}
def db_path(cat):return cat/'_viewer'/DB_NAME

def frame_path(frame,contrast='fixed'):
    value=unquote(str(frame)).removeprefix('../').lstrip('/')
    if not value or '?' in value or '#' in value or '..' in Path(value).parts or not value.startswith('catalog/'):return None
    if '/ink-detection/' in value:
        suffix=Path(value).suffix
        if suffix.lower() in ('.png','.tif','.tiff'):return value[:-len(suffix)]+('-global' if contrast=='global' else '')+suffix
        return value+('-global' if contrast=='global' else '')+'.png'
    return value+'/'+contrast+'.png'

def build(cat):
    cat=Path(cat);before=fingerprints(cat);target=db_path(cat);temp=target.with_name(target.name+'.building-'+str(os.getpid()))
    if temp.exists():temp.unlink()
    conn=sqlite3.connect(temp)
    conn.executescript('''PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
CREATE TABLE segments(key TEXT PRIMARY KEY,roll TEXT,segment TEXT,kind TEXT,map_count INTEGER DEFAULT 0,mask_count INTEGER DEFAULT 0,zarr_count INTEGER DEFAULT 0);
CREATE TABLE runs(key TEXT PRIMARY KEY,segment_key TEXT,id TEXT,data TEXT);
CREATE TABLE masks(id TEXT PRIMARY KEY,segment_key TEXT,unit TEXT,data TEXT);
CREATE TABLE zarrs(id TEXT PRIMARY KEY,segment_key TEXT,data TEXT);
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
CREATE INDEX runs_segment ON runs(segment_key);CREATE INDEX masks_segment ON masks(segment_key);CREATE INDEX zarrs_segment ON zarrs(segment_key);
CREATE INDEX segments_roll ON segments(roll);CREATE INDEX segments_name ON segments(segment);
''')
    def segment(roll,name,kind='segment'):
        key=identifier(roll,name,kind);conn.execute('INSERT OR IGNORE INTO segments(key,roll,segment,kind) VALUES(?,?,?,?)',(key,roll,name,kind));return key
    for roll in cat.iterdir():
        if roll.name.startswith('PHerc') and (roll/'segments').is_dir():
            conn.executemany('INSERT OR IGNORE INTO segments(key,roll,segment,kind) VALUES(?,?,?,?)',((identifier(roll.name,p.name,'segment'),roll.name,p.name,'segment') for p in os.scandir(roll/'segments') if p.is_dir(follow_symlinks=False)))
    for filename in ('manifest-work3.json','manifest.json'):
        path=cat/'_viewer'/filename
        if not path.exists():continue
        for run in json.loads(path.read_text()):
            frames=dict(run.get('frames') or {})
            if run.get('maximum'):frames['max']=run['maximum']
            entries=[m.groups() for f in frames.values() if (m:=re.search(r'catalog/([^/]+)/segments/([^/]+)/',str(f)))]
            unique=set(entries)
            if run.get('vastEntry'):
                roll,name,kind=(run['vastEntry'][k] for k in ('roll','name','kind'))
            elif len(unique)==1:roll,name=next(iter(unique));kind='segment'
            else:roll=run.get('scroll') or 'unknown';name=run.get('catalogMeta',{}).get('lam') or run.get('id','sin_identidad');kind='map_association_pending'
            sk=segment(roll,name,kind);rk=identifier(run.get('id'),dump(frames));run=dict(run,inventory_key=rk,segment_key=sk,inventory_segment=name,inventory_roll=roll)
            conn.execute('INSERT OR IGNORE INTO runs VALUES(?,?,?,?)',(rk,sk,run.get('id'),dump(run)))
    maskpath=cat/'_viewer/canonical-masks.json'
    if maskpath.exists():
        for r in json.loads(maskpath.read_text())['records']:
            roll=r['roll'];name=r.get('segment');kind='segment'
            if not name:
                name=r.get('declared_surface') or 'procedencia-'+identifier(str(Path(r.get('I','')).parent));kind='mask_association_pending'
            sk=segment(roll,name,kind);conn.execute('INSERT OR IGNORE INTO masks VALUES(?,?,?,?)',(r['id'],sk,r.get('unit',''),dump(r)))
    zp=cat/'_viewer/canonical-zarr-masks.json'
    if zp.exists():
        for r in json.loads(zp.read_text())['records']:
            roll,_,name=r['canonical_public_segment_key'].split('/');sk=segment(roll,name)
            conn.execute('INSERT INTO zarrs VALUES(?,?,?)',(r['id'],sk,dump(r)))
    conn.executescript('''UPDATE segments SET map_count=(SELECT count(*) FROM runs WHERE segment_key=segments.key),
 mask_count=(SELECT count(*) FROM masks WHERE segment_key=segments.key AND unit NOT IN ('filesystem_metadata','unpainted_template')),
 zarr_count=(SELECT count(*) FROM zarrs WHERE segment_key=segments.key);
''')
    summary={'utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'segments':conn.execute("SELECT count(*) FROM segments WHERE kind='segment'").fetchone()[0],
     'entries':conn.execute('SELECT count(*) FROM segments').fetchone()[0], 'map_runs':conn.execute('SELECT count(*) FROM runs').fetchone()[0],
     'mask_source_records':conn.execute('SELECT count(*) FROM masks').fetchone()[0], 'zarrs':conn.execute('SELECT count(*) FROM zarrs').fetchone()[0],
     'rolls':[r[0] for r in conn.execute('SELECT DISTINCT roll FROM segments ORDER BY roll')],
     'coverage':'All local catalog segment directories, both published map manifests, every canonical mask record, and every canonical ink9um Zarr. Missing map files and unresolved registration remain explicit.'}
    after=fingerprints(cat)
    if before!=after:conn.close();temp.unlink();raise RuntimeError('Los índices cambiaron durante la compilación; se conserva el índice anterior')
    for k,v in [('fingerprints',before),('summary',summary)]:conn.execute('INSERT INTO metadata VALUES(?,?)',(k,dump(v)))
    conn.commit();conn.close();os.chmod(temp,0o644);os.replace(temp,target)
    return summary

def maybe_refresh(cat):
    global _refresh_status
    now=time.monotonic();stamp=str(cat)
    if now-_checked.get(stamp,0)<60:return
    _checked[stamp]=now
    if not db_path(cat).exists():raise FileNotFoundError('Inventario maestro aún no compilado')
    with closing(sqlite3.connect('file:'+str(db_path(cat))+'?mode=ro',uri=True)) as c:prior=json.loads(c.execute('SELECT value FROM metadata WHERE key="fingerprints"').fetchone()[0])
    if prior==fingerprints(cat) or not _build_lock.acquire(False):return
    _refresh_status={'state':'refreshing'}
    def refresh():
        global _refresh_status
        try:build(cat);_refresh_status={'state':'ready'}
        except Exception as e:_refresh_status={'state':'error','error':str(e)}
        finally:_build_lock.release()
    threading.Thread(target=refresh,daemon=True).start()

@contextmanager
def connection(source):
    cat=root(source);maybe_refresh(cat);c=sqlite3.connect('file:'+str(db_path(cat))+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
    try:yield c
    finally:c.close()

def listing(source,params):
    with connection(source) as c:
        clauses=[];args=[]
        for param,column in [('roll','roll'),('kind','kind')]:
            if params.get(param):clauses.append(column+'=?');args.append(params[param][0])
        query=params.get('q',[''])[0].strip()
        if query:clauses.append('segment LIKE ?');args.append('%'+query+'%')
        if params.get('masks')==['1']:clauses.append('(mask_count>0 OR zarr_count>0)')
        if params.get('maps')==['1']:clauses.append('map_count>0')
        where=' WHERE '+' AND '.join(clauses) if clauses else ''
        total=c.execute('SELECT count(*) FROM segments'+where,args).fetchone()[0];offset=max(0,int(params.get('offset',['0'])[0]));limit=min(100,max(1,int(params.get('limit',['60'])[0])))
        rows=[dict(r) for r in c.execute('SELECT * FROM segments'+where+' ORDER BY (mask_count+zarr_count>0) DESC,(map_count>0) DESC,roll,segment LIMIT ? OFFSET ?',args+[limit,offset])]
        summary=json.loads(c.execute('SELECT value FROM metadata WHERE key="summary"').fetchone()[0]);return dict(total=total,rows=rows,summary=summary,refresh=_refresh_status)

def compact_mask(r):
    d=canonical.public_record(r);d.update(incomplete_roles=[a['role'] for a in r['assets'] if a['bytes']==0],unit=r.get('unit'),origins=1,source_ids=[r['id']],source_paths=[a['source'] for a in r['assets']],canonical_paths=[a['canonical'] for a in r['assets']],localEvidence=r.get('localEvidence'));return d

def detail(source,key):
    with connection(source) as c:
        row=c.execute('SELECT * FROM segments WHERE key=?',(key,)).fetchone()
        if row is None:raise FileNotFoundError('Entrada desconocida')
        runs=[json.loads(x[0]) for x in c.execute('SELECT data FROM runs WHERE segment_key=?',(key,))]
        masks={};aux=0
        for x in c.execute('SELECT data FROM masks WHERE segment_key=?',(key,)):
            r=json.loads(x[0])
            if r.get('unit')=='filesystem_metadata':aux+=1;continue
            sig=(r.get('depth'),r.get('unit'),tuple(a['sha256'] for a in r['assets']))
            if sig not in masks:masks[sig]=compact_mask(r)
            else:
                v=masks[sig];v['origins']+=1;v['source_ids'].append(r['id']);v['source_paths']+= [a['source'] for a in r['assets'] if a['source'] not in v['source_paths']]
                kind=r.get('type','').lower()
                if kind.startswith('a mano') or kind in ('declared_manual_snapshot','306b_manual_snapshot'):
                    # Keep the representative ID and assets consistent with the
                    # displayed manual declaration; preserve every origin alias.
                    v.update(canonical.public_record(r));v['canonical_paths']=[a['canonical'] for a in r['assets']]
        zarrs=[json.loads(x[0]) for x in c.execute('SELECT data FROM zarrs WHERE segment_key=?',(key,))]
        result=dict(row);result.update(runs=runs,masks=list(masks.values()),zarrs=zarrs,auxiliary_metadata_records=aux)
        # Only a shallow, on-demand view of segment metadata; no volume traversal.
        if row['kind']=='segment':
            base=root(source)/row['roll']/'segments'/row['segment'];result['catalog_path']=str(base)
            result['resources']=[{'name':x.name,'kind':'directory' if x.is_dir() else 'file'} for x in base.iterdir()] if base.is_dir() else []
        if hasattr(source,'vast_entry'):result.update(source.vast_entry(key))
        return result

def get_run(source,key):
    with connection(source) as c:row=c.execute('SELECT data FROM runs WHERE key=?',(key,)).fetchone()
    if row is None:raise FileNotFoundError('Corrida desconocida')
    return json.loads(row[0])

def map_info(source,run,depth,contrast='fixed'):
    if hasattr(source,'vast_map_info'):return source.vast_map_info(run,depth,contrast)
    from PIL import Image
    Image.MAX_IMAGE_PIXELS=1_000_000_000
    frame=run.get('maximum') if depth=='max' else run.get('frames',{}).get(str(depth))
    if not frame:return {'available':False,'reason':'Esta corrida no tiene mapa para esa profundidad'}
    allowed=(run.get('frameContrasts') or {}).get(frame,run.get('availableContrasts') or ['fixed'])
    if contrast not in allowed:return {'available':False,'reason':'Este contraste no está publicado para ese plano','state':'NOT_DECLARED_FOR_FRAME','available_contrasts':allowed}
    rel=frame_path(frame,contrast)
    if rel is None:return {'available':False,'reason':'Ruta histórica fuera del catálogo; falta reconciliar el mapa','declared_path':frame}
    path=(Path(source.origen)/rel).resolve();cat=root(source).resolve()
    if not path.is_relative_to(cat):raise ValueError('Mapa fuera del catálogo')
    original_path=str(path);representation='native'
    try:
        stat=path.stat()
        with Image.open(path) as im:size=list(im.size)
    except (OSError,ValueError) as e:
        # Published catalog naming contract: exact frame and contrast, never another depth.
        found=False
        if path.suffix.lower()=='.png' and path.parent.name=='ink-detection':
            for scale in (4,8):
                candidate=(path.parent/'downsampled'/(path.stem+'-ds'+str(scale)+'.jpg')).resolve()
                if not candidate.is_relative_to(cat):continue
                try:
                    stat=candidate.stat()
                    with Image.open(candidate) as im:size=list(im.size)
                except (OSError,ValueError):continue
                path=candidate;rel=str(path.relative_to(Path(source.origen).resolve()));representation='preview_ds'+str(scale);found=True;break
        if not found:return {'available':False,'reason':str(e),'path':str(path)}
    encoded='/'+quote(rel,safe='/')
    url='/api/mapa/'+quote(rel,safe='/')+'?escala=1' if path.suffix.lower() in ('.tif','.tiff') else encoded
    return {'available':True,'path':str(path),'url':url,'dimensions':size,'bytes':stat.st_size,'mtime_ns':stat.st_mtime_ns,'representation':representation,'original_path':original_path,'original_available':representation=='native'}

def map_request(source,params):
    run=get_run(source,params['run'][0]);return map_info(source,run,params.get('depth',['0'])[0],params.get('contrast',['fixed'])[0])

def orientation_index(source):
    path=root(source)/'_viewer/orientacion_vista.json'
    if not path.exists():return {},None
    stat=path.stat();key=(str(path),stat.st_mtime_ns,stat.st_size)
    if key not in _orientation_cache:
        _orientation_cache.clear();_orientation_cache[key]=json.loads(path.read_text()).get('corridas',{})
    return _orientation_cache[key],key

def display_pair(record,bodies):
    """Reversible display representation only; never changes stored/imported labels."""
    from PIL import Image, ImageChops, PngImagePlugin
    kind=record.get('type','').lower()
    if not (kind.startswith('a mano') or kind in ('declared_manual_snapshot','306b_manual_snapshot')):
        raise ValueError('La normalización visual requiere autoría manual declarada')
    result=[];proof=[];metadata=[]
    for body in bodies:
        with Image.open(io.BytesIO(body)) as im:
            im.load();raw=im.info.get('vesuvius:mascara_corrida')
            if not raw:raise ValueError('Faltan metadatos originales para la representación visual')
            metadata.append(json.loads(raw))
    shared=[{k:v for k,v in meta.items() if k!='editado_fuera_del_visor'} for meta in metadata]
    if shared[0]!=shared[1]:raise ValueError('Los metadatos geométricos del par difieren')
    display_meta=dict(shared[0])
    if any('editado_fuera_del_visor' in meta for meta in metadata):
        display_meta['display_original_edit_notes']={a['role']:meta.get('editado_fuera_del_visor') for a,meta in zip(record['assets'],metadata)}
    for asset,body in zip(record['assets'],bodies):
        with Image.open(io.BytesIO(body)) as im:
            im.load()
            if im.format!='PNG' or body[24]!=8 or im.mode not in ('L','LA','P','RGB','RGBA') or getattr(im,'n_frames',1)!=1 or not im.info.get('vesuvius:mascara_corrida'):
                raise ValueError('Faltan metadatos originales para la representación visual')
            channels=im.convert('RGBA').split()
            if channels[3].getextrema()!=(255,255):raise ValueError('La representación visual no interpreta transparencia')
            for channel in channels[:3]:
                if any(n and v not in (0,1,254,255) for v,n in enumerate(channel.histogram())):
                    raise ValueError('Hay valores fuera de 0/1/254/255; hace falta una receta de etiquetas')
            classes=[ch.point(lambda n:255 if n>=254 else 0) for ch in channels[:3]]
            if any(ImageChops.difference(classes[0],ch).getbbox() for ch in classes[1:]):
                raise ValueError('Los canales discrepan en la clase; no se normaliza')
            info=PngImagePlugin.PngInfo();info.add_itxt('vesuvius:mascara_corrida',json.dumps(display_meta,ensure_ascii=False))
            out=io.BytesIO();classes[0].save(out,format='PNG',pnginfo=info);result.append(out.getvalue())
            proof.append({'role':asset['role'],'source_sha256':asset['sha256'],'display_sha256':hashlib.sha256(out.getvalue()).hexdigest(),'dimensions':list(im.size),'positive_pixels':classes[0].histogram()[255]})
    return result,{'rule':'0/1 → 0; 254/255 → 255; canales concordantes y alfa 255','display_only':True,'coordinate_transform':'identity','original_metadata_by_role':{a['role']:meta for a,meta in zip(record['assets'],metadata)},'assets':proof}

def overlay(source,params,validate_pair):
    run=get_run(source,params['run'][0]);depth=params.get('depth',['0'])[0];depth='max' if depth=='max' else int(depth)
    data=canonical.inventory(source);r=data['by_id'].get(params['mask'][0]) if data else None
    reasons=[];result={'eligible':False,'reasons':reasons,'basis':None}
    if not r:reasons.append('Versión de máscara desconocida');return result
    if r.get('association')!='catalog_membership' or r.get('segment')!=run['inventory_segment'] or r['roll']!=run['inventory_roll']:reasons.append('La asociación de superficie no coincide o está pendiente');return result
    if r.get('depth')!=(None if depth=='max' else depth):reasons.append('La profundidad de la máscara no coincide');return result
    if len(r['assets'])!=2 or r.get('unit')!='I/S':reasons.append('Esta representación no es un par I/S apto para superposición');return result
    m=map_info(source,run,depth,params.get('contrast',['fixed'])[0])
    result['map']=m
    if not m['available']:reasons.append(m['reason']);return result
    if not m.get('original_available',True):reasons.append('Sólo está publicada la vista reducida del mapa; falta el original para validar la superposición');return result
    orientation,orientation_stamp=orientation_index(source)
    cache_key=(orientation_stamp,r['id'],run['inventory_key'],identifier(dump(run),dump(r)),params.get('contrast',['fixed'])[0],str(depth),m['bytes'],m['mtime_ns'],tuple((Path(a['canonical']).stat().st_mtime_ns,Path(a['canonical']).stat().st_size) for a in r['assets']))
    if cache_key in _overlay_cache:return _overlay_cache[cache_key]
    try:
        bodies=[canonical.read_asset(source,a) for a in r['assets']]
        base=r['roll']+'/segments/'+r['segment']
        try:sc=validate_pair(*bodies,None,r['segment'],base,depth,r['roll'])
        except ValueError as error:
            if str(error) not in ('La mascara debe ser opaca y gris: canales RGB identicos','Clases de mascara invalidas: solo 0 y 255'):raise
            display,proof=display_pair(r,bodies)
            sc=validate_pair(*display,None,r['segment'],base,depth,r['roll'])
            result['display_representation']=proof
        if sc is None:reasons.append('Faltan metadatos de corrida y cuadrícula en las máscaras')
        else:
            if [sc.get('ancho'),sc.get('alto')]!=m['dimensions']:reasons.append('Las dimensiones del mapa y la máscara difieren')
            if sc.get('cara')!=run.get('catalogMeta',{}).get('cara'):reasons.append('La cara/orientación declarada no coincide')
            mesh=(run.get('renderGrid') or {}).get('mesh_sha256') or run.get('meshAssociation',{}).get('meshSha256')
            if not mesh or sc.get('malla_sha256')!=mesh:reasons.append('Falta coincidencia de identidad de malla')
            same_run=sc.get('run_id')==run.get('id') and bool(sc.get('directorio_fuente')) and sc.get('directorio_fuente')==run.get('sourceDirectory')
            grid=run.get('renderGrid') or run.get('catalogMeta',{}).get('render_grid') or {}
            same_grid=bool(sc.get('grid_id')) and sc.get('grid_id')==grid.get('grid_id')
            if not same_run and not same_grid:reasons.append('No hay evidencia de la misma corrida/cuadrícula; no se transforma la máscara')
            if sc.get('grid_id') and grid.get('grid_id') and sc['grid_id']!=grid['grid_id']:reasons.append('La identidad de cuadrícula es diferente')
            saved_orientation=(sc.get('orientacion') or {}).get('correccion');current_orientation=orientation.get(run.get('id'))
            if saved_orientation is not None and current_orientation is not None and list(saved_orientation[:3])!=list(current_orientation[:3]):reasons.append('La orientación registrada de la máscara y la corrida difiere')
            if not reasons:result.update(eligible=True,basis='same_original_run_path_mesh_dimensions_depth' if same_run else 'same_explicit_render_grid',mask=canonical.public_record(r))
    except (OSError,ValueError) as e:reasons.append(str(e))
    if len(_overlay_cache)>512:_overlay_cache.clear()
    _overlay_cache[cache_key]=result;return result

def display_asset(source,params,validate_pair):
    qualified=overlay(source,params,validate_pair)
    if not qualified['eligible']:raise ValueError('Superposición no verificada: '+'; '.join(qualified['reasons']))
    r=canonical.inventory(source)['by_id'][params['mask'][0]]
    bodies=[canonical.read_asset(source,a) for a in r['assets']]
    if qualified.get('display_representation'):bodies,_=display_pair(r,bodies)
    role=params.get('role',['I'])[0]
    for asset,body in zip(r['assets'],bodies):
        if asset['role']==role:return body
    raise ValueError('Rol inexistente')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--catalog',required=True);args=parser.parse_args();print(dump(build(Path(args.catalog))))


def native_info(source,params,preview=False):
    from PIL import Image
    Image.MAX_IMAGE_PIXELS=1_000_000_000
    data=canonical.inventory(source);r=data['by_id'].get(params['mask'][0]) if data else None
    if not r:raise FileNotFoundError('Versión desconocida')
    a=next((a for a in r['assets'] if a['role']==params.get('role',['I'])[0]),None)
    if a is None:raise FileNotFoundError('Rol inexistente')
    body=canonical.read_asset(source,a)
    with Image.open(io.BytesIO(body)) as im:
        frame=int(params.get('page',['0'])[0]);count=getattr(im,'n_frames',1)
        if frame<0 or frame>=count:raise ValueError('Página fuera del archivo')
        im.seek(frame)
        if not preview:return {'dimensions':list(im.size),'pages':count,'mode':im.mode,'sha256':a['sha256'],'path':a['canonical']}
        im.thumbnail((1600,1600),Image.Resampling.NEAREST)
        if im.mode not in ('1','L','LA','RGB','RGBA','I;16'):im=im.convert('RGB')
        out=io.BytesIO();im.save(out,format='PNG');return out.getvalue()
