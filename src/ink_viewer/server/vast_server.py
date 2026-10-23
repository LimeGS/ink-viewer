"""Existing master viewer with an explicit, read-only Vast asset registry."""
import argparse, contextlib, json, mimetypes, os, re, secrets, threading
from pathlib import Path
from urllib.parse import quote, urlsplit
from functools import lru_cache
from email.utils import formatdate
from http.server import ThreadingHTTPServer
from ink_viewer.server.fuentes import Fuente, ruta_dentro
import ink_viewer.server.s3cache_proxy as proxy
import ink_viewer.catalog.master_inventory as master
from ink_viewer.catalog.vast_catalog import allowed, CANONICAL

@lru_cache(maxsize=2)
def bootstrap_index(path, revision, bootstrap):
    body = Path(path).read_bytes()
    script = b'<script>window.VISOR_BOOTSTRAP=' + bootstrap.encode() + b';window.ROLLO_SERVIDOR={};</script>'
    body = body.replace(b'<head>', b'<head>' + script, 1)
    body = body.replace(b'<script src="/api/rollo.js"></script>', b'')
    return proxy.encoded_bytes(body)

class VastSource(Fuente):
    def __init__(self,site):
        self.site=Path(site).resolve();super().__init__(str(CANONICAL))
        self.vast_index_root=self.site/'cache/catalog'
        self.registry=json.loads((self.site/'cache/_viewer/vast-assets.json').read_text())
        self.layout='catalog';self.manifest_rel='_viewer/manifest.json'
    def verificar(self):
        if self.origen!='/workspace/catalog' or not CANONICAL.is_dir():raise ValueError('Falta el catálogo canónico /workspace/catalog')
        if not (self.site/'cache/_viewer/manifest.json').is_file():raise ValueError('Falta el índice derivado; ejecutar refresh')
    def info(self):return dict(super().info(),canonical_root=self.origen,index_cache=str(self.vast_index_root),supplementary_roots=list(self.registry.get('roots',[])))
    def browser_manifest(self, runs):
        # Browser navigation needs render metadata, not repeated scientific receipts; originals remain in the API/index.
        result = []
        for run in runs:
            item = {key: value for key, value in run.items()
                    if key not in {'localEvidence', 'vastEntry', 'vastAsset', 'maskPaths'}}
            modes = item.get('availableContrasts', [])
            sizes = {}
            frames = dict(item.get('frames', {}))
            if item.get('maximum'): frames['max'] = item['maximum']
            for depth, frame in frames.items():
                for contrast in modes:
                    route = master.frame_path(frame, contrast)
                    asset = self.registry['assets'].get(self.registry['routes'].get(route), {})
                    dimensions = asset.get('dimensions')
                    if asset.get('state') == 'AVAILABLE' and dimensions and len(dimensions) == 2:
                        sizes.setdefault(str(depth), {})[contrast] = dimensions
            if sizes: item['frameDimensions'] = sizes
            result.append(item)
        return result
    def indice(self,rel,limite=256*2**20):
        if rel in {'_viewer/manifest.json','_viewer/legibilidad-auto.json'}:return json.loads((self.site/'cache'/rel).read_text())
        return super().indice(rel,limite=limite)
    def vast_asset_path(self,asset):
        p=Path(asset['canonical']).resolve(strict=True)
        a=self.registry['assets'].get(str(p))
        if not a or not allowed(p):raise ValueError('Archivo fuera del inventario local permitido')
        if a['state']!='AVAILABLE':raise ValueError('Archivo '+a['state']+': '+str(p))
        return p
    def vast_entry(self,key):return self.registry.get('segments',{}).get(key,self.registry.get('meshes',{}).get(key,{}))
    def vast_map_info(self,run,depth,contrast):
        frame=run.get('frames',{}).get(str(depth))
        if not frame:return {'available':False,'state':'NOT_DECLARED','reason':'No hay mapa declarado para esta profundidad'}
        if contrast not in run.get('availableContrasts',['fixed']):return {'available':False,'reason':'Contraste no publicado'}
        rel=master.frame_path(frame,contrast);key=self.registry['routes'].get(rel)
        if not key:return {'available':False,'reason':'Mapa fuera del índice local'}
        a=self.registry['assets'][key];p=Path(key)
        representation='native';original=key
        if a['state']!='AVAILABLE':
            preview=a.get('preview')
            if preview and self.registry['assets'].get(preview,{}).get('state')=='AVAILABLE':
                key=preview;a=self.registry['assets'][key];p=Path(key);representation='preview_ds4'
                rel=a['route']
            else:return {'available':False,'state':a['state'],'reason':'Archivo '+a['state']+': '+key,'path':key}
        try:
            st=p.stat()
            if st.st_size!=a['bytes'] or st.st_mtime_ns!=a['mtime_ns']:
                return {'available':False,'state':'CHANGED','reason':'El archivo cambió después del catálogo; actualizar el índice','path':key}
            if not allowed(p):raise ValueError('Archivo fuera del inventario')
            with p.open('rb'):pass
        except FileNotFoundError:return {'available':False,'state':'MISSING','reason':'Archivo ausente: '+key,'path':key}
        except OSError as e:return {'available':False,'state':'UNREADABLE','reason':str(e),'path':key}
        url='/'+quote(rel,safe='/')
        if p.suffix.lower() in {'.tif','.tiff'}:url='/api/vast-preview/'+run['id']
        return dict(available=True,path=key,url=url,dimensions=a['dimensions'],bytes=a['bytes'],mtime_ns=st.st_mtime_ns,
                    representation=representation,original_path=original,original_available=representation=='native',localEvidence=run.get('localEvidence'))
    @contextlib.contextmanager
    def abrir(self,rel,rango=None,head=False):
        ruta_dentro(Path('/'),rel)
        key=self.registry['routes'].get(rel) or self.registry['routes'].get('catalog/'+rel)
        if not key:
            if rel in {'_viewer/manifest.json','_viewer/legibilidad-auto.json'}:
                path=self.site/'cache'/rel
                with path.open('rb') as body:yield 200,{'Content-Length':str(path.stat().st_size),'Content-Type':'application/json'},body
                return
            with super().abrir(rel,rango,head) as response:yield response
            return
        p=self.vast_asset_path({'canonical':key});a=self.registry['assets'][key];st=p.stat()
        if st.st_size!=a['bytes'] or st.st_mtime_ns!=a['mtime_ns']:raise ValueError('Archivo cambió; actualizar catálogo')
        size=st.st_size;start,end,status=0,size-1,200
        headers={'Content-Type':mimetypes.guess_type(str(p))[0] or 'application/octet-stream','Accept-Ranges':'bytes',
                 'ETag':f'"{st.st_mtime_ns:x}-{size:x}"','Last-Modified':formatdate(st.st_mtime,usegmt=True),
                 'Cache-Control':'private, no-cache'}
        if rango and not head:
            if not re.fullmatch(r'bytes=\d*-\d*',rango):raise ValueError('Range inválido')
            x,y=rango[6:].split('-')
            if not x and not y:raise ValueError('Range vacío')
            start,end=(int(x),min(int(y),end) if y else end) if x else (max(0,size-int(y)),end)
            if start>end or start>=size:raise ValueError('Range fuera del archivo')
            status=206;headers['Content-Range']=f'bytes {start}-{end}/{size}'
        headers['Content-Length']=str(max(0,end-start+1))
        with p.open('rb') as body:body.seek(start);yield status,headers,body

