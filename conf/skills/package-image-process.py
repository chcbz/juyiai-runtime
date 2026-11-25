#!/usr/bin/env python3
"""Prepare deterministic offline image instruction packages; never publish or install."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('destination', type=Path, help='task-owned output directory')
args = parser.parse_args()
root = Path(__file__).resolve().parent
source = root / 'image-process'
shared = root / 'native-image'
args.destination.mkdir(parents=True, exist_ok=True)
for key, version in (('image-process', '1.0.0'), ('image-generate', '2.0.0'), ('image-edit', '2.0.0')):
    files = {'SKILL.md': source / ('SKILL.md' if key == 'image-process' else f'variants/{key}.md'),
             'scripts/resize.mjs': source / 'scripts/resize.mjs',
             'scripts/image-input.mjs': shared / 'scripts/image-input.mjs'}
    if key != 'image-process':
        files['image-process.md'] = source / 'SKILL.md'
    for name in ('magick.mjs', 'magick.wasm', 'LICENSE', 'NOTICE', 'PROVENANCE.md'):
        files[f'vendor/{name}'] = shared / 'vendor' / name
    with io.BytesIO() as stream:
        with zipfile.ZipFile(stream, 'w') as archive:
            for name, path in sorted(files.items()):
                entry = zipfile.ZipInfo(name, (2026, 11, 25, 0, 0, 0))
                entry.external_attr = 0o100644 << 16
                archive.writestr(entry, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
        content = stream.getvalue()
    target = args.destination / f'{key}-{version}.zip'
    try:
        with target.open('xb') as handle:
            handle.write(content)
    except FileExistsError:
        if target.read_bytes() != content:
            raise SystemExit(f'Refusing to replace versioned bytes: {target}')
    print(json.dumps(dict(skillKey=key, skillVersion=version, packageFile=target.name,
                          packageSha256=hashlib.sha256(content).hexdigest(), packageByteLength=len(content),
                          state='PREPARED_NOT_PUBLISHED')))
