use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    ai::AISettings,
    model::{Result, now},
    store::Store,
    web_search,
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    General,
    Recruiting,
    Knowledge,
    Web,
}

impl Capability {
    fn key(self) -> &'static str {
        match self {
            Self::General => "general",
            Self::Recruiting => "recruiting",
            Self::Knowledge => "knowledge",
            Self::Web => "web",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub capability: Capability,
    pub description: String,
    #[serde(skip_serializing)]
    provider: String,
    #[serde(skip_serializing)]
    scope_key: String,
}

impl Grant {
    pub fn new(
        capability: Capability,
        description: String,
        provider: &str,
        scope_key: &str,
    ) -> Self {
        Self {
            capability,
            description,
            provider: provider.to_owned(),
            scope_key: scope_key.to_owned(),
        }
    }
}

pub fn fingerprint(value: &impl Serialize) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(value)?)))
}

pub struct ConsentManager<'a>(&'a Connection);

impl<'a> ConsentManager<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self(db)
    }

    pub fn needs_confirmation(&self, grants: &[Grant]) -> Result<bool> {
        let mut lookup = self.0.prepare(
            "SELECT 1 FROM ai_consents WHERE provider=?1 AND capability=?2 AND scope_key=?3",
        )?;
        for grant in grants {
            let allowed = lookup
                .query_row(
                    params![grant.provider, grant.capability.key(), grant.scope_key],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?;
            if allowed.is_none() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn remember(&self, grants: &[Grant]) -> Result<()> {
        let mut insert = self.0.prepare(
            "INSERT INTO ai_consents(provider,capability,scope_key,description,granted_at) VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(provider,capability,scope_key) DO UPDATE SET granted_at=excluded.granted_at,description=excluded.description",
        )?;
        for grant in grants {
            insert.execute(params![
                grant.provider,
                grant.capability.key(),
                grant.scope_key,
                grant.description,
                now()
            ])?;
        }
        Ok(())
    }

    pub fn reset(&self, capability: Option<Capability>) -> Result<()> {
        self.0.execute(
            "DELETE FROM ai_consents WHERE ?1 IS NULL OR capability=?1",
            [capability.map(Capability::key)],
        )?;
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Remembered {
    provider: String,
    capability: String,
    scope_key: String,
    description: String,
    granted_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    model_provider: Option<String>,
    search_provider: Option<String>,
    remembered: Vec<Remembered>,
}

pub fn preferences(store: &Store) -> Result<Preferences> {
    let settings: AISettings = store.get_setting("ai")?;
    let mut list = store.db.prepare(
        "SELECT provider,capability,scope_key,description,granted_at FROM ai_consents ORDER BY granted_at DESC,capability,scope_key",
    )?;
    let remembered = list
        .query_map([], |r| {
            Ok(Remembered {
                provider: r.get(0)?,
                capability: r.get(1)?,
                scope_key: r.get(2)?,
                description: r.get(3)?,
                granted_at: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Preferences {
        model_provider: settings.endpoint().ok().map(|url| url.into()),
        search_provider: web_search::settings(store)?.endpoint,
        remembered,
    })
}
