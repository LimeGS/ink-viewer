#!/usr/bin/env python3
"""Send a committed code bundle over SSH and update only the remote preview."""
import argparse
import json
import re
import shlex
import subprocess
import tempfile
from pathlib import Path
from ink_viewer.paths import SOURCE_ROOT


REMOTE = r'''
import json, os, subprocess, sys, tempfile
from pathlib import Path
site, code, commit, origin = map(str, json.loads(sys.argv[1]))
site, code = Path(site), Path(code)
if not site.is_absolute() or not code.is_absolute(): raise SystemExit('Remote paths must be absolute')
if not (site / 'site.json').is_file(): raise SystemExit('Initialize the machine profile first')
transfers = site / 'transfers'; transfers.mkdir(exist_ok=True)
with tempfile.NamedTemporaryFile(dir=transfers, suffix='.bundle', delete=False) as f:
    import shutil
    shutil.copyfileobj(sys.stdin.buffer, f)
    bundle = f.name
try:
    if (code / '.git').exists():
        if subprocess.check_output(['git','-C',str(code),'status','--porcelain']).strip():
            raise SystemExit('Remote code checkout has edits; refusing to overwrite them')
        actual = subprocess.check_output(['git','-C',str(code),'remote','get-url','origin'],text=True).strip()
        if actual != origin: raise SystemExit('Remote checkout uses a different repository')
        subprocess.run(['git','-C',str(code),'fetch',bundle,commit],check=True)
    else:
        if code.exists(): raise SystemExit('Remote code directory exists without Git')
        code.parent.mkdir(parents=True,exist_ok=True)
        subprocess.run(['git','clone','--no-checkout',bundle,str(code)],check=True)
        subprocess.run(['git','-C',str(code),'remote','set-url','origin',origin],check=True)
    subprocess.run(['git','-C',str(code),'checkout','--detach',commit],check=True)
    settings = json.loads((site / 'site.json').read_text())
    packaged = (code/'src/ink_viewer/deployment/viewerctl.py').is_file()
    entry = ['-m','ink_viewer.deployment.viewerctl'] if packaged else [str(code/'viewerctl.py')]
    subprocess.run([settings['python'],'-B',*entry,'--site',str(site),
                    'update','--no-fetch','--ref',commit],check=True,cwd=code,
                   env=dict(os.environ,PYTHONPATH=str(code/'src' if packaged else code)))
finally:
    os.unlink(bundle)
'''


def code_bundle(repo, commit, bundle):
    """Ship one selected source history, rejecting data even if deleted at its tip."""
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Invalid publication commit')
    def git(*args):
        return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()
    paths = set(git('log', '--format=', '--name-only', '--no-renames', commit).splitlines()) - {''}
    # Accept the original flat history and the packaged source tree, never runtime data.
    special = {'README.md', 'VERSION', '.gitignore', 'requirements.txt', 'LICENSE',
               'LICENSE-Inter.txt', 'inter-17fe38ab302c7e5d.woff2', 'pyproject.toml',
               'package.json', '.github/workflows/tests.yml', 'docs/architecture.md'}
    suffixes = {'.py', '.js', '.cjs', '.css', '.html'}
    for name in sorted(paths):
        path = Path(name)
        nested_source = (name.startswith('src/ink_viewer/') and path.suffix in suffixes | {'.woff2'}
                         or name == 'src/ink_viewer/web/images/grilli.webp')
        nested_test = (name.startswith('tests/python/') and path.suffix == '.py' or
                       name.startswith('tests/javascript/') and path.suffix == '.cjs')
        flat_source = '/' not in name and not name.startswith('.') and path.suffix in suffixes
        if ('..' in path.parts or path.is_absolute() or
                any(part.startswith('.') for part in path.parts) and name not in special):
            raise ValueError('Selected Git history contains data/configuration: ' + name)
        if not (name in special or nested_source or nested_test or flat_source):
            raise ValueError('Selected Git history contains data/configuration: ' + name + '; use a source-only history')
    # A bundle advertising only refs/remotes/* clones empty. Use one head in an isolated bare repo.
    with tempfile.TemporaryDirectory(dir=Path(bundle).parent) as staging:
        subprocess.run(['git', 'init', '--bare', '--quiet', staging], check=True)
        subprocess.run(['git', '-C', staging, 'fetch', '--quiet', '--no-tags', str(Path(repo).resolve()), commit], check=True)
        subprocess.run(['git', '-C', staging, 'update-ref', 'refs/heads/viewer-release', commit], check=True)
        subprocess.run(['git', '-C', staging, 'symbolic-ref', 'HEAD', 'refs/heads/viewer-release'], check=True)
        subprocess.run(['git', '-C', staging, 'bundle', 'create', str(Path(bundle).resolve()), 'refs/heads/viewer-release', 'HEAD'], check=True)
    heads = dict(line.split()[::-1] for line in git('bundle', 'list-heads', str(bundle)).splitlines())
    if heads != {'refs/heads/viewer-release': commit, 'HEAD': commit}:
        raise ValueError('Publication reference changed while creating the bundle; retry')


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--host', required=True, help='SSH host or configured alias, optionally user@host')
    ap.add_argument('--ssh-port', type=int)
    ap.add_argument('--identity')
    ap.add_argument('--remote-site', required=True)
    ap.add_argument('--remote-code', required=True)
    ap.add_argument('--ref', default='origin/main')
    ap.add_argument('--no-fetch', action='store_true')
    a = ap.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]+(@[A-Za-z0-9_.-]+)?', a.host): ap.error('Invalid SSH host')
    repo = SOURCE_ROOT
    if not a.no_fetch: subprocess.run(['git','-C',str(repo),'fetch','origin'],check=True)
    commit = subprocess.check_output(['git','-C',str(repo),'rev-parse','--verify','--end-of-options',a.ref+'^{commit}'],text=True).strip()
    origin = subprocess.check_output(['git','-C',str(repo),'remote','get-url','origin'],text=True).strip()
    with tempfile.TemporaryDirectory() as tmp:
        bundle = Path(tmp) / 'viewer.bundle'
        code_bundle(repo, commit, bundle)
        ssh = ['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10']
        if a.ssh_port: ssh += ['-p',str(a.ssh_port)]
        if a.identity: ssh += ['-i',str(Path(a.identity).expanduser())]
        payload = json.dumps([a.remote_site,a.remote_code,commit,origin])
        command = 'python3 -c ' + shlex.quote(REMOTE) + ' ' + shlex.quote(payload)
        with bundle.open('rb') as body: subprocess.run([*ssh,a.host,command],stdin=body,check=True)


if __name__ == '__main__': main()
