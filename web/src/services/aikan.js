export const DEFAULT_BASE_URL = 'https://v.aikanbot.com';
export const DEFAULT_PROXY_URL = defaultProxyUrl();

function defaultProxyUrl() {
  if (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null') {
    return window.location.origin;
  }
  return 'http://127.0.0.1:8787';
}

function normalizeBaseUrl(rawUrl, fallback) {
  const value = String(rawUrl || '').trim() || fallback;
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.href.replace(/\/+$/, '');
  } catch (_) {
    return fallback;
  }
}

export function normalizeServerUrl(rawUrl) {
  return normalizeBaseUrl(rawUrl, DEFAULT_BASE_URL);
}

export function normalizeProxyServerUrl(rawUrl) {
  return normalizeBaseUrl(rawUrl, DEFAULT_PROXY_URL);
}

function corsHint(error, target) {
  if (error instanceof TypeError) {
    return new Error(`浏览器无法直连 ${target}，通常是 CORS、Cloudflare 或防盗链限制。`);
  }
  return error;
}

async function fetchText(url) {
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      mode: 'cors',
      credentials: 'omit',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } catch (error) {
    throw corsHint(error, url);
  }
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      mode: 'cors',
      credentials: 'omit',
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 160)}`);
    }
    const payload = JSON.parse(text);
    if (payload?.error) {
      throw new Error(payload.error);
    }
    return payload;
  } catch (error) {
    throw corsHint(error, url);
  }
}

function proxyApiUrl(proxyBaseUrl, path, params) {
  const query = new URLSearchParams(params);
  return `${normalizeProxyServerUrl(proxyBaseUrl)}${path}?${query.toString()}`;
}

function normalizeUrl(rawUrl, baseUrl = DEFAULT_BASE_URL) {
  try {
    return new URL(rawUrl, normalizeServerUrl(baseUrl)).href;
  } catch (_) {
    return '';
  }
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toAikanImageProxy(videoId, rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url || !videoId || url.startsWith('data:') || url.includes('img-p.aikanbot.com')) return url;
  try {
    return `https://img-p.aikanbot.com/i/${videoId}?u=${window.btoa(url).replace(/=+$/, '')}`;
  } catch (_) {
    return url;
  }
}

function firstImage(container, baseUrl, videoId = '') {
  const img = container?.querySelector?.('img');
  if (!img) return '';
  const candidates = [
    img.getAttribute('src'),
    img.getAttribute('data-src'),
    img.getAttribute('data-original'),
  ]
    .map((item) => normalizeUrl(item || '', baseUrl))
    .filter((item) => item && !item.startsWith('data:'));
  const proxied = candidates.find((item) => item.includes('img-p.aikanbot.com'));
  return proxied || toAikanImageProxy(videoId, candidates[0] || '');
}

function nearestCard(link) {
  return (
    link.closest('li, article, .item, .card, .module-item, .stui-vodlist__box, .vodlist_item, div[class*="item"]') ||
    link.parentElement ||
    link
  );
}

function extractTags(card, title) {
  const raw = compactText(card?.innerText || '');
  if (!raw) return [];
  return raw
    .replace(title, ' ')
    .split(/[\n\r/|·,，]+|\s{2,}/)
    .map(compactText)
    .filter(Boolean)
    .filter((item, index, array) => array.indexOf(item) === index)
    .slice(0, 10);
}

function playableCountFromLabel(label) {
  const match = String(label || '').match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function normalizeResult(item) {
  const meta = compactText(item.meta);
  const cast = compactText(item.cast);
  return {
    videoId: String(item.videoId || item.video_id || ''),
    title: compactText(item.title),
    url: String(item.url || ''),
    thumb: String(item.thumb || ''),
    playableCount: Number(item.playableCount || item.playable_count || 0),
    playableLabel: compactText(item.playableLabel || item.playable_label),
    meta,
    cast,
    tags: Array.isArray(item.tags) ? item.tags : [meta, cast].filter(Boolean),
    summary: compactText(item.summary) || [meta, cast].filter(Boolean).join('\n'),
    source: item.source || '',
  };
}

function resultFromCard(card, baseUrl, source) {
  const link = [...card.querySelectorAll('a[href]')].find((item) => /\/play\/(\d+)/.test(item.getAttribute('href') || ''));
  const match = link?.getAttribute('href')?.match(/\/play\/(\d+)/);
  if (!match) return null;

  const titleEl = card.querySelector('.title-text') || link;
  const label = compactText(card.querySelector('.label')?.textContent || '');
  const smallLines = [...card.querySelectorAll('.small')].map((item) => compactText(item.textContent)).filter(Boolean);
  const title = compactText(titleEl?.textContent || titleEl?.getAttribute?.('title') || card.querySelector('img')?.getAttribute('alt') || match[1]);
  const meta = smallLines[0] || '';
  const cast = smallLines[1] || '';

  return normalizeResult({
    videoId: match[1],
    title,
    url: normalizeUrl(link.getAttribute('href'), baseUrl),
    thumb: firstImage(card, baseUrl, match[1]),
    playableCount: playableCountFromLabel(label),
    playableLabel: label,
    meta,
    cast,
    tags: [meta, cast].filter(Boolean),
    summary: [meta, cast].filter(Boolean).join('\n'),
    source,
  });
}

export async function searchAikan(keyword, options = {}) {
  if (options.useSearchServer ?? options.useProxy) {
    const payload = await fetchJson(proxyApiUrl(options.proxyBaseUrl, '/api/search', {
      q: keyword,
      baseUrl: normalizeServerUrl(options.baseUrl),
    }));
    return (payload.results || []).map((item) => normalizeResult({
      ...item,
      source: 'proxy',
    }));
  }

  const baseUrl = normalizeServerUrl(options.baseUrl);
  const query = new URLSearchParams({ q: keyword });
  const searchUrl = `${baseUrl}/search?${query.toString()}`;
  const html = await fetchText(searchUrl);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const results = [];
  const seen = new Set();

  for (const card of doc.querySelectorAll('.media')) {
    const item = resultFromCard(card, baseUrl, searchUrl);
    if (!item || seen.has(item.videoId)) continue;
    seen.add(item.videoId);
    results.push(item);
  }

  for (const link of doc.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/\/play\/(\d+)/);
    if (!match) continue;

    const videoId = match[1];
    if (seen.has(videoId)) continue;
    seen.add(videoId);

    const card = nearestCard(link);
    const title = compactText(link.textContent || link.getAttribute('title') || card?.querySelector?.('[title]')?.getAttribute('title') || videoId);
    const summary = compactText(card?.innerText || link.textContent || '');
    results.push(normalizeResult({
      videoId,
      title,
      url: normalizeUrl(href, baseUrl),
      thumb: firstImage(link, baseUrl, videoId) || firstImage(card, baseUrl, videoId),
      tags: extractTags(card, title),
      summary,
      source: searchUrl,
    }));
  }

  return results;
}

