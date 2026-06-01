use super::SessionStore;
use crate::atoms::error::EngineResult;
use rusqlite::params;

impl SessionStore {
    // ── Config storage ─────────────────────────────────────────────────

    pub fn get_config(&self, key: &str) -> EngineResult<Option<String>> {
        let conn = self.conn.lock();
        let result = conn.query_row(
            "SELECT value FROM engine_config WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        );
        let value = match result {
            Ok(value) => value,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        // The engine config holds provider API keys and is encrypted at rest.
        // decrypt_config_value transparently passes through legacy plaintext.
        if key == "engine_config" {
            Ok(Some(crate::engine::vault::decrypt_config_value(&value)?))
        } else {
            Ok(Some(value))
        }
    }

    pub fn set_config(&self, key: &str, value: &str) -> EngineResult<()> {
        // Encrypt the engine config at rest — it contains provider API keys.
        // Other config keys (memory_config, etc.) are stored as-is; note the
        // `migration_dedup_done` flag is read via raw SQL elsewhere, so we must
        // NOT blanket-encrypt every key.
        let encrypted_owned;
        let value = if key == "engine_config" {
            encrypted_owned = crate::engine::vault::encrypt_config_value(value);
            encrypted_owned.as_str()
        } else {
            value
        };
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO engine_config (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }
}
