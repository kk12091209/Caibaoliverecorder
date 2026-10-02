#!/usr/bin/env python3
"""Archive committed source and initialized submodules, never untracked user data."""
import hashlib, io, json, subprocess, sys, tarfile, zipfile
from pathlib import Path
root = Path(__file__).resolve().parents[2]
out = Path(sys.argv[1]).resolve()
if out.exists():
    raise SystemExit(f'Output already exists: {out}')
def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])
revision = git(root, 'rev-parse', 'HEAD').decode().strip()
manifest = {'revision': revision, 'repository': 'https://github.com/kk12091209/Caibaoliverecorder', 'submodules': [], 'files': []}
out.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(out, 'x', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    def add(name, data, mode=0o100644):
        if name.startswith('/') or '..' in Path(name).parts:
            raise RuntimeError(f'Unsafe path: {name}')
        info = zipfile.ZipInfo(name, (2000, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = mode << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, data)
        manifest['files'].append({'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    def collect(repo, rev, prefix=''):
        data = git(repo, 'archive', '--format=tar', rev)
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            for member in tar:
                if member.isfile():
                    add(prefix + member.name, tar.extractfile(member).read(), 0o100000 | member.mode)
                elif member.issym():
                    add(prefix + member.name, member.linkname.encode(), 0o120777)
        for item in git(repo, 'ls-tree', '-r', '-z', rev).split(b'\0'):
            if not item: continue
            metadata, path = item.split(b'\t', 1)
            mode, kind, sha = metadata.decode().split()
            if mode != '160000': continue
            path = path.decode(); sub = repo / path
            if not (sub / '.git').exists():
                raise RuntimeError(f'Initialize submodule first: {sub}')
            url = git(sub, 'remote', 'get-url', 'origin').decode().strip()
            if '@' in url and url.startswith('http'):
                raise RuntimeError('Credential-bearing submodule URL')
            manifest['submodules'].append({'path': prefix + path, 'revision': sha, 'url': url})
            collect(sub, sha, prefix + path + '/')
    collect(root, revision)
    add('SOURCE-README.txt', f'''Caibo 0.1.4 corresponding application source at {revision}.
Includes committed source and exact submodule contents; no local recordings,
credentials, caches, SDKs or development runtime downloads are included.
The upstream repository contains public test fixtures and a legacy WPF helper.
They are tracked upstream inputs, not recordings from this installation.

Recorder GitVersion requires Git history. Build from the matching checkout:
  git clone --recurse-submodules https://github.com/kk12091209/Caibaoliverecorder.git
  cd Caibaoliverecorder
  git checkout {revision}
  git submodule update --init --recursive
Then follow live-editor/docs/MACOS.md or live-editor/docs/RELEASE.md.
FFmpeg supplier source and license inventory is a separate release attachment.
'''.encode())
    archive.writestr('SOURCE-MANIFEST.json', json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'archive': str(out), 'revision': revision, 'files': len(manifest['files']), 'bytes': out.stat().st_size}))
