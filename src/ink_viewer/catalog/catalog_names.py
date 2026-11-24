"""Official ink-map filenames, including Helena's per-offset PNG extension."""
import re
from datetime import datetime, timezone


# Same name-emission API used by the existing catalog producers; discovery does not infer calibration from it.
VOLUMES = {'20250521151220': ('8.64', '1.2', '116')}


MAP = re.compile(
    r'(?P<sample>PHerc[A-Za-z0-9]+|unknown)-(?P<segment>.+?)-'
    r'(?:(?P<res>\d+(?:\.\d+)?)um-(?:(?P<dist>\d+(?:\.\d+)?)m-)?'
    r'(?P<kev>\d+)keV-volume-(?P<volume>\d{14})(?:-L(?P<level>\d+))?(?:-t(?P<transform>\d+))?|volume-(?P<novolume>unknown))-'
    r'(?P<run>\d{14}|\d{10})-(?P<model>[A-Za-z0-9_-]+?)-tile(?P<tile>\d+)-stride(?P<stride>\d+)'
    r'(?:-c(?P<centre>[+-]\d+))?(?P<glob>-global)?\.(?P<extension>png|tif|tiff)$', re.I)
PREVIEW = re.compile(MAP.pattern.replace(r'\.(?P<extension>png|tif|tiff)$', r'-ds(?P<scale>\d+)\.jpg$'), re.I)


def parse(filename):
    name = filename.rsplit('/', 1)[-1]
    m = MAP.fullmatch(name) or PREVIEW.fullmatch(name)
    if not m:
        return None
    d = m.groupdict()
    d['centre'] = int(d['centre']) if d['centre'] is not None else None
    d['contrast'] = 'global' if d.pop('glob') else 'fixed'
    d['kind'] = 'preview' if d.get('scale') else 'map'
    d['official'] = (d['dist'] is not None or d['novolume'] is not None) and len(d['run']) == 14
    return d


def run14(run):
    if isinstance(run, datetime):
        return run.astimezone(timezone.utc).strftime('%Y%m%d%H%M%S')
    run = str(run)
    if len(run) == 10:
        return datetime.fromtimestamp(int(run), timezone.utc).strftime('%Y%m%d%H%M%S')
    assert re.fullmatch(r'\d{14}', run), run
    return run


def stem(sample, segment, volume, run, model, tile=256, stride=128):
    if volume not in VOLUMES:
        return f'{sample}-{segment}-volume-unknown-{run14(run)}-{model}-tile{tile}-stride{stride}'
    res, dist, kev = VOLUMES[volume]
    return f'{sample}-{segment}-{res}um-{dist}m-{kev}keV-volume-{volume}-{run14(run)}-{model}-tile{tile}-stride{stride}'


def map_name(stem_, centre, contrast='fixed'):
    c = '' if centre is None else f'-c{centre:+03d}'
    return f"{stem_}{c}{'-global' if contrast == 'global' else ''}.png"


def preview_name(stem_, centre, contrast='fixed', scale=4):
    return 'downsampled/' + map_name(stem_, centre, contrast).removesuffix('.png') + f'-ds{scale}.jpg'


def normalize(filename):
    head, _, name = filename.rpartition('/')
    d = parse(name)
    assert d, f'not a catalog map name: {filename}'
    s = stem(d['sample'], d['segment'], d['volume'], d['run'], d['model'], int(d['tile']), int(d['stride']))
    new = map_name(s, d['centre'], d['contrast']) if d['kind'] == 'map' else preview_name(s, d['centre'], d['contrast'], int(d['scale'])).split('/', 1)[1]
    return f'{head}/{new}' if head else new
