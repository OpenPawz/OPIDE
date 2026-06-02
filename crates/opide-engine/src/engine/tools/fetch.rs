// Paw Agent Engine — fetch tool
// HTTP requests to any URL.

use crate::atoms::error::EngineResult;
use crate::atoms::types::*;
use log::{info, warn};
use std::time::Duration;
use tauri::Manager;

/// §Security: SSRF protection — block access to internal/private network addresses
/// and cloud metadata endpoints. Applied unconditionally before any network policy.
///
/// B166: parse the URL and route IP literals through `is_private_ip` (so
/// IPv6-mapped IPv4 like `::ffff:127.0.0.1` and shorthand are handled by
/// the canonical-form check) plus an explicit cloud-metadata hostname
/// suffix list. Substring fallback retained for malformed URLs the parser
/// can't pull a host out of.
fn is_ssrf_target(url: &str) -> bool {
    if let Ok(parsed) = url::Url::parse(url) {
        if let Some(host) = parsed.host_str() {
            // IP literal? Use canonical-form check.
            if let Ok(ip) = host.parse::<std::net::IpAddr>() {
                return is_private_ip(&ip);
            }
            // Hostname — match cloud-metadata names by host suffix.
            let host_l = host.to_lowercase();
            const META_HOSTS: &[&str] = &[
                "localhost",
                "metadata.google.internal",
                "metadata.gce",
                "metadata.azure.com",
                "metadata",
            ];
            for h in META_HOSTS {
                if host_l == *h || host_l.ends_with(&format!(".{}", h)) {
                    return true;
                }
            }
            // Reject hostnames that look like non-canonical IP encodings
            // the URL parser left as-is (`0x7f000001`, decimal `2130706433`,
            // shorthand `127.1`). Pure-digit-and-dot host strings whose
            // IpAddr parse failed indicate one of these forms.
            let looks_ipy = !host_l.is_empty()
                && host_l
                    .chars()
                    .all(|c| c.is_ascii_digit() || c == '.' || c == 'x');
            if looks_ipy {
                return true;
            }
        }
    }

    // Substring fallback for URLs that didn't parse cleanly.
    let url_lower = url.to_lowercase();
    const BLOCKED_PREFIXES: &[&str] = &[
        "://localhost",
        "://127.",
        "://0.0.0.0",
        "://[::1]",
        "://[::]",
        "://0x7f",
        "://0177.",
    ];
    const BLOCKED_RANGES: &[&str] = &[
        "://10.",
        "://192.168.",
        "://169.254.",
        "://metadata.google",
        "://metadata.gce",
        "://100.100.100.200",
    ];
    for prefix in BLOCKED_PREFIXES {
        if url_lower.contains(prefix) {
            return true;
        }
    }
    for range in BLOCKED_RANGES {
        if url_lower.contains(range) {
            return true;
        }
    }
    if let Some(idx) = url_lower.find("://172.") {
        let after = &url_lower[idx + 7..];
        if let Some(dot) = after.find('.') {
            if let Ok(second_octet) = after[..dot].parse::<u8>() {
                if (16..=31).contains(&second_octet) {
                    return true;
                }
            }
        }
    }
    false
}

/// §Security: Check if a resolved IP address is private/loopback/link-local.
/// Catches DNS rebinding attacks where a public hostname resolves to an internal IP.
fn is_private_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || v4.octets()[0] == 100 && v4.octets()[1] == 64  // CGNAT 100.64/10
                || v4.octets() == [169, 254, 169, 254] // AWS metadata
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback() || v6.is_unspecified()
            // ::ffff:127.0.0.1 mapped IPv4
            || matches!(v6.to_ipv4_mapped(), Some(v4) if v4.is_loopback() || v4.is_private() || v4.is_link_local())
        }
    }
}

/// Resolve hostname and verify none of the IPs are private (anti-DNS-rebinding).
async fn check_dns_rebinding(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
    let host = match parsed.host_str() {
        Some(h) => h,
        None => return Ok(()), // No host to resolve
    };
    // Skip for IP literals — already checked by is_ssrf_target
    if host.parse::<std::net::IpAddr>().is_ok() {
        return Ok(());
    }
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host(format!("{}:{}", host, port))
        .await
        .map_err(|e| format!("DNS resolution failed for '{}': {}", host, e))?
        .collect();
    for addr in &addrs {
        if is_private_ip(&addr.ip()) {
            return Err(format!(
                "SSRF blocked: '{}' resolved to private/internal IP {} (possible DNS rebinding)",
                host,
                addr.ip()
            ));
        }
    }
    Ok(())
}

