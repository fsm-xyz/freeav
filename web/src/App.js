import {
  computed,
  nextTick,
  onBeforeUnmount,
  reactive,
  ref,
  watch,
} from "vue/dist/vue.esm-bundler.js";
import Hls from "hls.js";
import { createLoaderController } from "./hls/CachingHlsLoader.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_PROXY_URL,
  lineFromManualUrl,
  normalizeProxyServerUrl,
  normalizeServerUrl,
  proxiedResourceUrl,
  resolveLines,
  searchAikan,
} from "./services/aikan.js";

const SEARCH_CONFIG_STORAGE_KEY = "aikan.searchConfig";
const SEARCH_CONFIG_VERSION = 3;
const LEGACY_DEFAULT_PROXY_URL = "http://127.0.0.1:8787";
const CUSTOM_OPTION = "custom";
/** 搜索框占位与「未输入时用」的默认关键词 */
const DEFAULT_SEARCH_KEYWORD = "寒战";
const DATA_SOURCE_OPTIONS = [
  { label: "爱看", value: DEFAULT_BASE_URL },
  { label: "自定义", value: CUSTOM_OPTION },
];
const CODE_SERVER_OPTIONS = [
  { label: "当前网站", value: DEFAULT_PROXY_URL },
  { label: "自定义", value: CUSTOM_OPTION },
];

function loadSearchConfig() {
  const fallback = {
    sourcePreset: DEFAULT_BASE_URL,
    serverUrl: DEFAULT_BASE_URL,
    useSearchServer: true,
    useResolveServer: true,
    usePlaybackProxy: false,
    proxyServerPreset: DEFAULT_PROXY_URL,
    proxyServerUrl: DEFAULT_PROXY_URL,
  };

  try {
    const parsed = JSON.parse(
      window.localStorage?.getItem(SEARCH_CONFIG_STORAGE_KEY) || "{}",
    );
    const serverUrl = parsed.serverUrl || DEFAULT_BASE_URL;
    const isCurrentConfig = parsed.configVersion >= SEARCH_CONFIG_VERSION;
    const parsedProxyServerUrl = parsed.proxyServerUrl || DEFAULT_PROXY_URL;
    const isLegacyDefaultProxy =
      !isCurrentConfig &&
      normalizeProxyServerUrl(parsedProxyServerUrl) ===
        LEGACY_DEFAULT_PROXY_URL;
    const proxyServerUrl = isLegacyDefaultProxy
      ? DEFAULT_PROXY_URL
      : parsedProxyServerUrl;
    const proxyServerPreset =
      !isCurrentConfig && parsed.proxyServerPreset === LEGACY_DEFAULT_PROXY_URL
        ? DEFAULT_PROXY_URL
        : parsed.proxyServerPreset;
    return {
      sourcePreset:
        parsed.sourcePreset ||
        (parsed.useCustomServer || serverUrl !== DEFAULT_BASE_URL
          ? CUSTOM_OPTION
          : DEFAULT_BASE_URL),
      serverUrl,
      useSearchServer: parsed.useSearchServer ?? true,
      useResolveServer: isCurrentConfig
        ? (parsed.useResolveServer ?? true)
        : true,
      usePlaybackProxy: Boolean(parsed.usePlaybackProxy),
      proxyServerPreset:
        proxyServerPreset ||
        (proxyServerUrl !== DEFAULT_PROXY_URL
          ? CUSTOM_OPTION
          : DEFAULT_PROXY_URL),
      proxyServerUrl,
    };
  } catch (_) {
    return fallback;
  }
}

