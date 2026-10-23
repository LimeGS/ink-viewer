import copy
import json
from pathlib import Path
import tempfile
import unittest

from vast_catalog import build_v5_index
from vast_server import VastSource


class ScoresTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def run_record(self, model, score, segment='sheet--rev-123', roll='PHerc0175A'):
        directory = roll + '/segments/' + segment + '/ink-detection/run-' + model
        run = {'id': roll + ':' + segment + ':' + model, 'canonicalCatalog': True,
               'catalogMeta': {'lam': segment, 'modelo': model}, 'scroll': roll,
               'sourceDirectory': directory}
        doc = {'sample': roll, 'segment': segment, 'model': {'name': model}, 'scores': {}}
        if score is not None:
            doc['scores']['v5'] = {'max': score, 'modelo': model, 'mejor_centro': 2,
                                   'pct_rollo_modelo': 91.2, 'mapa_sha256': 'measured-map',
                                   'por_modelo': {'unpublished': {'max': 0.999}}}
        path = self.root / (directory + '.json')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(doc))
        return run, path

    def test_scores_preserve_measured_values_and_best_displayed_model(self):
        base, _ = self.run_record('base', 0)
        r3f, _ = self.run_record('r3f', 0.8)
        original = copy.deepcopy([base, r3f])
        result = build_v5_index([base, r3f], self.root)
        score = result['laminas']['sheet--rev-123']
        self.assertEqual(score['max'], 0.8)
        self.assertEqual(score['modelo'], 'r3f')
        self.assertEqual(score['mejor_centro'], 2)
        self.assertEqual(score['pct_rollo_modelo'], 91.2)
        self.assertEqual(score['por_modelo']['base']['max'], 0)
        self.assertEqual(set(score['por_modelo']), {'base', 'r3f'})
        self.assertEqual([base, r3f], original)
        self.assertFalse(result['errors'])

    def test_unmeasured_and_invalid_scores_are_not_zero_measurements(self):
        missing, _ = self.run_record('missing', None)
        invalid, _ = self.run_record('invalid', float('nan'))
        boolean, _ = self.run_record('boolean', True)
        result = build_v5_index([missing, invalid, boolean], self.root)
        self.assertEqual(result['laminas'], {})
        self.assertEqual(result['unscored_runs'], [missing['id']])
        self.assertEqual(len(result['errors']), 2)

    def test_wrong_identity_and_paths_outside_catalog_are_rejected(self):
        run, path = self.run_record('base', 0.5)
        doc = json.loads(path.read_text())
        doc['segment'] = 'another-revision'
        path.write_text(json.dumps(doc))
        outside = dict(run, sourceDirectory='../outside')
        result = build_v5_index([run, outside], self.root)
        self.assertFalse(result['laminas'])
        self.assertEqual(len(result['errors']), 2)

    def test_equal_names_from_different_scrolls_stay_separate(self):
        a, _ = self.run_record('base', 0.1, roll='PHerc0175A')
        b, _ = self.run_record('base', 0.9, roll='PHerc0306B')
        result = build_v5_index([a, b], self.root)
        self.assertEqual(set(result['laminas']), {'PHerc0175A/sheet--rev-123', 'PHerc0306B/sheet--rev-123'})

    def test_scores_are_served_from_deployment_cache_without_catalog_writes(self):
        source = object.__new__(VastSource)
        source.site = self.root
        source.registry = {'routes': {}}
        path = self.root / 'cache/_viewer/legibilidad-auto.json'
        path.parent.mkdir(parents=True)
        path.write_text('{"laminas":{"sheet":{"max":0.5}}}')
        with source.abrir('_viewer/legibilidad-auto.json') as (status, headers, body):
            self.assertEqual(status, 200)
            self.assertEqual(headers['Content-Type'], 'application/json')
            self.assertEqual(json.load(body)['laminas']['sheet']['max'], 0.5)
        self.assertEqual(source.indice('_viewer/legibilidad-auto.json')['laminas']['sheet']['max'], 0.5)


if __name__ == '__main__':
    unittest.main()
