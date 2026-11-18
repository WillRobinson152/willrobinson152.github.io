'use strict';

const byId = id => document.getElementById(id);
const unlock = byId('unlock');
const passphrase = byId('passphrase');
const status = byId('status');
const library = byId('library');
const browse = byId('browse');
const reading = byId('reading');
const search = byId('search');
const results = byId('results');
const clip = byId('clip');
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const indexName = '00000000000000000000000000000000.bin';
const mediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'audio/mpeg']);
const mediaURLs = new Set();
let session;
let articleRequest;
let unlockRequest;

async function record(name, signal) {
  if (!/^[a-f0-9]{32}\.bin$/.test(name)) throw new Error('Invalid name');
  const response = await fetch(`archive-data/${name}`, { cache: 'no-store', signal });
  if (!response.ok) throw new Error('Archive unavailable');
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.length < 49 || decoder.decode(data.subarray(0, 5)) !== 'WRAR1') {
    throw new Error('Invalid archive record');
  }
  return data;
}

async function decrypt(key, name, data, prefix) {
  if (!prefix.every((byte, index) => byte === data[index])) throw new Error('Different archive');
  const additionalData = new Uint8Array(21 + name.length);
  additionalData.set(prefix);
  additionalData.set(encoder.encode(name), 21);
  return crypto.subtle.decrypt({
    name: 'AES-GCM', iv: data.subarray(21, 33), additionalData,
  }, key, data.subarray(33));
}

function showResults() {
  results.replaceChildren();
  const words = search.value.toLocaleLowerCase().trim().split(/\s+/);
  const matches = session.articles.filter(article => {
    const text = [article.title, article.publisher, article.date].join(' ').toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });
  for (const article of matches) {
    const item = document.createElement('li');
    item.className = 'archive-result';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-link p-0 fw-semibold';
    button.textContent = article.title;
    button.addEventListener('click', () => openArticle(article));
    const metadata = document.createElement('div');
    metadata.textContent = [article.publisher, article.date].filter(Boolean).join(' · ');
    item.append(button, metadata);
    results.append(item);
  }
  status.textContent = matches.length === 1 ? '1 article' : `${matches.length} articles`;
}

function clearArticle() {
  articleRequest?.abort();
  articleRequest = undefined;
  clip.replaceChildren();
  for (const url of mediaURLs) URL.revokeObjectURL(url);
  mediaURLs.clear();
  reading.hidden = true;
  browse.hidden = false;
}

function configureEmbeds() {
  for (const container of clip.querySelectorAll('[data-flourish]')) {
    const path = container.dataset.flourish;
    if (!/^(story|visualisation)\/[0-9]+$/.test(path)) continue;
    const embedURL = `https://flo.uri.sh/${path}/embed`;
    const frame = document.createElement('iframe');
    frame.title = 'Interactive graphic from Flourish';
    frame.referrerPolicy = 'no-referrer';
    frame.sandbox.add('allow-scripts', 'allow-same-origin');
    frame.src = embedURL;

    const directLink = document.createElement('a');
    directLink.href = embedURL;
    directLink.target = '_blank';
    directLink.rel = 'noopener noreferrer';
    directLink.textContent = 'Open on Flourish (new tab)';
    container.append(frame, directLink);
  }
}

async function openArticle(article) {
  clearArticle();
  const current = session;
  const request = new AbortController();
  articleRequest = request;
  const { signal } = request;
  const load = async name => decrypt(current.key, name, await record(name, signal), current.prefix);
  status.textContent = 'Opening article…';
  try {
    const body = JSON.parse(decoder.decode(await load(article.id)));
    if (signal.aborted) return;
    clip.innerHTML = body;
    configureEmbeds();
    browse.hidden = true;
    reading.hidden = false;
    clip.focus();
    status.textContent = '';
    await Promise.all(Array.from(clip.querySelectorAll('[data-asset]'), async element => {
      try {
        if (!mediaTypes.has(element.dataset.type)) throw new Error('Invalid media type');
        const bytes = await load(element.dataset.asset);
        if (signal.aborted) return;
        const url = URL.createObjectURL(new Blob([bytes], { type: element.dataset.type }));
        mediaURLs.add(url);
        element.src = url;
      } catch {
        if (signal.aborted) return;
        const fallback = document.createElement('p');
        fallback.textContent = `${element.alt || 'Article media'} could not be loaded.`;
        element.replaceWith(fallback);
      }
    }));
  } catch {
    if (!signal.aborted) status.textContent = 'Could not open this article.';
  }
}

unlock.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = unlock.querySelector('button');
  const request = new AbortController();
  unlockRequest = request;
  submit.disabled = true;
  status.textContent = 'Unlocking…';
  const secret = encoder.encode(passphrase.value);
  passphrase.value = '';
  try {
    const material = await crypto.subtle.importKey('raw', secret, 'PBKDF2', false, ['deriveKey']);
    const data = await record(indexName, request.signal);
    const prefix = data.slice(0, 21);
    const key = await crypto.subtle.deriveKey({
      name: 'PBKDF2', salt: prefix.subarray(5), iterations: 600000, hash: 'SHA-256',
    }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const articles = JSON.parse(decoder.decode(await decrypt(key, indexName, data, prefix)));
    if (request.signal.aborted) return;
    session = { key, articles, prefix };
    unlock.hidden = true;
    library.hidden = false;
    showResults();
    search.focus();
  } catch {
    if (request.signal.aborted) return;
    status.textContent = 'Could not unlock the archive. Check the passphrase and try again.';
    passphrase.focus();
  } finally {
    if (unlockRequest === request) unlockRequest = undefined;
    secret.fill(0);
    submit.disabled = false;
  }
});

function lock(restoreFocus) {
  if (!session) return;
  session = undefined;
  clearArticle();
  search.value = '';
  results.replaceChildren();
  library.hidden = true;
  unlock.hidden = false;
  status.textContent = 'Archive locked.';
  if (restoreFocus) passphrase.focus();
}

search.addEventListener('input', showResults);
byId('back').addEventListener('click', () => {
  clearArticle();
  showResults();
  search.focus();
});
byId('lock').addEventListener('click', () => lock(true));
window.addEventListener('pagehide', () => {
  unlockRequest?.abort();
  passphrase.value = '';
  lock(false);
});
