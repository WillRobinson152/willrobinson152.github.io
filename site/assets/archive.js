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
const sortButtons = browse.querySelectorAll('[data-sort]');
const compareText = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const displayDate = new Intl.DateTimeFormat('en-US', {
  year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
});
// These titles and their awards are listed on the public Journalism page.
const awards = new Map([
  ['DataDigest: Yes, buyer agents steer clients, new study claims', 'SABEW Data Journalism'],
  ['Employed & Homeless: As CSX changes plans, dispatchers left in limbo during holidays', 'SABEW Transportation Honorable Mention'],
  ['Historic dividends : Preserving or demolishing downtown Jacksonville', 'NAREE Bronze'],
  ['Parking Pitch', 'SABEW Government Reporting'],
]);
const externalArticles = [
  {
    title: 'AI search loves listicles: What 25,000 URLs reveal about citations',
    publisher: 'Search Engine Land',
    date: '2026-03-19',
    url: 'https://searchengineland.com/ai-search-loves-listicles-what-25000-urls-reveal-about-citations-477682',
  },
  {
    title: 'What AI models are saying to voters ahead of the midterms',
    publisher: 'Evertune/Orchestra',
    date: '2026-08-28',
    url: 'https://www.evertune.ai/resources/insights-on-ai/what-ai-models-are-saying-to-voters-ahead-of-the-midterms',
  },
  {
    title: 'Where AI Sends Shoppers and Agents for Black Friday Deals',
    publisher: 'Evertune',
    date: '2026-10-28',
    url: 'https://www.evertune.ai/resources/insights-on-ai/where-ai-sends-shoppers-and-agents-for-black-friday-deals',
  },
];
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
  const { key, direction } = session.sort;
  const matches = session.articles.filter(article => {
    const text = [article.title, article.publisher, article.date, article.award].join(' ').toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });
  matches.sort((first, second) => (
    direction * compareText.compare(first[key] ?? '', second[key] ?? '')
    || compareText.compare(first.title, second.title)
  ));
  for (const sortButton of sortButtons) {
    const header = sortButton.parentElement;
    if (sortButton.dataset.sort === key) {
      header.setAttribute('aria-sort', direction === 1 ? 'ascending' : 'descending');
    } else {
      header.removeAttribute('aria-sort');
    }
  }
  for (const article of matches) {
    const row = results.insertRow();
    const published = row.insertCell();
    if (article.date) {
      const time = document.createElement('time');
      const date = new Date(article.date);
      time.dateTime = article.date;
      time.textContent = Number.isNaN(date.getTime()) ? article.date : displayDate.format(date);
      published.append(time);
    }
    const title = document.createElement(article.url ? 'a' : 'button');
    title.className = 'btn btn-link p-0 fw-semibold portfolio-title';
    title.textContent = article.title;
    if (article.url) {
      title.href = article.url;
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
      const label = document.createElement('span');
      label.className = 'visually-hidden';
      label.textContent = ' (opens in a new tab)';
      title.append(label);
    } else {
      title.type = 'button';
      title.addEventListener('click', () => openArticle(article));
    }
    row.insertCell().append(title);
    row.insertCell().textContent = article.publisher;
    row.insertCell().textContent = article.award || '—';
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
    const isStory = path.startsWith('story/');
    const embedURL = isStory
      ? `https://public.flourish.studio/${path}/`
      : `https://flo.uri.sh/${path}/embed`;
    const frame = document.createElement('iframe');
    frame.title = isStory ? 'Scrollable story from Flourish' : 'Interactive graphic from Flourish';
    if (isStory) frame.className = 'archive-story-frame';
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
    session = {
      key, prefix, sort: { key: 'date', direction: -1 },
      articles: [
        ...articles.map(article => ({ ...article, award: awards.get(article.title) })),
        ...externalArticles,
      ],
    };
    unlock.hidden = true;
    library.hidden = false;
    showResults();
    search.focus();
  } catch {
    if (request.signal.aborted) return;
    status.textContent = 'Could not unlock the archive. Check the password and try again.';
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
  status.textContent = '';
  if (restoreFocus) passphrase.focus();
}

search.addEventListener('input', showResults);
for (const button of sortButtons) {
  button.addEventListener('click', () => {
    const key = button.dataset.sort;
    const previous = session.sort;
    const direction = key === previous.key ? -previous.direction : key === 'date' ? -1 : 1;
    session.sort = { key, direction };
    showResults();
  });
}
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
