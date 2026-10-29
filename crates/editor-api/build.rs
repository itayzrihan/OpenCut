//! Embed only the pinned Earshot allowlist; runtime lookup never touches disk.
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    env, fs,
    path::{Component, Path, PathBuf},
};

fn verified(path: &Path, expected: &str) -> Vec<u8> {
    println!("cargo:rerun-if-changed={}", path.display());
    let bytes = fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        expected,
        "Earshot pinned file changed: {}",
        path.display()
    );
    bytes
}

fn main() {
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let vendor = root.join("classic/vendor/earshot");
    let manifest = verified(
        &vendor.join("manifest.json"),
        "1891eb0abbb4ac344f658af77ff6d557407e235200c42af9c43405f71b1449a2",
    );
    let files: Vec<serde_json::Value> = serde_json::from_slice(&manifest).unwrap();
    assert_eq!(files.len(), 282);
    let mut paths = BTreeSet::new();
    let mut source = String::from("static REPOSITORY_FILES: &[RepositoryFile] = &[\n");
    for file in files {
        let path = file["path"].as_str().unwrap();
        assert!(
            !path.is_empty()
                && !path.contains('\\')
                && Path::new(path)
                    .components()
                    .all(|part| matches!(part, Component::Normal(_)))
        );
        assert!(
            paths.insert(path.to_owned()),
            "Duplicate Earshot manifest path"
        );
        let full_path = vendor.join("upstream").join(path);
        assert!(
            fs::symlink_metadata(&full_path)
                .unwrap()
                .file_type()
                .is_file(),
            "Earshot source must be a regular file"
        );
        let hash = file["sha256"].as_str().unwrap();
        let bytes = verified(&full_path, hash);
        assert_eq!(bytes.len() as u64, file["size"].as_u64().unwrap());
        let text = std::str::from_utf8(&bytes)
            .ok()
            .filter(|s| !s.contains('\0'));
        source.push_str(&format!("RepositoryFile {{ path: {path:?}, sha256: {hash:?}, text: {}, bytes: include_bytes!({:?}) }},\n", text.is_some(), full_path));
    }
    source.push_str("];\n");
    verified(
        &root.join("classic/apps/web/src/earshot/catalog-data.json"),
        "54eacee497879889a5761320428f0e9b0534213a08fb76ad14844fd9f7145984",
    );
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("earshot_repository.rs"),
        source,
    )
    .unwrap();
}
