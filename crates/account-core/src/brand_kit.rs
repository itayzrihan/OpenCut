//! Account-owned, portable branding. Binary files remain in the host asset library.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrandLogo {
    pub asset_id: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrandKit {
    pub id: String,
    pub name: String,
    pub primary_color: String,
    pub secondary_color: String,
    pub background_color: String,
    #[serde(default)]
    pub style: String,
    #[serde(default)]
    pub phrases: Vec<String>,
    pub heading_font: String,
    pub body_font: String,
    pub logo: Option<BrandLogo>,
    #[serde(default)]
    pub music_ids: Vec<String>,
    #[serde(default)]
    pub sfx_ids: Vec<String>,
}
impl BrandKit {
    pub fn validate(&self) -> Result<(), String> {
        super::validate_id(&self.id)?;
        super::validate_name(&self.name)?;
        super::validate_name(&self.heading_font)?;
        super::validate_name(&self.body_font)?;
        for color in [
            &self.primary_color,
            &self.secondary_color,
            &self.background_color,
        ] {
            if color.len() != 7
                || !color.starts_with('#')
                || !color[1..].bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err("Brand colors must be six-digit hexadecimal colors".into());
            }
        }
        if self.style.len() > 8000
            || self.phrases.len() > 32
            || self
                .phrases
                .iter()
                .any(|s| s.trim().is_empty() || s.len() > 1000)
        {
            return Err(
                "Brand style is limited to 8000 bytes and 32 phrases of 1000 bytes each".into(),
            );
        }
        for ids in [&self.music_ids, &self.sfx_ids] {
            if ids.len() > 128 {
                return Err("Choose at most 128 sounds per kind".into());
            }
            let mut unique = std::collections::BTreeSet::new();
            for id in ids {
                super::validate_id(id)?;
                if !unique.insert(id) {
                    return Err("Duplicate brand sound".into());
                }
            }
        }
        if let Some(logo) = &self.logo {
            super::validate_id(&logo.asset_id)?;
            if logo.width == 0 || logo.height == 0 || logo.width > 32768 || logo.height > 32768 {
                return Err("Invalid logo dimensions".into());
            }
        }
        Ok(())
    }
}
