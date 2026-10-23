import unittest
from catalog_names import map_name, normalize, parse, preview_name, stem

LEGACY = 'PHerc1447-m071-072e3x_r1--cut-53cf4facc341073c1a28-8.64um-116keV-volume-20250521151220-1789721772-r3f-tile256-stride128-c-06-global.png'
OFFICIAL = 'PHerc1447-m071-072e3x_r1--cut-53cf4facc341073c1a28-8.64um-1.2m-116keV-volume-20250521151220-20260918085612-r3f-tile256-stride128-c-06-global.png'


class Names(unittest.TestCase):
    def test_legacy_name_on_work3_normalizes_to_official(self):
        self.assertEqual(normalize(LEGACY), OFFICIAL)
        self.assertEqual(normalize('ink-detection/' + LEGACY), 'ink-detection/' + OFFICIAL)
        self.assertEqual(normalize(OFFICIAL), OFFICIAL)  # idempotent

    def test_parse_fields(self):
        d = parse(OFFICIAL)
        self.assertEqual((d['segment'], d['model'], d['centre'], d['contrast'], d['kind'], d['official']),
                         ('m071-072e3x_r1--cut-53cf4facc341073c1a28', 'r3f', -6, 'global', 'map', True))
        self.assertFalse(parse(LEGACY)['official'])
        self.assertIsNone(parse('fixed.png'))

    def test_projection_has_no_centre(self):
        legacy = LEGACY.replace('-c-06-global.png', '-global.png')
        d = parse(legacy)
        self.assertEqual((d['kind'], d['centre'], d['contrast']), ('map', None, 'global'))
        self.assertEqual(normalize(legacy), OFFICIAL.replace('-c-06-global.png', '-global.png'))

    def test_segment_names_with_hyphens_and_timestamps(self):
        s = stem('PHerc1447', '20250703034159-auto_grown_20250703034159599', '20250521151220', '20260920101500', 'base')
        d = parse(map_name(s, 4))
        self.assertEqual((d['segment'], d['run'], d['centre'], d['contrast']),
                         ('20250703034159-auto_grown_20250703034159599', '20260920101500', 4, 'fixed'))

    def test_unknown_scroll_and_volume_are_explicit(self):
        s = stem('unknown', 'V00_B95', None, '20260911120000', 'base')
        self.assertEqual(s, 'unknown-V00_B95-volume-unknown-20260911120000-base-tile256-stride128')
        d = parse(map_name(s, 2))
        self.assertEqual((d['sample'], d['segment'], d['volume'], d['centre'], d['official']), ('unknown', 'V00_B95', None, 2, True))

    def test_previews(self):
        s = stem('PHerc1447', 'seg--sha-a03bee4157af9123fe6c', '20250521151220', '20260920101500', 'r3f')
        self.assertEqual(preview_name(s, 4, 'global', 8), f'downsampled/{s}-c+04-global-ds8.jpg')
        legacy_run_preview = 'PHerc1447-m079-080xx_r2--cut-0257950daf2607204a34-8.64um-116keV-volume-20250521151220-1789705975-r9e-tile256-stride128-ds8.jpg'
        d = parse(legacy_run_preview)
        self.assertEqual((d['kind'], d['centre'], d['scale']), ('preview', None, '8'))
        self.assertTrue(normalize(legacy_run_preview).endswith('-8.64um-1.2m-116keV-volume-20250521151220-20260918043255-r9e-tile256-stride128-ds8.jpg'))


if __name__ == '__main__':
    unittest.main()
