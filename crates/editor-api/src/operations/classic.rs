use super::*;
use crate::ClassicProject;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClassicInput {
    project_id: String,
    expected_revision: u64,
    classic: ClassicProject,
}

pub(super) fn register_classic_operations(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    for (id, title, attach) in [
        (
            "project.classic.attach",
            "Attach existing Classic project",
            true,
        ),
        (
            "project.classic.commit",
            "Commit Classic project edit",
            false,
        ),
    ] {
        let state = state.clone();
        let events = events.clone();
        register::<ClassicInput, MutationOutput, _, _>(
            registry,
            id,
            title,
            "Validates and commits the complete serialized Classic project and durable media bindings without translating or dropping feature fields. The existing scenes remain the only timeline. Requires explicit project identity and revision; supports undo, dry run and registry retry keys.",
            "project",
            AccessLevel::Write,
            false,
            false,
            &["classic", "project", "bridge", "timeline"],
            move |mut context, input| {
                let state = state.clone();
                let events = events.clone();
                async move {
                    if attach {
                        if requested_project_id(&context).is_some_and(|id| id != input.project_id) {
                            return Err(CapabilityError::Conflict(
                                "Classic target project mismatch".into(),
                            ));
                        }
                        // An attach names the incoming project. It need not be
                        // active yet; identity is checked inside the mutation.
                        context.metadata.remove("opencut/projectId");
                    }
                    let mutation = mutate(
                        &state,
                        &events,
                        &context,
                        title,
                        Some(input.expected_revision),
                        |document| {
                            input
                                .classic
                                .validate()
                                .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                            if input
                                .classic
                                .id()
                                .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?
                                != input.project_id
                            {
                                return Err(CapabilityError::Conflict(
                                    "Classic snapshot belongs to another project".into(),
                                ));
                            }
                            if let Some(project) = &document.project {
                                if project.id != input.project_id || project.classic.is_none() {
                                    return Err(CapabilityError::Conflict(
                                        "Classic target project is not active".into(),
                                    ));
                                }
                            } else if !attach {
                                return Err(CapabilityError::Unavailable(
                                    "attach the existing Classic project before committing an edit"
                                        .into(),
                                ));
                            }
                            let name = input
                                .classic
                                .name()
                                .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?
                                .to_owned();
                            let settings = input
                                .classic
                                .settings()
                                .map_err(|e| CapabilityError::InvalidInput(e.to_string()))?;
                            if let Some(project) = document.project.as_mut() {
                                project.name = name;
                                project.settings = settings;
                                project.classic = Some(input.classic);
                            } else {
                                document.project = Some(Project {
                                    id: input.project_id.clone(),
                                    name,
                                    settings,
                                    file_path: None,
                                    assets: Vec::new(),
                                    timeline: Timeline::default(),
                                    classic: Some(input.classic),
                                    metadata: Default::default(),
                                    export_presets: Vec::new(),
                                    extensions: Map::new(),
                                });
                            }
                            Ok(vec![input.project_id])
                        },
                    )?;
                    Ok(OperationSuccess::new(mutation).summary(title).changed([
                        STATE_RESOURCE,
                        PROJECT_RESOURCE,
                        TIMELINE_RESOURCE,
                    ]))
                }
            },
        )?;
    }
    Ok(())
}
