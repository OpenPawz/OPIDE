// Pawz Agent Engine — Skill Vault
// SessionStore impl blocks for credential CRUD, enabled state, custom instructions,
// onboarding, and bulk operations.

use crate::atoms::error::EngineResult;
use crate::engine::sessions::SessionStore;
use rusqlite::params;

impl SessionStore {
    /// Ensure skill vault tables exist (idempotent).
    /// Called during init; schema.rs also creates them, but this is a safety net.
    pub fn init_skill_tables(&self) -> EngineResult<()> {
        let conn = self.conn.lock();
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS skill_credentials (
                skill_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (skill_id, key)
            );
            CREATE TABLE IF NOT EXISTS skill_enabled (
                skill_id TEXT PRIMARY KEY,
                enabled INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS skill_custom_instructions (
                skill_id TEXT PRIMARY KEY,
                instructions TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            ",
        )?;
        Ok(())
    }

    // ── Enabled state ───────────────────────────────────────────────

    /// Get explicit enabled state for a skill (None = not set, use default).
    pub fn get_skill_enabled_state(&self, skill_id: &str) -> EngineResult<Option<bool>> {
        let conn = self.conn.lock();
        let result = conn.query_row(
            "SELECT enabled FROM skill_enabled WHERE skill_id = ?1",
            params![skill_id],
            |row| row.get::<_, i32>(0),
        );
        match result {
            Ok(v) => Ok(Some(v != 0)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Check if a skill is enabled (returns false if not explicitly set).
    pub fn is_skill_enabled(&self, skill_id: &str) -> EngineResult<bool> {
        Ok(self.get_skill_enabled_state(skill_id)?.unwrap_or(false))
    }

    /// Set skill enabled/disabled.
    pub fn set_skill_enabled(&self, skill_id: &str, enabled: bool) -> EngineResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO skill_enabled (skill_id, enabled, updated_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(skill_id) DO UPDATE SET enabled = ?2, updated_at = datetime('now')",
            params![skill_id, enabled as i32],
        )?;
        Ok(())
    }

    /// Bulk enable/disable a list of skill IDs.
    pub fn bulk_set_skills_enabled(&self, skill_ids: &[String], enabled: bool) -> EngineResult<()> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "INSERT INTO skill_enabled (skill_id, enabled, updated_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(skill_id) DO UPDATE SET enabled = ?2, updated_at = datetime('now')",
        )?;
        for id in skill_ids {
            stmt.execute(params![id, enabled as i32])?;
        }
        Ok(())
    }

    // ── Credentials ─────────────────────────────────────────────────

    /// Set (upsert) an encrypted credential value.
    pub fn set_skill_credential(
        &self,
        skill_id: &str,
        key: &str,
        encrypted_value: &str,
    ) -> EngineResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO skill_credentials (skill_id, key, value, updated_at)
             VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT(skill_id, key) DO UPDATE SET value = ?3, updated_at = datetime('now')",
            params![skill_id, key, encrypted_value],
        )?;
        Ok(())
    }

    /// Get a single encrypted credential value.
    pub fn get_skill_credential(
        &self,
        skill_id: &str,
        key: &str,
    ) -> EngineResult<Option<String>> {
        let conn = self.conn.lock();
        let result = conn.query_row(
            "SELECT value FROM skill_credentials WHERE skill_id = ?1 AND key = ?2",
            params![skill_id, key],
            |row| row.get(0),
        );
        match result {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// List all credential keys for a skill (not the values).
    pub fn list_skill_credential_keys(&self, skill_id: &str) -> EngineResult<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT key FROM skill_credentials WHERE skill_id = ?1 ORDER BY key",
        )?;
        let keys = stmt
            .query_map(params![skill_id], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(keys)
    }

    /// Delete a single credential.
    pub fn delete_skill_credential(&self, skill_id: &str, key: &str) -> EngineResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM skill_credentials WHERE skill_id = ?1 AND key = ?2",
            params![skill_id, key],
        )?;
        Ok(())
    }

    /// Delete all credentials for a skill.
    pub fn delete_all_skill_credentials(&self, skill_id: &str) -> EngineResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM skill_credentials WHERE skill_id = ?1",
            params![skill_id],
        )?;
        Ok(())
    }

    // ── Custom instructions ─────────────────────────────────────────

    /// Get custom instructions for a skill.
    pub fn get_skill_custom_instructions(&self, skill_id: &str) -> EngineResult<Option<String>> {
        let conn = self.conn.lock();
        let result = conn.query_row(
            "SELECT instructions FROM skill_custom_instructions WHERE skill_id = ?1",
            params![skill_id],
            |row| row.get(0),
        );
        match result {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Set custom instructions for a skill (upsert).
    pub fn set_skill_custom_instructions(
        &self,
        skill_id: &str,
        instructions: &str,
    ) -> EngineResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO skill_custom_instructions (skill_id, instructions, updated_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(skill_id) DO UPDATE SET instructions = ?2, updated_at = datetime('now')",
            params![skill_id, instructions],
        )?;
        Ok(())
    }

    // ── Onboarding ──────────────────────────────────────────────────

    /// Check if initial onboarding is complete.
    pub fn is_onboarding_complete(&self) -> EngineResult<bool> {
        let conn = self.conn.lock();
        let result = conn.query_row(
            "SELECT value FROM engine_config WHERE key = 'onboarding_complete'",
            [],
            |row| row.get::<_, String>(0),
        );
        match result {
            Ok(v) => Ok(v == "1" || v == "true"),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    /// Mark onboarding as complete.
    pub fn set_onboarding_complete(&self) -> EngineResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO engine_config (key, value) VALUES ('onboarding_complete', '1')",
            [],
        )?;
        Ok(())
    }
}
