use std::collections::{BTreeMap, BTreeSet, HashSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::artifact::{ARTIFACT_URI_PREFIX, ArtifactRef};

pub const CURRENT_SCHEMA_VERSION: u32 = 3;
pub const SMART_LAYER_MASK_ARTIFACT_MIME_TYPE: &str =
    "application/vnd.opencut.background-mask-cache";

/// Exact rational value used for media time bases and frame rates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Rational {
    pub numerator: i64,
    pub denominator: i64,
}

impl Rational {
    pub const fn new(numerator: i64, denominator: i64) -> Self {
        Self {
            numerator,
            denominator,
        }
    }

    pub fn validate(self, name: &str) -> Result<(), ModelError> {
        if self.numerator <= 0 || self.denominator <= 0 {
            return Err(ModelError::Invalid(format!(
                "{name} numerator and denominator must be positive"
            )));
        }
        Ok(())
    }

    pub fn from_decimal(value: f64) -> Self {
        const DENOMINATOR: i64 = 1_000_000;
        let numerator = (value * DENOMINATOR as f64).round() as i64;
        let divisor = greatest_common_divisor(numerator.unsigned_abs(), DENOMINATOR as u64) as i64;
        Self::new(numerator / divisor, DENOMINATOR / divisor)
    }
}

impl Default for Rational {
    fn default() -> Self {
        Self::new(1, 48_000)
    }
}

/// Frame-accurate time represented as integer ticks in a rational time base.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MediaTime {
    pub ticks: i64,
    pub time_base: Rational,
}

impl MediaTime {
    pub fn from_seconds(seconds: f64, time_base: Rational) -> Self {
        let ticks =
            (seconds * time_base.denominator as f64 / time_base.numerator as f64).round() as i64;
        Self { ticks, time_base }
    }

    pub fn as_seconds(self) -> f64 {
        self.ticks as f64 * self.time_base.numerator as f64 / self.time_base.denominator as f64
    }

    pub fn validate(self, name: &str) -> Result<(), ModelError> {
        self.time_base.validate(name)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EditorDocument {
    pub schema_version: u32,
    pub revision: u64,
    pub next_id: u64,
    pub application: ApplicationState,
    pub project: Option<Project>,
    pub selection: SelectionState,
    pub playback: PlaybackState,
    pub workspace: WorkspaceState,
    #[serde(default)]
    pub extensions: Map<String, Value>,
}

impl Default for EditorDocument {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            revision: 0,
            next_id: 1,
            application: ApplicationState {
                name: "OpenCut".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            project: None,
            selection: SelectionState::default(),
            playback: PlaybackState::default(),
            workspace: WorkspaceState::default(),
            extensions: Map::new(),
        }
    }
}

impl EditorDocument {
    pub fn allocate_id(&mut self, prefix: &str) -> String {
        let id = format!("{prefix}-{}", self.next_id);
        self.next_id += 1;
        id
    }

    pub fn timeline_duration(&self) -> f64 {
        self.project
            .as_ref()
            .map(|project| project.timeline.duration())
            .unwrap_or(0.0)
    }

    pub fn validate(&self) -> Result<(), ModelError> {
        if self.schema_version == 0 {
            return Err(ModelError::Invalid(
                "schemaVersion must be greater than zero".into(),
            ));
        }
        if self.next_id == 0 {
            return Err(ModelError::Invalid(
                "nextId must be greater than zero".into(),
            ));
        }
        self.playback.validate()?;
        self.workspace.validate()?;
        let Some(project) = &self.project else {
            if !self.selection.is_empty() {
                return Err(ModelError::Invalid(
                    "selection must be empty when no project is open".into(),
                ));
            }
            return Ok(());
        };
        project.validate()?;
        let asset_ids: HashSet<_> = project
            .assets
            .iter()
            .map(|asset| asset.id.as_str())
            .collect();
        let track_ids: HashSet<_> = project
            .timeline
            .tracks
            .iter()
            .map(|track| track.id.as_str())
            .collect();
        let item_ids: HashSet<_> = project
            .timeline
            .tracks
            .iter()
            .flat_map(|track| track.items.iter().map(|item| item.id.as_str()))
            .collect();
        let effect_ids: HashSet<_> = project
            .timeline
            .tracks
            .iter()
            .flat_map(|track| track.items.iter())
            .flat_map(|item| item.effects.iter().map(|effect| effect.id.as_str()))
            .collect();

        for id in &self.selection.asset_ids {
            if !asset_ids.contains(id.as_str()) {
                return Err(ModelError::Invalid(format!(
                    "selection references unknown asset `{id}`"
                )));
            }
        }
        for id in &self.selection.track_ids {
            if !track_ids.contains(id.as_str()) {
                return Err(ModelError::Invalid(format!(
                    "selection references unknown track `{id}`"
                )));
            }
        }
        for id in &self.selection.item_ids {
            if !item_ids.contains(id.as_str()) {
                return Err(ModelError::Invalid(format!(
                    "selection references unknown timeline item `{id}`"
                )));
            }
        }
        for id in &self.selection.effect_ids {
            if !effect_ids.contains(id.as_str()) {
                return Err(ModelError::Invalid(format!(
                    "selection references unknown effect `{id}`"
                )));
            }
        }
        Ok(())
    }

    /// Migrates legacy floating-point documents and re-synchronizes the
    /// compatibility seconds fields from exact media ticks.
    pub fn migrate_to_current(&mut self) -> Result<bool, ModelError> {
        let migrated = self.schema_version < CURRENT_SCHEMA_VERSION;
        let legacy_seconds_are_source = self.schema_version < 2;
        if self.schema_version > CURRENT_SCHEMA_VERSION {
            return Err(ModelError::Invalid(format!(
                "schemaVersion {} is newer than supported version {}",
                self.schema_version, CURRENT_SCHEMA_VERSION
            )));
        }
        if let Some(project) = &mut self.project {
            if legacy_seconds_are_source {
                project.settings.frame_rate_rational =
                    Rational::from_decimal(project.settings.frame_rate);
            } else {
                project.settings.frame_rate = project.settings.frame_rate_rational.numerator as f64
                    / project.settings.frame_rate_rational.denominator as f64;
            }
            let time_base = project.settings.time_base;
            project
                .timeline
                .sync_exact(time_base, legacy_seconds_are_source);
            self.playback
                .sync_exact(time_base, legacy_seconds_are_source);
        }
        self.schema_version = CURRENT_SCHEMA_VERSION;
        Ok(migrated)
    }

