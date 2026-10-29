//! Earshot source contract shared by plan compilers and canonical editor state.
//! These are inert definitions; only the isolated audio host executes them.
use serde_json::Value;

pub const EARSHOT_BANK_REVISION: &str = "591fa3e028032e6dce56620a20e932e35667e8d8";

fn bounded(value: &Value, min: f64, max: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|v| v.is_finite() && (min..=max).contains(&v))
}

fn valid_note(note: &str) -> bool {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        regex::Regex::new(r"^(?:[A-Ga-g](?:#|b|s)?[0-9]|[0-9]+(?:\.[0-9]+)?(?:hz)?)$").unwrap()
    });
    let bytes = note.as_bytes();
    if bytes.len() > 24 || !pattern.is_match(note) {
        return false;
    }
    if bytes[0].is_ascii_digit() {
        return note
            .strip_suffix("hz")
            .unwrap_or(note)
            .parse::<f64>()
            .is_ok_and(|hz| hz.is_finite() && (20.0..=20_000.0).contains(&hz));
    }
    let base = match bytes[0].to_ascii_uppercase() {
        b'C' => 0,
        b'D' => 2,
        b'E' => 4,
        b'F' => 5,
        b'G' => 7,
        b'A' => 9,
        b'B' => 11,
        _ => return false,
    };
    let (offset, accidental) = match bytes.get(1) {
        Some(b'#' | b's') => (2, 1),
        Some(b'b') => (2, -1),
        _ => (1, 0),
    };
    let Ok(octave) = note[offset..].parse::<i32>() else {
        return false;
    };
    if !(0..=9).contains(&octave) {
        return false;
    }
    let midi = (octave + 1) * 12 + base + accidental;
    let hz = 440.0 * 2_f64.powf((midi as f64 - 69.0) / 12.0);
    (20.0..=20_000.0).contains(&hz)
}

pub fn validate_procedural_audio_source(source: &Value) -> Result<(), String> {
    let fields = source
        .as_object()
        .ok_or("Procedural source must be an object")?;
    let allowed = [
        "version",
        "engine",
        "bankRevision",
        "presetId",
        "seed",
        "duration",
        "apex",
        "pitch",
        "parameters",
        "sourceCode",
        "echo",
    ];
    if fields.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Unknown procedural audio source field".into());
    }
    if source["version"].as_u64() != Some(1)
        || source["engine"] != "earshot"
        || source["bankRevision"] != EARSHOT_BANK_REVISION
    {
        return Err("Unsupported Earshot source version, engine or bank revision".into());
    }
    if !source["presetId"].as_str().is_some_and(|id| {
        let parts: Vec<_> = id.split('/').collect();
        id.len() <= 128
            && (2..=3).contains(&parts.len())
            && parts.iter().all(|part| {
                !part.is_empty()
                    && part.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || b"_.-".contains(&b)
                    })
            })
    }) {
        return Err("Earshot presetId must be a bounded catalog identifier".into());
    }
    if !source["seed"]
        .as_u64()
        .is_some_and(|seed| seed <= u32::MAX as u64)
    {
        return Err("Earshot seed must be an unsigned 32-bit integer".into());
    }
    if !bounded(&source["duration"], 0.02, 30.0)
        || fields
            .get("apex")
            .is_some_and(|value| !bounded(value, 0.0, source["duration"].as_f64().unwrap_or(0.0)))
    {
        return Err("Earshot duration must be 0.02..30 seconds and apex within the source".into());
    }
    if let Some(pitch) = fields.get("pitch") {
        if !(bounded(pitch, 20.0, 20_000.0) || pitch.as_str().is_some_and(valid_note)) {
            return Err(
                "Earshot pitch must be 20..20000 Hz or a scientific note in that range".into(),
            );
        }
    }
    if let Some(parameters) = fields.get("parameters") {
        let map = parameters
            .as_object()
            .ok_or("Earshot parameters must be an object")?;
        if map.len() > 64
            || map.iter().any(|(key, value)| {
                key.is_empty()
                    || key.len() > 64
                    || !key.as_bytes()[0].is_ascii_alphabetic()
                    || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                    || !bounded(value, -1e6, 1e6)
            })
        {
            return Err("Earshot accepts up to 64 named finite numeric parameters".into());
        }
    }
    if let Some(code) = fields.get("sourceCode") {
        if !code.as_str().is_some_and(|code| {
            !code.trim().is_empty() && code.len() <= 32_768 && !code.contains('\0')
        }) {
            return Err("Earshot sourceCode must contain 1..32768 UTF-8 bytes without NUL".into());
        }
    }
    if let Some(echo) = fields.get("echo") {
        let fields = echo.as_object().ok_or("Earshot echo must be an object")?;
        if fields
            .keys()
            .any(|key| !["delay", "feedback", "mix"].contains(&key.as_str()))
            || !bounded(&echo["delay"], 0.005, 2.0)
            || !bounded(&echo["feedback"], 0.0, 0.9)
            || !bounded(&echo["mix"], 0.0, 1.0)
        {
            return Err(
                "Earshot echo requires delay 0.005..2 seconds, feedback 0..0.9 and mix 0..1".into(),
            );
        }
    }
    Ok(())
}

pub fn validate_procedural_audio_element(element: &Value) -> Result<(), String> {
    let procedural = element.get("procedural");
    if procedural.is_none() && element["sourceType"] != "procedural" {
        return Ok(());
    }
    if element["type"] != "audio" || element["sourceType"] != "procedural" {
        return Err("A procedural source requires an audio clip with sourceType procedural".into());
    }
    if [
        "mediaId",
        "sourceUrl",
        "libraryAssetId",
        "librarySourceType",
        "file",
        "buffer",
    ]
    .iter()
    .any(|key| element.get(key).is_some())
    {
        return Err(
            "Procedural audio stores code and parameters, never a file or media binding".into(),
        );
    }
    let source = procedural.ok_or("Procedural audio source is required")?;
    validate_procedural_audio_source(source)?;
    let source_ticks = (source["duration"].as_f64().unwrap() * 120_000.0).round() as i64;
    if element
        .get("sourceDuration")
        .is_some_and(|value| value.as_i64() != Some(source_ticks))
    {
        return Err(
            "Procedural sourceDuration must match its synthesized duration in ticks".into(),
        );
    }
    if let (Some(start), Some(end), Some(duration)) = (
        element["trimStart"].as_i64(),
        element["trimEnd"].as_i64(),
        element["duration"].as_i64(),
    ) {
        let rate = element["retime"]["rate"].as_f64().unwrap_or(1.0);
        if start < 0
            || end < 0
            || duration < 0
            || !rate.is_finite()
            || !(0.01..=5.0).contains(&rate)
            || start as f64 + end as f64 + duration as f64 * rate
                > source_ticks as f64 + rate.max(1.0)
        {
            return Err("Procedural clip timing exceeds its synthesized source".into());
        }
    }
    Ok(())
}
