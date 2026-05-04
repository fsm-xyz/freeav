# Aikan Axum 技术架构

本文档描述 `aikan-axum` 当前实现的技术架构、请求链路、构建方式和关键设计细节。

## 项目目标

`aikan-axum` 是一个 Rust/Axum 后端与静态 Web 前端打包在一起的本地服务。构建时先生成 `web/dist`，再通过 `rust-embed` 将静态资源嵌入 Rust 二进制，最终产物可以作为单个可执行文件运行。

当前默认模式下：

- 搜索走本地 Axum 服务端的 `/api/search`。
- 播放线路解析走本地 Axum 服务端的 `/api/m3u8`。
- HLS 播放仍由浏览器和 `hls.js` 驱动。
- 播放分片代理缓存可在界面中按需启用，启用后资源会通过 `/api/proxy` 转发。

## 目录结构

```text
aikan-axum/
  src/
    main.rs              # Axum 服务、API 路由、静态资源嵌入、源站请求与解析
  web/
    src/
      App.js             # Vue 应用主界面、状态、搜索/解析/播放流程
      main.js            # 前端入口
      services/aikan.js  # 前端搜索、解析、代理 URL 组装和浏览器端兜底解析
      hls/
        CachingHlsLoader.js # hls.js 自定义 loader、LRU 缓存、预取调度
        playlist.js         # m3u8 资源和分片解析
      styles.css
    scripts/
      build.js           # Bun 构建脚本，输出 web/dist
      serve.js           # 前端预览服务
    dist/                # 构建后的静态资源，供 Rust 嵌入
  docs/
    architecture.md      # 本文档
  Makefile               # build/run/dist/clean 和跨平台构建目标
  Cargo.toml
```

## 后端架构

后端入口位于 `src/main.rs`，运行时绑定 `127.0.0.1`，默认端口为 `8787`。端口可以通过命令行第一个参数或 `PORT` 环境变量覆盖。

核心组件：

- `axum`：HTTP 路由、状态注入、响应封装。
- `tokio`：异步运行时。
- `reqwest`：服务端访问源站、播放页、接口和代理资源。
- `regex`：解析搜索结果、播放页隐藏字段和播放线路。
- `rust-embed`：将 `web/dist` 嵌入二进制。
- `mime_guess`：静态资源响应类型识别。

服务启动时创建一个共享 `reqwest::Client`，配置 30 秒超时和桌面浏览器风格的 `User-Agent`。所有 API 共享该 client。

## 路由

### `GET /api/search`

参数：

- `q`：搜索关键词，必填。
- `baseUrl`：源站地址，可选，默认 `https://v.aikanbot.com`。

处理流程：

1. 校验关键词。
2. 规范化源站地址，只接受 `http` 和 `https`。
3. 请求 `{baseUrl}/search?q=...`。
4. 解析搜索结果中的视频 ID、标题、封面、可播放线路提示、元信息和演员信息。
5. 将封面地址改写为 `/api/proxy` 地址，避免浏览器直接加载源站图片时遇到防盗链或 CORS 限制。

### `GET /api/m3u8`

参数：

- `videoId`：数字视频 ID，必填。
- `baseUrl`：源站地址，可选。

处理流程：

1. 校验 `videoId` 必须为数字。
2. 请求 `{baseUrl}/play/{videoId}`。
3. 解析播放页隐藏字段：`current_id`、`e_token`、`mtype`。
4. 根据 `current_id` 后四位和 `e_token` 生成 `token`。
5. 请求 `{baseUrl}/api/getResN?videoId=...&mtype=...&token=...`。
6. 解析返回数据中的 `resData`，提取 `.m3u8` 线路。

### `GET /api/resolve`

参数：

- `q`：搜索关键词，必填。
- `baseUrl`：源站地址，可选。

该接口组合搜索和解析：先搜索关键词，选取第一条结果，再解析其播放线路。适合命令式调用或快速验证，不是当前前端主流程的必需接口。

### `GET /api/proxy`

参数：

- `url`：要代理的目标资源，必须是 `http` 或 `https`。
- `referer`：可选，默认使用 `url`。

处理流程：

1. 服务端请求目标资源。
2. 保留或推断 `Content-Type`。
3. 如果资源是 m3u8，则重写其中的分片、子播放列表和 key 地址，让后续请求继续走 `/api/proxy`。
4. 添加 `Access-Control-Allow-Origin: *` 和 `Cache-Control: no-store`。

## 前端架构

前端是基于 Vue Options API 的单文件式模块组织，入口是 `web/src/main.js`，主应用在 `web/src/App.js`。

主要状态：

