import argparse
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from ink_viewer.deployment import viewerctl,verify_vast_live


class DeploymentGuards(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name).resolve();self.site=self.root/'site';self.site.mkdir()
        self.data=self.root/'data';self.data.mkdir()
        self.settings={'schema':viewerctl.SCHEMA,'mode':'source','env':{},'port':18101,'preview_port':18102}

    def test_profile_validation_and_external_config_import(self):
        file=self.site/'site.json'
        for update in ({'schema':'unknown'},{'env':{'UNSUPPORTED':'x'}},{'preview_port':18101}):
            file.write_text(json.dumps(dict(self.settings,**update)))
            with self.subTest(update=update),self.assertRaises(ValueError):viewerctl.load_settings(self.site)
        file.unlink()
        args=argparse.Namespace(origin=None,source_config=str(self.root/'origin.json'),legacy_root=None,annotations=None,pipeline=str(self.root/'pipeline'),scroll='PHercA',from_port=None,name='fixture',port=18101,preview_port=18102)
        Path(args.source_config).write_text(json.dumps({'origen':str(self.data)}))
        viewerctl.init_site(self.site,args)
        self.assertEqual(viewerctl.load_settings(self.site)['scroll'],'PHercA')
        self.assertEqual(json.loads((self.site/'origin.json').read_text())['origen'],str(self.data))
        other=self.root/'other'
        args.source_config=str(self.root/'missing')
        with self.assertRaises(ValueError):viewerctl.init_site(other,args)
        args.from_port=18103;args.origin=str(self.data)
        with self.assertRaises(ValueError):viewerctl.init_site(other,args)
        args.from_port=None;args.origin=None;args.legacy_root=str(self.data);args.preview_port=args.port
        with self.assertRaises(ValueError):viewerctl.init_site(other,args)
        args.preview_port=18102;args.legacy_root=str(self.root/'file');Path(args.legacy_root).write_text('not a directory')
        with self.assertRaises(ValueError):viewerctl.init_site(other,args)

    def test_stop_refuses_port_mismatch_and_stale_processes(self):
        runtime=self.site/'state/preview';runtime.mkdir(parents=True)
        file=runtime/'process.json';data={'pid':4242,'port':18102,'nonce':'owned'}
        file.write_text(json.dumps(data))
        with patch.object(viewerctl.os,'kill',side_effect=ProcessLookupError):viewerctl.stop(self.site,'preview')
        self.assertFalse(file.exists());file.write_text(json.dumps(data))
        for value in (OSError('offline'),{'nonce':'somebody-else'}):
            with patch.object(viewerctl.os,'kill') as kill,patch.object(viewerctl,'health') as health:
                if isinstance(value,Exception):health.side_effect=value
                else:health.return_value=value
                with self.assertRaises(ValueError):viewerctl.stop(self.site,'preview')
                kill.assert_called_once_with(4242,0)
        with patch.object(viewerctl.os,'kill'),patch.object(viewerctl,'health',return_value={'nonce':'owned'}),patch.object(viewerctl.socket,'socket') as socket,patch.object(viewerctl.time,'sleep'):
            socket.return_value.__enter__.return_value.connect_ex.return_value=0
            with self.assertRaises(ValueError):viewerctl.stop(self.site,'preview')
        file.unlink();viewerctl.stop(self.site,'preview')

    def test_live_verifier_rejects_other_sources_before_reading_assets(self):
        with patch.object(verify_vast_live.urllib.request,'urlopen',return_value=contextlib.closing(io.BytesIO(b'{"origen":"other-source"}'))),patch('sys.argv',['verify','--site',str(self.site)]),self.assertRaises(AssertionError):verify_vast_live.main()
