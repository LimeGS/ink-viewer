import http.server,io,json,tempfile,threading,unittest,urllib.error,urllib.parse,urllib.request
from pathlib import Path
from unittest.mock import patch
from test_fuentes import png
import ink_viewer.server.s3cache_proxy as p
def serve(handler):
 srv=http.server.ThreadingHTTPServer(('127.0.0.1',0),handler);threading.Thread(target=srv.serve_forever,daemon=True).start();return srv
class Configured(unittest.TestCase):
 def setUp(self):
  self.addCleanup(patch.stopall)
  for name in ('ROOT','CACHE','LOG_FILE','SCROLL','ROLLO','ESPEJO','LABELS_UNKNOWN','WORK3_BASE','TOKEN_FILE','s3','index','writer_put'):
   patch.object(p,name,getattr(p,name)).start()
  patch.object(p,'CAMPANA_S3','s3://test-bucket/campaign').start()
  patch.object(p,'BUCKET','test-bucket').start()
  patch.object(p,'cargar_rollo',side_effect=lambda scroll,fuente=None:{'scroll':scroll,'voxel_um':8.64} if scroll in ('PHerc1447','PHerc0800') else {'scroll':scroll,'voxel_um':None}).start()
class Rollo(Configured):
 def test_1447_igual_que_antes_y_0800(self):
  # 25-sep generalizar-por-rollo: con PHerc1447 lo resuelto es exactamente lo que estaba escrito a mano hasta hoy
  info=p.configurar('PHerc1447')
  self.assertEqual((p.ESPEJO,p.LABELS_UNKNOWN,p.BUCKET),('campaign/PHerc1447/all-gallery-backing/','_unresolved/PHerc1447','test-bucket'))
  self.assertEqual((info['voxel_um'],p.ROOT),(8.64,Path.cwd().resolve()))
  info=p.configurar('PHerc0800')
  self.assertEqual((p.ESPEJO,p.LABELS_UNKNOWN,info['scroll']),('campaign/PHerc0800/all-gallery-backing/','_unresolved/PHerc0800','PHerc0800'))
  # el indice de laminas de OTRO rollo no manda: una lamina con el mismo nombre va a _unresolved/<este rollo>
  idx0=p.index;p.index=lambda name:{'lam':'PHerc1447/segments/s'} if name=='lamina_labels_index.json' else {}
  try:
   self.assertEqual(p.labels_base('lam'),'_unresolved/PHerc0800')
   self.assertEqual(p.labels_base('lam','PHerc0800/segments/t'),'PHerc0800/segments/t')
   p.configurar('PHerc1447');self.assertEqual(p.labels_base('lam'),'PHerc1447/segments/s')
  finally:p.index=idx0
  # el docroot de un rollo nuevo no tiene indices: {} (antes KeyError en cada pedido fuera del docroot)
  with tempfile.TemporaryDirectory() as d:
   raiz0=p.ROOT;p.configurar('PHerc0800',d)
   try:self.assertEqual((p.index('mac_cache_index.json'),p.index('mac_cache_index.json'),p.LOG_FILE),({},{},Path(d).resolve()/'s3cache_proxy.log'))
   finally:p.configurar('PHerc1447',raiz0)
 def test_multi_rollo_sin_scroll(self):
  # un proxy sin --scroll sirve todos: el sample sale del path y /api/rollo.js se resuelve por ?rollo=
  p.configurar()                                    # sin scroll: ya no aborta
  self.assertIsNone(p.SCROLL)
  self.assertEqual(p.sample_de('catalog/PHerc0800/segments/s/ink-detection/x.png'),'PHerc0800')
  self.assertEqual(p.sample_de('catalog/_unresolved/PHerc0800/q/ink-detection/x.png'),'PHerc0800')
  self.assertIsNone(p.sample_de('col/gallery/lam/base_c+00/fixed.png'))   # legacy sin sample
  self.assertEqual(p.sample_de('../catalog/PHerc1447/segments/s/ink-detection/x.png'),'PHerc1447')
  self.assertEqual(p.espejo_de('PHerc0800'),'campaign/PHerc0800/all-gallery-backing/')
  # etiqueta de un segmento oficial: manda ?base=, no el rollo del proxy
  self.assertEqual(p.labels_base('lam','PHerc0800/segments/t'),'PHerc0800/segments/t')
  # sin base y sin indice: _unresolved del rollo pedido
  idx0=p.index;p.index=lambda name:{} if name=='lamina_labels_index.json' else {}
  try:self.assertEqual(p.labels_base('lam',rollo='PHerc0800'),'_unresolved/PHerc0800')
  finally:p.index=idx0
  p.configurar('PHerc1447')                         # con --scroll vuelve lo de siempre
