import Hls from 'hls.js';
import { LRUCache } from 'lru-cache';
import { isPlaylistUrl, isPrefetchableResource, parsePlaylist } from './playlist.js';

const DefaultLoader = Hls.DefaultConfig.loader;

function now() {
  return performance.now();
}

function emptyStats(start, size = 0) {
  return {
    aborted: false,
    loaded: size,
    retry: 0,
    total: size,
    trequest: start,
    tfirst: start,
    tload: start,
  };
}

function fetchErrorMessage(error) {
  if (error instanceof TypeError) {
    return '浏览器直连失败，可能是 CORS、Cloudflare 或防盗链限制';
  }
  return error?.message || String(error);
}

function resourceTypeForUrl(url) {
  if (isPlaylistUrl(url)) return 'playlist';
  if (/\.key(?:$|\?)/i.test(String(url || ''))) return 'key';
  if (isPrefetchableResource(url)) return 'segment';
  return 'resource';
}

export function createLoaderController(options = {}) {
  const controller = {
    config: {
      maxEntries: 240,
      maxBytes: 256 * 1024 * 1024,
      concurrency: 8,
      initialSegments: 12,
      aheadSegments: 24,
      ...options,
    },
    cache: null,
    queue: [],
    queued: new Set(),
    pending: new Map(),
    segmentMap: new Map(),
    metrics: {
      requested: 0,
      completed: 0,
      failed: 0,
      hits: 0,
      misses: 0,
      evicted: 0,
      active: 0,
      bytes: 0,
      lastSpeed: 0,
      averageSpeed: 0,
    },
    emit: options.emit || (() => {}),
  };

  function emit(type, payload = {}) {
    controller.emit({
      type,
      metrics: { ...controller.metrics, cacheSize: controller.cache.size, maxBytes: controller.config.maxBytes },
      ...payload,
    });
  }

  function updateConfig(next = {}) {
    controller.config = { ...controller.config, ...next };
    controller.cache = new LRUCache({
      max: controller.config.maxEntries,
      maxSize: controller.config.maxBytes,
      sizeCalculation(entry) {
        return entry?.data?.byteLength || 1;
      },
      dispose(entry, key) {
        controller.metrics.bytes = Math.max(0, controller.metrics.bytes - (entry?.data?.byteLength || 0));
        controller.metrics.evicted += 1;
        markSegment(key, { status: 'evicted' });
        emit('cache-evict', { url: key });
      },
    });
    emit('config', { config: { ...controller.config } });
  }

  function reset() {
    controller.queue.length = 0;
    controller.queued.clear();
    controller.pending.clear();
    controller.segmentMap.clear();
    controller.metrics = {
      requested: 0,
      completed: 0,
      failed: 0,
      hits: 0,
      misses: 0,
      evicted: 0,
      active: 0,
      bytes: 0,
      lastSpeed: 0,
      averageSpeed: 0,
    };
    controller.cache.clear();
    emit('reset');
  }

  function markSegment(url, patch) {
    const current = controller.segmentMap.get(url) || {
      url,
      index: controller.segmentMap.size,
      type: resourceTypeForUrl(url),
      status: 'discovered',
    };
    const next = { ...current, ...patch, updatedAt: Date.now() };
    controller.segmentMap.set(url, next);
    emit('segment', { segment: next, segments: Array.from(controller.segmentMap.values()) });
  }

  function registerPlaylist(text, playlistUrl) {
    const { resources, segments } = parsePlaylist(text, playlistUrl);
    markSegment(playlistUrl, { type: 'playlist', status: 'playlist', playlistUrl });

    for (const resource of resources) {
      if (resource.type !== 'playlist' && resource.type !== 'key') continue;
      const existing = controller.segmentMap.get(resource.url);
      const index = existing?.index ?? controller.segmentMap.size;
      controller.segmentMap.set(resource.url, {
        ...existing,
        ...resource,
        index,
        playlistUrl,
        status: existing?.status || 'discovered',
        updatedAt: Date.now(),
      });
    }

    for (const segment of segments) {
      const existing = controller.segmentMap.get(segment.url);
      const index = existing?.index ?? controller.segmentMap.size;
      controller.segmentMap.set(segment.url, {
        ...existing,
        ...segment,
        index,
        playlistIndex: segment.index,
        playlistUrl,
        status: existing?.status || 'discovered',
        updatedAt: Date.now(),
      });
    }

    for (const resource of resources) {
      if (resource.type === 'playlist' || resource.type === 'key') {
        queuePrefetch(resource.url);
      }
    }

    segments.slice(0, controller.config.initialSegments).forEach((segment) => queuePrefetch(segment.url));
    emit('playlist', { playlistUrl, segments: Array.from(controller.segmentMap.values()) });
  }

  function queuePrefetch(url) {
    if (!url || controller.cache.has(url) || controller.pending.has(url) || controller.queued.has(url)) return;
    if (!isPlaylistUrl(url) && !isPrefetchableResource(url)) return;
    controller.queue.push(url);
    controller.queued.add(url);
    controller.metrics.requested += 1;
    markSegment(url, { status: 'queued' });
    pump();
  }

  function scheduleAfter(url) {
    const segment = controller.segmentMap.get(url);
    if (!segment) return;
    const ordered = Array.from(controller.segmentMap.values())
      .filter((item) => item.type === 'segment')
      .sort((a, b) => a.index - b.index);
    const index = ordered.findIndex((item) => item.url === url);
    if (index < 0) return;
    ordered.slice(index + 1, index + 1 + controller.config.aheadSegments).forEach((item) => queuePrefetch(item.url));
  }

  function remember(url, data, contentType, source, durationMs) {
    const old = controller.cache.get(url);
    if (old?.data) {
      controller.metrics.bytes = Math.max(0, controller.metrics.bytes - old.data.byteLength);
    }
    controller.cache.set(url, { data, contentType, source, cachedAt: Date.now() });
    controller.metrics.bytes += data.byteLength;
    controller.metrics.completed += 1;
    const speed = durationMs > 0 ? data.byteLength / (durationMs / 1000) : 0;
    controller.metrics.lastSpeed = speed;
    controller.metrics.averageSpeed = controller.metrics.averageSpeed ? controller.metrics.averageSpeed * 0.75 + speed * 0.25 : speed;
    markSegment(url, {
      status: source === 'loader' ? 'loaded' : 'prefetched',
      size: data.byteLength,
      speed,
      durationMs,
      contentType,
    });
  }

  async function fetchForPrefetch(url) {
    const start = now();
      markSegment(url, { status: 'loading', type: resourceTypeForUrl(url) });
    const response = await fetch(url, { cache: 'force-cache', mode: 'cors', credentials: 'omit' });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
    if (isPlaylistUrl(url) || contentType.toLowerCase().includes('mpegurl')) {
      const text = await response.text();
      registerPlaylist(text, url);
      return;
    }
    const data = await response.arrayBuffer();
    remember(url, data, contentType, 'prefetch', now() - start);
  }

  function pump() {
    while (controller.metrics.active < controller.config.concurrency && controller.queue.length > 0) {
      const url = controller.queue.shift();
      controller.queued.delete(url);
      controller.metrics.active += 1;
      const task = fetchForPrefetch(url)
        .catch((error) => {
          controller.metrics.failed += 1;
          markSegment(url, { status: 'failed', error: fetchErrorMessage(error) });
        })
        .finally(() => {
          controller.pending.delete(url);
          controller.metrics.active -= 1;
          emit('metrics');
          pump();
        });
      controller.pending.set(url, task);
    }
    emit('metrics');
  }

  class CachingHlsLoader extends DefaultLoader {
    load(context, config, callbacks) {
      const url = context.url;
      const cached = controller.cache.get(url);
      if (cached?.data && !isPlaylistUrl(url)) {
        const stamp = now();
        controller.metrics.hits += 1;
        markSegment(url, { status: 'hit', size: cached.data.byteLength });
        scheduleAfter(url);
        callbacks.onSuccess(
          { url, data: cached.data },
          emptyStats(stamp, cached.data.byteLength),
          context,
          null,
        );
        emit('metrics');
        return;
      }

      controller.metrics.misses += 1;
      markSegment(url, { status: isPlaylistUrl(url) ? 'playlist' : 'loading', type: resourceTypeForUrl(url) });
      const start = now();
      const wrappedCallbacks = {
        ...callbacks,
        onSuccess: (response, stats, ctx, networkDetails) => {
          const data = response?.data;
          if (typeof data === 'string' && (ctx.type === 'manifest' || ctx.type === 'level' || isPlaylistUrl(ctx.url))) {
            registerPlaylist(data, ctx.url);
          } else if (data instanceof ArrayBuffer && isPrefetchableResource(ctx.url)) {
            remember(ctx.url, data, networkDetails?.getResponseHeader?.('Content-Type') || 'application/octet-stream', 'loader', now() - start);
            scheduleAfter(ctx.url);
          } else if (ctx?.url) {
            scheduleAfter(ctx.url);
          }
          callbacks.onSuccess(response, stats, ctx, networkDetails);
          emit('metrics');
        },
        onError: (error, ctx, networkDetails, stats) => {
          controller.metrics.failed += 1;
          markSegment(ctx?.url || url, { status: 'failed', error: error?.text || error?.details || 'HLS load error' });
          callbacks.onError(error, ctx, networkDetails, stats);
          emit('metrics');
        },
      };
      super.load(context, config, wrappedCallbacks);
      emit('metrics');
    }
  }

  updateConfig(options);

  return {
    Loader: CachingHlsLoader,
    updateConfig,
    reset,
    registerPlaylist,
    queuePrefetch,
    metrics: controller.metrics,
    getSegments: () => Array.from(controller.segmentMap.values()),
  };
}
