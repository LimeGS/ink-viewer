import contextlib
import copy
import io
import json
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch
from PIL import Image

from ink_viewer.catalog import vast_catalog
from ink_viewer.server import vast_server
from test_fuentes import servidor


class VastSourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name).resolve();self.site=self.root/'site';self.catalog=self.root/'catalog';self.catalog.mkdir()
        self.cache=self.site/'cache/_viewer';self.cache.mkdir(parents=True)
        self.file=self.catalog/'PHercA/segments/s/ink-detection/map.png';self.file.parent.mkdir(parents=True)
        Image.new('L',(8,4),11).save(self.file)
        self.route='catalog/'+str(self.file.relative_to(self.catalog))
        self.run={'id':'s','scroll':'PHercA','frames':{'0':'../'+self.route},'availableContrasts':['fixed'],'vastAsset':str(self.file),'catalogMeta':{'lam':'s','modelo':'base'},'localEvidence':{'origin':'fixture'}}
        a=self.asset(self.file,self.route)
        registry={'roots':[str(self.catalog)],'assets':{str(self.file):a},'routes':{self.route:str(self.file)},'segments':{'s':{'name':'s'}}}
        (self.cache/'vast-assets.json').write_text(json.dumps(registry))
        (self.cache/'manifest.json').write_text(json.dumps([self.run]))
        (self.cache/'legibilidad-auto.json').write_text('{"laminas":{}}')
        self.addCleanup(patch.stopall)
        patch.object(vast_catalog,'CANONICAL',self.catalog).start()
        patch.object(vast_catalog,'ROOTS',[]).start()
        patch.object(vast_server,'CANONICAL',self.catalog).start()
        self.source=vast_server.VastSource(self.site)

    def asset(self,p,route):
        st=p.stat()
        return {'state':'AVAILABLE','bytes':st.st_size,'mtime_ns':st.st_mtime_ns,'dimensions':[8,4],'route':route}

    def test_registered_files_ranges_integrity_and_verification(self):
        s=self.source
        self.assertEqual(s.info()['canonical_root'],str(self.catalog))
        self.assertEqual(s.vast_entry('s'),{'name':'s'})
        self.assertEqual(s.vast_entry('missing'),{})
        self.assertEqual(s.indice('_viewer/manifest.json')[0]['id'],'s')
        (self.catalog/'metadata.json').write_text('{"fixture":true}')
        self.assertTrue(s.indice('metadata.json')['fixture'])
        with s.abrir('metadata.json') as (_,_,body):self.assertTrue(json.load(body)['fixture'])
        for value in (None,'bytes=2-7','bytes=-5','bytes=3-'):
            with self.subTest(range=value),s.abrir(self.route,value) as (status,headers,body):
                expected=self.file.read_bytes()
                if value=='bytes=2-7':expected=expected[2:8]
                elif value=='bytes=-5':expected=expected[-5:]
                elif value=='bytes=3-':expected=expected[3:]
                self.assertEqual(body.read(int(headers['Content-Length'])),expected)
                self.assertEqual(status,206 if value else 200)
                self.assertIn('ETag',headers)
        with s.abrir(self.route,'bytes=0-2',True) as (status,_,__):self.assertEqual(status,200)
        for value in ('bad','bytes=-','bytes=9999-','bytes=8-2'):
            with self.subTest(range=value),self.assertRaises(ValueError),s.abrir(self.route,value):pass
        with self.assertRaises(ValueError):s.verificar()
        s.origen='/workspace/catalog';s.verificar()
        (self.cache/'manifest.json').unlink()
        with self.assertRaises(ValueError):s.verificar()
        s.origen=str(self.catalog)
        outside=self.root/'outside.png';Image.new('L',(1,1)).save(outside)
        with self.assertRaises(ValueError):s.vast_asset_path({'canonical':str(outside)})
        s.registry['assets'][str(self.file)]['state']='MISSING'
        with self.assertRaises(ValueError):s.vast_asset_path({'canonical':str(self.file)})
        s.registry['assets'][str(self.file)]['state']='AVAILABLE'
        self.file.write_bytes(self.file.read_bytes()+b'changed')
        with self.assertRaises(ValueError),s.abrir(self.route):pass

    def test_map_states_never_infer_availability_or_registration(self):
        s=self.source;run=self.run
        self.assertFalse(s.vast_map_info(run,'2','fixed')['available'])
        self.assertFalse(s.vast_map_info(run,'0','unpublished')['available'])
        unknown=copy.deepcopy(run);unknown['frames']['0']='../catalog/PHercA/segments/s/ink-detection/other.png'
        self.assertFalse(s.vast_map_info(unknown,'0','fixed')['available'])
        result=s.vast_map_info(run,'0','fixed')
        self.assertTrue(result['original_available']);self.assertEqual(result['dimensions'],[8,4])
        a=s.registry['assets'][str(self.file)];a['state']='MISSING'
        self.assertEqual(s.vast_map_info(run,'0','fixed')['state'],'MISSING')
        preview=self.file.with_suffix('.jpg');Image.new('L',(8,4)).save(preview)
        s.registry['assets'][str(preview)]=self.asset(preview,'catalog/preview.jpg');a['preview']=str(preview)
        result=s.vast_map_info(run,'0','fixed')
        self.assertTrue(result['available']);self.assertFalse(result['original_available'])
        self.assertEqual(result['representation'],'preview_ds4')
        a.pop('preview');a['state']='AVAILABLE'
        self.file.write_bytes(b'changed')
        self.assertEqual(s.vast_map_info(run,'0','fixed')['state'],'CHANGED')
        self.file.unlink()
        self.assertEqual(s.vast_map_info(run,'0','fixed')['state'],'MISSING')

    def test_http_read_only_preview_and_host_validation(self):
        tif=self.file.with_suffix('.tif');Image.new('L',(8,4),81).save(tif)
        self.source.registry['assets'][str(tif)]=self.asset(tif,'catalog/map.tif')
        run=dict(self.run,id='tif',vastAsset=str(tif))
        with servidor(vast_server.ReadOnlyHandler,self.source) as (srv,base):
            srv.runs=[run]
            def get(path,method='GET',headers=None):
                return urllib.request.urlopen(urllib.request.Request(base+path,method=method,headers=headers or {}))
            with get('/api/vast-preview/tif') as r:
                with Image.open(io.BytesIO(r.read())) as im:self.assertEqual(im.size,(8,4))
            for method in ('POST','PUT','DELETE'):
                with self.subTest(method=method),self.assertRaises(urllib.error.HTTPError) as e:get('/api/origen',method)
                self.assertEqual(e.exception.code,405)
            for path in ('/api/vast-preview/unknown','/api/unknown'):
                with self.assertRaises(urllib.error.HTTPError) as e:get(path)
                self.assertEqual(e.exception.code,404)
            for path in ('/catalog/_viewer/legibilidad-auto.json','/api/vast-preview/tif'):
                with self.assertRaises(urllib.error.HTTPError) as e:get(path,headers={'Host':'untrusted.invalid'})
                self.assertEqual(e.exception.code,403)
            with get('/catalog/_viewer/legibilidad-auto.json','HEAD') as r:self.assertEqual(r.read(),b'')
            self.source.registry['assets'][str(tif)]['state']='MISSING'
            with self.assertRaises(urllib.error.HTTPError) as e:get('/api/vast-preview/tif')
            self.assertEqual(e.exception.code,404)