- 搜索关键词、搜索结果、当前解析线路。
- 搜索配置：数据源、服务端搜索、服务端解析、播放代理缓存、代理服务器地址。
- 播放状态：当前线路、选择的线路、音量、影院模式。
- HLS 缓存指标：请求数、成功数、失败数、命中率、缓存大小、速度和分片状态。

配置持久化在浏览器 `localStorage` 的 `aikan.searchConfig` 中。当前配置版本为 `2`，默认启用服务端搜索和服务端解析。旧配置会迁移为服务端解析默认开启，用户之后手动关闭会被保留。

## 搜索和解析链路

当前默认链路：

```text
用户输入关键词
  -> App.js doSearch()
  -> services/aikan.js searchAikan()
  -> GET /api/search
  -> Axum 请求源站搜索页并解析
  -> 前端渲染搜索结果

用户点击解析线路
  -> App.js resolveResult()
  -> services/aikan.js resolveLines()
  -> GET /api/m3u8
  -> Axum 请求播放页和 getResN 接口
  -> 前端获得 m3u8 线路并交给播放器
```

`services/aikan.js` 中仍保留浏览器端直连搜索和直连解析逻辑。当用户在界面关闭“搜索”或“解析线路”的服务端开关时，前端会直接访问源站；这通常更容易受到 CORS、Cloudflare 或防盗链限制。

## HLS 播放和缓存

播放使用 `hls.js`。当浏览器支持 `MediaSource` 时，应用创建 `Hls` 实例，并注入自定义 `CachingHlsLoader`。如果浏览器原生支持 `application/vnd.apple.mpegurl`，则直接把播放地址赋给 `video.src`。

`CachingHlsLoader` 的职责：

- 解析主 m3u8 和子 m3u8，发现媒体分片、key 和子播放列表。
- 使用 `lru-cache` 在浏览器内存中缓存分片资源。
- 初始预取前 `initialSegments` 个媒体分片。
- 播放过程中根据当前命中分片向前预取 `aheadSegments` 个分片。
- 记录每个资源的状态：已发现、排队、加载中、播放列表、已预取、已加载、缓存命中、失败、已淘汰。
- 将指标回传给 Vue 页面，用于展示速度、并发、缓存大小、命中率和分片状态图。

默认缓存参数：

- 最大缓存：`256 MB`
- 最大条目：`240`
- 预取并发：`8`
- 初始预热：`12` 个分片
- 前向窗口：`24` 个分片

如果启用“分片缓存”开关，非手动输入线路会先通过 `/api/proxy` 转成同源代理地址，再交给播放器和 loader。手动输入的 m3u8 默认不自动启用播放代理。

## 构建和打包

前端构建：

```sh
cd web
bun run build
```

`web/scripts/build.js` 会清空 `web/dist`，通过 `Bun.build` 打包 `src/main.js`，复制 `styles.css`，并生成 `index.html`。

完整构建：

```sh
make build
```

`make build` 先执行前端构建，再执行 Rust release 构建。因为静态资源通过 `rust-embed` 嵌入，所以修改前端后必须重新生成 `web/dist`，并重新编译 Rust 二进制，最终可执行文件才会包含新前端。

本地运行：

```sh
make run
```

分发产物：

```sh
make dist
```

该目标会把 release 二进制复制到 `dist/`。

## 运行时配置

服务端：

- 默认监听：`http://127.0.0.1:8787`
- 覆盖端口：`PORT=9000 make run`
- Windows 下 Makefile 使用 `rustup run stable-x86_64-pc-windows-msvc cargo`

前端：

- 默认数据源：`https://v.aikanbot.com`
- 默认代理服务器：`http://127.0.0.1:8787`
- 数据源和代理服务器都支持自定义。
- 搜索和解析默认走服务端。
- 播放代理缓存默认关闭，由用户在界面中开启。

## 错误处理和限制

- API 错误统一返回 `{ "error": "..." }` JSON。
- 后端源站请求非 2xx 时，会截取部分响应体放入错误信息。
- 前端直连源站失败时，会提示可能是 CORS、Cloudflare 或防盗链限制。
- HTML 解析主要依赖当前源站结构和正则表达式；源站 DOM 或接口变化时，搜索结果和播放线路解析可能需要同步调整。
- `/api/proxy` 只允许代理 `http` 和 `https` URL，但没有域名白名单。若未来开放到非本机网络，应增加访问控制、目标域限制和速率限制。

## 开发建议

- 修改前端源码后运行 `bun run build`，再运行 `cargo build` 或 `make build`。
- 修改后端解析逻辑时，优先用 `/api/search` 和 `/api/m3u8` 单独验证，再验证前端流程。
- 播放问题先区分三类：线路解析失败、m3u8 加载失败、媒体分片加载失败。
- 若出现播放资源跨域或防盗链问题，优先开启“分片缓存”让播放资源走 `/api/proxy`。
