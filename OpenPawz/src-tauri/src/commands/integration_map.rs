// commands/integration_map.rs — Service-to-skill credential mapping utilities.
//
// Extracted from commands/n8n.rs so these pure mapping functions remain
// available even when the `docker` feature (and thus the n8n module) is disabled.
// Used by commands/oauth.rs and commands/integrations.rs.

/// Map a service_id to its corresponding skill_id without needing credentials.
/// Used by disconnect to know which skill vault to purge.
pub fn service_to_skill_id(service_id: &str) -> String {
    match service_id {
        "slack" => "slack".into(),
        "discord" => "discord".into(),
        "github" | "github-app" => "github".into(),
        "trello" => "trello".into(),
        "telegram" => "telegram".into(),
        // Each service has its own vault — no more rest_api collision
        "notion" => "notion".into(),
        "linear" => "linear".into(),
        "stripe" => "stripe".into(),
        "todoist" => "todoist".into(),
        "clickup" => "clickup".into(),
        "airtable" => "airtable".into(),
        "sendgrid" => "sendgrid".into(),
        "jira" => "jira".into(),
        "zendesk" => "zendesk".into(),
        "hubspot" => "hubspot".into(),
        "twilio" => "twilio".into(),
        "shopify" => "shopify".into(),
        "pagerduty" => "pagerduty".into(),
        "microsoft-teams" => "microsoft_365".into(),
        "outlook" | "onedrive" | "microsoft" | "microsoft-365" => "microsoft_365".into(),
        "google" | "google-workspace" => "google_workspace".into(),
        "gmail" | "google-drive" | "google-calendar" | "google-sheets" | "google-docs" => {
            "google_workspace".into()
        }
        // Fallback: skill_id == service_id
        other => other.into(),
    }
}