pub fn definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "fetch".into(),
                description: "Make an HTTP request to any URL. Returns the response body. Use for API calls, web scraping, downloading content, or reading a specific web page.".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "url": { "type": "string", "description": "The URL to fetch" },
                        "method": {
                            "type": "string",
                            "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
                            "description": "HTTP method (default: GET)"
                        },
                        "headers": { "type": "object", "description": "HTTP headers as key-value pairs" },
                        "body": { "description": "Request body for POST/PUT/PATCH. Pass a JSON object directly (preferred) or a JSON string." }
                    },
                    "required": ["url"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "web_search".into(),
                description: "Search the web and return a ranked list of result titles, URLs, and snippets. Use this to find current information, documentation, or examples, then read a specific result with the `fetch` tool.".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "The search query" },
                        "max_results": { "type": "integer", "description": "Maximum results to return (default 8, max 15)" }
                    },
                    "required": ["query"]
                }),
            },
        },
    ]
}

pub async fn execute(
    name: &str,
    args: &serde_json::Value,
    app_handle: &tauri::AppHandle,
) -> Option<Result<String, String>> {
    match name {
        "fetch" => Some(
            execute_fetch(args, app_handle)
                .await
                .map_err(|e| e.to_string()),
        ),
        "web_search" => Some(
            execute_web_search(args, app_handle)
                .await
                .map_err(|e| e.to_string()),
        ),
        _ => None,
    }
}

// ── web_search ─────────────────────────────────────────────────────────────────
//
// Keyless web search via DuckDuckGo's HTML endpoint. We reuse execute_fetch so
// the SSRF protection, redirect re-validation, and connection pool all apply.
// The HTML is parsed for result anchors (format verified against the live
// endpoint). Best-effort: if the page format changes and nothing parses, we
// return a clear message instead of failing, and the agent can fall back to
// fetching a search URL directly.

async fn execute_web_search(
    args: &serde_json::Value,
    app_handle: &tauri::AppHandle,
) -> EngineResult<String> {
    let query = args["query"]
        .as_str()
        .ok_or("web_search: missing 'query' argument")?
        .trim();
    if query.is_empty() {
        return Err("web_search: 'query' is empty".into());
    }
    let max = args["max_results"].as_u64().unwrap_or(8).clamp(1, 15) as usize;

    // Build the DDG HTML search URL with a properly-encoded query.
    let qs = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("q", query)
        .finish();
    let search_url = format!("https://html.duckduckgo.com/html/?{qs}");

    info!("[engine] web_search: {}", query);

    // Reuse the hardened fetch path. DDG needs a browser-like User-Agent.
    let fetch_args = serde_json::json!({
        "url": search_url,
        "headers": {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
        }
    });
    let html = execute_fetch(&fetch_args, app_handle).await?;

    let results = parse_ddg_results(&html, max);
    if results.is_empty() {
        return Ok(format!(
            "web_search: no results parsed for \"{query}\". The search page may have \
             changed format or rate-limited the request. You can retry, or fetch a \
             search URL directly with the `fetch` tool."
        ));
    }

    let mut out = format!("Web search results for \"{query}\":\n\n");
    for (i, (title, link, snippet)) in results.iter().enumerate() {
        out.push_str(&format!("{}. {title}\n   {link}\n", i + 1));
        if !snippet.is_empty() {
            out.push_str(&format!("   {snippet}\n"));
        }
        out.push('\n');
    }
    out.push_str("Use the `fetch` tool on a result URL to read the full page.");
    Ok(out)
}