class ReadOnlyHandler(proxy.Handler):
    def _codigo(self, head=False):
        if urlsplit(self.path).path in ('/', '/index.html', '/all-gallery/', '/all-gallery/index.html'):
            if urlsplit(self.path).path == '/': return super()._codigo(head)
            source = self.server.fuente
            metadata = {}
            for candidate in source.rutas_visor('all-gallery/metadata.json'):
                value = source.indice(candidate)
                if isinstance(value, dict) and value:
                    metadata = value
                    break
            rolls = {run.get('scroll') for run in self.server.runs} | {'PHerc1447'}
            bootstrap = {'origen': self._origen_info(), 'metadata': metadata,
                         'rollos': {roll: proxy.cargar_rollo(roll, source) for roll in rolls
                                    if re.fullmatch(r'PHerc[0-9A-Za-z]+', roll or '')}}
            packed = json.dumps(bootstrap, sort_keys=True, ensure_ascii=True, separators=(',', ':')).replace('<', '\\u003c')
            path = proxy.CODE / 'index.html'
            body, compressed, etag = bootstrap_index(str(path), proxy.file_revision(path), packed)
            self._send_bytes(body, 'text/html', 'local', head, etag, compressed)
            return True
        return super()._codigo(head)
    def _v5_scores(self, head=False):
        if urlsplit(self.path).path != '/catalog/_viewer/legibilidad-auto.json': return False
        if not self._host_local():
            self.send_error(403)
            return True
        self._serve_file(self.server.fuente.site/'cache/_viewer/legibilidad-auto.json', head)
        return True
    def do_HEAD(self):
        if self._v5_scores(True): return
        return super().do_HEAD()
    def do_POST(self):self._json({'error':'Instancia Vast de sólo lectura; no guarda máscaras ni cambia el origen'},405)
    do_PUT=do_POST
    do_DELETE=do_POST
    def send_error(self,code,message=None,explain=None):
        if self.path.startswith('/api/'):return self._json({'error':message or explain or 'Archivo no disponible'},code)
        return super().send_error(code,message,explain)
    def do_GET(self):
        if self._v5_scores(): return
        if self.path.startswith('/api/vast-preview/'):
            if not self._host_local():return self.send_error(403)
            import io
            from PIL import Image
            rid=self.path.split('/')[-1];run=next((r for r in self.server.runs if r['id']==rid),None)
            if not run:return self.send_error(404,'Mapa desconocido')
            try:
                p=self.server.fuente.vast_asset_path({'canonical':run['vastAsset']})
                with Image.open(p) as im:
                    if getattr(im,'n_frames',1)!=1 or im.mode=='F':raise ValueError('TIFF no es un mapa 2D entero')
                    out=io.BytesIO();im.save(out,format='PNG')
                return self._send_bytes(out.getvalue(),'image/png','vast-local')
            except (OSError,ValueError) as e:return self.send_error(404,str(e))
        return super().do_GET()

def main():
    p=argparse.ArgumentParser();p.add_argument('--site',required=True);p.add_argument('--port',type=int,default=8798);a=p.parse_args()
    source=VastSource(a.site);source.verificar();proxy.configurar(None,None,source)
    proxy.LOG_FILE=Path(a.site)/'visor.log'
    server=ThreadingHTTPServer(('127.0.0.1',a.port),ReadOnlyHandler)
    server.fuente=source;server.config_path=Path(a.site)/'readonly-config.json'
    server.config_token='';server.config_lock=threading.Lock();server.daemon_threads=True
    server.runs=json.loads((Path(a.site)/'cache/_viewer/manifest.json').read_text())
    print(json.dumps({'url':f'http://127.0.0.1:{a.port}/all-gallery/index.html','pid':os.getpid(),'site':a.site,'read_only':True}),flush=True)
    server.serve_forever()

if __name__=='__main__':main()
