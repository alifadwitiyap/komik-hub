// Smoke test: buktikan fitur gzip/brotli reqwest benar-benar aktif di runtime,
// bukan cuma ada di lockfile. Kalau fitur hilang, `content-encoding` akan tetap
// ada di response dan body tidak ter-dekompres.

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::Client::builder().build()?;

    // Endpoint yang membalas gzip kalau Accept-Encoding diminta.
    let url = "https://httpbin.org/gzip";
    let resp = client.get(url).send().await?;
    let status = resp.status();
    let enc = resp
        .headers()
        .get(reqwest::header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let body = resp.text().await?;

    // Body ter-dekompres = JSON valid yang bisa di-parse.
    let parsed: serde_json::Value = serde_json::from_str(&body)?;
    let gzipped = parsed
        .get("gzipped")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    println!("status          = {status}");
    println!("content-encoding= {enc:?}");
    println!("body len        = {} byte", body.len());
    println!("json valid      = ya");
    println!("server gzipped  = {gzipped}");

    // Kontrak: kalau reqwest punya fitur gzip, header encoding DIBUANG dan
    // body sudah didekompres jadi JSON.
    if enc.is_some() {
        return Err("GAGAL: content-encoding masih ada -> body tidak didekompres".into());
    }
    if !gzipped {
        return Err("GAGAL: server tidak membalas gzip, smoke test tidak membuktikan apa pun".into());
    }
    println!("\nLULUS: reqwest mendekompak gzip secara transparan (fitur aktif)");
    Ok(())
}
