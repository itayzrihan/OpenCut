//! Read-only development probe: cargo run -p opencut-editor-api --example
//! inspect_hyperframes -- <project-directory>. Does not execute source scripts.

use std::{collections::BTreeMap, path::Path};

use opencut_editor_api::{HyperframesSource, inspect_hyperframes};

fn read_sources(
    root: &Path,
    directory: &Path,
    files: &mut BTreeMap<String, String>,
    bytes: &mut u64,
) -> Result<(), Box<dyn std::error::Error>> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.')
            || matches!(
                name.as_ref(),
                "node_modules" | "output" | "renders" | "snapshots" | "dist"
            )
        {
            continue;
        }
        let kind = entry.file_type()?;
        // Follow no symlinks/reparse points outside the explicitly selected root.
        if kind.is_symlink() || !path.canonicalize()?.starts_with(root) {
            continue;
        }
        if kind.is_dir() {
            read_sources(root, &path, files, bytes)?;
        } else if kind.is_file()
            && (matches!(
                path.extension().and_then(|s| s.to_str()),
                Some("html" | "css" | "js" | "mjs" | "svg" | "json")
            ) || path == root.join("hyperframes.json"))
        {
            *bytes += entry.metadata()?.len();
            if *bytes > 16 * 1024 * 1024 || files.len() >= 512 {
                return Err("source package exceeds inspection limits".into());
            }
            let key = path
                .strip_prefix(root)?
                .to_string_lossy()
                .replace('\\', "/");
            files.insert(key, std::fs::read_to_string(path)?);
        }
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = std::env::args()
        .nth(1)
        .ok_or("usage: inspect_hyperframes <project-directory>")?;
    let root = std::fs::canonicalize(directory)?;
    let mut files = BTreeMap::new();
    read_sources(&root, &root, &mut files, &mut 0)?;
    let source = HyperframesSource {
        entry_file: "index.html".into(),
        files,
        resource_asset_ids: BTreeMap::new(),
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&inspect_hyperframes(&source)?)?
    );
    Ok(())
}
