use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use regex::Regex;
use reqwest::Client;
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{borrow::Cow, net::SocketAddr, sync::Arc, time::Duration};
use url::{form_urlencoded, Url};

const BASE_URL: &str = "https://v.aikanbot.com";
const DEFAULT_PORT: u16 = 8787;
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

#[derive(RustEmbed)]
#[folder = "web/dist/"]
struct StaticFiles;

#[derive(Clone)]
struct AppState {
    client: Client,
}

#[derive(Debug)]
struct AppError {
    status: StatusCode,
    message: String,
}

impl AppError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        json_response(self.status, serde_json::json!({ "error": self.message }))
    }
}

impl From<reqwest::Error> for AppError {
    fn from(error: reqwest::Error) -> Self {
        Self::internal(error.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::internal(error.to_string())
    }
}

impl From<regex::Error> for AppError {
    fn from(error: regex::Error) -> Self {
        Self::internal(error.to_string())
    }
}

type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Serialize, Clone)]
struct SearchResult {
    video_id: String,
    title: String,
    url: String,
    thumb: String,
    playable_count: usize,
    playable_label: String,
    meta: String,
    cast: String,
    summary: String,
}

#[derive(Debug, Serialize, Clone)]
struct M3u8Line {
    flag: String,
    name: String,
    url: String,
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    q: String,
    #[serde(rename = "baseUrl")]
    base_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct M3u8Query {
    #[serde(rename = "videoId")]
    video_id: String,
    #[serde(rename = "baseUrl")]
    base_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProxyQuery {
    url: String,
    referer: Option<String>,
}

#[derive(Debug, Serialize)]
struct SearchResponse {
    results: Vec<SearchResult>,
}

#[derive(Debug, Serialize)]
struct M3u8Response {
    #[serde(rename = "videoId")]
    video_id: String,
    #[serde(rename = "apiUrl")]
    api_url: String,
    lines: Vec<M3u8Line>,
}

#[derive(Debug, Serialize)]
struct ResolveResponse {
    results: Vec<SearchResult>,
    selected: Option<SearchResult>,
    #[serde(rename = "apiUrl")]
    api_url: String,
    lines: Vec<M3u8Line>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let port = std::env::args()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .or_else(|| {
            std::env::var("PORT")
                .ok()
                .and_then(|value| value.parse().ok())
        })
        .unwrap_or(DEFAULT_PORT);

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(USER_AGENT)
        .build()?;
    let state = Arc::new(AppState { client });

    let app = Router::new()
        .route("/api/search", get(handle_search))
        .route("/api/m3u8", get(handle_m3u8))
        .route("/api/resolve", get(handle_resolve))
        .route("/api/proxy", get(handle_proxy))
        .fallback(static_handler)
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    println!("Aikan Axum server: http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn handle_search(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SearchQuery>,
) -> AppResult<Response> {
    let keyword = query.q.trim();
    if keyword.is_empty() {
        return Err(AppError::bad_request("missing q"));
    }
    let base_url = normalize_base_url(query.base_url.as_deref());
    let results = search_aikan(&state.client, keyword, &base_url).await?;
    let results = results
        .into_iter()
        .map(|item| result_payload(item, &headers, &base_url))
        .collect();
    Ok(json_response(StatusCode::OK, SearchResponse { results }))
}

async fn handle_m3u8(
    State(state): State<Arc<AppState>>,
    Query(query): Query<M3u8Query>,
) -> AppResult<Response> {
    if !Regex::new(r"^\d+$")?.is_match(query.video_id.trim()) {
        return Err(AppError::bad_request("missing or invalid videoId"));
    }
    let base_url = normalize_base_url(query.base_url.as_deref());
    let (api_url, lines) = get_m3u8_lines(&state.client, query.video_id.trim(), &base_url).await?;
    Ok(json_response(
        StatusCode::OK,
        M3u8Response {
            video_id: query.video_id,
            api_url,
            lines,
        },
    ))
}

async fn handle_resolve(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SearchQuery>,
) -> AppResult<Response> {
    let keyword = query.q.trim();
    if keyword.is_empty() {
        return Err(AppError::bad_request("missing q"));
    }
    let base_url = normalize_base_url(query.base_url.as_deref());
    let results = search_aikan(&state.client, keyword, &base_url).await?;
    let Some(first) = results.first() else {
        return Ok(json_response(
            StatusCode::OK,
            ResolveResponse {
                results: vec![],
                selected: None,
                api_url: String::new(),
                lines: vec![],
            },
        ));
    };
    let (api_url, lines) = get_m3u8_lines(&state.client, &first.video_id, &base_url).await?;
    let payload_results: Vec<_> = results
        .into_iter()
        .map(|item| result_payload(item, &headers, &base_url))
        .collect();
    let selected = payload_results.first().cloned();

    Ok(json_response(
        StatusCode::OK,
        ResolveResponse {
            results: payload_results,
            selected,
            api_url,
            lines,
        },
    ))
}

async fn handle_proxy(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ProxyQuery>,
) -> AppResult<Response> {
    if !query.url.starts_with("http://") && !query.url.starts_with("https://") {
        return Err(AppError::bad_request("missing or invalid url"));
    }
    let referer = query.referer.as_deref().unwrap_or(&query.url);
    let (mut data, mut content_type) =
        fetch_bytes(&state.client, &query.url, referer, "*/*").await?;
    if is_playlist_url(&query.url, &content_type) {
        let text = String::from_utf8_lossy(&data);
        data = rewrite_playlist(&text, &query.url, host_header(&headers)).into_bytes();
        content_type = "application/vnd.apple.mpegurl; charset=utf-8".to_string();
    }

    let mut response = Response::new(Body::from(data));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header_value(&content_type, "application/octet-stream"),
    );
    add_common_headers(response.headers_mut());
    Ok(response)
}

async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let file = StaticFiles::get(path).or_else(|| StaticFiles::get("index.html"));

    match file {
        Some(content) => {
            let body: Cow<'static, [u8]> = content.data;
            let mut response = Response::new(Body::from(body.into_owned()));
            *response.status_mut() = StatusCode::OK;
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_str(mime.as_ref())
                    .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
            );
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

async fn fetch_bytes(
    client: &Client,
    url: &str,
    referer: &str,
    accept: &str,
) -> AppResult<(Vec<u8>, String)> {
    let mut request = client
        .get(url)
        .header(header::ACCEPT, accept)
        .header(header::ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::PRAGMA, "no-cache");
    if !referer.is_empty() {
        request = request.header(header::REFERER, referer);
    }

    let response = request.send().await?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let data = response.bytes().await?.to_vec();

    if !status.is_success() {
        let detail = String::from_utf8_lossy(&data);
        return Err(AppError::internal(format!(
            "HTTP {status} while requesting {url}: {}",
            &detail.chars().take(300).collect::<String>()
        )));
    }

    Ok((data, content_type))
}

async fn fetch_text(client: &Client, url: &str, referer: &str) -> AppResult<String> {
    let (data, content_type) = fetch_bytes(
        client,
        url,
        referer,
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    )
    .await?;
    let charset = Regex::new(r"(?i)charset=([\w-]+)")?
        .captures(&content_type)
        .and_then(|captures| captures.get(1).map(|item| item.as_str().to_lowercase()))
        .unwrap_or_else(|| "utf-8".to_string());
    if charset == "utf-8" || charset == "utf8" {
        Ok(String::from_utf8_lossy(&data).to_string())
    } else {
        Ok(String::from_utf8_lossy(&data).to_string())
    }
}

async fn fetch_json(client: &Client, url: &str, referer: &str) -> AppResult<Value> {
    let (data, _) = fetch_bytes(
        client,
        url,
        referer,
        "application/json, text/javascript, */*; q=0.01",
    )
    .await?;
    Ok(serde_json::from_slice(&data)?)
}

async fn search_aikan(
    client: &Client,
    keyword: &str,
    base_url: &str,
) -> AppResult<Vec<SearchResult>> {
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("q", keyword)
        .finish();
    let html = fetch_text(client, &format!("{base_url}/search?{query}"), "").await?;
    parse_search_results(&html, base_url)
}

fn normalize_base_url(raw_url: Option<&str>) -> String {
    let value = raw_url.unwrap_or(BASE_URL).trim();
    match Url::parse(value) {
        Ok(url) if url.scheme() == "http" || url.scheme() == "https" => {
            value.trim_end_matches('/').to_string()
        }
        _ => BASE_URL.to_string(),
    }
}

fn parse_search_results(html: &str, base_url: &str) -> AppResult<Vec<SearchResult>> {
    let media_re = Regex::new(r#"(?is)<div\s+class=["']media["']"#)?;
    let mut results = Vec::new();
    let media_starts: Vec<_> = media_re.find_iter(html).map(|item| item.start()).collect();
    let body_end = Regex::new(r"(?is)</body>")?
        .find(html)
        .map(|item| item.start())
        .unwrap_or(html.len());
    for (index, start) in media_starts.iter().enumerate() {
        let end = media_starts
            .get(index + 1)
            .copied()
            .unwrap_or(body_end)
            .max(*start);
        let block = &html[*start..end.min(html.len())];
        if let Some(item) = parse_media_result(block, base_url)? {
            if !results
                .iter()
                .any(|existing: &SearchResult| existing.video_id == item.video_id)
            {
                results.push(item);
            }
        }
    }
    if !results.is_empty() {
        return Ok(results);
    }

    let href_re = Regex::new(r#"href=["'](/play/(\d+))["']"#)?;
    for captures in href_re.captures_iter(html) {
        let video_id = captures.get(2).unwrap().as_str().to_string();
        if results.iter().any(|existing| existing.video_id == video_id) {
            continue;
        }
        let href = captures.get(1).unwrap().as_str();
        results.push(SearchResult {
            video_id: video_id.clone(),
            title: video_id,
            url: join_url(base_url, href),
            thumb: String::new(),
            playable_count: 0,
            playable_label: String::new(),
            meta: String::new(),
            cast: String::new(),
            summary: String::new(),
        });
    }
    Ok(results)
}

fn parse_media_result(block: &str, base_url: &str) -> AppResult<Option<SearchResult>> {
    let href_re = Regex::new(r#"(?is)href=["']([^"']*/play/(\d+)[^"']*)["']"#)?;
    let Some(href_caps) = href_re.captures(block) else {
        return Ok(None);
    };
    let href = href_caps.get(1).unwrap().as_str();
    let video_id = href_caps.get(2).unwrap().as_str();

    let title = capture_inner(
        block,
        r#"(?is)class=["'][^"']*title-text[^"']*["'][^>]*>(.*?)</a>"#,
    )?
    .or_else(|| attr_value(block, "alt").ok())
    .unwrap_or_else(|| video_id.to_string());
    let label = capture_inner(
        block,
        r#"(?is)class=["'][^"']*label[^"']*["'][^>]*>(.*?)</span>"#,
    )?
    .unwrap_or_default();
    let small_re = Regex::new(r#"(?is)class=["'][^"']*small[^"']*["'][^>]*>(.*?)</span>"#)?;
    let small_lines: Vec<_> = small_re
        .captures_iter(block)
        .filter_map(|captures| captures.get(1).map(|item| compact_text(item.as_str())))
        .collect();
    let meta = small_lines.get(0).cloned().unwrap_or_default();
    let cast = small_lines.get(1).cloned().unwrap_or_default();
    let thumb = Regex::new(r#"(?is)<img\b[^>]*>"#)?
        .find(block)
        .map(|item| image_url_from_tag(video_id, item.as_str(), base_url))
        .unwrap_or_default();
    let playable_count = Regex::new(r"\d+")?
        .find(&label)
        .and_then(|item| item.as_str().parse::<usize>().ok())
        .unwrap_or(0);
    let summary = [meta.clone(), cast.clone()]
        .into_iter()
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    Ok(Some(SearchResult {
        video_id: video_id.to_string(),
        title,
        url: join_url(base_url, href),
        thumb,
        playable_count,
        playable_label: label,
        meta,
        cast,
        summary,
    }))
}

fn capture_inner(text: &str, pattern: &str) -> AppResult<Option<String>> {
    Ok(Regex::new(pattern)?
        .captures(text)
        .and_then(|captures| captures.get(1).map(|item| compact_text(item.as_str()))))
}

fn attr_value(html: &str, name: &str) -> AppResult<String> {
    let pattern = format!(r#"(?is)\b{}=["']([^"']*)["']"#, regex::escape(name));
    Ok(Regex::new(&pattern)?
        .captures(html)
        .and_then(|captures| captures.get(1).map(|item| html_unescape(item.as_str())))
        .unwrap_or_default())
}

fn compact_text(value: &str) -> String {
    html_unescape(
        &Regex::new(r"(?is)<[^>]+>")
            .expect("valid regex")
            .replace_all(value, " "),
    )
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
}

fn html_unescape(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

fn image_url_from_tag(video_id: &str, image_html: &str, base_url: &str) -> String {
    let mut candidates = vec![
        attr_value(image_html, "src").unwrap_or_default(),
        attr_value(image_html, "data-src").unwrap_or_default(),
        attr_value(image_html, "data-original").unwrap_or_default(),
    ];
    candidates = candidates
        .into_iter()
        .map(|item| join_url(base_url, &item))
        .filter(|item| !item.is_empty() && !item.starts_with("data:"))
        .collect();

    candidates
        .iter()
        .find(|item| item.contains("img-p.aikanbot.com"))
        .cloned()
        .unwrap_or_else(|| {
            candidates
                .first()
                .map(|item| proxied_image_url(video_id, item))
                .unwrap_or_default()
        })
}

fn proxied_image_url(video_id: &str, raw_url: &str) -> String {
    if raw_url.is_empty() || raw_url.starts_with("data:") || raw_url.contains("img-p.aikanbot.com")
    {
        return raw_url.to_string();
    }
    let encoded = STANDARD
        .encode(raw_url.as_bytes())
        .trim_end_matches('=')
        .to_string();
    format!("https://img-p.aikanbot.com/i/{video_id}?u={encoded}")
}

async fn get_m3u8_lines(
    client: &Client,
    video_id: &str,
    base_url: &str,
) -> AppResult<(String, Vec<M3u8Line>)> {
    let play_url = format!("{base_url}/play/{video_id}");
    let play_html = fetch_text(client, &play_url, &format!("{base_url}/")).await?;
    let inputs = parse_hidden_inputs(&play_html)?;
    let current_id = inputs
        .get("current_id")
        .cloned()
        .unwrap_or_else(|| video_id.to_string());
    let e_token = inputs
        .get("e_token")
        .ok_or_else(|| AppError::internal("Missing e_token or mtype in play page"))?;
    let mtype = inputs
        .get("mtype")
        .ok_or_else(|| AppError::internal("Missing e_token or mtype in play page"))?;
    let token = build_token(&current_id, e_token)?;
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("videoId", video_id)
        .append_pair("mtype", mtype)
        .append_pair("token", &token)
        .finish();
    let api_url = format!("{base_url}/api/getResN?{query}");
    let payload = fetch_json(client, &api_url, &play_url).await?;
    Ok((api_url, parse_m3u8_lines(&payload)?))
}

fn parse_hidden_inputs(html: &str) -> AppResult<std::collections::HashMap<String, String>> {
    let mut inputs = std::collections::HashMap::new();
    let input_re = Regex::new(r#"(?is)<input\b[^>]*>"#)?;
    for item in input_re.find_iter(html) {
        let tag = item.as_str();
        let id = attr_value(tag, "id")?;
        if id.is_empty() {
            continue;
        }
        inputs.insert(id, attr_value(tag, "value")?);
    }
    Ok(inputs)
}

fn build_token(current_id: &str, encrypted_token: &str) -> AppResult<String> {
    if current_id.len() < 4 {
        return Err(AppError::internal(format!(
            "current_id is too short: {current_id}"
        )));
    }
    let mut rest = encrypted_token.to_string();
    let mut chunks = Vec::new();
    for digit in current_id
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        let Some(value) = digit.to_digit(10) else {
            return Err(AppError::internal(format!(
                "current_id suffix contains non-digit: {current_id}"
            )));
        };
        let offset = value as usize % 3 + 1;
        if rest.len() < offset + 8 {
            return Err(AppError::internal(
                "e_token is too short for token generation",
            ));
        }
        chunks.push(rest[offset..offset + 8].to_string());
        rest = rest[offset + 8..].to_string();
    }
    Ok(chunks.join(""))
}

fn parse_m3u8_lines(payload: &Value) -> AppResult<Vec<M3u8Line>> {
    if payload.get("state").and_then(Value::as_i64) != Some(1) {
        return Err(AppError::internal(format!(
            "getResN failed: state={} message={}",
            payload
                .get("state")
                .map(Value::to_string)
                .unwrap_or_else(|| "-".to_string()),
            payload
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("-")
        )));
    }

    let mut lines = Vec::new();
    let list = payload
        .get("data")
        .and_then(|data| data.get("list"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for item in list {
        let fallback_flag = item
            .get("flag")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let raw_res_data = item.get("resData").and_then(Value::as_str).unwrap_or("[]");
        let entries: Vec<Value> = serde_json::from_str(raw_res_data).unwrap_or_default();
        for entry in entries {
            let flag = entry
                .get("flag")
                .and_then(Value::as_str)
                .unwrap_or(&fallback_flag)
                .to_string();
            let raw_url = entry.get("url").and_then(Value::as_str).unwrap_or("");
            for part in raw_url.split('#') {
                let Some((name, m3u8_url)) = part.split_once('$') else {
                    continue;
                };
                if m3u8_url.to_lowercase().contains(".m3u8") {
                    lines.push(M3u8Line {
                        flag: flag.clone(),
                        name: compact_text(name),
                        url: m3u8_url.to_string(),
                    });
                }
            }
        }
    }
    Ok(lines)
}

fn rewrite_uri_attributes(line: &str, base_url: &str, host: &str) -> String {
    Regex::new(r#"URI="([^"]+)""#)
        .expect("valid regex")
        .replace_all(line, |captures: &regex::Captures| {
            let raw = captures.get(1).unwrap().as_str();
            let absolute = join_url(base_url, raw);
            format!("URI=\"{}\"", proxy_url(host, &absolute, base_url))
        })
        .to_string()
}

fn rewrite_playlist(text: &str, base_url: &str, host: &str) -> String {
    let mut output = Vec::new();
    for line in text.lines() {
        let stripped = line.trim();
        if stripped.is_empty() {
            output.push(line.to_string());
        } else if stripped.starts_with('#') {
            output.push(rewrite_uri_attributes(line, base_url, host));
        } else {
            let absolute = join_url(base_url, stripped);
            output.push(proxy_url(host, &absolute, base_url));
        }
    }
    output.join("\n") + "\n"
}

fn is_playlist_url(url: &str, content_type: &str) -> bool {
    let lower_url = url.to_lowercase();
    let lower_type = content_type.to_lowercase();
    lower_url.contains(".m3u8")
        || lower_type.contains("mpegurl")
        || lower_type.contains("application/vnd.apple")
}

fn result_payload(mut item: SearchResult, headers: &HeaderMap, base_url: &str) -> SearchResult {
    if !item.thumb.is_empty() {
        item.thumb = proxy_url(host_header(headers), &item.thumb, &format!("{base_url}/"));
    }
    item
}

fn proxy_url(host: &str, source_url: &str, referer: &str) -> String {
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("url", source_url)
        .append_pair("referer", referer)
        .finish();
    format!("http://{host}/api/proxy?{query}")
}

fn host_header(headers: &HeaderMap) -> &str {
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("127.0.0.1:8787")
}

fn join_url(base_url: &str, raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    Url::parse(base_url)
        .and_then(|base| base.join(raw))
        .map(|url| url.to_string())
        .unwrap_or_else(|_| raw.to_string())
}

fn json_response<T: Serialize>(status: StatusCode, payload: T) -> Response {
    let mut response = (status, Json(payload)).into_response();
    add_common_headers(response.headers_mut());
    response
}

fn add_common_headers(headers: &mut HeaderMap) {
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
}

fn header_value(value: &str, fallback: &'static str) -> HeaderValue {
    HeaderValue::from_str(value).unwrap_or_else(|_| HeaderValue::from_static(fallback))
}
