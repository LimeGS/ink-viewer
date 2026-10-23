import io,json,tempfile,unittest,hashlib
from pathlib import Path
from unittest.mock import patch
from PIL import Image,PngImagePlugin
from ink_viewer.server.fuentes import Fuente
from ink_viewer.server.s3cache_proxy import validar_par
import ink_viewer.catalog.master_inventory as mi

class MasterInventory(unittest.TestCase):
 def setUp(self):
  refresher=patch.object(mi,'maybe_refresh',return_value=None);refresher.start();self.addCleanup(refresher.stop)
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name);self.cat=self.root/'catalog';self.v=self.cat/'_viewer';self.v.mkdir(parents=True);self.source=Fuente(str(self.root));self.seg=self.cat/'PHerc1447/segments/s';self.seg.mkdir(parents=True);(self.cat/'PHerc1447/segments/no_map').mkdir();self.maps=self.seg/'ink-detection';self.maps.mkdir();Image.new('L',(4,3),50).save(self.maps/'run-c+00.png')
  self.run={'id':'run-test','scroll':'PHerc1447','frames':{'0':'../catalog/PHerc1447/segments/s/ink-detection/run-c+00'},'sourceDirectory':'PHerc1447/segments/s/ink-detection/run','catalogMeta':{'lam':'s','cara':'fwd'},'meshAssociation':{'meshSha256':'mesh'}}
  self.meta={'formato':'vesuvius.mascara_corrida.v1','lamina':'s','segmento':'s','rollo':'PHerc1447','base':'PHerc1447/segments/s','ancho':4,'alto':3,'profundidad':0,'cara':'fwd','run_id':'run-test','malla_sha256':'mesh','directorio_fuente':self.run['sourceDirectory']}
  self.record={'id':'mask-test','roll':'PHerc1447','segment':'s','association':'catalog_membership','depth':0,'unit':'I/S','assets':[]};self.write_masks()
  self.publish()
 def write_masks(self):
  assets=[]
  for role,value in [('I',255),('S',255)]:
   p=self.seg/'labels/series/version'/(role+'.png');p.parent.mkdir(parents=True,exist_ok=True);info=PngImagePlugin.PngInfo();info.add_itxt('vesuvius:mascara_corrida',json.dumps(self.meta));Image.new('L',(4,3),value).save(p,pnginfo=info);b=p.read_bytes();assets.append({'role':role,'canonical':str(p),'source':str(p),'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b)})
  self.record['assets']=assets
 def publish(self):
  (self.v/'manifest-work3.json').write_text(json.dumps([self.run]));(self.v/'canonical-masks.json').write_text(json.dumps({'schema':'canonical-masks.v1','records':[self.record]}));mi.build(self.cat)
 def params(self):return {'mask':['mask-test'],'run':[mi.identifier(self.run['id'],mi.dump(self.run['frames']))],'depth':['0']}
 def test_complete_catalog_and_no_maps(self):
  data=mi.listing(self.source,{});self.assertEqual(data['summary']['segments'],2);self.assertEqual(data['total'],2);self.assertEqual(mi.listing(self.source,{'masks':['1']})['total'],1)
  detail=mi.detail(self.source,mi.identifier('PHerc1447','no_map','segment'));self.assertEqual(detail['runs'],[]);self.assertEqual(detail['masks'],[])
 def test_overlay_requires_exact_run_mesh_depth_and_grid(self):
  self.assertTrue(mi.overlay(self.source,self.params(),validar_par)['eligible'])
  for key,value in [('run_id','another'),('malla_sha256','other-mesh'),('directorio_fuente','another/path'),('cara','rev')]:
   old=self.meta.get(key);self.meta[key]=value;self.write_masks();self.publish();self.assertFalse(mi.overlay(self.source,self.params(),validar_par)['eligible'],key);self.meta[key]=old
  self.write_masks();self.publish();params=self.params();params['depth']=['1'];self.assertFalse(mi.overlay(self.source,params,validar_par)['eligible'])
 def test_pending_sources_still_visible_and_never_overlay(self):
  self.record.update(segment='',declared_surface='s',association='pending');self.publish();d=mi.listing(self.source,{'kind':['mask_association_pending']});self.assertEqual(d['total'],1);detail=mi.detail(self.source,d['rows'][0]['key']);self.assertEqual(len(detail['masks']),1);self.assertFalse(mi.overlay(self.source,self.params(),validar_par)['eligible'])
 def test_native_integrity_and_map_dimensions(self):
  self.assertEqual(mi.native_info(self.source,{'mask':['mask-test']} )['dimensions'],[4,3]);Image.new('L',(5,3)).save(self.maps/'run-c+00.png');self.assertFalse(mi.overlay(self.source,self.params(),validar_par)['eligible']);Path(self.record['assets'][0]['canonical']).write_bytes(b'tampered')
  with self.assertRaises(ValueError):mi.native_info(self.source,{'mask':['mask-test']})
 def test_known_orientation_conflict_cannot_be_bypassed(self):
  self.meta['orientacion']={'correccion':[0,0,0]};self.write_masks();self.publish()
  (self.v/'orientacion_vista.json').write_text(json.dumps({'corridas':{'run-test':[0,1,0,'mirror']}}))
  self.assertFalse(mi.overlay(self.source,self.params(),validar_par)['eligible'])
 def test_map_path_cannot_escape_catalog(self):
  self.assertIsNone(mi.frame_path('../elsewhere/map'))
  outside=self.root/'outside.png';Image.new('L',(4,3)).save(outside);(self.maps/'run-c+00.png').unlink();(self.maps/'run-c+00.png').symlink_to(outside)
  with self.assertRaises(ValueError):mi.map_request(self.source,self.params())
 def test_reduced_map_is_visible_but_never_overlayed(self):
  (self.maps/'run-c+00.png').unlink();d=self.maps/'downsampled';d.mkdir();Image.new('L',(4,3),50).save(d/'run-c+00-ds8.jpg')
  info=mi.map_request(self.source,self.params());self.assertTrue(info['available']);self.assertFalse(info['original_available']);self.assertEqual(info['representation'],'preview_ds8')
  self.assertFalse(mi.overlay(self.source,self.params(),validar_par)['eligible'])
  self.assertFalse(mi.map_info(self.source,self.run,0,'global')['available'])
 def test_frame_specific_contrasts_are_not_missing_files(self):
  self.run['availableContrasts']=['fixed','global'];self.run['frameContrasts']={self.run['frames']['0']:['fixed']}
  info=mi.map_info(self.source,self.run,0,'global');self.assertEqual(info['state'],'NOT_DECLARED_FOR_FRAME');self.assertEqual(info['available_contrasts'],['fixed'])
 def display_masks(self,ink=(254,255,254,255),support=(255,254,255,255)):
  self.record['type']='a mano'
  for a,value in zip(self.record['assets'],[ink,support]):
   p=Path(a['canonical']);info=PngImagePlugin.PngInfo();info.add_itxt('vesuvius:mascara_corrida',json.dumps(self.meta));Image.new('RGBA',(4,3),value).save(p,pnginfo=info);body=p.read_bytes();a.update(bytes=len(body),sha256=hashlib.sha256(body).hexdigest())
  self.publish()
 def test_display_representation_preserves_originals_and_geometry(self):
  self.display_masks();before=[Path(a['canonical']).read_bytes() for a in self.record['assets']]
  with self.assertRaises(ValueError):validar_par(*before,None,'s','PHerc1447/segments/s',0,'PHerc1447')
  result=mi.overlay(self.source,self.params(),validar_par);self.assertTrue(result['eligible']);self.assertTrue(result['display_representation']['display_only'])
  body=mi.display_asset(self.source,self.params(),validar_par)
  with Image.open(io.BytesIO(body)) as im:self.assertEqual(im.getextrema(),(255,255));self.assertEqual(im.size,(4,3))
  self.assertEqual(before,[Path(a['canonical']).read_bytes() for a in self.record['assets']])
  self.meta['run_id']='other';self.display_masks();self.assertFalse(mi.overlay(self.source,self.params(),validar_par)['eligible'])
  with self.assertRaises(ValueError):mi.display_asset(self.source,self.params(),validar_par)
 def test_display_rejects_ambiguous_labels_transparency_and_outside_support(self):
  for ink,sup in [((128,128,128,255),(255,255,255,255)),((0,255,0,255),(255,255,255,255)),((1,1,1,0),(255,255,255,255)),((254,254,254,255),(1,1,1,255))]:
   self.display_masks(ink,sup);self.assertFalse(mi.overlay(self.source,self.params(),validar_par)['eligible'])
  self.display_masks();self.record['type']='automatica';self.publish();self.assertFalse(mi.overlay(self.source,self.params(),validar_par)['eligible'])
 def test_display_keeps_role_specific_edit_notes_but_rejects_geometry_difference(self):
  self.display_masks()
  bodies=[Path(a['canonical']).read_bytes() for a in self.record['assets']]
  def modified(meta):
   info=PngImagePlugin.PngInfo();info.add_itxt('vesuvius:mascara_corrida',json.dumps(meta));stream=io.BytesIO();Image.new('RGBA',(4,3),(254,255,254,255)).save(stream,format='PNG',pnginfo=info);return stream.getvalue()
  bodies[1]=modified(self.meta|{'editado_fuera_del_visor':'reviewed support edit'})
  display,proof=mi.display_pair(self.record,bodies);sc=validar_par(*display,None,'s','PHerc1447/segments/s',0,'PHerc1447');self.assertEqual(sc['display_original_edit_notes']['S'],'reviewed support edit');self.assertEqual(proof['original_metadata_by_role']['S']['editado_fuera_del_visor'],'reviewed support edit')
  bodies[1]=modified(self.meta|{'run_id':'other'})
  with self.assertRaises(ValueError):mi.display_pair(self.record,bodies)
 def test_duplicate_picker_keeps_manual_identity_and_all_origins(self):
  self.display_masks();manual=dict(self.record,id='manual-origin');self.record['type']='unknown'
  (self.v/'canonical-masks.json').write_text(json.dumps({'schema':'canonical-masks.v1','records':[self.record,manual]}));mi.build(self.cat)
  d=mi.detail(self.source,mi.identifier('PHerc1447','s','segment'));self.assertEqual(len(d['masks']),1)
  m=d['masks'][0];self.assertEqual(m['id'],'manual-origin');self.assertEqual(m['origins'],2);self.assertEqual(set(m['source_ids']),{'mask-test','manual-origin'});self.assertTrue(all('manual-origin' in a['url'] for a in m['assets']))

if __name__=='__main__':unittest.main()
