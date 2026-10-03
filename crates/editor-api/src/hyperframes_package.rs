//! Platform-neutral folder ingestion. Hosts supply paths/sizes, then read only
//! the returned files; this module never reads a filesystem or runs source.

use std::collections::BTreeSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    ModelError,
    hyperframes::{MAX_FILES, MAX_SOURCE_BYTES, validate_package_path},
};

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HyperframesPackageFile {
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum HyperframesPackageFileKind {
    Source,
    Resource,
}

#[derive(Debug, Clone, Copy, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum HyperframesResourceType {
    Image,
    Audio,
    Video,
    File,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HyperframesPlannedFile {
    pub path: String,
    pub size: u64,
    pub kind: HyperframesPackageFileKind,
    pub mime_type: String,
    pub media_type: HyperframesResourceType,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HyperframesPackagePlan {
    /// None means the host must ask the user to select one of entryCandidates.
    pub entry_file: Option<String>,
    pub entry_candidates: Vec<String>,
    pub files: Vec<HyperframesPlannedFile>,
    pub ignored_paths: Vec<String>,
    pub source_bytes: u64,
    pub resource_bytes: u64,
}

pub fn plan_hyperframes_package(
    files: Vec<HyperframesPackageFile>,
    entry_file: Option<String>,
) -> Result<HyperframesPackagePlan, ModelError> {
    if files.len() > 100_000 {
        return Err(ModelError::Invalid(
            "Select the HyperFrames composition folder; the selection exceeds 100,000 files".into(),
        ));
    }
    let mut plan = HyperframesPackagePlan {
        entry_file: None,
        entry_candidates: vec![],
        files: vec![],
        ignored_paths: vec![],
        source_bytes: 0,
        resource_bytes: 0,
    };
    let mut paths = BTreeSet::new();
    for file in files {
        validate_package_path(&file.path)?;
        // These are installation/version-control internals, never authored
        // composition assets. Other directories are retained, including output.
        if file
            .path
            .split('/')
            .any(|p| p.eq_ignore_ascii_case("node_modules") || p.eq_ignore_ascii_case(".git"))
        {
            plan.ignored_paths.push(file.path);
            continue;
        }
        if !paths.insert(file.path.clone()) {
            return Err(ModelError::Invalid(format!(
                "Duplicate HyperFrames file: {}",
                file.path
            )));
        }
        if paths.len() > MAX_FILES {
            return Err(ModelError::Invalid(
                "HyperFrames package exceeds 512 files; select its composition folder".into(),
            ));
        }
        let extension = file
            .path
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        let is_source = matches!(
            extension.as_str(),
            "html"
                | "htm"
                | "css"
                | "js"
                | "mjs"
                | "cjs"
                | "json"
                | "svg"
                | "txt"
                | "wgsl"
                | "glsl"
                | "frag"
                | "vert"
                | "cube"
                | "csv"
                | "vtt"
                | "srt"
                | "xml"
                | "map"
        );
        if matches!(extension.as_str(), "html" | "htm") {
            plan.entry_candidates.push(file.path.clone());
        }
        let bytes = if is_source {
            &mut plan.source_bytes
        } else {
            &mut plan.resource_bytes
        };
        *bytes = bytes
            .checked_add(file.size)
            .ok_or_else(|| ModelError::Invalid("HyperFrames package size overflow".into()))?;
        if plan.source_bytes > MAX_SOURCE_BYTES as u64 {
            return Err(ModelError::Invalid(
                "HyperFrames source exceeds 16 MiB".into(),
            ));
        }
        let (mime, media_type) = resource_type(&extension);
        plan.files.push(HyperframesPlannedFile {
            path: file.path,
            size: file.size,
            kind: if is_source {
                HyperframesPackageFileKind::Source
            } else {
                HyperframesPackageFileKind::Resource
            },
            mime_type: mime.into(),
            media_type,
        });
    }
    plan.entry_candidates.sort();
    plan.ignored_paths.sort();
    plan.files.sort_by(|a, b| a.path.cmp(&b.path));
    if plan.entry_candidates.is_empty() {
        return Err(ModelError::Invalid(
            "The selected folder contains no HTML entry file".into(),
        ));
    }
    plan.entry_file = match entry_file {
        Some(entry) if plan.entry_candidates.contains(&entry) => Some(entry),
        Some(_) => {
            return Err(ModelError::Invalid(
                "The selected HyperFrames entry file is missing or is not HTML".into(),
            ));
        }
        None if plan.entry_candidates.iter().any(|p| p == "index.html") => {
            Some("index.html".into())
        }
        None if plan.entry_candidates.len() == 1 => plan.entry_candidates.first().cloned(),
        None => None,
    };
    Ok(plan)
}

fn resource_type(extension: &str) -> (&'static str, HyperframesResourceType) {
    use HyperframesResourceType::*;
    match extension {
        "mp4" | "m4v" => ("video/mp4", Video),
        "mov" => ("video/quicktime", Video),
        "webm" => ("video/webm", Video),
        "mkv" => ("video/x-matroska", Video),
        "avi" => ("video/x-msvideo", Video),
        "mp3" => ("audio/mpeg", Audio),
        "wav" => ("audio/wav", Audio),
        "m4a" => ("audio/mp4", Audio),
        "aac" => ("audio/aac", Audio),
        "flac" => ("audio/flac", Audio),
        "ogg" | "oga" => ("audio/ogg", Audio),
        "opus" => ("audio/opus", Audio),
        "png" => ("image/png", Image),
        "jpg" | "jpeg" => ("image/jpeg", Image),
        "webp" => ("image/webp", Image),
        "gif" => ("image/gif", Image),
        "avif" => ("image/avif", Image),
        "bmp" => ("image/bmp", Image),
        "svg" => ("image/svg+xml", Image),
        "woff" => ("font/woff", File),
        "woff2" => ("font/woff2", File),
        "ttf" => ("font/ttf", File),
        "otf" => ("font/otf", File),
        "wasm" => ("application/wasm", File),
        _ => ("application/octet-stream", File),
    }
}