/// Strip HTML tags and unescape common entities from a fragment.
fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&#x2F;", "/")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Parse DuckDuckGo HTML results into (title, url, snippet) tuples. Format
/// (verified live 2026-06): result anchors carry `class="result__a"` and link
/// through `//duckduckgo.com/l/?uddg=<percent-encoded-target>`; snippets carry
/// `class="result__snippet"`.
fn parse_ddg_results(html: &str, max: usize) -> Vec<(String, String, String)> {
    let decode_uddg = |raw_href: &str| -> Option<String> {
        let unescaped = raw_href.replace("&amp;", "&");
        let full = if let Some(rest) = unescaped.strip_prefix("//") {
            format!("https://{rest}")
        } else {
            unescaped.clone()
        };
        url::Url::parse(&full).ok().and_then(|u| {
            u.query_pairs()
                .find(|(k, _)| k == "uddg")
                .map(|(_, v)| v.into_owned())
        })
    };

    let inner_text = |block: &str| -> String {
        // Text between the anchor's opening-tag close ('>') and '</a>'.
        block
            .split_once('>')
            .map(|(_, rest)| rest)
            .and_then(|rest| rest.split("</a>").next())
            .map(strip_html)
            .unwrap_or_default()
    };

    let mut results: Vec<(String, String, String)> = Vec::new();
    for block in html.split("class=\"result__a\"").skip(1) {
        if results.len() >= max {
            break;
        }
        let href = block
            .split_once("href=\"")
            .and_then(|(_, rest)| rest.split_once('"').map(|(h, _)| h))
            .unwrap_or("");
        let link = decode_uddg(href).unwrap_or_default();
        let title = inner_text(block);
        let snippet = block
            .find("result__snippet")
            .map(|i| inner_text(&block[i..]))
            .unwrap_or_default();
        if !title.is_empty() && link.starts_with("http") {
            results.push((title, link, snippet));
        }
    }
    results
}

