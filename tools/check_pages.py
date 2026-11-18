#!/usr/bin/env python3
"""Export and check the exact Pages payload from HEAD or the Git index."""
import argparse
import io
from pathlib import Path
import re
import subprocess
import tarfile

PUBLIC = set("""
portfolio.html assets/archive.css assets/archive.js assets/bootstrap-LICENSE
assets/bootswatch-LICENSE assets/flatly.min.css assets/portfolio.css coding.html
data-analysis.html index.html journalism.html
""".split())
INDEX = 'archive-data/00000000000000000000000000000000.bin'
CIPHERTEXT = re.compile(r'archive-data/[a-f0-9]{32}\.bin')


def export(staged, output):
    revision = subprocess.check_output(['git', 'write-tree'], text=True).strip() if staged else 'HEAD'
    payload = subprocess.check_output(['git', 'archive', '--format=tar', f'{revision}:site'])
    files = {}
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:') as archive:
        for entry in archive:
            if entry.isdir() and entry.name in {'archive-data', 'assets'}:
                continue
            name = entry.name
            if not entry.isfile() or name in files or not (name in PUBLIC or CIPHERTEXT.fullmatch(name)):
                raise ValueError(f'Unexpected Pages artifact entry: {name}')
            files[name] = archive.extractfile(entry).read()
    if not PUBLIC.issubset(files) or INDEX not in files:
        raise ValueError('Required site files or the encrypted index are missing.')
    prefix = files[INDEX][:21]
    nonces = set()
    for name, data in files.items():
        if not CIPHERTEXT.fullmatch(name):
            continue
        nonce = data[21:33]
        if len(data) <= 49 or not prefix.startswith(b'WRAR1') or data[:21] != prefix or nonce in nonces:
            raise ValueError(f'Invalid encrypted record: {name}')
        nonces.add(nonce)
    if len(nonces) < 2:
        raise ValueError('The archive must include an index and at least one article.')
    output.mkdir()
    for name, data in files.items():
        path = output / name
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(data)
    print(f'Exported {len(PUBLIC)} public files and {len(nonces)} opaque records from {revision}.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--staged', action='store_true')
    parser.add_argument('output', type=Path, help='A new directory for the Pages artifact')
    arguments = parser.parse_args()
    try:
        export(arguments.staged, arguments.output)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Pages check failed: {error}\n')
