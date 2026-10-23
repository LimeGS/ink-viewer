"""Failure and cache contracts for legacy adapters; external calls are stand-ins."""
import contextlib
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import MagicMock,patch

from ink_viewer.server import s3cache_proxy as proxy
from ink_viewer.server.fuentes import Fuente,guardar_json,url_http
from ink_viewer.catalog import exportar_compuertas as gates


class ProxyContracts(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name).resolve();self.addCleanup(patch.stopall)
        for name in ('ROOT','LOG_FILE','WORK3_BASE','TOKEN_FILE','PERFIL','_s3','_pending','PENDING_MAX'):
            patch.object(proxy,name,getattr(proxy,name)).start()
        proxy.ROOT=self.root;proxy.LOG_FILE=self.root/'log';proxy._pending={}

    def test_physical_metadata_fallbacks_and_invalid_values(self):
        with self.assertRaises(ValueError):proxy.cargar_rollo('../outside')
        (self.root/'rollos').mkdir();f=self.root/'rollos/PHercA.json'
        f.write_text('{"scroll":"PHercA","voxel_um":7.91}')
        self.assertEqual(proxy.cargar_rollo('PHercA')['voxel_um'],7.91)
        f.write_text('{"scroll":"PHercB","voxel_um":7.91}')
        with self.assertRaises(ValueError):proxy.cargar_rollo('PHercA')
        f.unlink();external=self.root/'imported';(external/'PHercA').mkdir(parents=True)
        meta=external/'PHercA/rollo.json';meta.write_text('{"scroll":"PHercA","voxel_um":8.64}')
        with patch.dict(proxy.os.environ,{'TRAZADO_WORK':str(external),'PIPELINE':str(self.root)}):
            self.assertEqual(proxy.cargar_rollo('PHercA')['voxel_um'],8.64)
            meta.write_text('{"scroll":"other","voxel_um":8.64}')
            with self.assertRaises(ValueError):proxy.cargar_rollo('PHercA')
            meta.unlink();f.write_text('{"scroll":"PHercA","voxel_um":9.1}')
            self.assertEqual(proxy.cargar_rollo('PHercA')['voxel_um'],9.1)
        proxy.ROOT=self.root/'empty'
        with patch.dict(proxy.os.environ,{'TRAZADO_WORK':'','PIPELINE':str(self.root)}):
            self.assertEqual(proxy.cargar_rollo('PHercA')['voxel_um'],9.1)
            f.write_text('{"scroll":"other","voxel_um":9.1}')
            self.assertIsNone(proxy.cargar_rollo('PHercA')['voxel_um'])

    def test_signed_client_is_lazy_and_reused(self):
        with patch('boto3.Session') as session:
            proxy._s3=None;proxy.PERFIL='fixture-profile'
            first=proxy.s3();self.assertIs(proxy.s3(),first)
            session.assert_called_once_with(profile_name='fixture-profile')
            proxy._s3=None;proxy.PERFIL='';proxy.s3()
            self.assertEqual(session.call_args.kwargs,{})

    def test_writer_errors_preserve_status_and_deferred_uploads_are_bounded(self):
        proxy.WORK3_BASE='';proxy.TOKEN_FILE=None
        with self.assertRaises(PermissionError):proxy.writer_put('x',b'x')
        proxy.WORK3_BASE='http://fixture.invalid';proxy.TOKEN_FILE=self.root/'token';proxy.TOKEN_FILE.write_text('test-only')
        error=urllib.error.HTTPError('http://fixture.invalid',409,'conflict',{},io.BytesIO(b'{"error":"conflict"}'))
        with patch.object(proxy.urllib.request,'urlopen',side_effect=error):
            self.assertEqual(proxy.writer_put('x',b'x'),(409,{'error':'conflict'}))
        for status in (404,500):
            error=urllib.error.HTTPError('http://fixture.invalid',status,'failure',{},io.BytesIO())
            with patch.object(proxy.urllib.request,'urlopen',side_effect=error),patch.object(proxy,'s3') as client,patch.object(proxy,'writer_put',return_value=(503,{'error':'offline'})),patch.object(proxy,'log'):
                client.return_value.get_object.return_value={'Body':io.BytesIO(b'pixels')}
                if status==500:
                    with self.assertRaises(urllib.error.HTTPError):proxy.s3_once('catalog/a.png','a')
                else:
                    self.assertEqual(proxy.s3_once('catalog/a.png','a'),b'pixels')
                    self.assertEqual(proxy._pending['catalog/a.png'],b'pixels')
                    proxy.PENDING_MAX=0
                    self.assertEqual(proxy.s3_once('catalog/a.png','a'),b'pixels')
                    self.assertFalse(proxy._pending)
                    self.assertEqual(client.return_value.get_object.call_count,1)
        for value in ('/absolute','../escape'):
            with self.assertRaises(ValueError):proxy.catalog_url({'path':value})

    def test_stream_failures_and_optional_missing_do_not_hide_errors(self):
        handler=object.__new__(proxy.Handler)
        handler.headers={};handler.wfile=io.BytesIO()
        handler.send_error=MagicMock();handler.send_response=MagicMock();handler.send_header=MagicMock();handler.end_headers=MagicMock()
        for status in (404,500):
            error=urllib.error.HTTPError('http://fixture.invalid',status,'failure',{},io.BytesIO())
            with patch.object(proxy.urllib.request,'urlopen',side_effect=error):
                result=handler._stream('http://fixture.invalid',missing_ok=True)
                if status==404:self.assertEqual(result,404)
                else:handler.send_error.assert_called_with(500,None)
        with patch.object(proxy.urllib.request,'urlopen',side_effect=OSError('offline')),patch.object(proxy,'log'):
            handler._stream('http://fixture.invalid');handler.send_error.assert_called_with(502,'work-3 no responde')
        source=MagicMock();source.indice.return_value={}
        with self.assertRaises(ValueError):proxy.manifest_bytes.__wrapped__(source,None)
        self.assertFalse(proxy.accepts_gzip('gzip;q=invalid'))

    def test_input_validation_atomic_json_and_mask_history(self):
        for value in ('https://host/a/../b','ftp://host','https://user:pass@host','https://host/?q=1'):
            with self.assertRaises(ValueError):url_http(value)
        for origin,kwargs in (('',{}),('s3://',{}),('ftp://host',{}),(str(self.root),{'perfil':True}),(str(self.root),{'region':'x'}),(str(self.root),{'anotaciones':str(self.root/'missing')})):
            with self.subTest(origin=origin,kwargs=kwargs),self.assertRaises(ValueError):Fuente(origin,**kwargs)
        file=self.root/'atomic.json';file.write_text('{"old":true}')
        with patch('ink_viewer.server.fuentes.os.replace',side_effect=OSError('disk failure')),self.assertRaises(OSError):guardar_json(file,{'new':True})
        self.assertEqual(json.loads(file.read_text()),{'old':True})
        self.assertEqual(list(self.root.iterdir()),[file])
        labels=self.root/'labels';labels.mkdir();source=Fuente(str(self.root),anotaciones=str(labels))
        source.guardar_mascara('x.png',b'old');source.guardar_mascara('x.png',b'new')
        self.assertEqual(source.mascara_local('x.png').read_bytes(),b'new')
        history=source.mascara_local('x.png').parent/'.history'
        self.assertEqual(next(history.iterdir()).read_bytes(),b'old')
        with self.assertRaises(PermissionError):Fuente(str(self.root)).guardar_mascara('x.png',b'x')

    def test_gate_export_rejects_unbound_and_conflicting_receipts(self):
        tasks=self.root/'tasks';receipts=self.root/'receipts';meta=self.root/'segments/s/mesh/tifxyz/meta.json';meta.parent.mkdir(parents=True);meta.write_text('{}')
        import hashlib
        digest={'meta.json':hashlib.sha256(meta.read_bytes()).hexdigest()}
        (self.root/'segments/s/catalog-entry.json').write_text(json.dumps({'mesh_inputs_sha256':digest}))
        task={'unidad':'u','sha':digest,'etiqueta':{'aliases':[{'segment_id':'../bad','sha':digest},{'segment_id':'missing','sha':digest},{'segment_id':'s','sha':digest}]}}
        tasks.write_text(json.dumps(task)+'\n')
        receipt={'unidad':'u','sha_entradas':digest,'capa':'0','estado':'PASS','metricas':{'area_cm2':8}}
        receipts.write_text(json.dumps(receipt)+'\n'+json.dumps(dict(receipt,estado='FAIL'))+'\n')
        with self.assertRaises(ValueError):gates.export(self.root,tasks,receipts)
        receipts.write_text(json.dumps(dict(receipt,sha_entradas={}))+'\n')
        self.assertFalse(gates.export(self.root,tasks,receipts)['laminas'])
        output=self.root/'output.json'
        with patch.object(gates,'__name__','test-fixture'):
            import runpy,sys
            with patch.object(sys,'argv',['export','--catalogo',str(self.root),'--tareas',str(tasks),'--filas',str(receipts),'--salida',str(output)]),contextlib.redirect_stdout(io.StringIO()):
                runpy.run_module('ink_viewer.catalog.exportar_compuertas',run_name='__main__')
        self.assertEqual(json.loads(output.read_text())['laminas'],{})