class Tiers(Configured):
 def test_mac_work3_s3_once_and_masks(self):
  p.configurar('PHerc1447')
  with tempfile.TemporaryDirectory() as w3,tempfile.TemporaryDirectory() as mac:
   p.LOG_FILE=Path(w3,'proxy.log')   # 25-sep: the test never writes a log next to the proxy
   f=Path(w3,p.ESPEJO,'col/gallery/lam/base_c+00/fixed.png');f.parent.mkdir(parents=True);f.write_bytes(b'W3')
   Path(mac,'col/gallery/lam/base_c+04').mkdir(parents=True);Path(mac,'col/gallery/lam/base_c+04/fixed.png').write_bytes(b'MAC')
   c=Path(w3,'catalog/PHerc1447/segments/s/ink-detection/m-c+04.png');c.parent.mkdir(parents=True);c.write_bytes(b'CAT')
   Path(w3,'token').write_text('t0k')
   class Work3(http.server.SimpleHTTPRequestHandler):      # nginx (GET) + catalog_writer (PUT) stand-in
    def __init__(s,*a,**k):super().__init__(*a,directory=w3,**k)
    def log_message(s,*a):pass
    def do_PUT(s):
     assert s.headers['X-Catalog-Token']=='t0k'
     rel=urllib.parse.unquote(s.path).removeprefix('/catalog-write/');d=Path(w3,'catalog',rel);d.parent.mkdir(parents=True,exist_ok=True)
     d.write_bytes(s.rfile.read(int(s.headers['Content-Length'])));b=b'{"status":"created"}'
     s.send_response(201);s.send_header('Content-Length',str(len(b)));s.end_headers();s.wfile.write(b)
   up=serve(Work3);calls=[]
   class FakeS3:
    def get_object(s,Bucket,Key):calls.append(Key);return {'Body':io.BytesIO(b'FROM-S3')}
   p.WORK3_BASE=f'http://127.0.0.1:{up.server_port}';p.CACHE=Path(mac);p.TOKEN_FILE=Path(w3,'token');p.s3=lambda:FakeS3()
   idx={'mac_cache_index.json':{'catalog/PHerc1447/segments/s/ink-detection/cached-c+04.png':'col/gallery/lam/base_c+04/fixed.png'},
        's3_on_demand_index.json':{'catalog/PHerc1447/segments/s/ink-detection/s3only-c+02.png':'k/s3only.png'},
        'lamina_labels_index.json':{'lam':'PHerc1447/segments/s'},'catalog_asset_index.json':{}}
   p.index=lambda name:idx.get(name,{})
   px=serve(p.Handler);get=lambda rel:urllib.request.urlopen(f'http://127.0.0.1:{px.server_port}/{rel}')
   r=get('col/gallery/lam/base_c+00/fixed.png');self.assertEqual((r.read(),r.headers['X-Fuente']),(b'W3','work-3'))
   r=get('catalog/PHerc1447/segments/s/ink-detection/m-c%2B04.png');self.assertEqual((r.read(),r.headers['X-Fuente']),(b'CAT','work-3'))
   p.ROOT=Path(mac);r=get('catalog/PHerc1447/segments/s/ink-detection/cached-c%2B04.png');self.assertEqual((r.read(),r.headers['X-Fuente']),(b'MAC','mac-cache'))
   r=get('catalog/PHerc1447/segments/s/ink-detection/s3only-c%2B02.png');self.assertEqual((r.read(),r.headers['X-Fuente']),(b'FROM-S3','s3->work-3'))
   self.assertEqual(Path(w3,'catalog/PHerc1447/segments/s/ink-detection/s3only-c+02.png').read_bytes(),b'FROM-S3')
   r=get('catalog/PHerc1447/segments/s/ink-detection/s3only-c%2B02.png');self.assertEqual((r.read(),r.headers['X-Fuente']),(b'FROM-S3','work-3'))
   self.assertEqual(calls,['k/s3only.png'])                                   # S3 once, then work-3
   with self.assertRaises(urllib.error.HTTPError) as e:get('col/gallery/lam/base_c-04/fixed.png')
   self.assertEqual(e.exception.code,404);self.assertEqual(len(calls),1)       # not indexed: never S3
   req=urllib.request.Request(f'http://127.0.0.1:{px.server_port}/api/mascara/lam/lam.png?c=4',data=png(0),method='POST')
   out=json.loads(urllib.request.urlopen(req).read());self.assertEqual(out['clave_profundidad'],'PHerc1447/segments/s/labels/por-profundidad/lam/c+04/lam.png')
   self.assertEqual(get('api/etiqueta/lam/c%2B04/lam.png').read(),png(0))
   # 24-sep: the viewer names the segment of the map (?base=), so a lamina missing from the index no longer lands in _unresolved
   post=lambda q,body:json.loads(urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{px.server_port}/api/mascara/alias/alias.png?c=4'+q,data=body,method='POST')).read())
   self.assertEqual(post('&base=PHerc1447/segments/s2',png(255))['clave_profundidad'],'PHerc1447/segments/s2/labels/por-profundidad/alias/c+04/alias.png')
   self.assertEqual(get('api/etiqueta/alias/c%2B04/alias.png?base=PHerc1447/segments/s2').read(),png(255))
   with self.assertRaises(urllib.error.HTTPError) as e:post('&base=../../etc',png(0))
   self.assertEqual(e.exception.code,400)
   # 25-sep: el JSON de corrida va al lado del par (oficial + por profundidad) y uno roto se rechaza
   pj=lambda name,body:urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{px.server_port}/api/mascara/lam/'+name,data=body,method='POST'))
   self.assertEqual(json.loads(pj('lam_run.json?c=-4',json.dumps({'run_id':'run_x','segmento':'lam','lamina':'lam','ancho':2,'alto':2,'profundidad':-4}).encode()).read())['clave_profundidad'],'PHerc1447/segments/s/labels/por-profundidad/lam/c-04/lam_run.json')
   self.assertEqual(json.loads(get('api/etiqueta/lam/c-04/lam_run.json').read())['run_id'],'run_x')
   self.assertEqual(json.loads(get('api/etiqueta/lam/c-04/lam_run.json?opcional=1').read())['run_id'],'run_x')
   r=get('api/etiqueta/lam/c%2B08/lam_run.json?opcional=1');self.assertEqual((r.status,r.read()),(204,b''))   # no existe: 204
   with self.assertRaises(urllib.error.HTTPError) as e:get('api/etiqueta/lam/c%2B08/lam_run.json')
   self.assertEqual(e.exception.code,404)                                                                              # sin opcional: 404 como siempre
   self.assertEqual(json.loads(Path(w3,'catalog/PHerc1447/segments/s/labels/etiquetas/lam/lam_run.json').read_bytes())['run_id'],'run_x')
   with self.assertRaises(urllib.error.HTTPError) as e:pj('lam_roto.json?c=4',b'{no es json')
   self.assertEqual(e.exception.code,400);self.assertFalse(Path(w3,'catalog/PHerc1447/segments/s/labels/etiquetas/lam/lam_roto.json').exists())
   with self.assertRaises(urllib.error.HTTPError) as e:pj('lam_x.txt',b'x')
   self.assertEqual(e.exception.code,400)
   # 25-sep: si work-3 rechaza el .json (catalog_writer solo acepta .png en labels/), 200 con ok:false y sin escribir nada
   wp=p.writer_put;p.writer_put=lambda rel,body:(400,{'error':'path or size not allowed'}) if rel.endswith('.json') else wp(rel,body)
   out=json.loads(pj('lam_rechazo_run.json?c=4',json.dumps({'run_id':'run_y','segmento':'lam','lamina':'lam','ancho':2,'alto':2,'profundidad':4}).encode()).read());self.assertEqual(out['ok'],False);self.assertIn('catalog_writer',out['motivo'])
   self.assertFalse(Path(w3,'catalog/PHerc1447/segments/s/labels/etiquetas/lam/lam_rechazo_run.json').exists())
   p.writer_put=lambda rel,body:(500,{'error':'disco'})            # otro fallo del writer con un PNG: sigue siendo 502
   with self.assertRaises(urllib.error.HTTPError) as e:pj('lam.png?c=4',png(0))
   self.assertEqual(e.exception.code,502);p.writer_put=wp
   # 25-sep: el visor pide el rollo del proxy antes que nada (rollo_visor.js)
   r=get('api/rollo.js');t=r.read().decode()
   self.assertTrue(t.startswith('window.ROLLO_SERVIDOR='));self.assertIn('no-cache',r.headers['Cache-Control'])
   d=json.loads(t[len('window.ROLLO_SERVIDOR='):].rstrip().rstrip(';'))
   self.assertEqual((d['scroll'],d['voxel_um'],d['proxy']['etiquetas_sin_segmento']),('PHerc1447',8.64,'_unresolved/PHerc1447'))
   # multi-rollo: ?rollo= resuelve ese rollo; sin query, {}
   r=get('api/rollo.js?rollo=PHerc0800');d=json.loads(r.read().decode()[len('window.ROLLO_SERVIDOR='):].rstrip().rstrip(';'))
   self.assertEqual((d['scroll'],d['voxel_um']),('PHerc0800',8.64))
   p.configurar()                                    # proxy agnostico: sin query no hay rollo que devolver
   r=get('api/rollo.js');self.assertEqual(r.read().decode().strip(),'window.ROLLO_SERVIDOR={};')
   p.configurar('PHerc1447')
   self.assertIn(b'null',get('api/rollo.js?rollo=PHercZZZZ').read())
   up.shutdown();px.shutdown();up.server_close();px.server_close()
if __name__=='__main__':unittest.main()