/// Map integration credential keys (from UI) to skill vault keys (for tools).
/// Returns (skill_id, mapped_credentials).
pub(crate) fn map_integration_to_skill(
    service_id: &str,
    creds: &std::collections::HashMap<String, String>,
) -> (String, std::collections::HashMap<String, String>) {
    let mut mapped = std::collections::HashMap::new();

    let skill_id = match service_id {
        // ── Services with dedicated tool modules ──
        "slack" => {
            if let Some(v) = creds
                .get("bot_token")
                .or(creds.get("access_token"))
                .or(creds.get("api_key"))
            {
                mapped.insert("SLACK_BOT_TOKEN".into(), v.clone());
            }
            if let Some(v) = creds.get("default_channel") {
                mapped.insert("SLACK_DEFAULT_CHANNEL".into(), v.clone());
            }
            "slack"
        }
        "discord" => {
            if let Some(v) = creds.get("bot_token").or(creds.get("api_key")) {
                mapped.insert("DISCORD_BOT_TOKEN".into(), v.clone());
            }
            if let Some(v) = creds.get("default_channel") {
                mapped.insert("DISCORD_DEFAULT_CHANNEL".into(), v.clone());
            }
            if let Some(v) = creds.get("server_id").or(creds.get("guild_id")) {
                mapped.insert("DISCORD_SERVER_ID".into(), v.clone());
            }
            "discord"
        }
        "github" | "github-app" => {
            if let Some(v) = creds
                .get("access_token")
                .or(creds.get("api_key"))
                .or(creds.get("token"))
            {
                mapped.insert("GITHUB_TOKEN".into(), v.clone());
            }
            "github"
        }
        "trello" => {
            if let Some(v) = creds.get("api_key") {
                mapped.insert("TRELLO_API_KEY".into(), v.clone());
            }
            if let Some(v) = creds.get("api_token").or(creds.get("token")) {
                mapped.insert("TRELLO_TOKEN".into(), v.clone());
            }
            "trello"
        }
        "telegram" => {
            if let Some(v) = creds.get("bot_token").or(creds.get("api_key")) {
                mapped.insert("TELEGRAM_BOT_TOKEN".into(), v.clone());
            }
            "telegram"
        }
        // ── Services with per-service skill vaults ──────────────────────
        "notion" => {
            if let Some(v) = creds.get("api_key").or(creds.get("access_token")) {
                mapped.insert("NOTION_API_KEY".into(), v.clone());
            }
            "notion"
        }
        "linear" => {
            if let Some(v) = creds.get("api_key") {
                mapped.insert("API_KEY".into(), v.clone());
            }
            mapped.insert("API_BASE_URL".into(), "https://api.linear.app".into());
            mapped.insert("API_AUTH_HEADER".into(), "Authorization".into());
            mapped.insert("API_AUTH_PREFIX".into(), "Bearer".into());
            mapped.insert("SERVICE_NAME".into(), "Linear".into());
            mapped.insert(
                "SERVICE_HINT".into(),
                "GraphQL API for issue tracking. POST /graphql with query body.".into(),
            );
            "linear"
        }
        "stripe" => {
            if let Some(v) = creds.get("secret_key").or(creds.get("api_key")) {
                mapped.insert("API_KEY".into(), v.clone());
            }
            mapped.insert("API_BASE_URL".into(), "https://api.stripe.com/v1".into());
            mapped.insert("API_AUTH_HEADER".into(), "Authorization".into());
            mapped.insert("API_AUTH_PREFIX".into(), "Bearer".into());
            mapped.insert("SERVICE_NAME".into(), "Stripe".into());
            mapped.insert(
                "SERVICE_HINT".into(),
                "Payments API. Use form-encoded bodies for POST/PUT.".into(),
            );
            "stripe"
        }
        "todoist" => {
            if let Some(v) = creds.get("api_token").or(creds.get("api_key")) {
                mapped.insert("API_KEY".into(), v.clone());
            }
            mapped.insert(
                "API_BASE_URL".into(),
                "https://api.todoist.com/rest/v2".into(),
            );
            mapped.insert("API_AUTH_HEADER".into(), "Authorization".into());
            mapped.insert("API_AUTH_PREFIX".into(), "Bearer".into());
            mapped.insert("SERVICE_NAME".into(), "Todoist".into());
            mapped.insert(
                "SERVICE_HINT".into(),
                "Task management. GET/POST /tasks, /projects, /sections, /labels.".into(),
            );
            "todoist"
        }
        "clickup" => {
            if let Some(v) = creds.get("api_key") {
                mapped.insert("API_KEY".into(), v.clone());
            }
            mapped.insert(
                "API_BASE_URL".into(),
                "https://api.clickup.com/api/v2".into(),
            );
            mapped.insert("API_AUTH_HEADER".into(), "Authorization".into());
            mapped.insert("API_AUTH_PREFIX".into(), "Bearer".into());
            mapped.insert("SERVICE_NAME".into(), "ClickUp".into());
            mapped.insert(
                "SERVICE_HINT".into(),
                "Project management. GET /team, /space, /task.".into(),
            );
            "clickup"
        }
        "airtable" => {
            if let Some(v) = creds.get("api_key") {
                mapped.insert("API_KEY".into(), v.clone());
            }
            mapped.insert("API_BASE_URL".into(), "https://api.airtable.com/v0".into());
            mapped.insert("API_AUTH_HEADER".into(), "Authorization".into());
            mapped.insert("API_AUTH_PREFIX".into(), "Bearer".into());
            mapped.insert("SERVICE_NAME".into(), "Airtable".into());
            mapped.insert(
                "SERVICE_HINT".into(),
                "Spreadsheet-database. GET/POST /{baseId}/{tableName}.".into(),
            );
            "airtable"
        }
        "sendgrid" => {
            if let Some(v) = creds.get("api_key") {
                mapped.insert("API_KEY".into(), v.clone());
            }
            mapped.insert("API_BASE_URL".into(), "https://api.sendgrid.com/v3".into());
            mapped.insert("API_AUTH_HEADER".into(), "Authorization".into());
            mapped.insert("API_AUTH_PREFIX".into(), "Bearer".into());
            mapped.insert("SERVICE_NAME".into(), "SendGrid".into());
            mapped.insert(
                "SERVICE_HINT".into(),
                "Email API. POST /mail/send with JSON body.".into(),
            );
            "sendgrid"
        }
        "jira" => {
            let domain = creds.get("domain").cloned().unwrap_or_default();
            let email = creds.get("email").cloned().unwrap_or_default();
            let token = creds.get("api_token").cloned().unwrap_or_default();
            if !domain.is_empty() {
                let base = if domain.starts_with("http") {
                    format!("{}/rest/api/3", domain.trim_end_matches('/'))
                } else {
                    format!("https://{}/rest/api/3", domain.trim_end_matches('/'))
                };
                mapped.insert("API_BASE_URL".into(), base);
            }
            if !email.is_empty() && !token.is_empty() {
                use base64::Engine;
                let encoded = base64::engine::general_purpose::STANDARD
                    .encode(format!("{}:{}", email, token));
                mapped.insert("API_KEY".into(), encoded);
                mapped.insert("API_AUTH_HEADER".into(), "Authorization".into());
                mapped.insert("API_AUTH_PREFIX".into(), "Basic".into());
            }
            mapped.insert("SERVICE_NAME".into(), "Jira".into());
            mapped.insert(
                "SERVICE_HINT".into(),
                "Issue tracking. GET/POST /issue, /search, /project.".into(),
            );
            "jira"
        }
        "zendesk" => {
            let subdomain = creds.get("subdomain").cloned().unwrap_or_default();
            let email = creds.get("email").cloned().unwrap_or_default();
            let token = creds.get("api_token").cloned().unwrap_or_default();
            if !subdomain.is_empty() {
                mapped.insert(
                    "API_BASE_URL".into(),
                    format!("https://{}.zendesk.com/api/v2", subdomain),
                );
            }
            if !email.is_empty() && !token.is_empty() {
                use base64::Engine;
                let encoded = base64::engine::general_purpose::STANDARD
                    .encode(format!("{}/token:{}", email, token));
                mapped.insert("API_KEY".into(), encoded);
                mapped.insert("API_AUTH_HEADER".into(), "Authorization".into());
                mapped.insert("API_AUTH_PREFIX".into(), "Basic".into());
            }
            mapped.insert("SERVICE_NAME".into(), "Zendesk".into());
            mapped.insert(
                "SERVICE_HINT".into(),
                "Support tickets. GET/POST /tickets, /users, /organizations.".into(),
            );
            "zendesk"
        }
        "hubspot" => {
            if let Some(v) = creds.get("access_token").or(creds.get("api_key")) {
                mapped.insert("API_KEY".into(), v.clone());
            }
            mapped.insert("API_BASE_URL".into(), "https://api.hubapi.com".into());
            mapped.insert("API_AUTH_HEADER".into(), "Authorization".into());
            mapped.insert("API_AUTH_PREFIX".into(), "Bearer".into());
            mapped.insert("SERVICE_NAME".into(), "HubSpot".into());
            mapped.insert(
                "SERVICE_HINT".into(),
                "CRM. GET/POST /crm/v3/objects/contacts, /deals, /companies.".into(),
            );
            "hubspot"
        }
        "twilio" => {
            let sid = creds.get("account_sid").cloned().unwrap_or_default();
            let token = creds.get("auth_token").cloned().unwrap_or_default();
            if !sid.is_empty() {
                mapped.insert(
                    "API_BASE_URL".into(),
                    format!("https://api.twilio.com/2010-04-01/Accounts/{}", sid),
                );
            }
            if !sid.is_empty() && !token.is_empty() {
                use base64::Engine;
                let encoded =
                    base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", sid, token));
                mapped.insert("API_KEY".into(), encoded);
                mapped.insert("API_AUTH_HEADER".into(), "Authorization".into());
                mapped.insert("API_AUTH_PREFIX".into(), "Basic".into());
            }
            mapped.insert("SERVICE_NAME".into(), "Twilio".into());
            mapped.insert(
                "SERVICE_HINT".into(),
                "Messaging API. POST /Messages.json to send SMS.".into(),
            );
            "twilio"
        }
        "microsoft-teams" | "microsoft" | "microsoft-365" | "outlook" | "onedrive" => {
            for (k, v) in creds {
                mapped.insert(k.to_uppercase(), v.clone());
            }
            mapped.insert("SERVICE_NAME".into(), "Microsoft 365".into());
            mapped.insert(
                "SERVICE_HINT".into(),
                "Outlook, Calendar, OneDrive, Teams, Tasks, OneNote via Microsoft Graph API."
                    .into(),
            );
            "microsoft_365"
        }
        "google" | "google-workspace" | "gmail" | "google-drive" | "google-calendar"
        | "google-sheets" | "google-docs" => {
            mapped.insert("GOOGLE_OAUTH_CONNECTED".into(), "true".into());
            "google_workspace"
        }
        "shopify" => {
            if let Some(v) = creds.get("access_token").or(creds.get("api_key")) {
                mapped.insert("API_KEY".into(), v.clone());
            }
            if let Some(v) = creds.get("shop_domain") {
                mapped.insert(
                    "API_BASE_URL".into(),
                    format!("https://{}/admin/api/2024-01", v),
                );
            }
            mapped.insert("API_AUTH_HEADER".into(), "X-Shopify-Access-Token".into());
            mapped.insert("API_AUTH_PREFIX".into(), "".into());
            mapped.insert("SERVICE_NAME".into(), "Shopify".into());
            mapped.insert(
                "SERVICE_HINT".into(),
                "E-commerce admin API. GET/POST /products, /orders, /customers.".into(),
            );
            "shopify"
        }
        "pagerduty" => {
            if let Some(v) = creds.get("api_key").or(creds.get("access_token")) {
                mapped.insert("API_KEY".into(), v.clone());
            }
            mapped.insert("API_BASE_URL".into(), "https://api.pagerduty.com".into());
            mapped.insert("API_AUTH_HEADER".into(), "Authorization".into());
            mapped.insert("API_AUTH_PREFIX".into(), "Token token=".into());
            mapped.insert("SERVICE_NAME".into(), "PagerDuty".into());
            mapped.insert(
                "SERVICE_HINT".into(),
                "Incident management. GET/POST /incidents, /services, /users.".into(),
            );
            "pagerduty"
        }
        // ── Fallback: store raw creds under service_id as a REST API skill ──
        other => {
            for (k, v) in creds {
                mapped.insert(k.to_uppercase(), v.clone());
            }
            other
        }
    };

    (skill_id.to_string(), mapped)
}
