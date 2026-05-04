# Aikan Axum

Rust/Axum backend with the static web UI embedded into a single deployable binary.

## Documentation

- [Technical architecture](docs/architecture.md)

## Requirements

- Rust toolchain (`cargo`)
- Bun
- `make` for the provided build targets

## Build

```sh
make build
```

This builds `web/dist` first, then compiles the release binary with the generated static files embedded.

## Run

```sh
make run
```

The service listens on `http://127.0.0.1:8787` by default. You can override the host and port with:

```sh
HOST=0.0.0.0 PORT=9000 make run
```

On PowerShell:

```powershell
$env:HOST="0.0.0.0"; $env:PORT=9000; make run
```

The frontend uses the current website origin as the default proxy server. For example, opening `http://192.168.1.10:9000` makes the default API/proxy base URL `http://192.168.1.10:9000`.

## API Routes

- `GET /api/search?q=...&baseUrl=...`
- `GET /api/m3u8?videoId=...&baseUrl=...`
- `GET /api/resolve?q=...&baseUrl=...`
- `GET /api/proxy?url=...&referer=...`

All backend routes are under `/api/*`; other paths serve the embedded frontend.
