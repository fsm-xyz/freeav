export function absoluteUrl(baseUrl, rawUrl) {
  try {
    return new URL(String(rawUrl || '').trim(), baseUrl).href;
  } catch (_) {
    return '';
  }
}

export function isPlaylistUrl(url) {
  return /\.m3u8(?:$|\?)/i.test(String(url || ''));
}

export function isPrefetchableResource(url) {
  return /\.(ts|m4s|aac|key)(?:$|\?)/i.test(String(url || ''));
}

export function parsePlaylist(text, baseUrl) {
  const resources = [];
  const segments = [];
  const seen = new Set();
  let pendingDuration = 0;

  function add(raw, type = 'resource') {
    const url = absoluteUrl(baseUrl, raw);
    if (!url || seen.has(url)) return;
    seen.add(url);
    const resolvedType = isPlaylistUrl(url) ? 'playlist' : type;
    const item = {
      url,
      type: resolvedType,
      duration: pendingDuration,
      resourceIndex: resources.length,
      index: segments.length,
    };
    resources.push(item);
    if (isPrefetchableResource(url) && resolvedType === 'segment') {
      segments.push({ ...item, index: segments.length });
    }
    pendingDuration = 0;
  }

  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const duration = Number.parseFloat(line.slice(8).split(',')[0]);
      pendingDuration = Number.isFinite(duration) ? duration : 0;
      continue;
    }

    if (line.startsWith('#')) {
      const attrRe = /URI="([^"]+)"/g;
      let match;
      while ((match = attrRe.exec(line))) {
        add(match[1], 'key');
      }
      continue;
    }

    add(line, 'segment');
  }

  return { resources, segments };
}