    pub fn sync_exact_from_seconds(&mut self) -> Result<(), ModelError> {
        if let Some(project) = &mut self.project {
            project.settings.frame_rate_rational =
                Rational::from_decimal(project.settings.frame_rate);
            let time_base = project.settings.time_base;
            project.timeline.sync_exact(time_base, true);
            self.playback.sync_exact(time_base, true);
        }
        self.schema_version = CURRENT_SCHEMA_VERSION;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationState {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub file_path: Option<String>,
    pub settings: ProjectSettings,
    #[serde(default)]
    pub assets: Vec<MediaAsset>,
    pub timeline: Timeline,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
    #[serde(default)]
    pub export_presets: Vec<ExportPreset>,
    #[serde(default)]
    pub extensions: Map<String, Value>,
}

impl Project {
    pub fn validate(&self) -> Result<(), ModelError> {
        if self.id.is_empty() || self.name.trim().is_empty() {
            return Err(ModelError::Invalid(
                "project id and name must not be empty".into(),
            ));
        }
        self.settings.validate()?;
        ensure_unique(self.assets.iter().map(|asset| asset.id.as_str()), "asset")?;
        for asset in &self.assets {
            asset.validate()?;
        }
        ensure_unique(
            self.export_presets.iter().map(|preset| preset.id.as_str()),
            "export preset",
        )?;
        for preset in &self.export_presets {
            preset.validate()?;
        }
        let asset_ids: HashSet<_> = self.assets.iter().map(|asset| asset.id.as_str()).collect();
        self.timeline.validate(&asset_ids)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
    #[serde(default = "default_frame_rate_rational")]
    pub frame_rate_rational: Rational,
    #[serde(default)]
    pub time_base: Rational,
    pub sample_rate: u32,
    pub channels: u8,
    pub background_color: String,
    #[serde(default)]
    pub background: BackgroundFill,
    pub color_space: String,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            frame_rate: 30.0,
            frame_rate_rational: default_frame_rate_rational(),
            time_base: Rational::default(),
            sample_rate: 48_000,
            channels: 2,
            background_color: "#000000".into(),
            background: BackgroundFill::default(),
            color_space: "rec709".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundFill {
    pub fill_type: String,
    pub color: String,
    #[serde(default)]
    pub gradient_stops: Vec<GradientStop>,
    #[serde(default)]
    pub angle_degrees: f64,
}

impl Default for BackgroundFill {
    fn default() -> Self {
        Self {
            fill_type: "solid".into(),
            color: "#000000".into(),
            gradient_stops: Vec::new(),
            angle_degrees: 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GradientStop {
    pub offset: f64,
    pub color: String,
}

impl ProjectSettings {
    fn validate(&self) -> Result<(), ModelError> {
        if self.width == 0 || self.height == 0 {
            return Err(ModelError::Invalid(
                "project width and height must be greater than zero".into(),
            ));
        }
        if !self.frame_rate.is_finite() || self.frame_rate <= 0.0 {
            return Err(ModelError::Invalid(
                "project frameRate must be a finite positive number".into(),
            ));
        }
        self.frame_rate_rational
            .validate("project frameRateRational")?;
        self.time_base.validate("project timeBase")?;
        if self.sample_rate == 0 || self.channels == 0 {
            return Err(ModelError::Invalid(
                "project audio sampleRate and channels must be greater than zero".into(),
            ));
        }
        Ok(())
    }
}

fn default_frame_rate_rational() -> Rational {
    Rational::new(30, 1)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreset {
    pub id: String,
    pub name: String,
    pub container: String,
    pub video_codec: String,
    pub audio_codec: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_rate: Option<f64>,
    pub video_bitrate: Option<u64>,
    pub audio_bitrate: Option<u64>,
    #[serde(default)]
    pub options: Map<String, Value>,
}

impl ExportPreset {
    fn validate(&self) -> Result<(), ModelError> {
        if self.id.is_empty()
            || self.name.trim().is_empty()
            || self.container.trim().is_empty()
            || self.video_codec.trim().is_empty()
            || self.audio_codec.trim().is_empty()
        {
            return Err(ModelError::Invalid(
                "export preset id, name, container, videoCodec, and audioCodec must not be empty"
                    .into(),
            ));
        }
        if self.width == Some(0) || self.height == Some(0) {
            return Err(ModelError::Invalid(
                "export preset width and height must be greater than zero".into(),
            ));
        }
        validate_optional_positive(self.frame_rate, "export preset frameRate")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub id: String,
    pub name: String,
    pub source: String,
    pub media_type: MediaType,
    pub duration_seconds: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_rate: Option<f64>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
    pub has_video: bool,
    pub has_audio: bool,
    pub proxy_source: Option<String>,
    pub offline: bool,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
    #[serde(default)]
    pub extensions: Map<String, Value>,
}

impl MediaAsset {
    fn validate(&self) -> Result<(), ModelError> {
        if self.id.is_empty() || self.name.is_empty() || self.source.is_empty() {
            return Err(ModelError::Invalid(
                "asset id, name, and source must not be empty".into(),
            ));
        }
        validate_optional_non_negative(self.duration_seconds, "asset durationSeconds")?;
        validate_optional_positive(self.frame_rate, "asset frameRate")?;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MediaType {
    Video,
    Audio,
    Image,
    AnimatedImage,
    Subtitle,
    Font,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    #[serde(default)]
    pub tracks: Vec<Track>,
    #[serde(default)]
    pub transitions: Vec<Transition>,
    #[serde(default)]
    pub markers: Vec<Marker>,
    pub in_point_seconds: Option<f64>,
    pub out_point_seconds: Option<f64>,
    #[serde(default)]
    pub in_point: Option<MediaTime>,
    #[serde(default)]
    pub out_point: Option<MediaTime>,
    #[serde(default = "default_timeline_zoom")]
    pub zoom: f64,
    #[serde(default)]
    pub scroll_seconds: f64,
    #[serde(default)]
    pub scroll_time: Option<MediaTime>,
    #[serde(default)]
    pub extensions: Map<String, Value>,
}

impl Default for Timeline {
    fn default() -> Self {
        Self {
            tracks: Vec::new(),
            transitions: Vec::new(),
            markers: Vec::new(),
            in_point_seconds: None,
            out_point_seconds: None,
            in_point: None,
            out_point: None,
            zoom: 1.0,
            scroll_seconds: 0.0,
            scroll_time: None,
            extensions: Map::new(),
        }
    }
}

impl Timeline {
    pub fn duration(&self) -> f64 {
        self.tracks
            .iter()
            .flat_map(|track| &track.items)
            .map(TimelineItem::end_seconds)
            .fold(0.0, f64::max)
    }

    fn validate(&self, asset_ids: &HashSet<&str>) -> Result<(), ModelError> {
        ensure_unique(self.tracks.iter().map(|track| track.id.as_str()), "track")?;
        let mut item_ids = HashSet::new();
        let mut effect_ids = HashSet::new();
        for track in &self.tracks {
            track.validate(asset_ids, &mut item_ids, &mut effect_ids)?;
        }
        ensure_unique(
            self.transitions
                .iter()
                .map(|transition| transition.id.as_str()),
            "transition",
        )?;
        for transition in &self.transitions {
            transition.validate(&item_ids)?;
        }
        ensure_unique(
            self.markers.iter().map(|marker| marker.id.as_str()),
            "marker",
        )?;
        for marker in &self.markers {
            validate_non_negative(marker.time_seconds, "marker timeSeconds")?;
        }
        validate_optional_non_negative(self.in_point_seconds, "timeline inPointSeconds")?;
        validate_optional_non_negative(self.out_point_seconds, "timeline outPointSeconds")?;
        if let (Some(start), Some(end)) = (self.in_point_seconds, self.out_point_seconds)
            && end <= start
        {
            return Err(ModelError::Invalid(
                "timeline outPointSeconds must be after inPointSeconds".into(),
            ));
        }
        if !self.zoom.is_finite() || self.zoom <= 0.0 {
            return Err(ModelError::Invalid(
                "timeline zoom must be a finite positive number".into(),
            ));
        }
        validate_non_negative(self.scroll_seconds, "timeline scrollSeconds")
    }

    fn sync_exact(&mut self, time_base: Rational, legacy_seconds_are_source: bool) {
        sync_optional_time(
            &mut self.in_point_seconds,
            &mut self.in_point,
            time_base,
            legacy_seconds_are_source,
        );
        sync_optional_time(
            &mut self.out_point_seconds,
            &mut self.out_point,
            time_base,
            legacy_seconds_are_source,
        );
        sync_time(
            &mut self.scroll_seconds,
            &mut self.scroll_time,
            time_base,
            legacy_seconds_are_source,
        );
        for track in &mut self.tracks {
            for item in &mut track.items {
                item.sync_exact(time_base, legacy_seconds_are_source);
            }
        }
        for transition in &mut self.transitions {
            transition.sync_exact(time_base, legacy_seconds_are_source);
        }
        for marker in &mut self.markers {
            marker.sync_exact(time_base, legacy_seconds_are_source);
        }
    }
}

fn default_timeline_zoom() -> f64 {
    1.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub name: String,
    pub kind: TrackKind,
    #[serde(default)]
    pub items: Vec<TimelineItem>,
    pub enabled: bool,
    pub locked: bool,
    pub muted: bool,
    pub solo: bool,
    pub hidden: bool,
    #[serde(default = "default_track_height")]
    pub height: f64,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
    #[serde(default)]
    pub extensions: Map<String, Value>,
}

impl Track {
    fn validate(
        &self,
        asset_ids: &HashSet<&str>,
        item_ids: &mut HashSet<String>,
        effect_ids: &mut HashSet<String>,
    ) -> Result<(), ModelError> {
        if self.id.is_empty() || self.name.is_empty() {
            return Err(ModelError::Invalid(
                "track id and name must not be empty".into(),
            ));
        }
        if !self.height.is_finite() || self.height <= 0.0 {
            return Err(ModelError::Invalid(format!(
                "track `{}` height must be a finite positive number",
                self.id
            )));
        }
        for item in &self.items {
            if !item_ids.insert(item.id.clone()) {
                return Err(ModelError::DuplicateId {
                    kind: "timeline item",
                    id: item.id.clone(),
                });
            }
            if matches!(item.kind, TimelineItemKind::SmartLayer)
                && !matches!(self.kind, TrackKind::Adjustment | TrackKind::Overlay)
            {
                return Err(ModelError::Invalid(format!(
                    "smart layer item `{}` must be on an adjustment or overlay track",
                    item.id
                )));
            }
            item.validate(asset_ids, effect_ids)?;
        }
        Ok(())
    }
}

fn default_track_height() -> f64 {
    64.0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TrackKind {
    Video,
    Audio,
    Text,
    Caption,
    Overlay,
    Adjustment,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimelineItem {
    pub id: String,
    pub name: String,
    pub kind: TimelineItemKind,
    pub start_seconds: f64,
    pub duration_seconds: f64,
    #[serde(default)]
    pub start: Option<MediaTime>,
    #[serde(default)]
    pub duration: Option<MediaTime>,
    #[serde(default)]
    pub source_in_seconds: f64,
    pub source_out_seconds: Option<f64>,
    #[serde(default)]
    pub source_in: Option<MediaTime>,
    #[serde(default)]
    pub source_out: Option<MediaTime>,
    #[serde(default = "default_speed")]
    pub speed: f64,
    pub enabled: bool,
    pub locked: bool,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub linked_item_ids: BTreeSet<String>,
    pub asset_id: Option<String>,
    #[serde(default)]
    pub transform: Transform,
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    #[serde(default)]
    pub blend_mode: BlendMode,
    #[serde(default)]
    pub audio: AudioProperties,
    pub text: Option<TextProperties>,
    pub shape: Option<ShapeProperties>,
    #[serde(default)]
    pub smart_layer: Option<SmartLayer>,
    #[serde(default)]
    pub masks: Vec<Mask>,
    #[serde(default)]
    pub effects: Vec<Effect>,
    #[serde(default)]
    pub keyframes: Vec<Keyframe>,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
    #[serde(default)]
    pub extensions: Map<String, Value>,
}

impl TimelineItem {
    pub fn end_seconds(&self) -> f64 {
        self.start_seconds + self.duration_seconds
    }

    fn validate(
        &self,
        asset_ids: &HashSet<&str>,
        effect_ids: &mut HashSet<String>,
    ) -> Result<(), ModelError> {
        if self.id.is_empty() || self.name.is_empty() {
            return Err(ModelError::Invalid(
                "timeline item id and name must not be empty".into(),
            ));
        }
        validate_non_negative(self.start_seconds, "item startSeconds")?;
        validate_positive(self.duration_seconds, "item durationSeconds")?;
        validate_non_negative(self.source_in_seconds, "item sourceInSeconds")?;
        validate_optional_non_negative(self.source_out_seconds, "item sourceOutSeconds")?;
        if let Some(source_out) = self.source_out_seconds
            && source_out <= self.source_in_seconds
        {
            return Err(ModelError::Invalid(format!(
                "timeline item `{}` sourceOutSeconds must be after sourceInSeconds",
                self.id
            )));
        }
        validate_positive(self.speed, "item speed")?;
        if let Some(asset_id) = &self.asset_id
            && !asset_ids.contains(asset_id.as_str())
        {
            return Err(ModelError::Invalid(format!(
                "timeline item `{}` references unknown asset `{asset_id}`",
                self.id
            )));
        }
        if matches!(
            self.kind,
            TimelineItemKind::Video
                | TimelineItemKind::Audio
                | TimelineItemKind::Image
                | TimelineItemKind::Compound
        ) && self.asset_id.is_none()
        {
            return Err(ModelError::Invalid(format!(
                "timeline item `{}` requires an assetId",
                self.id
            )));
        }
        ensure_unique(self.masks.iter().map(|mask| mask.id.as_str()), "mask")?;
        for mask in &self.masks {
            mask.validate()?;
        }
        if matches!(
            self.kind,
            TimelineItemKind::Text | TimelineItemKind::Caption
        ) && self.text.is_none()
        {
            return Err(ModelError::Invalid(format!(
                "text item `{}` requires text properties",
                self.id
            )));
        }
        if matches!(self.kind, TimelineItemKind::SmartLayer) && self.smart_layer.is_none() {
            return Err(ModelError::Invalid(format!(
                "smart layer item `{}` requires smartLayer properties",
                self.id
            )));
        }
        if !matches!(self.kind, TimelineItemKind::SmartLayer) && self.smart_layer.is_some() {
            return Err(ModelError::Invalid(format!(
                "non-smart timeline item `{}` must not contain smartLayer properties",
                self.id
            )));
        }
        self.transform.validate()?;
        validate_unit_interval(self.opacity, "item opacity")?;
        self.audio.validate()?;
        if let Some(text) = &self.text {
            text.validate()?;
        }
        if let Some(shape) = &self.shape {
            shape.validate()?;
        }
        if let Some(smart_layer) = &self.smart_layer {
            smart_layer.validate(self.duration_seconds)?;
        }
        ensure_unique(
            self.effects.iter().map(|effect| effect.id.as_str()),
            "effect",
        )?;
        for effect in &self.effects {
            effect.validate()?;
            if !effect_ids.insert(effect.id.clone()) {
                return Err(ModelError::DuplicateId {
                    kind: "effect",
                    id: effect.id.clone(),
                });
            }
        }
        ensure_unique(
            self.keyframes.iter().map(|keyframe| keyframe.id.as_str()),
            "keyframe",
        )?;
        for keyframe in &self.keyframes {
            keyframe.validate(self.duration_seconds)?;
        }
        Ok(())
    }

    fn sync_exact(&mut self, time_base: Rational, legacy_seconds_are_source: bool) {
        sync_time(
            &mut self.start_seconds,
            &mut self.start,
            time_base,
            legacy_seconds_are_source,
        );
        sync_time(
            &mut self.duration_seconds,
            &mut self.duration,
            time_base,
            legacy_seconds_are_source,
        );
        sync_time(
            &mut self.source_in_seconds,
            &mut self.source_in,
            time_base,
            legacy_seconds_are_source,
        );
        sync_optional_time(
            &mut self.source_out_seconds,
            &mut self.source_out,
            time_base,
            legacy_seconds_are_source,
        );
        for keyframe in &mut self.keyframes {
            keyframe.sync_exact(time_base, legacy_seconds_are_source);
        }
    }
}

fn default_speed() -> f64 {
    1.0
}

fn default_true() -> bool {
    true
}

fn default_opacity() -> f64 {
    1.0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TimelineItemKind {
    Video,
    Audio,
    Image,
    Text,
    Caption,
    Shape,
    Adjustment,
    Compound,
    SmartLayer,
}

/// One timeline-visible layer whose renderer may derive multiple composited
/// visuals without exposing those implementation layers in the timeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SmartLayer {
    pub layer_type: SmartLayerType,
    #[serde(default)]
    pub source: SmartLayerSource,
    pub speaker_frame_breakout: SpeakerFrameBreakoutSettings,
    #[serde(default)]
    pub application: SmartLayerApplication,
}

impl SmartLayer {
    pub fn speaker_frame_breakout(settings: SpeakerFrameBreakoutSettings) -> Self {
        Self {
            layer_type: SmartLayerType::SpeakerFrameBreakout,
            source: SmartLayerSource::default(),
            speaker_frame_breakout: settings,
            application: SmartLayerApplication::default(),
        }
    }

    pub fn mark_configuration_changed(&mut self) {
        self.application.configuration_revision =
            self.application.configuration_revision.saturating_add(1);
    }

    pub fn set_applied_snapshot(&mut self, snapshot: SmartLayerAppliedSnapshot) {
        self.application.applied_snapshot = Some(snapshot);
    }

    fn validate(&self, duration_seconds: f64) -> Result<(), ModelError> {
        if !matches!(self.layer_type, SmartLayerType::SpeakerFrameBreakout) {
            return Err(ModelError::Invalid("unsupported smart layer type".into()));
        }
        self.source.validate()?;
        self.speaker_frame_breakout.validate(duration_seconds)?;
        self.application.validate(duration_seconds)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SmartLayerType {
    SpeakerFrameBreakout,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SmartLayerSource {
    pub mode: SmartLayerSourceMode,
}

impl Default for SmartLayerSource {
    fn default() -> Self {
        Self {
            mode: SmartLayerSourceMode::NearestVideoBelow,
        }
    }
}

impl SmartLayerSource {
    fn validate(&self) -> Result<(), ModelError> {
        if !matches!(self.mode, SmartLayerSourceMode::NearestVideoBelow) {
            return Err(ModelError::Invalid(
                "unsupported smart layer source mode".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SmartLayerSourceMode {
    NearestVideoBelow,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerFrameBreakoutSettings {
    #[serde(default)]
    pub background: SmartLayerBackground,
    #[serde(default)]
    pub layout: SpeakerFrameLayout,
    #[serde(default)]
    pub fade: SmartLayerFade,
    #[serde(default)]
    pub background_removal: SmartLayerBackgroundRemoval,
}

impl SpeakerFrameBreakoutSettings {
    fn validate(&self, duration_seconds: f64) -> Result<(), ModelError> {
        self.background.validate()?;
        self.layout.validate()?;
        self.fade.validate(duration_seconds)?;
        self.background_removal.validate()
    }
}

/// A serialized reference to any entry from the Backgrounds catalog. The
/// definition and parameters are copied into the document so generated and
/// built-in backgrounds render consistently after reopening a project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SmartLayerBackground {
    pub background_id: String,
    pub definition_id: String,
    #[serde(default)]
    pub parameters: Map<String, Value>,
}

impl Default for SmartLayerBackground {
    fn default() -> Self {
        let mut parameters = Map::new();
        parameters.insert("preset".into(), Value::String("grid".into()));
        parameters.insert("colorA".into(), Value::String("#F8F8F5".into()));
        parameters.insert("colorB".into(), Value::String("#D8DAD5".into()));
        parameters.insert("colorC".into(), Value::String("#FFFFFF".into()));
        parameters.insert("density".into(), Value::from(48));
        parameters.insert("intensity".into(), Value::from(12));
        parameters.insert("scale".into(), Value::from(52));
        parameters.insert("seed".into(), Value::from(7));
        Self {
            background_id: "paper-grid".into(),
            definition_id: "preset-background".into(),
            parameters,
        }
    }
}

impl SmartLayerBackground {
    fn validate(&self) -> Result<(), ModelError> {
        if self.background_id.trim().is_empty() || self.definition_id.trim().is_empty() {
            return Err(ModelError::Invalid(
                "smart layer backgroundId and definitionId must not be empty".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerFrameLayout {
    pub speaker_scale: f64,
    pub position_x: f64,
    pub position_y: f64,
    pub crop_top: f64,
    pub corner_radius: f64,
}

impl Default for SpeakerFrameLayout {
    fn default() -> Self {
        Self {
            speaker_scale: 0.7,
            position_x: 0.5,
            position_y: 0.68,
            crop_top: 0.22,
            corner_radius: 0.08,
        }
    }
}

impl SpeakerFrameLayout {
    fn validate(&self) -> Result<(), ModelError> {
        validate_positive(self.speaker_scale, "speaker frame speakerScale")?;
        validate_unit_interval(self.position_x, "speaker frame positionX")?;
        validate_unit_interval(self.position_y, "speaker frame positionY")?;
        validate_unit_interval(self.crop_top, "speaker frame cropTop")?;
        validate_unit_interval(self.corner_radius, "speaker frame cornerRadius")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SmartLayerFade {
    pub in_seconds: f64,
    pub out_seconds: f64,
}

impl Default for SmartLayerFade {
    fn default() -> Self {
        Self {
            in_seconds: 0.35,
            out_seconds: 0.35,
        }
    }
}

impl SmartLayerFade {
    fn validate(&self, duration_seconds: f64) -> Result<(), ModelError> {
        validate_non_negative(self.in_seconds, "smart layer fade inSeconds")?;
        validate_non_negative(self.out_seconds, "smart layer fade outSeconds")?;
        if self.in_seconds + self.out_seconds > duration_seconds {
            return Err(ModelError::Invalid(
                "smart layer fade durations must fit inside the layer duration".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SmartLayerBackgroundRemoval {
    pub quality: BackgroundRemovalQuality,
    pub mask_threshold: f64,
    pub edge_feather: f64,
    pub refine_edges: bool,
}

impl Default for SmartLayerBackgroundRemoval {
    fn default() -> Self {
        Self {
            quality: BackgroundRemovalQuality::Precise,
            mask_threshold: 0.55,
            edge_feather: 0.08,
            refine_edges: true,
        }
    }
}

impl SmartLayerBackgroundRemoval {
    fn validate(&self) -> Result<(), ModelError> {
        validate_unit_interval(
            self.mask_threshold,
            "smart layer background removal maskThreshold",
        )?;
        validate_unit_interval(
            self.edge_feather,
            "smart layer background removal edgeFeather",
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundRemovalQuality {
    Fast,
    Balanced,
    Precise,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SmartLayerApplication {
    pub configuration_revision: u64,
    pub applied_snapshot: Option<SmartLayerAppliedSnapshot>,
}

impl Default for SmartLayerApplication {
    fn default() -> Self {
        Self {
            configuration_revision: 1,
            applied_snapshot: None,
        }
    }
}

impl SmartLayerApplication {
    fn validate(&self, duration_seconds: f64) -> Result<(), ModelError> {
        if self.configuration_revision == 0 {
            return Err(ModelError::Invalid(
                "smart layer configurationRevision must be greater than zero".into(),
            ));
        }
        if let Some(snapshot) = &self.applied_snapshot {
            snapshot.validate(duration_seconds)?;
            if snapshot.configuration_revision > self.configuration_revision {
                return Err(ModelError::Invalid(
                    "smart layer applied snapshot cannot target a future configuration revision"
                        .into(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SmartLayerAppliedSnapshot {
    pub configuration_revision: u64,
    pub settings_signature: String,
    pub source_signature: String,
    pub source_items: Vec<SmartLayerSourceItemSnapshot>,
    pub artifacts: Vec<ArtifactRef>,
    pub processing_backend: String,
    pub frame_rate: Rational,
    pub frame_count: u64,
    pub applied_at_ms: u64,
}

impl SmartLayerAppliedSnapshot {
    fn validate(&self, duration_seconds: f64) -> Result<(), ModelError> {
        if self.configuration_revision == 0 {
            return Err(ModelError::Invalid(
                "smart layer snapshot configurationRevision must be greater than zero".into(),
            ));
        }
        if self.settings_signature.trim().is_empty()
            || self.source_signature.trim().is_empty()
            || self.processing_backend.trim().is_empty()
        {
            return Err(ModelError::Invalid(
                "smart layer snapshot signatures and processingBackend must not be empty".into(),
            ));
        }
        if self.source_items.is_empty() {
            return Err(ModelError::Invalid(
                "smart layer snapshot must contain at least one source item".into(),
            ));
        }
        ensure_unique(
            self.source_items
                .iter()
                .map(|source| source.item_id.as_str()),
            "smart layer source item",
        )?;
        for source in &self.source_items {
            source.validate()?;
        }
        if self.artifacts.is_empty() {
            return Err(ModelError::Invalid(
                "smart layer snapshot must contain at least one bounded artifact reference".into(),
            ));
        }
        ensure_unique(
            self.artifacts.iter().map(|artifact| artifact.id.as_str()),
            "smart layer artifact",
        )?;
        let mut covered_duration_ms = 0_u64;
        for artifact in &self.artifacts {
            if artifact.id.trim().is_empty()
                || artifact.uri != format!("{ARTIFACT_URI_PREFIX}{}", artifact.id)
                || artifact.mime_type != SMART_LAYER_MASK_ARTIFACT_MIME_TYPE
                || artifact.sha256.len() != 64
                || !artifact
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                || artifact.byte_size == 0
                || artifact.expires_at_ms <= artifact.created_at_ms
                || artifact.duration_ms.is_none_or(|duration| duration == 0)
            {
                return Err(ModelError::Invalid(
                    "smart layer artifact reference must be a canonical, checksummed mask cache from the ArtifactStore with positive duration coverage".into(),
                ));
            }
            covered_duration_ms = covered_duration_ms.saturating_add(
                artifact
                    .duration_ms
                    .expect("validated smart layer artifact duration"),
            );
        }
        self.frame_rate.validate("smart layer snapshot frameRate")?;
        if self.frame_count == 0 {
            return Err(ModelError::Invalid(
                "smart layer snapshot frameCount must be greater than zero".into(),
            ));
        }
        let frames_per_second =
            self.frame_rate.numerator as f64 / self.frame_rate.denominator as f64;
        let expected_frame_count = (duration_seconds * frames_per_second).ceil() as u64;
        if self.frame_count != expected_frame_count {
            return Err(ModelError::Invalid(format!(
                "smart layer snapshot frameCount {} does not cover the expected {expected_frame_count} frames",
                self.frame_count
            )));
        }
        let required_duration_ms = (duration_seconds * 1_000.0).ceil() as u64;
        if covered_duration_ms < required_duration_ms {
            return Err(ModelError::Invalid(format!(
                "smart layer artifacts cover {covered_duration_ms}ms, less than the required {required_duration_ms}ms"
            )));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SmartLayerSourceItemSnapshot {
    pub track_id: String,
    pub item_id: String,
    pub asset_id: String,
    pub start_seconds: f64,
    pub duration_seconds: f64,
    pub source_in_seconds: f64,
    pub source_out_seconds: Option<f64>,
    pub speed: f64,
}

impl SmartLayerSourceItemSnapshot {
    fn validate(&self) -> Result<(), ModelError> {
        if self.track_id.trim().is_empty()
            || self.item_id.trim().is_empty()
            || self.asset_id.trim().is_empty()
        {
            return Err(ModelError::Invalid(
                "smart layer source trackId, itemId, and assetId must not be empty".into(),
            ));
        }
        validate_non_negative(self.start_seconds, "smart layer source startSeconds")?;
        validate_positive(self.duration_seconds, "smart layer source durationSeconds")?;
        validate_non_negative(self.source_in_seconds, "smart layer source sourceInSeconds")?;
        validate_optional_non_negative(
            self.source_out_seconds,
            "smart layer source sourceOutSeconds",
        )?;
        validate_positive(self.speed, "smart layer source speed")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    pub position_x: f64,
    pub position_y: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub rotation_degrees: f64,
    pub anchor_x: f64,
    pub anchor_y: f64,
    pub crop: Crop,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Mask {
    pub id: String,
    pub name: String,
    pub mode: MaskMode,
    #[serde(default)]
    pub points: Vec<MaskPoint>,
    #[serde(default)]
    pub feather: f64,
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    #[serde(default)]
    pub inverted: bool,
    pub stroke_color: Option<String>,
    #[serde(default)]
    pub stroke_width: f64,
}

impl Mask {
    fn validate(&self) -> Result<(), ModelError> {
        if self.id.is_empty() || self.name.trim().is_empty() {
            return Err(ModelError::Invalid(
                "mask id and name must not be empty".into(),
            ));
        }
        validate_non_negative(self.feather, "mask feather")?;
        validate_unit_interval(self.opacity, "mask opacity")?;
        validate_non_negative(self.stroke_width, "mask strokeWidth")?;
        for point in &self.points {
            if !point.x.is_finite() || !point.y.is_finite() {
                return Err(ModelError::Invalid(
                    "mask point coordinates must be finite".into(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MaskMode {
    Add,
    Subtract,
    Intersect,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MaskPoint {
    pub x: f64,
    pub y: f64,
}

impl Default for Transform {
    fn default() -> Self {
        Self {
            position_x: 0.0,
            position_y: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            rotation_degrees: 0.0,
            anchor_x: 0.5,
            anchor_y: 0.5,
            crop: Crop::default(),
        }
    }
}

impl Transform {
    fn validate(&self) -> Result<(), ModelError> {
        for (label, value) in [
            ("positionX", self.position_x),
            ("positionY", self.position_y),
            ("scaleX", self.scale_x),
            ("scaleY", self.scale_y),
            ("rotationDegrees", self.rotation_degrees),
            ("anchorX", self.anchor_x),
            ("anchorY", self.anchor_y),
        ] {
            if !value.is_finite() {
                return Err(ModelError::Invalid(format!(
                    "transform {label} must be finite"
                )));
            }
        }
        self.crop.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct Crop {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

impl Crop {
    fn validate(&self) -> Result<(), ModelError> {
        for (label, value) in [
            ("left", self.left),
            ("top", self.top),
            ("right", self.right),
            ("bottom", self.bottom),
        ] {
            validate_unit_interval(value, &format!("crop {label}"))?;
        }
        if self.left + self.right >= 1.0 || self.top + self.bottom >= 1.0 {
            return Err(ModelError::Invalid(
                "opposing crop values must sum to less than 1".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum BlendMode {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
    HardLight,
    SoftLight,
    Difference,
    Exclusion,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AudioProperties {
    pub volume: f64,
    pub pan: f64,
    #[serde(default = "default_true")]
    pub maintain_pitch: bool,
    pub muted: bool,
    pub fade_in_seconds: f64,
    pub fade_out_seconds: f64,
}

impl Default for AudioProperties {
    fn default() -> Self {
        Self {
            volume: 1.0,
            pan: 0.0,
            maintain_pitch: true,
            muted: false,
            fade_in_seconds: 0.0,
            fade_out_seconds: 0.0,
        }
    }
}

impl AudioProperties {
    fn validate(&self) -> Result<(), ModelError> {
        if !self.volume.is_finite() || self.volume < 0.0 {
            return Err(ModelError::Invalid(
                "audio volume must be a finite non-negative number".into(),
            ));
        }
        if !self.pan.is_finite() || !(-1.0..=1.0).contains(&self.pan) {
            return Err(ModelError::Invalid(
                "audio pan must be between -1 and 1".into(),
            ));
        }
        validate_non_negative(self.fade_in_seconds, "audio fadeInSeconds")?;
        validate_non_negative(self.fade_out_seconds, "audio fadeOutSeconds")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TextProperties {
    pub content: String,
    pub font_family: String,
    pub font_size: f64,
    pub font_weight: u16,
    pub italic: bool,
    pub underline: bool,
    pub color: String,
    pub background_color: Option<String>,
    pub alignment: TextAlignment,
    pub vertical_alignment: VerticalAlignment,
    pub line_height: f64,
    pub letter_spacing: f64,
    pub stroke_color: Option<String>,
    pub stroke_width: f64,
    pub shadow: Option<TextShadow>,
    pub box_width: Option<f64>,
    pub box_height: Option<f64>,
    #[serde(default)]
    pub rich_spans: Vec<RichTextSpan>,
    #[serde(default)]
    pub extensions: Map<String, Value>,
}

impl Default for TextProperties {
    fn default() -> Self {
        Self {
            content: "Text".into(),
            font_family: "Inter".into(),
            font_size: 64.0,
            font_weight: 400,
            italic: false,
            underline: false,
            color: "#ffffff".into(),
            background_color: None,
            alignment: TextAlignment::Center,
            vertical_alignment: VerticalAlignment::Middle,
            line_height: 1.2,
            letter_spacing: 0.0,
            stroke_color: None,
            stroke_width: 0.0,
            shadow: None,
            box_width: None,
            box_height: None,
            rich_spans: Vec::new(),
            extensions: Map::new(),
        }
    }
}

impl TextProperties {
    fn validate(&self) -> Result<(), ModelError> {
        if self.font_family.trim().is_empty() {
            return Err(ModelError::Invalid(
                "text fontFamily must not be empty".into(),
            ));
        }
        validate_positive(self.font_size, "text fontSize")?;
        validate_positive(self.line_height, "text lineHeight")?;
        validate_non_negative(self.stroke_width, "text strokeWidth")?;
        validate_optional_positive(self.box_width, "text boxWidth")?;
        validate_optional_positive(self.box_height, "text boxHeight")?;
        if let Some(shadow) = &self.shadow {
            validate_non_negative(shadow.blur, "text shadow blur")?;
            for value in [shadow.offset_x, shadow.offset_y] {
                if !value.is_finite() {
                    return Err(ModelError::Invalid(
                        "text shadow offsets must be finite".into(),
                    ));
                }
            }
        }
        for span in &self.rich_spans {
            if span.start >= span.end || span.end > self.content.len() {
                return Err(ModelError::Invalid(
                    "rich text span must be non-empty and inside text content".into(),
                ));
            }
            validate_optional_positive(span.font_size, "rich text span fontSize")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RichTextSpan {
    pub start: usize,
    pub end: usize,
    pub font_family: Option<String>,
    pub font_size: Option<f64>,
    pub font_weight: Option<u16>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TextAlignment {
    Left,
    Center,
    Right,
    Justify,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum VerticalAlignment {
    Top,
    Middle,
    Bottom,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TextShadow {
    pub color: String,
    pub offset_x: f64,
    pub offset_y: f64,
    pub blur: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShapeProperties {
    pub shape_type: String,
    pub fill_color: String,
    pub stroke_color: Option<String>,
    pub stroke_width: f64,
    pub corner_radius: f64,
    #[serde(default)]
    pub parameters: Map<String, Value>,
}

impl ShapeProperties {
    fn validate(&self) -> Result<(), ModelError> {
        if self.shape_type.trim().is_empty() || self.fill_color.trim().is_empty() {
            return Err(ModelError::Invalid(
                "shape type and fillColor must not be empty".into(),
            ));
        }
        validate_non_negative(self.stroke_width, "shape strokeWidth")?;
        validate_non_negative(self.corner_radius, "shape cornerRadius")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub id: String,
    pub effect_type: String,
    pub name: String,
    pub enabled: bool,
    #[serde(default)]
    pub parameters: Map<String, Value>,
    #[serde(default)]
    pub extensions: Map<String, Value>,
}

impl Effect {
    fn validate(&self) -> Result<(), ModelError> {
        if self.id.is_empty() || self.effect_type.trim().is_empty() || self.name.trim().is_empty() {
            return Err(ModelError::Invalid(
                "effect id, effectType, and name must not be empty".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Keyframe {
    pub id: String,
    pub property: String,
    pub time_seconds: f64,
    #[serde(default)]
    pub time: Option<MediaTime>,
    pub value: Value,
    pub interpolation: KeyframeInterpolation,
    pub easing: Option<CubicBezier>,
}

impl Keyframe {
    fn validate(&self, duration_seconds: f64) -> Result<(), ModelError> {
        if self.id.is_empty() || self.property.trim().is_empty() {
            return Err(ModelError::Invalid(
                "keyframe id and property must not be empty".into(),
            ));
        }
        validate_non_negative(self.time_seconds, "keyframe timeSeconds")?;
        if self.time_seconds > duration_seconds {
            return Err(ModelError::Invalid(format!(
                "keyframe `{}` lies after its timeline item duration",
                self.id
            )));
        }
        if let Some(easing) = &self.easing {
            for value in [easing.x1, easing.y1, easing.x2, easing.y2] {
                if !value.is_finite() {
                    return Err(ModelError::Invalid(
                        "keyframe easing values must be finite".into(),
                    ));
                }
            }
        }
        Ok(())
    }

    fn sync_exact(&mut self, time_base: Rational, legacy_seconds_are_source: bool) {
        sync_time(
            &mut self.time_seconds,
            &mut self.time,
            time_base,
            legacy_seconds_are_source,
        );
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum KeyframeInterpolation {
    Hold,
    Linear,
    Bezier,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CubicBezier {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub id: String,
    pub transition_type: String,
    pub from_item_id: Option<String>,
    pub to_item_id: Option<String>,
    pub start_seconds: f64,
    pub duration_seconds: f64,
    #[serde(default)]
    pub start: Option<MediaTime>,
    #[serde(default)]
    pub duration: Option<MediaTime>,
    pub enabled: bool,
    #[serde(default)]
    pub parameters: Map<String, Value>,
}

impl Transition {
    fn validate(&self, item_ids: &HashSet<String>) -> Result<(), ModelError> {
        if self.id.is_empty() || self.transition_type.trim().is_empty() {
            return Err(ModelError::Invalid(
                "transition id and transitionType must not be empty".into(),
            ));
        }
        if self.from_item_id.is_none() && self.to_item_id.is_none() {
            return Err(ModelError::Invalid(format!(
                "transition `{}` must reference at least one item",
                self.id
            )));
        }
        validate_non_negative(self.start_seconds, "transition startSeconds")?;
        validate_positive(self.duration_seconds, "transition durationSeconds")?;
        for id in [&self.from_item_id, &self.to_item_id].into_iter().flatten() {
            if !item_ids.contains(id) {
                return Err(ModelError::Invalid(format!(
                    "transition `{}` references unknown item `{id}`",
                    self.id
                )));
            }
        }
        Ok(())
    }

    fn sync_exact(&mut self, time_base: Rational, legacy_seconds_are_source: bool) {
        sync_time(
            &mut self.start_seconds,
            &mut self.start,
            time_base,
            legacy_seconds_are_source,
        );
        sync_time(
            &mut self.duration_seconds,
            &mut self.duration,
            time_base,
            legacy_seconds_are_source,
        );
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: String,
    pub time_seconds: f64,
    #[serde(default)]
    pub time: Option<MediaTime>,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
    #[serde(default)]
    pub duration: Option<MediaTime>,
    pub name: String,
    pub color: String,
    pub note: Option<String>,
}

impl Marker {
    fn sync_exact(&mut self, time_base: Rational, legacy_seconds_are_source: bool) {
        sync_time(
            &mut self.time_seconds,
            &mut self.time,
            time_base,
            legacy_seconds_are_source,
        );
        sync_optional_time(
            &mut self.duration_seconds,
            &mut self.duration,
            time_base,
            legacy_seconds_are_source,
        );
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct SelectionState {
    #[serde(default)]
    pub asset_ids: BTreeSet<String>,
    #[serde(default)]
    pub track_ids: BTreeSet<String>,
    #[serde(default)]
    pub item_ids: BTreeSet<String>,
    #[serde(default)]
    pub effect_ids: BTreeSet<String>,
}

impl SelectionState {
    pub fn is_empty(&self) -> bool {
        self.asset_ids.is_empty()
            && self.track_ids.is_empty()
            && self.item_ids.is_empty()
            && self.effect_ids.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackState {
    pub playing: bool,
    pub position_seconds: f64,
    #[serde(default)]
    pub position: Option<MediaTime>,
    pub rate: f64,
    pub loop_enabled: bool,
    pub loop_start_seconds: Option<f64>,
    pub loop_end_seconds: Option<f64>,
    #[serde(default)]
    pub loop_start: Option<MediaTime>,
    #[serde(default)]
    pub loop_end: Option<MediaTime>,
    pub volume: f64,
    pub muted: bool,
}

impl PlaybackState {
    fn validate(&self) -> Result<(), ModelError> {
        validate_non_negative(self.position_seconds, "playback positionSeconds")?;
        validate_positive(self.rate, "playback rate")?;
        validate_unit_interval(self.volume, "playback volume")?;
        validate_optional_non_negative(self.loop_start_seconds, "playback loopStartSeconds")?;
        validate_optional_non_negative(self.loop_end_seconds, "playback loopEndSeconds")?;
        if let (Some(start), Some(end)) = (self.loop_start_seconds, self.loop_end_seconds)
            && end <= start
        {
            return Err(ModelError::Invalid(
                "playback loopEndSeconds must be after loopStartSeconds".into(),
            ));
        }
        Ok(())
    }

    fn sync_exact(&mut self, time_base: Rational, legacy_seconds_are_source: bool) {
        sync_time(
            &mut self.position_seconds,
            &mut self.position,
            time_base,
            legacy_seconds_are_source,
        );
        sync_optional_time(
            &mut self.loop_start_seconds,
            &mut self.loop_start,
            time_base,
            legacy_seconds_are_source,
        );
        sync_optional_time(
            &mut self.loop_end_seconds,
            &mut self.loop_end,
            time_base,
            legacy_seconds_are_source,
        );
    }
}

impl Default for PlaybackState {
    fn default() -> Self {
        Self {
            playing: false,
            position_seconds: 0.0,
            position: Some(MediaTime::from_seconds(0.0, Rational::default())),
            rate: 1.0,
            loop_enabled: false,
            loop_start_seconds: None,
            loop_end_seconds: None,
            loop_start: None,
            loop_end: None,
            volume: 1.0,
            muted: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub active_panel: String,
    pub snapping_enabled: bool,
    pub ripple_edit_enabled: bool,
    pub preview_quality: String,
    #[serde(default)]
    pub panel_state: Map<String, Value>,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            active_panel: "timeline".into(),
            snapping_enabled: true,
            ripple_edit_enabled: false,
            preview_quality: "auto".into(),
            panel_state: Map::new(),
        }
    }
}

impl WorkspaceState {
    fn validate(&self) -> Result<(), ModelError> {
        if self.active_panel.trim().is_empty() || self.preview_quality.trim().is_empty() {
            return Err(ModelError::Invalid(
                "workspace activePanel and previewQuality must not be empty".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum ModelError {
    #[error("invalid editor state: {0}")]
    Invalid(String),
    #[error("duplicate {kind} id `{id}`")]
    DuplicateId { kind: &'static str, id: String },
}

fn ensure_unique<'a>(
    ids: impl IntoIterator<Item = &'a str>,
    kind: &'static str,
) -> Result<(), ModelError> {
    let mut seen = HashSet::new();
    for id in ids {
        if id.is_empty() {
            return Err(ModelError::Invalid(format!("{kind} id must not be empty")));
        }
        if !seen.insert(id) {
            return Err(ModelError::DuplicateId {
                kind,
                id: id.into(),
            });
        }
    }
    Ok(())
}

fn sync_time(
    seconds: &mut f64,
    exact: &mut Option<MediaTime>,
    time_base: Rational,
    legacy_seconds_are_source: bool,
) {
    if !legacy_seconds_are_source && let Some(value) = exact {
        *seconds = value.as_seconds();
    }
    *exact = Some(MediaTime::from_seconds(*seconds, time_base));
    *seconds = exact.expect("set above").as_seconds();
}

fn sync_optional_time(
    seconds: &mut Option<f64>,
    exact: &mut Option<MediaTime>,
    time_base: Rational,
    legacy_seconds_are_source: bool,
) {
    if !legacy_seconds_are_source && let Some(value) = exact {
        *seconds = Some(value.as_seconds());
    }
    *exact = seconds.map(|seconds| MediaTime::from_seconds(seconds, time_base));
    *seconds = exact.map(MediaTime::as_seconds);
}

fn greatest_common_divisor(mut left: u64, mut right: u64) -> u64 {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left.max(1)
}

fn validate_non_negative(value: f64, label: &str) -> Result<(), ModelError> {
    if value.is_finite() && value >= 0.0 {
        Ok(())
    } else {
        Err(ModelError::Invalid(format!(
            "{label} must be a finite non-negative number"
        )))
    }
}

fn validate_positive(value: f64, label: &str) -> Result<(), ModelError> {
    if value.is_finite() && value > 0.0 {
        Ok(())
    } else {
        Err(ModelError::Invalid(format!(
            "{label} must be a finite positive number"
        )))
    }
}

fn validate_optional_non_negative(value: Option<f64>, label: &str) -> Result<(), ModelError> {
    value.map_or(Ok(()), |value| validate_non_negative(value, label))
}

fn validate_optional_positive(value: Option<f64>, label: &str) -> Result<(), ModelError> {
    value.map_or(Ok(()), |value| validate_positive(value, label))
}

fn validate_unit_interval(value: f64, label: &str) -> Result<(), ModelError> {
    if value.is_finite() && (0.0..=1.0).contains(&value) {
        Ok(())
    } else {
        Err(ModelError::Invalid(format!(
            "{label} must be between 0 and 1"
        )))
    }
}
