#!/usr/bin/env python3
"""Build or authenticate an archive using a private source manifest."""
import argparse
from getpass import getpass
from html import escape
import json
from pathlib import Path
import re
import secrets
import sys
import tempfile
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from lxml import html


MAGIC = b'WRAR1'
INDEX = '00000000000000000000000000000000.bin'
ITERATIONS = 600_000
NAME = re.compile(r'[a-f0-9]{32}\.bin')
FLOURISH = re.compile(r'(?:story|visualisation)/[0-9]+')
TAGS = set('a abbr b blockquote br cite code dd div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i li ol p pre q s small span strong sub sup table tbody td th thead tr u ul'.split())
VOID = {'br', 'hr'}
ASSET_TYPES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.mp3': 'audio/mpeg',
}


def private_path(path):
    resolved = Path(path).resolve(strict=True)
    if any(
        (parent / '.git').is_file() or (parent / '.git' / 'HEAD').is_file()
        for parent in resolved.parents
    ):
        raise ValueError('Keep all plaintext sources outside Git checkouts.')
    return resolved


def web_link(value):
    return value.startswith('#') or (
        urlsplit(value).scheme in {'https', 'http'} and bool(urlsplit(value).hostname)
    )


def encode(value):
    return json.dumps(value, ensure_ascii=False).encode('utf-8')


class Sources:
    def __init__(self, manifest):
        self.directory = manifest.parent
        self.files = {}
        self.asset_ids = {}

    def read(self, config):
        articles = []
        for entry in config['articles']:
            document = html.document_fromstring(
                private_path(self.directory / entry['clip']).read_bytes(),
                parser=html.HTMLParser(encoding='utf-8', no_network=True),
            )
            heading = document.find('.//h1')
            if heading is None:
                raise ValueError('An article clip is missing its headline.')
            title = ' '.join(heading.text_content().split())
            pieces = [self.render(heading, entry), escape(heading.tail or '')]
            for sibling in heading.itersiblings():
                pieces.extend((self.render(sibling, entry), escape(sibling.tail or '')))
            article_id = self.add(encode(''.join(pieces)))
            articles.append({
                'id': article_id, 'title': title, 'publisher': entry['publisher'],
                'date': entry['date'],
            })
        if not articles:
            raise ValueError('The manifest must contain at least one article.')
        self.files[INDEX] = encode(articles)

    def add(self, contents):
        name = secrets.token_hex(16) + '.bin'
        while name == INDEX or name in self.files:
            name = secrets.token_hex(16) + '.bin'
        self.files[name] = contents
        return name

    def render(self, node, entry):
        tag = node.tag
        if not isinstance(tag, str) or tag in {'script', 'style', 'iframe', 'object', 'embed', 'template'}:
            return ''
        if tag in {'img', 'audio'}:
            label = node.get('alt', '') if tag == 'img' else 'Audio excerpt'
            label = label or 'Article image'
            source = node.get('src', '')
            local = entry.get('assets', {}).get(source)
            if local is None:
                return f'<p class="archive-media-note">{escape(label)} (file unavailable)</p>'
            path = private_path(self.directory / local)
            mime = ASSET_TYPES.get(path.suffix.lower(), '')
            if not mime.startswith('image/' if tag == 'img' else 'audio/'):
                raise ValueError('An archive media file has an unsupported extension.')
            if path not in self.asset_ids:
                self.asset_ids[path] = self.add(path.read_bytes())
            attrs = f'data-asset="{self.asset_ids[path]}" data-type="{mime}"'
            if tag == 'img':
                return f'<img {attrs} alt="{escape(label, quote=True)}">'
            return f'<audio {attrs} controls preload="none" aria-label="{label}"></audio>'
        if 'flourish-embed' in node.get('class', '').split():
            embed = node.get('data-src', '').split('?', 1)[0]
            if FLOURISH.fullmatch(embed) and embed in entry.get('flourish', []):
                return f'<div class="archive-embed" data-flourish="{embed}"></div>'
            return '<p class="archive-media-note">Interactive graphic unavailable. See the original article.</p>'
        contents = escape(node.text or '') + ''.join(
            self.render(child, entry) + escape(child.tail or '') for child in node
        )
        if tag not in TAGS:
            return contents
        if tag in VOID:
            return f'<{tag}>'
        attrs = ''
        if tag == 'a' and web_link(node.get('href', '')):
            href = escape(node.get('href'), quote=True)
            attrs = f' href="{href}"'
            if not href.startswith('#'):
                attrs += ' target="_blank" rel="noopener noreferrer"'
        source_id = node.get('id', '')
        if re.fullmatch(r'[A-Za-z][\w-]*', source_id):
            attrs += f' id="clip-{source_id}"'
        if attrs.startswith(' href="#'):
            attrs = attrs.replace(' href="#', ' href="#clip-', 1)
        return f'<{tag}{attrs}>{contents}</{tag}>'


