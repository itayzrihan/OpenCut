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
#[serde(rename_all = "camelCase")]
pub enum BrandImageKind {
    Character,
    Image,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrandImage {
    pub asset_id: String,
    pub name: String,
    pub kind: BrandImageKind,
    #[serde(default)]
    pub tags: Vec<String>,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<BrandImage>,
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
        if self.images.len() > 64 {
            return Err("A Brand Kit can contain up to 64 images".into());
        }
        let mut image_ids = std::collections::BTreeSet::new();
        for image in &self.images {
            super::validate_id(&image.asset_id)?;
            super::validate_name(&image.name)?;
            if !image_ids.insert(&image.asset_id) {
                return Err("Duplicate Brand Kit image".into());
            }
            if image.tags.len() > 12 {
                return Err("An image can have up to 12 tags".into());
            }
            let mut tags = std::collections::BTreeSet::new();
            for tag in &image.tags {
                let trimmed = tag.trim();
                if trimmed.is_empty() || tag.len() > 96 || tag.chars().any(char::is_control) {
                    return Err("Image tags must be non-empty and at most 96 bytes".into());
                }
                if !tags.insert(trimmed.to_lowercase()) {
                    return Err("Duplicate image tag".into());
                }
            }
        }
        Ok(())
    }
}