function hiddenInputs(doc) {
  const inputs = {};
  for (const input of doc.querySelectorAll('input[id]')) {
    inputs[input.id] = input.getAttribute('value') || input.value || '';
  }
  return inputs;
}

export function buildToken(currentId, encryptedToken) {
  if (!currentId || currentId.length < 4) {
    throw new Error(`current_id 太短：${currentId || '-'}`);
  }
  let rest = encryptedToken || '';
  const chunks = [];
  for (const digit of currentId.slice(-4)) {
    if (!/\d/.test(digit)) {
      throw new Error(`current_id 后四位包含非数字：${currentId}`);
    }
    const offset = Number(digit) % 3 + 1;
    const chunk = rest.slice(offset, offset + 8);
    if (chunk.length !== 8) {
      throw new Error('e_token 太短，无法生成 getResN token');
    }
    chunks.push(chunk);
    rest = rest.slice(offset + 8);
  }
  return chunks.join('');
}

export function parseM3u8Lines(payload) {
  if (payload?.state !== 1) {
    throw new Error(`getResN 失败：state=${payload?.state ?? '-'} message=${payload?.message ?? '-'}`);
  }

  const lines = [];
  const list = payload?.data?.list || [];
  for (const item of list) {
    const fallbackFlag = String(item?.flag || '');
    let entries = [];
    try {
      entries = JSON.parse(item?.resData || '[]');
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const flag = String(entry?.flag || fallbackFlag);
      const rawUrl = String(entry?.url || '');
      for (const part of rawUrl.split('#')) {
        if (!part.includes('$')) continue;
        const [name, ...urlParts] = part.split('$');
        const url = urlParts.join('$');
        if (/\.m3u8(?:$|\?)/i.test(url)) {
          lines.push({
            index: lines.length,
            flag,
            name: compactText(name) || `线路 ${lines.length + 1}`,
            url,
            source: 'getResN',
          });
        }
      }
    }
  }
  return lines;
}

export async function resolveLines(videoId, options = {}) {
  if (options.useResolveServer ?? options.useProxy) {
    const payload = await fetchJson(proxyApiUrl(options.proxyBaseUrl, '/api/m3u8', {
      videoId,
      baseUrl: normalizeServerUrl(options.baseUrl),
    }));
    return {
      videoId: String(payload.videoId || videoId),
      playUrl: '',
      apiUrl: payload.apiUrl || '',
      lines: (payload.lines || []).map((line, index) => ({
        index,
        flag: String(line.flag || ''),
        name: compactText(line.name) || `线路 ${index + 1}`,
        url: String(line.url || ''),
        source: 'proxy',
      })),
    };
  }

  const baseUrl = normalizeServerUrl(options.baseUrl);
  const playUrl = `${baseUrl}/play/${videoId}`;
  const html = await fetchText(playUrl);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const inputs = hiddenInputs(doc);
  const currentId = inputs.current_id || videoId;
  const eToken = inputs.e_token;
  const mtype = inputs.mtype;

  if (!eToken || !mtype) {
    throw new Error('播放页缺少 e_token 或 mtype，可能页面结构变化或被源站拦截。');
  }

  const token = buildToken(currentId, eToken);
  const apiQuery = new URLSearchParams({ videoId, mtype, token });
  const apiUrl = `${baseUrl}/api/getResN?${apiQuery.toString()}`;
  const payload = await fetchJson(apiUrl);
  return {
    videoId,
    playUrl,
    apiUrl,
    lines: parseM3u8Lines(payload),
  };
}

export function lineFromManualUrl(url) {
  return {
    index: 0,
    flag: '',
    name: '手动输入',
    url: String(url || '').trim(),
    source: 'manual',
  };
}

export function proxiedResourceUrl(url, options = {}) {
  const sourceUrl = String(url || '').trim();
  if (!(options.usePlaybackProxy ?? options.useProxy) || !sourceUrl) return sourceUrl;
  const query = new URLSearchParams({
    url: sourceUrl,
    referer: options.referer || sourceUrl,
  });
  return `${normalizeProxyServerUrl(options.proxyBaseUrl)}/api/proxy?${query.toString()}`;
}