def cipher(password, salt):
    return AESGCM(PBKDF2HMAC(
        algorithm=SHA256(), length=32, salt=salt, iterations=ITERATIONS,
    ).derive(password.encode('utf-8')))


def seal(aes, name, data, prefix):
    nonce = secrets.token_bytes(12)
    return prefix + nonce + aes.encrypt(nonce, data, prefix + name.encode('ascii'))


def decrypt_bundle(directory, password):
    index = (directory / INDEX).read_bytes()
    prefix = index[:21]
    if len(prefix) != 21 or not prefix.startswith(MAGIC):
        raise ValueError('Invalid archive header.')
    aes = cipher(password, prefix[5:])
    plaintext = {}
    for path in directory.iterdir():
        if not NAME.fullmatch(path.name) or path.is_symlink():
            raise ValueError('Unexpected archive entry.')
        data = path.read_bytes()
        if len(data) < 49 or data[:21] != prefix:
            raise ValueError('Invalid archive record.')
        plaintext[path.name] = aes.decrypt(data[21:33], data[33:], prefix + path.name.encode('ascii'))
    articles = json.loads(plaintext[INDEX])
    referenced = {INDEX}
    for article in articles:
        article_id = article['id']
        content = html.fragment_fromstring(json.loads(plaintext[article_id]), create_parent=True)
        referenced.add(article_id)
        referenced.update(node.attrib['data-asset'] for node in content.xpath('//*[@data-asset]'))
    if referenced != plaintext.keys():
        raise ValueError('The archive contains missing or unreferenced records.')
    return plaintext, len(articles)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    build = commands.add_parser('build')
    build.add_argument('manifest', type=Path)
    build.add_argument('output', type=Path)
    verify = commands.add_parser('verify')
    verify.add_argument('directory', type=Path)
    args = parser.parse_args()
    if not sys.stdin.isatty():
        parser.error('Run from an interactive terminal for the hidden passphrase prompt.')
    password = getpass('Archive passphrase: ')
    try:
        if args.command == 'verify':
            plaintext, count = decrypt_bundle(args.directory, password)
        else:
            if len(password) < 20 or password != getpass('Confirm passphrase: '):
                raise ValueError('Use a strong passphrase of at least 20 characters and confirm it.')
            manifest = private_path(args.manifest)
            sources = Sources(manifest)
            sources.read(json.loads(manifest.read_text(encoding='utf-8')))
            output = args.output.resolve()
            if output.exists():
                raise ValueError('Choose a new output directory.')
            prefix = MAGIC + secrets.token_bytes(16)
            aes = cipher(password, prefix[5:])
            with tempfile.TemporaryDirectory(prefix='.archive-', dir=output.parent) as scratch:
                bundle = Path(scratch) / 'payload'
                bundle.mkdir()
                for name, contents in sources.files.items():
                    (bundle / name).write_bytes(seal(aes, name, contents, prefix))
                plaintext, count = decrypt_bundle(bundle, password)
                if plaintext != sources.files:
                    raise ValueError('Archive round-trip verification failed.')
                bundle.rename(output)
    except InvalidTag:
        parser.exit(1, 'Authentication failed. Check the passphrase and bundle integrity.\n')
    except (ValueError, KeyError, OSError, TypeError) as error:
        parser.exit(1, f'Archive operation failed ({type(error).__name__}). Check paths, manifest, and input files.\n')
    print(f'Authenticated {count} articles and {len(plaintext) - count - 1} assets.')


if __name__ == '__main__':
    main()
