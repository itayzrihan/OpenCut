//! Source changes are prepared without execution, then committed with an exact
//! runtime observation. Shared occurrences detach through the same canonical
//! transaction used by render variables.
use crate::{ClassicProject, HyperframesRuntimeManifest, HyperframesSource, ModelError};
use std::collections::BTreeMap;

impl HyperframesSource {
    pub fn with_file_changes(
        &self,
        changes: BTreeMap<String, Option<String>>,
    ) -> Result<Self, ModelError> {
        self.validate()?;
        if changes.is_empty() || changes.len() > crate::hyperframes::MAX_FILES {
            return Err(ModelError::Invalid(
                "HyperFrames source edits require between one and 512 file changes".into(),
            ));
        }
        let mut source = self.clone();
        for (path, content) in changes {
            match content {
                Some(content) => {
                    source.files.insert(path, content);
                }
                None => {
                    if source.files.remove(&path).is_none() {
                        return Err(ModelError::Invalid(format!(
                            "HyperFrames source file does not exist: {path}"
                        )));
                    }
                }
            }
        }
        crate::inspect_hyperframes(&source)?;
        Ok(source)
    }
}

impl ClassicProject {
    pub fn set_hyperframes_source(
        &mut self,
        scene_id: &str,
        element_id: &str,
        source_fingerprint: &str,
        changes: BTreeMap<String, Option<String>>,
        manifest: HyperframesRuntimeManifest,
    ) -> Result<(), ModelError> {
        let (_, composition, _) = self.hyperframes_clip_composition(scene_id, element_id)?;
        if composition.source.fingerprint() != source_fingerprint {
            return Err(ModelError::Invalid(
                "HyperFrames source changed while editing; reopen the source editor".into(),
            ));
        }
        let source = composition.source.with_file_changes(changes)?;
        self.replace_hyperframes_clip_source(scene_id, element_id, source, manifest)
    }
}
