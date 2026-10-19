//! komiku-server — proxy API Komiku+ untuk komiku-web.
//!
//! Backend hanya bertugas: generate header keamanan, dekripsi payload, cache
//! katalog, dan normalisasi bentuk JSON. Gambar tetap diambil browser langsung
//! dari CDN (`img.komiku.org`) — statis dan bisa di-hotlink, jadi tidak perlu
//! proxy byte yang hanya membebani server.

mod api;
mod crypto;
mod downloads;
mod hosts;
mod notif;
mod pdf;
mod progress;
mod read;
mod routes;
mod unified;
mod user;

use routes::AppState;
// Diperlukan untuk memanggil `.call(req)` pada Service/ServeDir di bawah.

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "komiku_server=info,tower_http=info".into()),
        )
        .init();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8788);

    // Serve dir frontend hanya diaktifkan kalau build-nya sudah ada (release build).
    // Saat dev, Vite mem-proxy /api ke port ini.
    //
    // ServeDir bawaan TIDAK melakukan SPA rewrite: request /manga/6426 yang tak ada
    // sebagai file akan 404, padahal itu route React Router. Karena itu fallback ini
    // membaca file langsung dari disk — aset dari path-nya, selain itu index.html.
    let dist = std::path::Path::new("../komiku-web/dist");
    let app = routes::router(AppState::default());
    // Route notif favorit lintas sumber (mirror unified::unified_routes()).
    // Handler stateless -> Router<()>, langsung di-merge sebelum fallback SPA.
    let app = app.merge(notif::notif_routes());
    // Akun (username-only) + posisi baca per-akun. Sama-sama stateless.
    let app = app.merge(user::user_routes());
    let app = app.merge(progress::progress_routes());
    // State "sudah dibaca" per akun (chapter yang pernah dibuka) — union,
    // supaya push dari device lain tidak menimpa mark chapter lain.
    let app = app.merge(read::read_routes());
    let app = if dist.is_dir() {
        let dist = dist.to_path_buf();
        app.fallback_service(tower::service_fn(
            move |req: axum::http::Request<axum::body::Body>| {
                let dist = dist.clone();
                async move { Ok::<_, std::convert::Infallible>(spa_fallback(&dist, req).await) }
            },
        ))
    } else {
        app
    };
    // Kompresi gzip untuk SEMUA respons (API JSON + aset statis SPA).
    // Dipasang PALING LUAR, setelah fallback, supaya aset hasil `spa_fallback`
    // ikut terkompresi — bukan cuma route API. Hanya gzip yang aktif (fitur
    // `compression-gzip`), dan tower-http otomatis:
    //   - menambah `Vary: Accept-Encoding` pada respons yang dikompres,
    //   - melewati (identity) respons yang sudah ter-encode, respons `206
    //     Content-Range`, `text/event-stream` (SSE), `image/*`, dan body
    //     < 32 byte — jadi SSE streaming & gambar tidak pernah dirusak.
    // Client tanpa `Accept-Encoding: gzip` (curl polos, bot) menerima body
    // apa adanya, jadi tidak ada regresi untuk konsumen non-browser.
    let app = app.layer(tower_http::compression::CompressionLayer::new());

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("komiku-server di http://localhost:{port}");
    if dist.is_dir() {
        tracing::info!("juga menyajikan frontend dari {}", dist.display());
    }
    axum::serve(listener, app).await?;
    Ok(())
}

/// Sajikan file dari `dist`: aset sesuai path, selain itu `index.html`
/// supaya React Router (dan refresh langsung di /manga/:id) tetap jalan.
async fn spa_fallback(
    dist: &std::path::Path,
    req: axum::http::Request<axum::body::Body>,
) -> axum::response::Response {
    use axum::body::Body;
    use axum::http::{header, StatusCode};

    let path = req.uri().path().trim_start_matches('/').to_string();
    let last = path.rsplit('/').next().unwrap_or_default();
    // Ekstensi NYATA, bukan "segmen mengandung titik": nomor chapter BERTITIK
    // ("1.5", "179.6", "00.1") juga mengandung '.'. Kalau tiap segmen bertitik
    // dianggap aset, route React Router /baca/:handle/:number jadi 404 saat
    // di-refresh atau dibuka via deep-link (server mencari dist/1.5 yang tak
    // pernah ada). Daftar ini = ekstensi yang benar-benar keluar dari build.
    let is_asset = last.rsplit_once('.').is_some_and(|(_, ext)| {
        matches!(
            ext.to_ascii_lowercase().as_str(),
            "html"
                | "js"
                | "mjs"
                | "css"
                | "json"
                | "svg"
                | "png"
                | "jpg"
                | "jpeg"
                | "webp"
                | "ico"
                | "woff"
                | "woff2"
                | "ttf"
                | "otf"
                | "map"
                | "webmanifest"
        )
    });
    let file = if is_asset {
        dist.join(&path)
    } else {
        dist.join("index.html")
    };

    // cegah path traversal (../../etc/passwd) — canonicalisasi lalu pastikan
    // masih berada di dalam dist.
    let resolved = match file.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return axum::response::Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::from("not found"))
                .unwrap()
        }
    };
    let root = dist.canonicalize().unwrap_or_else(|_| dist.to_path_buf());
    if !resolved.starts_with(&root) {
        return axum::response::Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Body::from("forbidden"))
            .unwrap();
    }

    match tokio::fs::read(&resolved).await {
        Ok(bytes) => {
            let mime = match resolved.extension().and_then(|e| e.to_str()) {
                Some("html") => "text/html; charset=utf-8",
                Some("js") => "text/javascript; charset=utf-8",
                Some("css") => "text/css; charset=utf-8",
                Some("json") => "application/json",
                Some("svg") => "image/svg+xml",
                Some("png") => "image/png",
                Some("jpg") | Some("jpeg") => "image/jpeg",
                Some("webp") => "image/webp",
                Some("ico") => "image/x-icon",
                Some("woff2") => "font/woff2",
                _ => "application/octet-stream",
            };
            let cache = if is_asset && path.starts_with("assets/") {
                // aset ber-hash dari Vite aman di-cache lama
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            };
            axum::response::Response::builder()
                .header(header::CONTENT_TYPE, mime)
                .header(header::CACHE_CONTROL, cache)
                .body(Body::from(bytes))
                .unwrap()
        }
        Err(_) => axum::response::Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("not found"))
            .unwrap(),
    }
}