async fn execute_fetch(
    args: &serde_json::Value,
    app_handle: &tauri::AppHandle,
) -> EngineResult<String> {
    let url = args["url"]
        .as_str()
        .ok_or("fetch: missing 'url' argument")?;
    let method = args["method"].as_str().unwrap_or("GET");

    info!("[engine] fetch: {} {}", method, url);

    // §Security: SSRF protection — unconditionally block internal/private IPs
    if is_ssrf_target(url) {
        warn!("[engine] fetch: SSRF blocked — {} {}", method, url);
        return Err(
            "fetch: access to internal/private network addresses is blocked (SSRF protection). \
             This includes localhost, RFC-1918 private ranges, link-local, and cloud metadata endpoints."
                .into(),
        );
    }

    // §Security: Anti-DNS-rebinding — resolve hostname and verify IPs are public
    if let Err(msg) = check_dns_rebinding(url).await {
        warn!(
            "[engine] fetch: DNS rebinding blocked — {} {}: {}",
            method, url, msg
        );
        return Err(format!("fetch: {}", msg).into());
    }

    // Network policy enforcement was removed in OPIDE phase 1 along with
    // commands::browser. If an outbound allowlist is reintroduced it should
    // live in the slim opide-engine surface, not in the legacy browser
    // command module.

    // ── Auto-inject credentials for known API domains ─────────────────
    // If the agent calls a Discord API URL without an Authorization header,
    // automatically inject the bot token from the skill vault. This prevents
    // 401 errors when the LLM forgets to include the header (which happens
    // frequently after context truncation).
    let mut injected_headers: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    let has_auth_header = args["headers"]
        .as_object()
        .map(|h| h.keys().any(|k| k.eq_ignore_ascii_case("authorization")))
        .unwrap_or(false);

    // B169: match Discord API hosts by canonical hostname so canary/ptb/staging
    // subdomains (canary.discord.com, ptb.discord.com) also get the bot token
    // injected. The substring `discord.com/api` excluded those.
    let parsed_url_for_inject = url::Url::parse(url).ok();
    let host_lower = parsed_url_for_inject
        .as_ref()
        .and_then(|u| u.host_str())
        .map(|h| h.to_lowercase())
        .unwrap_or_default();
    let path_lower = parsed_url_for_inject
        .as_ref()
        .map(|u| u.path().to_string())
        .unwrap_or_default();
    let is_discord_api = matches!(
        host_lower.as_str(),
        "discord.com" | "canary.discord.com" | "ptb.discord.com" | "staging.discord.com"
    ) && path_lower.starts_with("/api");

    // Discord bot auto-auth header injection was removed in OPIDE phase 1
    // along with engine::skills (the skill credential vault).
    let _ = is_discord_api;

    // Auto-inject Content-Type for Discord API mutations when body is present
    if is_discord_api && args["body"].is_string() {
        let has_ct = args["headers"]
            .as_object()
            .map(|h| h.keys().any(|k| k.eq_ignore_ascii_case("content-type")))
            .unwrap_or(false);
        if !has_ct {
            injected_headers.insert("Content-Type".into(), "application/json".into());
        }
    }

    // B168: lazy-static client so we keep a connection pool across calls.
    // Building a fresh reqwest::Client per fetch threw away connection reuse
    // and re-resolved DNS on every call.
    use std::sync::LazyLock;
    static FETCH_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(8)
            // §Security: re-validate every redirect hop. is_ssrf_target /
            // check_dns_rebinding above only vet the *original* URL; reqwest's
            // default policy would then follow a 302 to
            // http://169.254.169.254/ or http://localhost/ straight into the
            // internal target. Block any hop that resolves to an SSRF target
            // and cap the chain ourselves. (Residual: a redirect to an
            // attacker hostname that DNS-rebinds to a private IP isn't caught
            // here — the policy closure is sync and can't await a DNS lookup.)
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if is_ssrf_target(attempt.url().as_str()) {
                    attempt.error("SSRF blocked: redirect to internal/private address")
                } else if attempt.previous().len() > 10 {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .expect("Failed to build fetch client")
    });
    let client = &*FETCH_CLIENT;

    // ── Retry loop for transient errors ──────────────────────────────
    use crate::engine::http::{is_retryable_status, parse_retry_after, retry_delay, MAX_RETRIES};

    let mut last_err: Option<String> = None;
    let mut response_result: Option<(u16, String)> = None;

    for attempt in 0..=MAX_RETRIES {
        // Rebuild the request each attempt (RequestBuilder is not Clone)
        let mut req = match method.to_uppercase().as_str() {
            "POST" => client.post(url),
            "PUT" => client.put(url),
            "PATCH" => client.patch(url),
            "DELETE" => client.delete(url),
            "HEAD" => client.head(url),
            _ => client.get(url),
        };
        // Apply auto-injected credential headers first (so explicit headers override)
        for (key, value) in &injected_headers {
            req = req.header(key.as_str(), value.as_str());
        }
        if let Some(headers) = args["headers"].as_object() {
            for (key, value) in headers {
                if let Some(v) = value.as_str() {
                    req = req.header(key.as_str(), v);
                }
            }
        }
        // Accept body as either a JSON string or a JSON object/array.
        // When the model passes an object (e.g. {"name":"foo","type":0}),
        // we serialize it to a JSON string. This avoids the double-escaping
        // problem that causes MALFORMED_FUNCTION_CALL errors in Gemini.
        if let Some(body_str) = args["body"].as_str() {
            req = req.body(body_str.to_string());
        } else if args["body"].is_object() || args["body"].is_array() {
            req = req.body(serde_json::to_string(&args["body"]).unwrap_or_default());
        }

        match req.send().await {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let retry_after = resp
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(parse_retry_after);

                if is_retryable_status(status) && attempt < MAX_RETRIES {
                    log::warn!(
                        "[fetch] Retryable status {} on attempt {}, backing off",
                        status,
                        attempt + 1
                    );
                    retry_delay(attempt, retry_after).await;
                    continue;
                }

                let body = resp
                    .text()
                    .await
                    .unwrap_or_else(|e| format!("(body read error: {})", e));
                response_result = Some((status, body));
                break;
            }
            Err(e) => {
                if attempt < MAX_RETRIES && (e.is_timeout() || e.is_connect()) {
                    log::warn!(
                        "[fetch] Transport error on attempt {}: {} — retrying",
                        attempt + 1,
                        e
                    );
                    retry_delay(attempt, None).await;
                    continue;
                }
                last_err = Some(e.to_string());
                break;
            }
        }
    }

    let (status, body) = match response_result {
        Some(r) => r,
        None => {
            return Err(format!(
                "fetch failed after retries: {}",
                last_err.unwrap_or_default()
            )
            .into())
        }
    };

    // B167: floor to a UTF-8 char boundary before slicing — non-ASCII response
    // bodies (international API responses, JSON with non-ASCII strings)
    // panicked when MAX_BODY landed mid-codepoint. Reuses S9's helper.
    const MAX_BODY: usize = 50_000;
    let body_len = body.len();
    let truncated = if body_len > MAX_BODY {
        let mut head = body;
        crate::engine::util::safe_truncate_in_place(
            &mut head,
            MAX_BODY,
            &format!("...\n[truncated, {} total bytes]", body_len),
        );
        head
    } else {
        body
    };

    Ok(format!(
        "HTTP {} {}\n\n{}",
        status,
        if status < 400 { "OK" } else { "Error" },
        truncated
    ))
}