export default {
  name: "App",
  template: `
    <div class="app-shell">
      <main class="layout" :class="{ theater: theaterMode }">
        <section v-if="!theaterMode" class="search-column">
          <header class="hero card">
            <div class="hero-content">
              <div class="hero-main">
                <div class="hero-feature-row">
                  <div class="feature-pills" aria-label="功能特性">
                    <span class="feature-pill search">服务端搜索</span>
                    <span class="feature-pill parse">服务端解析</span>
                    <span class="feature-pill prefetch">HLS并发加载</span>
                  </div>
                  <a
                    class="github-link"
                    href="https://github.com/fsm-xyz/freeav"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="GitHub"
                    title="GitHub: fsm-xyz"
                  >
                    <svg class="github-icon" viewBox="0 0 16 16" role="img" aria-hidden="true" focusable="false">
                      <path
                        fill="currentColor"
                        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
                      />
                    </svg>
                  </a>
                </div>
              </div>
            </div>
          </header>

          <form class="card search-card" @submit.prevent="doSearch">
            <div class="input-row">
              <input id="keyword" v-model.trim="keyword" placeholder="${DEFAULT_SEARCH_KEYWORD}" />
              <button type="submit" :disabled="searching">{{ searching ? '搜索中' : '搜索' }}</button>
              <button
                type="button"
                class="ghost"
                :aria-expanded="configPanelOpen ? 'true' : 'false'"
                aria-controls="search-config-panel"
                @click="configPanelOpen = !configPanelOpen"
              >
                {{ configPanelOpen ? '收起' : '配置' }}
              </button>
            </div>
            <div v-show="configPanelOpen" id="search-config-panel" class="search-config-panel">
              <div class="search-config">
                <div class="config-title">数据源</div>
                <label>
                  <div class="combo-row">
                    <select v-model="searchConfig.sourcePreset" @change="applySourcePreset">
                      <option v-for="option in dataSourceOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                    </select>
                    <input
                      v-model.trim="searchConfig.serverUrl"
                      :disabled="searchConfig.sourcePreset !== customOption"
                      placeholder="https://v.aikanbot.com"
                    />
                  </div>
                </label>

                <div class="config-title">代理</div>
                <label class="switch-row">
                  <input v-model="searchConfig.useSearchServer" type="checkbox" />
                  <span>搜索</span>
                </label>
                <label class="switch-row">
                  <input v-model="searchConfig.useResolveServer" type="checkbox" />
                  <span>解析线路</span>
                </label>
                <label class="switch-row">
                  <input v-model="searchConfig.usePlaybackProxy" type="checkbox" />
                  <span>分片缓存</span>
                </label>
                <label>
                  <div class="combo-row">
                    <select v-model="searchConfig.proxyServerPreset" @change="applyProxyServerPreset">
                      <option v-for="option in codeServerOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                    </select>
                    <input
                      v-model.trim="searchConfig.proxyServerUrl"
                      :disabled="!usesCodeServer || searchConfig.proxyServerPreset !== customOption"
                      :placeholder="activeProxyBaseUrl"
                    />
                  </div>
                </label>
                <div class="search-config-actions">
                  <button type="button" class="secondary" @click="saveSearchConfig">保存</button>
                  <button type="button" class="ghost" @click="resetSearchConfigDefaults">重置</button>
                </div>
              </div>
            </div>
          </form>

          <section class="card manual-card">
            <div class="input-row input-row-compact">
              <input id="manualUrl" v-model.trim="manualUrl" placeholder="粘贴 .m3u8 地址播放" />
              <button type="button" class="secondary" @click="playManual">播放</button>
            </div>
          </section>

          <section class="card results-card">
            <div class="section-title">
              <h2>搜索结果</h2>
              <span>{{ results.length }} 条</span>
            </div>
            <div v-if="!results.length" class="empty">暂无结果</div>
            <article v-for="item in results" :key="item.videoId" class="result-item">
              <img v-if="item.thumb" :src="item.thumb" alt="" loading="lazy" />
              <div class="result-body">
                <div class="result-title">
                  <strong>{{ item.title }}</strong>
                  <span v-if="availabilityLabel(item)" class="availability">{{ availabilityLabel(item) }}</span>
                </div>
                <p v-if="item.meta" class="result-meta">{{ item.meta }}</p>
                <p v-if="item.cast" class="result-cast">{{ item.cast }}</p>
                <p v-if="!item.meta && !item.cast && item.summary" class="result-summary">{{ item.summary }}</p>
                <div class="result-actions">
                  <button :disabled="resolvingId === item.videoId" @click="resolveResult(item)">
                    {{ resolvingId === item.videoId ? '解析中' : '解析线路' }}
                  </button>
                  <button class="ghost" @click="openExternal(item.url)">打开源页</button>
                </div>
              </div>
            </article>
          </section>
        </section>

          <section class="play-column">
          <section ref="playerCardEl" class="card player-card">
            <video ref="videoEl" controls playsinline></video>

            <div class="toolbar">
              <div class="toolbar-main">
                <div class="line-select-group">
                  <button class="line-label copy-line-label" :disabled="!currentLine" title="点击复制当前线路地址" @click="copyCurrentLine">线路</button>
                  <select v-if="lines.length" v-model.number="selectedLineIndex" @change="playSelectedLine">
                    <option v-for="(line, index) in lines" :key="line.url" :value="index">
                      {{ lineLabel(line, index) }}
                    </option>
                  </select>
                  <select v-else disabled>
                    <option>暂无线路</option>
                  </select>
                  <span
                    v-if="currentSegmentShortLabel"
                    class="segment-position"
                    aria-live="polite"
                    :title="currentSegmentLabel || '当前分片'"
                  >{{ currentSegmentShortLabel }}</span>
                </div>
                <button class="secondary" :disabled="!lines.length || probing" @click="probeLines">
                  {{ probing ? '检测中' : '检测线路' }}
                </button>
                <button class="ghost detail-pill" @click="toggleDetails">
                  {{ detailsExpanded ? '收起详情' : '详情' }}
                </button>
              </div>
              <div class="toolbar-side">
                <div class="volume-control" aria-label="音量控制">
                  <span>音量</span>
                  <input v-model.number="volume" type="range" min="0" max="100" step="1" :style="{ '--volume': volume + '%' }" @input="applyVolume" />
                  <button class="ghost" @click="toggleMute">{{ isMuted ? '取消静音' : '静音' }}</button>
                </div>
                <div class="player-button-group">
                  <button class="ghost" @click="theaterMode = !theaterMode">{{ theaterMode ? '退出影院' : '影院模式' }}</button>
                  <button class="ghost" @click="copyDiagnostics">复制诊断</button>
                </div>
              </div>
            </div>
          </section>

          <template v-if="detailsExpanded">
            <section class="status-grid">
              <div class="card stat-card"><span>当前速度</span><strong>{{ formatSpeed(metrics.lastSpeed) }}</strong></div>
              <div class="card stat-card"><span>平均速度</span><strong>{{ formatSpeed(metrics.averageSpeed) }}</strong></div>
              <div class="card stat-card"><span>并发</span><strong>{{ metrics.active }}/{{ cacheConfig.concurrency }}</strong></div>
              <div class="card stat-card"><span>缓存</span><strong>{{ formatBytes(metrics.bytes) }}</strong></div>
              <div class="card stat-card"><span>命中率</span><strong>{{ hitRate }}</strong></div>
            </section>

            <section class="card graph-card">
              <div class="section-title">
                <div class="graph-heading">
                  <h2>分片状态图</h2>
                </div>
                <div class="graph-summary">
                  <span>{{ indexResources.length }} 个索引资源 / {{ mediaSegments.length }} 个媒体分片 · <em class="graph-playing-hint">黄框为当前播放</em></span>
                  <span class="graph-actions">单击查看 · 双击跳转</span>
                </div>
              </div>
              <div class="segment-legend" aria-label="分片状态颜色图例">
                <span v-for="item in segmentLegend" :key="item.status">
                  <i :class="['segment-cell', item.status]"></i>{{ item.label }}
                </span>
              </div>
              <div v-if="!orderedSegments.length" class="empty">播放后会显示 m3u8 中的 ts/m4s/key 状态。</div>
              <div v-else class="graph-rows">
                <div class="graph-row">
                  <div class="graph-row-title">索引资源</div>
                  <div v-if="!indexResources.length" class="graph-row-empty">暂无 m3u8/key</div>
                  <div v-else class="segment-graph index-graph">
                    <button
                      v-for="resource in indexResources"
                      :key="resource.url"
                      :class="['segment-cell', resource.status]"
                      :title="resource.url"
                      @click="selectedSegment = resource"
                    >
                      {{ resourceLabel(resource) }}
                    </button>
                  </div>
                </div>
                <div class="graph-row">
                  <div class="graph-row-title">媒体分片</div>
                  <div v-if="!mediaSegments.length" class="graph-row-empty">暂无 ts/m4s/aac 分片</div>
                  <div v-else class="segment-graph">
                    <button
                      v-for="segment in mediaSegments"
                      :key="segment.url"
                      :class="['segment-cell', segment.status, { 'is-playing': isPlayingSegment(segment) }]"
                      :title="'单击查看详情，双击从此分片播放：' + segment.url"
                      @click="selectedSegment = segment"
                      @dblclick.stop="seekToSegment(segment)"
                    >
                      {{ segment.displayIndex }}
                    </button>
                  </div>
                </div>
              </div>
              <div v-if="selectedSegment" class="segment-detail">
                <button class="close" @click="selectedSegment = null">x</button>
                <h3>{{ selectedSegment.type === 'segment' ? '分片 #' + selectedSegment.displayIndex : resourceLabel(selectedSegment) }}</h3>
                <p><b>状态：</b>{{ segmentLabel(selectedSegment.status) }}</p>
                <p><b>类型：</b>{{ resourceTypeLabel(selectedSegment.type) }}</p>
                <p><b>片长：</b>{{ formatPlaylistSegmentDuration(selectedSegment.duration) }}</p>
                <p><b>大小：</b>{{ formatBytes(selectedSegment.size || 0) }}</p>
                <p><b>下载耗时：</b>{{ selectedSegment.durationMs ? formatMs(selectedSegment.durationMs) : '-' }}</p>
                <p><b>速度：</b>{{ selectedSegment.speed ? formatSpeed(selectedSegment.speed) : '-' }}</p>
                <p v-if="selectedSegment.playlistUrl" class="break-all"><b>所属 m3u8：</b>{{ selectedSegment.playlistUrl }}</p>
                <p v-if="selectedSegment.error" class="error"><b>错误：</b>{{ selectedSegment.error }}</p>
                <p class="break-all"><b>URL：</b>{{ selectedSegment.url }}</p>
              </div>
            </section>

            <section class="card settings-card">
              <div class="section-title">
                <h2>缓存配置</h2>
                <button class="secondary" @click="applyCacheConfig">应用并清空缓存</button>
              </div>
              <div class="settings-grid">
                <label>最大缓存 MB <input v-model.number="cacheConfig.maxMB" type="number" min="16" /></label>
                <label>最大条目 <input v-model.number="cacheConfig.maxEntries" type="number" min="16" /></label>
                <label>预取并发 <input v-model.number="cacheConfig.concurrency" type="number" min="1" max="32" /></label>
                <label>初始预热 <input v-model.number="cacheConfig.initialSegments" type="number" min="0" /></label>
                <label>前向窗口 <input v-model.number="cacheConfig.aheadSegments" type="number" min="1" /></label>
              </div>
            </section>
          </template>
        </section>
      </main>

      <div v-if="status.message" :class="['toast', status.error ? 'error' : 'ok']">{{ status.message }}</div>
    </div>
  `,
  setup() {
    const keyword = ref("");
    const manualUrl = ref("");
    const searching = ref(false);
    const configPanelOpen = ref(false);
    const resolvingId = ref("");
    const probing = ref(false);
    const theaterMode = ref(false);
    const detailsExpanded = ref(false);
    const results = ref([]);
    const lines = ref([]);
    const selectedLineIndex = ref(0);
    const currentLine = ref(null);
    const selectedSegment = ref(null);
    /** 当前播放分片，如「分片 3 / 120」（依赖 hls.js FRAG_CHANGED） */
    const currentSegmentLabel = ref("");
    /** 工具栏简短显示，如「3/120」 */
    const currentSegmentShortLabel = ref("");
    /** 与分片方格匹配用的 URL（含代理/解析后与列表对齐） */
    const currentPlayingSegmentUrl = ref("");
    const videoEl = ref(null);
    const playerCardEl = ref(null);
    const volume = ref(80);
    const isMuted = ref(false);
    const status = reactive({ message: "", error: false });
    const storedSearchConfig = loadSearchConfig();
    const searchConfig = reactive({
      sourcePreset: storedSearchConfig.sourcePreset,
      serverUrl: storedSearchConfig.serverUrl,
      useSearchServer: storedSearchConfig.useSearchServer,
      useResolveServer: storedSearchConfig.useResolveServer,
      usePlaybackProxy: storedSearchConfig.usePlaybackProxy,
      proxyServerPreset: storedSearchConfig.proxyServerPreset,
      proxyServerUrl: storedSearchConfig.proxyServerUrl,
    });
    const metrics = reactive({
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
    });
    const segments = ref([]);
    const segmentLegend = [
      { status: "discovered", label: "已发现" },
      { status: "playlist", label: "播放列表" },
      { status: "queued", label: "排队" },
      { status: "loading", label: "加载中" },
      { status: "prefetched", label: "已预取" },
      { status: "loaded", label: "已加载" },
      { status: "hit", label: "缓存命中" },
      { status: "failed", label: "失败" },
      { status: "evicted", label: "已淘汰" },
    ];
    const cacheConfig = reactive({
      maxMB: 256,
      maxEntries: 240,
      concurrency: 3,
      initialSegments: 6,
      aheadSegments: 9,
    });

    let hls = null;
    let statusTimer = 0;
    const loaderController = createLoaderController({
      maxBytes: cacheConfig.maxMB * 1024 * 1024,
      maxEntries: cacheConfig.maxEntries,
      concurrency: cacheConfig.concurrency,
      initialSegments: cacheConfig.initialSegments,
      aheadSegments: cacheConfig.aheadSegments,
      emit: onLoaderEvent,
    });

    const orderedSegments = computed(() =>
      [...segments.value].sort((a, b) => a.index - b.index),
    );
    const indexResources = computed(() =>
      orderedSegments.value.filter(
        (item) => item.type === "playlist" || item.type === "key",
      ),
    );
    const mediaSegments = computed(() =>
      orderedSegments.value
        .filter((item) => item.type === "segment")
        .map((item, index) => ({ ...item, displayIndex: index + 1 })),
    );
    const hitRate = computed(() => {
      const total = metrics.hits + metrics.misses;
      return total ? `${Math.round((metrics.hits / total) * 100)}%` : "0%";
    });
    const activeSearchBaseUrl = computed(() =>
      normalizeServerUrl(searchConfig.serverUrl),
    );
    const activeProxyBaseUrl = computed(() =>
      normalizeProxyServerUrl(searchConfig.proxyServerUrl),
    );
    const usesCodeServer = computed(
      () =>
        searchConfig.useSearchServer ||
        searchConfig.useResolveServer ||
        searchConfig.usePlaybackProxy,
    );
    const searchSourceLabel = computed(() =>
      searchConfig.sourcePreset === CUSTOM_OPTION ? "（自定义）" : "（预设）",
    );
    const requestModeLabel = computed(() =>
      [
        searchConfig.useSearchServer ? "搜索走服务器" : "搜索直连",
        searchConfig.useResolveServer ? "解析走服务器" : "解析直连",
        searchConfig.usePlaybackProxy ? "播放代理缓存" : "播放直连",
      ].join(" / "),
    );

    function persistSearchConfig() {
      window.localStorage?.setItem(
        SEARCH_CONFIG_STORAGE_KEY,
        JSON.stringify({
          configVersion: SEARCH_CONFIG_VERSION,
          sourcePreset: searchConfig.sourcePreset,
          serverUrl: searchConfig.serverUrl,
          useSearchServer: searchConfig.useSearchServer,
          useResolveServer: searchConfig.useResolveServer,
          usePlaybackProxy: searchConfig.usePlaybackProxy,
          proxyServerPreset: searchConfig.proxyServerPreset,
          proxyServerUrl: searchConfig.proxyServerUrl,
        }),
      );
    }

    watch(searchConfig, persistSearchConfig, { deep: true });

    function saveSearchConfig() {
      persistSearchConfig();
      setStatus("配置已保存。", false);
    }

    function resetSearchConfigDefaults() {
      searchConfig.sourcePreset = DEFAULT_BASE_URL;
      searchConfig.serverUrl = DEFAULT_BASE_URL;
      searchConfig.useSearchServer = true;
      searchConfig.useResolveServer = true;
      searchConfig.usePlaybackProxy = false;
      searchConfig.proxyServerPreset = DEFAULT_PROXY_URL;
      searchConfig.proxyServerUrl = DEFAULT_PROXY_URL;
      persistSearchConfig();
      setStatus("已恢复默认配置。", false);
    }

    function onLoaderEvent(event) {
      if (event.metrics) Object.assign(metrics, event.metrics);
      if (event.segments) segments.value = event.segments;
      if (event.segment) {
        const next = new Map(segments.value.map((item) => [item.url, item]));
        next.set(event.segment.url, event.segment);
        segments.value = Array.from(next.values());
      }
    }

    function clearStatusTimer() {
      if (statusTimer) {
        window.clearTimeout(statusTimer);
        statusTimer = 0;
      }
    }

    function setStatus(
      message,
      error = false,
      timeoutMs = error ? 8000 : 3500,
    ) {
      clearStatusTimer();
      status.message = message;
      status.error = error;
      if (message && timeoutMs > 0) {
        statusTimer = window.setTimeout(() => {
          status.message = "";
          status.error = false;
          statusTimer = 0;
        }, timeoutMs);
      }
    }

    function toggleDetails() {
      detailsExpanded.value = !detailsExpanded.value;
      if (!detailsExpanded.value) {
        selectedSegment.value = null;
      }
    }

    function applySourcePreset() {
      if (searchConfig.sourcePreset !== CUSTOM_OPTION) {
        searchConfig.serverUrl = searchConfig.sourcePreset;
      }
    }

    function applyProxyServerPreset() {
      if (searchConfig.proxyServerPreset !== CUSTOM_OPTION) {
        searchConfig.proxyServerUrl = searchConfig.proxyServerPreset;
      }
    }

    function scrollPlayerCardIntoView() {
      const el = playerCardEl.value;
      if (!el || typeof el.scrollIntoView !== "function") return;
      try {
        el.scrollIntoView({
          behavior: "smooth",
          block: "center",
          inline: "nearest",
        });
      } catch (_) {
        el.scrollIntoView(true);
      }
    }

    async function doSearch() {
      const q = (keyword.value || "").trim() || DEFAULT_SEARCH_KEYWORD;
      searching.value = true;
      setStatus("正在搜索...", false);
      try {
        results.value = await searchAikan(q, {
          baseUrl: activeSearchBaseUrl.value,
          useSearchServer: searchConfig.useSearchServer,
          proxyBaseUrl: activeProxyBaseUrl.value,
        });
        setStatus(`搜索完成：${results.value.length} 条结果`, false);
      } catch (error) {
        setStatus(error.message || String(error), true);
      } finally {
        searching.value = false;
      }
    }

    async function resolveResult(item) {
      resolvingId.value = item.videoId;
      setStatus(`正在解析 ${item.title} 的播放线路...`, false);
      try {
        const data = await resolveLines(item.videoId, {
          baseUrl: activeSearchBaseUrl.value,
          useResolveServer: searchConfig.useResolveServer,
          proxyBaseUrl: activeProxyBaseUrl.value,
        });
        lines.value = data.lines;
        selectedLineIndex.value = 0;
        setStatus(`解析完成：${data.lines.length} 条线路`, false);
        if (data.lines[0]) {
          await playLine(data.lines[0], 0);
          await nextTick();
          scrollPlayerCardIntoView();
        }
      } catch (error) {
        setStatus(error.message || String(error), true);
      } finally {
        resolvingId.value = "";
      }
    }

    async function playManual() {
      if (!manualUrl.value || !manualUrl.value.includes(".m3u8")) {
        setStatus("请粘贴有效的 m3u8 地址", true);
        return;
      }
      const line = lineFromManualUrl(manualUrl.value);
      lines.value = [line];
      selectedLineIndex.value = 0;
      await playLine(line, 0);
    }

    function destroyHls() {
      currentSegmentLabel.value = "";
      currentSegmentShortLabel.value = "";
      currentPlayingSegmentUrl.value = "";
      if (hls) {
        hls.destroy();
        hls = null;
      }
    }

    function resolveFragPlayUrl(frag) {
      if (!frag) return "";
      if (frag.url) return String(frag.url);
      if (frag.relurl && frag.baseurl) {
        try {
          return new URL(String(frag.relurl), String(frag.baseurl)).href;
        } catch (_) {
          return String(frag.relurl);
        }
      }
      return "";
    }

    function urlsLikelySameSegment(a, b) {
      if (!a || !b) return false;
      if (a === b) return true;
      try {
        const ua = new URL(String(a));
        const ub = new URL(String(b));
        if (ua.href === ub.href) return true;
        if (ua.origin === ub.origin && ua.pathname === ub.pathname) {
          if (ua.search === ub.search) return true;
          if (!ua.search || !ub.search) return true;
        }
      } catch (_) {
        /* fall through */
      }
      const sa = String(a).split(/[?#]/)[0];
      const sb = String(b).split(/[?#]/)[0];
      return sa === sb || sa.endsWith(sb) || sb.endsWith(sa);
    }

    function updateLabelFromFrag(frag) {
      const playUrl = resolveFragPlayUrl(frag);
      if (!playUrl) {
        currentSegmentLabel.value = "";
        currentSegmentShortLabel.value = "";
        currentPlayingSegmentUrl.value = "";
        return;
      }
      const list = mediaSegments.value;
      const total = list.length;
      const idx = list.findIndex((s) => urlsLikelySameSegment(s.url, playUrl));
      if (idx >= 0 && total > 0) {
        const canonical = list[idx].url;
        currentPlayingSegmentUrl.value = canonical;
        currentSegmentLabel.value = `分片 ${idx + 1} / ${total}`;
        currentSegmentShortLabel.value = `${idx + 1}/${total}`;
        return;
      }
      currentPlayingSegmentUrl.value = playUrl;
      const sn = frag.sn;
      const snNum = typeof sn === "number" ? sn : Number(sn);
      if (Number.isFinite(snNum)) {
        currentSegmentLabel.value =
          total > 0 ? `分片 #${snNum}（共 ${total}）` : `分片 #${snNum}`;
        currentSegmentShortLabel.value =
          total > 0 ? `#${snNum}/${total}` : `#${snNum}`;
        return;
      }
      currentSegmentLabel.value = "";
      currentSegmentShortLabel.value = "";
      currentPlayingSegmentUrl.value = "";
    }

    function isPlayingSegment(segment) {
      const refUrl = currentPlayingSegmentUrl.value;
      if (!segment?.url || !refUrl) return false;
      return urlsLikelySameSegment(segment.url, refUrl);
    }

    function segmentDurationSeconds(segment) {
      const duration = Number(segment?.duration);
      return Number.isFinite(duration) && duration > 0 ? duration : 0;
    }

    function segmentStartSeconds(segment) {
      const list = mediaSegments.value;
      const index = list.findIndex((item) =>
        urlsLikelySameSegment(item.url, segment?.url),
      );
      if (index < 0) return null;
      return list
        .slice(0, index)
        .reduce((total, item) => total + segmentDurationSeconds(item), 0);
    }

    async function seekToSegment(segment) {
      const video = videoEl.value;
      if (!video || segment?.type !== "segment") return;
      const targetSeconds = segmentStartSeconds(segment);
      if (targetSeconds == null) {
        setStatus("没有找到这个分片在播放列表中的位置。", true);
        return;
      }
      if (targetSeconds <= 0 && segment?.displayIndex > 1) {
        setStatus("这个分片缺少 #EXTINF 时长，暂时无法计算跳转时间。", true);
        return;
      }

      currentPlayingSegmentUrl.value = segment.url;
      currentSegmentLabel.value = `分片 ${segment.displayIndex} / ${mediaSegments.value.length}`;
      currentSegmentShortLabel.value = `${segment.displayIndex}/${mediaSegments.value.length}`;
      selectedSegment.value = segment;

      try {
        if (hls && typeof hls.startLoad === "function") {
          hls.startLoad(targetSeconds);
        }
        video.currentTime = targetSeconds;
        await video.play();
        setStatus(`已跳转到分片 ${segment.displayIndex}`, false);
      } catch (error) {
        setStatus(
          error?.name === "NotAllowedError"
            ? "已跳转，请手动点击播放。"
            : error.message || String(error),
          true,
        );
      }
    }

    async function playSelectedLine() {
      const line = lines.value[selectedLineIndex.value];
      if (line) await playLine(line, selectedLineIndex.value);
    }

    async function playLine(line, index) {
      selectedLineIndex.value = index;
      currentLine.value = line;
      selectedSegment.value = null;
      segments.value = [];
      loaderController.reset();
      destroyHls();

      const video = videoEl.value;
      if (!video) return;
      video.volume = Math.max(0, Math.min(1, volume.value / 100));
      video.muted = isMuted.value;
      const playbackUrl = proxiedResourceUrl(line.url, {
        usePlaybackProxy:
          searchConfig.usePlaybackProxy && line.source !== "manual",
        proxyBaseUrl: activeProxyBaseUrl.value,
      });

      if (Hls.isSupported()) {
        hls = new Hls({
          loader: loaderController.Loader,
          maxBufferLength: 60,
          maxMaxBufferLength: 120,
          maxBufferSize: 60 * 1000 * 1000,
          startFragPrefetch: true,
          testBandwidth: true,
          fragLoadingMaxRetry: 5,
          fragLoadingRetryDelay: 1000,
        });
        hls.loadSource(playbackUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video
            .play()
            .catch(() =>
              setStatus("浏览器阻止自动播放，请手动点击播放。", true),
            );
        });
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setStatus(
              `网络错误：${data.details}。可能是 CORS 或防盗链限制。`,
              true,
            );
            hls.startLoad();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            setStatus(`媒体错误：${data.details}，尝试恢复。`, true);
            hls.recoverMediaError();
          } else {
            setStatus(`播放器错误：${data.details}`, true);
            destroyHls();
          }
        });
        hls.on(Hls.Events.FRAG_CHANGED, (_, data) => {
          const frag = data?.frag;
          if (!frag) return;
          if (frag.type === "audio" || frag.type === "subtitle") return;
          if (frag.sn === "initSegment") return;
          updateLabelFromFrag(frag);
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = playbackUrl;
        await video
          .play()
          .catch(() => setStatus("浏览器阻止自动播放，请手动点击播放。", true));
      } else {
        setStatus("当前浏览器不支持 HLS，且 hls.js 不可用。", true);
      }
    }

    async function probeLines() {
      probing.value = true;
      try {
        for (const line of lines.value) {
          const started = performance.now();
          const probeUrl = proxiedResourceUrl(line.url, {
            usePlaybackProxy:
              searchConfig.usePlaybackProxy && line.source !== "manual",
            proxyBaseUrl: activeProxyBaseUrl.value,
          });
          try {
            const response = await fetch(probeUrl, {
              mode: "cors",
              cache: "no-store",
              credentials: "omit",
            });
            line.health = {
              ok: response.ok,
              latency: performance.now() - started,
              status: response.status,
            };
          } catch (error) {
            line.health = {
              ok: false,
              latency: performance.now() - started,
              status: 0,
              error: error.message || String(error),
            };
          }
        }
        lines.value = [...lines.value].sort((a, b) => {
          if (a.health?.ok && !b.health?.ok) return -1;
          if (!a.health?.ok && b.health?.ok) return 1;
          return (
            (a.health?.latency || Infinity) - (b.health?.latency || Infinity)
          );
        });
        setStatus("线路检测完成，已按可用性和延迟排序。", false);
      } finally {
        probing.value = false;
      }
    }

    function applyCacheConfig() {
      loaderController.updateConfig({
        maxBytes: cacheConfig.maxMB * 1024 * 1024,
        maxEntries: cacheConfig.maxEntries,
        concurrency: cacheConfig.concurrency,
        initialSegments: cacheConfig.initialSegments,
        aheadSegments: cacheConfig.aheadSegments,
      });
      loaderController.reset();
      segments.value = [];
      setStatus("缓存配置已应用。", false);
    }

    function applyVolume() {
      const video = videoEl.value;
      if (!video) return;
      const nextVolume = Math.max(0, Math.min(1, volume.value / 100));
      video.volume = nextVolume;
      video.muted = nextVolume === 0;
      isMuted.value = video.muted;
    }

    function toggleMute() {
      isMuted.value = !isMuted.value;
      const video = videoEl.value;
      if (video) video.muted = isMuted.value;
    }

    function copyDiagnostics() {
      const payload = {
        currentLine: currentLine.value,
        metrics: { ...metrics },
        searchConfig: { ...searchConfig },
        cacheConfig: { ...cacheConfig },
        indexResources: indexResources.value.slice(0, 40),
        mediaSegments: mediaSegments.value.slice(0, 80),
        status: { ...status },
      };
      copyText(JSON.stringify(payload, null, 2));
    }

    function copyText(text) {
      if (!text) return;
      navigator.clipboard
        ?.writeText(text)
        .then(() => setStatus("已复制到剪贴板", false))
        .catch(() => setStatus("复制失败", true));
    }

    function copyCurrentLine() {
      copyText(
        currentLine.value?.url ||
          lines.value[selectedLineIndex.value]?.url ||
          "",
      );
    }

    function openExternal(url) {
      window.open(url, "_blank", "noopener,noreferrer");
    }

    function formatBytes(bytes) {
      if (!bytes) return "0 B";
      const units = ["B", "KB", "MB", "GB"];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
    }

    function formatSpeed(bytesPerSecond) {
      return `${formatBytes(bytesPerSecond)}/s`;
    }

    function formatMs(ms) {
      return `${Math.round(ms)} ms`;
    }

    /** m3u8 #EXTINF 标称时长（秒） */
    function formatPlaylistSegmentDuration(seconds) {
      if (seconds == null) return "-";
      const s = Number(seconds);
      if (!Number.isFinite(s) || s <= 0) return "-";
      if (s >= 3600) {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s - h * 3600 - m * 60;
        return `${h}:${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
      }
      if (s >= 60) {
        const m = Math.floor(s / 60);
        const sec = s - m * 60;
        return `${m} 分 ${sec.toFixed(3).replace(/\.?0+$/, "")} 秒`;
      }
      return `${s.toFixed(3).replace(/\.?0+$/, "")} 秒`;
    }

    function segmentLabel(statusName) {
      const labels = {
        discovered: "已发现",
        queued: "排队",
        loading: "加载中",
        playlist: "播放列表",
        prefetched: "已预取",
        loaded: "已加载",
        hit: "缓存命中",
        failed: "失败",
        evicted: "已淘汰",
      };
      return labels[statusName] || statusName || "-";
    }

    function resourceTypeLabel(type) {
      const labels = {
        playlist: "m3u8 播放列表",
        key: "解密 key",
        segment: "媒体分片",
        resource: "资源",
      };
      return labels[type] || type || "-";
    }

    function resourceLabel(resource) {
      if (resource.type === "playlist") return "m3u8";
      if (resource.type === "key") return "key";
      return String((resource.index || 0) + 1);
    }

    function lineLabel(line, index) {
      if (!line) return "尚未选择线路";
      if (line.flag && line.name) return `${line.flag} · ${line.name}`;
      return line.name || line.flag || `线路 ${index + 1}`;
    }

    function availabilityLabel(item) {
      if (item?.playableLabel) return item.playableLabel;
      if (item?.playableCount) return `[${item.playableCount}条线路可播放]`;
      return "";
    }

    onBeforeUnmount(() => {
      clearStatusTimer();
      destroyHls();
    });

    return {
      keyword,
      manualUrl,
      searching,
      configPanelOpen,
      resolvingId,
      probing,
      theaterMode,
      detailsExpanded,
      results,
      lines,
      selectedLineIndex,
      currentLine,
      selectedSegment,
      currentSegmentLabel,
      currentSegmentShortLabel,
      isPlayingSegment,
      seekToSegment,
      videoEl,
      playerCardEl,
      volume,
      isMuted,
      status,
      searchConfig,
      customOption: CUSTOM_OPTION,
      dataSourceOptions: DATA_SOURCE_OPTIONS,
      codeServerOptions: CODE_SERVER_OPTIONS,
      metrics,
      cacheConfig,
      segmentLegend,
      orderedSegments,
      indexResources,
      mediaSegments,
      hitRate,
      activeSearchBaseUrl,
      activeProxyBaseUrl,
      usesCodeServer,
      searchSourceLabel,
      requestModeLabel,
      doSearch,
      resolveResult,
      playManual,
      playSelectedLine,
      playLine,
      probeLines,
      applyCacheConfig,
      applyVolume,
      toggleMute,
      toggleDetails,
      applySourcePreset,
      applyProxyServerPreset,
      saveSearchConfig,
      resetSearchConfigDefaults,
      copyDiagnostics,
      copyText,
      copyCurrentLine,
      openExternal,
      formatBytes,
      formatSpeed,
      formatMs,
      formatPlaylistSegmentDuration,
      segmentLabel,
      resourceTypeLabel,
      resourceLabel,
      lineLabel,
      availabilityLabel,
    };
  },
};
