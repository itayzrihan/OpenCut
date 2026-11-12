use super::*;
use crate::{
    generative::chapters::{Chapter, Plan, SourceRow, SourceSlot},
    production::{KEY as PRODUCTION_KEY, ProductionWorkspace},
};
use serde_json::json;
use sha2::{Digest, Sha256};
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Build {
    project_id: String,
    expected_revision: u64,
    id: String,
    title: String,
    model: String,
    resolution: String,
    aspect_ratio: String,
    supported_durations: Vec<u32>,
    #[serde(default)]
    row_ids: Vec<String>,
    #[serde(default)]
    script_ids: Vec<String>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    project_id: String,
    expected_revision: u64,
    plan_id: String,
    #[serde(default)]
    start_time: i64,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Planned {
    #[serde(flatten)]
    mutation: MutationOutput,
    plan: Plan,
}
#[derive(Serialize, JsonSchema)]
struct ReadPlan {
    plan: Plan,
}
#[derive(Serialize, JsonSchema)]
struct Collection {
    clips: Vec<Value>,
}
fn load(p: &Project) -> Result<(GenerativeDocument, ProductionWorkspace), CapabilityError> {
    Ok((
        serde_json::from_value(p.extensions.get(KEY).cloned().unwrap_or_else(|| json!({})))
            .map_err(|e| invalid(&e.to_string()))?,
        serde_json::from_value(
            p.extensions
                .get(PRODUCTION_KEY)
                .cloned()
                .unwrap_or_else(|| json!({})),
        )
        .map_err(|e| invalid(&e.to_string()))?,
    ))
}
fn invalid(s: &str) -> CapabilityError {
    CapabilityError::InvalidInput(s.into())
}
pub(super) fn register_chapters(
    registry: &CapabilityRegistry,
    state: Arc<RwLock<EditorStore>>,
    events: broadcast::Sender<u64>,
) -> Result<(), RegistryError> {
    let build_state = state.clone();
    let build_events = events.clone();
    register::<Build, Planned, _, _>(
        registry,
        DocumentSupport::Both,
        crate::CapabilityExecution::Immediate,
        "project.generative.chapters.build",
        "Plan chapter generation",
        "Derive up to 200 video chapters from selected scriptIds or rowIds, automatically splitting long rows into live-model-sized time windows. Preserve concatenated source text and supplied Latin transliteration exactly; whole-word distribution across split windows is estimated and must be reviewed before approval. Select the shortest advertised duration fitting each window. Capture approved reference versions for independent parallel generation; continuity is guidance, not guaranteed matching frames. Storyboards optional. No network or paid calls. Atomic revision/undo/dry-run/idempotency.",
        "generative",
        AccessLevel::Write,
        false,
        false,
        &["chapters", "director", "video"],
        move |context, i| {
            let state = build_state.clone();
            let events = build_events.clone();
            async move {
                let mut result = None;
                let mutation = mutate(
                    &state,
                    &events,
                    &context,
                    "Plan video chapters",
                    Some(i.expected_revision),
                    |d| {
                        let p = project_mut(d)?;
                        if p.id != i.project_id {
                            return Err(CapabilityError::Conflict("Project changed".into()));
                        }
                        let (mut doc, workspace) = load(p)?;
                        if i.supported_durations.is_empty()
                            || i.supported_durations.len() > 120
                            || i.supported_durations.iter().any(|s| !(1..=120).contains(s))
                        {
                            return Err(invalid("Use the current provider model duration catalog"));
                        }
                        if i.row_ids.iter().collect::<HashSet<_>>().len() != i.row_ids.len()
                            || i.row_ids
                                .iter()
                                .any(|id| !workspace.script_rows.iter().any(|r| &r.id == id))
                        {
                            return Err(invalid("Selected script row is missing or duplicated"));
                        }
                        if !i.script_ids.is_empty() && !i.row_ids.is_empty() {
                            return Err(invalid("Choose scriptIds or rowIds"));
                        }
                        let handoff = doc
                            .production_handoff
                            .as_ref()
                            .filter(|_| i.script_ids.is_empty());
                        if let Some(handoff) = handoff {
                            if handoff.rows.iter().any(|captured| {
                                !workspace.script_rows.iter().any(|row| {
                                    row.id == captured.row_id
                                        && workspace.is_active_script_row(&row.id)
                                        && row.current_version == captured.version
                                        && row.current().content == captured.content
                                })
                            }) || handoff.reference_slots.iter().any(|captured| {
                                !workspace.reference_slots.iter().any(|slot| {
                                    slot.id == captured.slot_id
                                        && slot.slot_version == captured.slot_version
                                        && slot.approved_version == Some(captured.version)
                                        && slot.selected_version == Some(captured.version)
                                        && slot.versions.iter().any(|version| {
                                            version.version == captured.version
                                                && version.reference_id == captured.reference_id
                                        })
                                })
                            }) {
                                return Err(invalid(
                                    "Production sources changed after handoff. Send the updated script and references to the Director again.",
                                ));
                            }
                        }
                        let mut rows = if !i.script_ids.is_empty()
                            || (i.row_ids.is_empty() && handoff.is_none())
                        {
                            workspace
                                .selected_script_rows(&i.script_ids)
                                .map_err(|e| invalid(&e.to_string()))?
                        } else {
                            workspace
                                .script_rows
                                .iter()
                                .filter(|row| {
                                    workspace.is_active_script_row(&row.id)
                                        && if i.row_ids.is_empty() {
                                            handoff.is_some_and(|h| {
                                                h.rows.iter().any(|r| r.row_id == row.id)
                                            })
                                        } else {
                                            i.row_ids.contains(&row.id)
                                        }
                                })
                                .collect::<Vec<_>>()
                        };
                        rows.sort_by_key(|r| r.current().content.start_ms);
                        if rows.is_empty()
                            || rows.len() > 200
                            || (!i.row_ids.is_empty() && rows.len() != i.row_ids.len())
                        {
                            return Err(invalid("Choose between one and 200 active script rows"));
                        }
                        let references = workspace
                            .reference_slots
                            .iter()
                            .filter(|slot| {
                                handoff.is_none_or(|h| {
                                    h.reference_slots.iter().any(|s| s.slot_id == slot.id)
                                })
                            })
                            .filter_map(|s| {
                                s.approved_version
                                    .filter(|v| Some(*v) == s.selected_version)
                                    .and_then(|version| {
                                        s.versions.iter().find(|v| v.version == version).map(|v| {
                                            SourceSlot {
                                                id: s.id.clone(),
                                                slot_version: s.slot_version,
                                                version,
                                                reference_id: v.reference_id.clone(),
                                            }
                                        })
                                    })
                            })
                            .collect::<Vec<_>>();
                        let programmatic = workspace.scripts.iter().any(|script| {
                            script.parent_script_id.is_some()
                                && rows.iter().any(|row| script.row_ids.contains(&row.id))
                        });
                        if programmatic
                            && rows.windows(2).any(|pair| {
                                pair[0].current().content.end_ms
                                    > pair[1].current().content.start_ms
                            })
                        {
                            return Err(invalid(
                                "Programmatic script assets must not overlap; choose the segments rather than their parent",
                            ));
                        }
                        let direction = if programmatic {
                            let structured = serde_json::from_str::<Value>(&doc.direction).ok();
                            structured
                                .as_ref()
                                .and_then(|v| v["creative_intent"].as_str())
                                .unwrap_or(&doc.direction)
                                .chars()
                                .take(1500)
                                .collect::<String>()
                        } else {
                            doc.direction.clone()
                        };
                        let mut chapters = vec![];
                        let mut previous = String::new();
                        let max_duration = *i.supported_durations.iter().max().unwrap();
                        for row in rows {
                            let c = &row.current().content;
                            let mut windows = vec![];
                            let mut cursor = c.start_ms;
                            while cursor < c.end_ms {
                                let stop = (cursor + max_duration * 1000).min(c.end_ms);
                                windows.push((cursor, stop));
                                cursor = stop;
                            }
                            if chapters.len() + windows.len() > 200 {
                                return Err(invalid(
                                    "This plan exceeds 200 chapters after automatic splitting. Select fewer source rows for this batch.",
                                ));
                            }
                            let spoken = crate::generative::chapters::split_text(
                                &c.source_text,
                                &windows,
                                c.start_ms,
                                c.end_ms,
                            );
                            let latin = crate::generative::chapters::split_text(
                                &c.latin_transliteration,
                                &windows,
                                c.start_ms,
                                c.end_ms,
                            );
                            for (part, (start, stop)) in windows.iter().copied().enumerate() {
                                let index = chapters.len();
                                let required = (stop - start).div_ceil(1000);
                                let duration = *i
                                    .supported_durations
                                    .iter()
                                    .filter(|s| **s >= required)
                                    .min()
                                    .unwrap();
                                let estimated = c.timing_estimated || windows.len() > 1;
                                let prompt=json!({"task":"Generate this chapter as one video. Speak only the dialogue field of this chapter. globalDirection is context for style and story, not additional dialogue; do not repeat other chapters. Preserve exact source dialogue; do not translate, paraphrase or invent Latin transliteration.","chapter":index+1,"sourceLanguage":c.source_language,"dialogue":spoken[part],"latinTransliteration":latin[part],"speaker":c.speaker,"visualDirection":c.visual_description,"globalDirection":direction,"previousChapterVisualDirection":previous,"continuity":"Preserve subject identity, wardrobe, lighting and style using shared approved references. Chapters are generated independently; exact boundary matching is not guaranteed.","sourceTiming":{"startMs":start,"endMs":stop,"estimated":estimated,"note":if windows.len()>1{"Long source row was split automatically. Word distribution is estimated; review dialogue timing before paid approval."}else{"Canonical source timing"}},"durationSeconds":duration}).to_string();
                                chapters.push(Chapter {
                                    id: format!("chapter-{}", index + 1),
                                    title: format!("Chapter {}", index + 1),
                                    source: SourceRow {
                                        digest: format!(
                                            "{:x}",
                                            Sha256::digest(
                                                serde_json::to_vec(c)
                                                    .map_err(|e| invalid(&e.to_string()))?
                                            )
                                        ),
                                        id: row.id.clone(),
                                        version: row.current_version,
                                    },
                                    source_start_ms: start,
                                    source_end_ms: stop,
                                    timing_estimated: estimated,
                                    source_text: spoken[part].clone(),
                                    latin_transliteration: latin[part].clone(),
                                    visual_description: c.visual_description.clone(),
                                    prompt,
                                    duration,
                                });
                                previous = c.visual_description.clone();
                            }
                        }
                        if doc.jobs.len() + chapters.len() > 200 {
                            return Err(invalid(
                                "This project reached its generation history limit. Create a new project before preparing more chapters.",
                            ));
                        }
                        let version = doc
                            .chapter_plans
                            .iter()
                            .filter(|p| p.id == i.id)
                            .map(|p| p.version)
                            .max()
                            .unwrap_or(0)
                            .checked_add(1)
                            .ok_or_else(|| invalid("Chapter version exhausted"))?;
                        let plan = Plan {
                            direction_digest: format!(
                                "{:x}",
                                Sha256::digest(doc.direction.as_bytes())
                            ),
                            id: i.id.clone(),
                            title: i.title.clone(),
                            version,
                            model: i.model.clone(),
                            resolution: i.resolution.clone(),
                            aspect_ratio: i.aspect_ratio.clone(),
                            chapters,
                            programmatic,
                            references,
                            batch_id: None,
                            job_ids: vec![],
                        };
                        plan.validate().map_err(|e| invalid(&e.to_string()))?;
                        plan.check_sources(&workspace, &doc)
                            .map_err(|e| invalid(&e.to_string()))?;
                        // Prepared provider requests are immutable: rebuilding uses a new collection identity.
                        if doc
                            .chapter_plans
                            .iter()
                            .any(|p| p.id == i.id && p.batch_id.is_some())
                        {
                            return Err(invalid(
                                "This chapter collection has prepared requests. Create a new plan ID to revise it.",
                            ));
                        }
                        doc.chapter_plans.retain(|p| p.id != i.id);
                        doc.chapter_plans.push(plan.clone());
                        doc.validate().map_err(|e| invalid(&e.to_string()))?;
                        p.extensions
                            .insert(KEY.into(), serde_json::to_value(&doc).unwrap());
                        result = Some(plan);
                        Ok(vec![p.id.clone()])
                    },
                )?;
                Ok(OperationSuccess::new(Planned {
                    mutation,
                    plan: result.unwrap(),
                })
                .changed([STATE_RESOURCE, PROJECT_RESOURCE]))
            }
        },
    )?;
    let read_state = state.clone();
    register::<Target, ReadPlan, _, _>(
        registry,
        DocumentSupport::Both,
        crate::CapabilityExecution::Immediate,
        "project.generative.chapters.validate",
        "Validate chapter source captures",
        "Read a chapter plan only if its source rows and approved reference versions still match the canonical production workspace. Use immediately before preparing human-approved provider requests. No IO.",
        "generative",
        AccessLevel::Read,
        false,
        false,
        &["chapters", "director"],
        move |_, i| {
            let state = read_state.clone();
            async move {
                let s = state.read().map_err(|_| invalid("State lock"))?;
                if s.document.revision != i.expected_revision {
                    return Err(CapabilityError::Conflict("Revision changed".into()));
                }
                let p = s
                    .document
                    .project
                    .as_ref()
                    .filter(|p| p.id == i.project_id)
                    .ok_or_else(|| invalid("Project changed"))?;
                let (doc, w) = load(p)?;
                let plan = doc
                    .chapter_plans
                    .iter()
                    .find(|p| p.id == i.plan_id)
                    .ok_or_else(|| invalid("Chapter plan missing"))?
                    .clone();
                plan.check_sources(&w, &doc)
                    .map_err(|e| invalid(&e.to_string()))?;
                Ok(OperationSuccess::new(ReadPlan { plan }))
            }
        },
    )?;
    register::<Target, Collection, _, _>(
        registry,
        DocumentSupport::Classic,
        crate::CapabilityExecution::Immediate,
        "project.generative.chapters.collection",
        "Plan chapter collection insertion",
        "Resolve all imported chapter outputs to individual sequential video clip drafts. Call timeline.classic.elements.insert with these clips for one atomic undoable insertion. This combined collection preserves every chapter cut and never flattens media or modifies podcast unified angles. No filesystem or network access.",
        "generative",
        AccessLevel::Read,
        false,
        false,
        &["chapters", "assets", "collection"],
        move |_, i| {
            let state = state.clone();
            async move {
                let s = state.read().map_err(|_| invalid("State lock"))?;
                if s.document.revision != i.expected_revision || i.start_time < 0 {
                    return Err(CapabilityError::Conflict(
                        "Revision or insertion time invalid".into(),
                    ));
                }
                let p = s
                    .document
                    .project
                    .as_ref()
                    .filter(|p| p.id == i.project_id)
                    .ok_or_else(|| invalid("Project changed"))?;
                let (doc, _) = load(p)?;
                let plan = doc
                    .chapter_plans
                    .iter()
                    .find(|p| p.id == i.plan_id)
                    .ok_or_else(|| invalid("Chapter plan missing"))?;
                if plan.job_ids.len() != plan.chapters.len() {
                    return Err(invalid(
                        "Prepare and import every chapter before inserting the collection",
                    ));
                }
                let assets = &p
                    .classic
                    .as_ref()
                    .ok_or_else(|| invalid("Open Classic editor"))?
                    .media_assets;
                let mut cursor = i.start_time;
                let mut clips = vec![];
                for (c, id) in plan.chapters.iter().zip(&plan.job_ids) {
                    let media = doc
                        .jobs
                        .iter()
                        .find(|j| &j.id == id && j.status == "ready")
                        .and_then(|j| j.media_id.as_ref())
                        .ok_or_else(|| invalid("Every chapter must finish and import first"))?;
                    let asset = assets
                        .iter()
                        .find(|a| a["id"] == *media && a["type"] == "video")
                        .ok_or_else(|| invalid("Chapter media is missing"))?;
                    let source = asset["duration"]
                        .as_f64()
                        .filter(|s| s.is_finite() && *s > 0.0)
                        .ok_or_else(|| invalid("Chapter media duration is invalid"))?;
                    let source_ticks = (source * 120000.0).round() as i64;
                    let expected_ticks = if plan.programmatic {
                        i64::from(c.source_end_ms - c.source_start_ms) * 120
                    } else {
                        i64::from(c.duration) * 120000
                    };
                    let duration = source_ticks.min(expected_ticks);
                    if duration <= 0 {
                        return Err(invalid("Chapter video is empty"));
                    }
                    clips.push(json!({"element":{"type":"video","name":c.title,"mediaId":media,"startTime":cursor,"duration":duration,"sourceDuration":source_ticks,"trimStart":0,"trimEnd":source_ticks-duration,"isSourceAudioEnabled":true,"params":{}},"placement":{"mode":"auto","trackType":"video"}}));
                    cursor = cursor
                        .checked_add(duration)
                        .filter(|t| *t <= 9_007_199_254_740_991)
                        .ok_or_else(|| invalid("Chapter collection exceeds timeline bounds"))?;
                }
                Ok(OperationSuccess::new(Collection { clips }))
            }
        },
    )
}
