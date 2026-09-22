//! Local detector acceptance and face/body association; no network or model prompt.
use bridge::export;
use serde::{Deserialize, Serialize};
use serde_json::json;
#[derive(Deserialize)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    score: f64,
}
#[derive(Deserialize)]
struct Frame {
    width: f64,
    height: f64,
    faces: Vec<Rect>,
    #[serde(default)]
    poses: Vec<Vec<Landmark>>,
}
#[derive(Deserialize)]
struct Landmark {
    x: f64,
    y: f64,
    visibility: f64,
    presence: f64,
}
fn visible(p: &Landmark) -> bool {
    [p.x, p.y, p.visibility, p.presence]
        .iter()
        .all(|v| v.is_finite())
        && (0.0..=1.0).contains(&p.x)
        && (0.0..=1.0).contains(&p.y)
        && (0.7..=1.0).contains(&p.visibility)
        && (0.7..=1.0).contains(&p.presence)
}
fn torso_center(p: &[Landmark], face: &Rect, f: &Frame) -> Option<f64> {
    if p.len() != 33 || ![0, 11, 12].iter().all(|i| visible(&p[*i])) {
        return None;
    }
    let nose = &p[0];
    if nose.x * f.width < face.x - face.width * 0.2
        || nose.x * f.width > face.x + face.width * 1.2
        || nose.y * f.height < face.y - face.height * 0.2
        || nose.y * f.height > face.y + face.height * 1.2
    {
        return None;
    }
    let shoulders = (&p[11], &p[12]);
    if (shoulders.0.x - shoulders.1.x).abs() < face.width / f.width * 0.6
        || (shoulders.0.y + shoulders.1.y) / 2. <= nose.y
    {
        return None;
    }
    let mut center = (shoulders.0.x + shoulders.1.x) / 2.;
    if visible(&p[23]) && visible(&p[24]) && p[23].y > shoulders.0.y && p[24].y > shoulders.1.y {
        center = center * 0.75 + (p[23].x + p[24].x) / 2. * 0.25;
    }
    (((face.x + face.width / 2.) / f.width - center).abs() <= 0.12).then_some(center)
}
#[derive(Deserialize)]
struct Input {
    frames: Vec<Frame>,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSubjectFramingOptions {
    pub detections_json: String,
}
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalSubjectFramingResult {
    pub valid: bool,
    pub error: String,
    pub samples_json: String,
    pub accepted_frames: usize,
    pub body_frames: usize,
}
fn usable(r: &Rect, f: &Frame, min_score: f64) -> bool {
    [r.x, r.y, r.width, r.height, r.score]
        .iter()
        .all(|v| v.is_finite())
        && r.x >= 0.
        && r.y >= 0.
        && r.width >= 1.
        && r.height >= 1.
        && r.x + r.width <= f.width
        && r.y + r.height <= f.height
        && r.score >= min_score
}
#[export]
pub fn resolve_local_subject_framing(o: LocalSubjectFramingOptions) -> LocalSubjectFramingResult {
    match resolve(&o.detections_json) {
        Ok(r) => r,
        Err(error) => LocalSubjectFramingResult {
            error,
            ..Default::default()
        },
    }
}
fn resolve(raw: &str) -> Result<LocalSubjectFramingResult, String> {
    let mut input: Input = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    if !(3..=5).contains(&input.frames.len()) {
        return Err("Expected three to five source frames".into());
    }
    // Non-maximum suppression merges overlapping rectangles of the SAME face.
    for f in &mut input.frames {
        let mut indices: Vec<_> = (0..f.faces.len())
            .filter(|i| usable(&f.faces[*i], f, 5.))
            .collect();
        indices.sort_by(|a, b| f.faces[*b].score.total_cmp(&f.faces[*a].score));
        let mut kept: Vec<usize> = Vec::new();
        for i in indices {
            let a = &f.faces[i];
            if kept.iter().all(|j| {
                let b = &f.faces[*j];
                let intersection = ((a.x + a.width).min(b.x + b.width) - a.x.max(b.x)).max(0.)
                    * ((a.y + a.height).min(b.y + b.height) - a.y.max(b.y)).max(0.);
                intersection / (a.width * a.height).min(b.width * b.height) < 0.5
            }) {
                kept.push(i);
            }
        }
        let mut n = 0;
        f.faces.retain(|_| {
            let keep = kept.contains(&n);
            n += 1;
            keep
        });
    }
    let count = input.frames.len();
    let mut samples = Vec::new();
    let mut centers = Vec::new();
    let mut body_frames = 0;
    for f in &input.frames {
        if !f.width.is_finite() || !f.height.is_finite() || f.width < 1. || f.height < 1. {
            return Err("Invalid source dimensions".into());
        }
    }
    // Require one geometrically consistent detection across a majority of samples.
    // A transient hand/background false positive is not a second persistent subject.
    let near = |a: &Rect, fa: &Frame, b: &Rect, fb: &Frame| {
        let aw = a.width / fa.width;
        let bw = b.width / fb.width;
        ((a.x + a.width / 2.) / fa.width - (b.x + b.width / 2.) / fb.width).abs()
            <= (aw.max(bw) * 0.9).max(0.06)
            && ((a.y + a.height / 2.) / fa.height - (b.y + b.height / 2.) / fb.height).abs()
                <= (a.height / fa.height).max(b.height / fb.height) * 0.9
            && bw / aw >= 0.5
            && bw / aw <= 2.
    };
    let mut tracks: Vec<Vec<Option<usize>>> = Vec::new();
    for sf in &input.frames {
        for seed in sf.faces.iter().filter(|r| usable(r, sf, 5.)) {
            let mut track = Vec::new();

            for f in &input.frames {
                let matches: Vec<_> = f
                    .faces
                    .iter()
                    .enumerate()
                    .filter(|(_, r)| usable(r, f, 5.) && near(seed, sf, r, f))
                    .map(|(i, _)| i)
                    .collect();
                if matches.len() > 1 {
                    track.push(None);
                    continue;
                }
                track.push(matches.first().copied());
            }
            let hits = track.iter().flatten().count();
            if hits >= 3
                && hits * 2 > count
                && !tracks.iter().any(|prior| {
                    prior
                        .iter()
                        .zip(&track)
                        .filter(|(a, b)| a.is_some() && a == b)
                        .count()
                        >= 3
                })
            {
                tracks.push(track);
            }
        }
    }
    if tracks.len() != 1 {
        return Err(if tracks.is_empty() {
            "Not enough consistent local face detections; framing unchanged"
        } else {
            "Multiple persistent faces detected; framing unchanged"
        }
        .into());
    }
    for (f, index) in input.frames.iter().zip(&tracks[0]) {
        let Some(index) = index else { continue };
        let face = &f.faces[*index];
        let fx = (face.x + face.width / 2.) / f.width;
        let bodies: Vec<_> = f
            .poses
            .iter()
            .filter_map(|p| torso_center(p, face, f))
            .collect();
        // Missing/ambiguous torso: center the observed face, never invent a body detection.
        let bx = if bodies.len() == 1 {
            body_frames += 1;
            bodies[0]
        } else {
            fx
        };
        centers.push(fx * 0.8 + bx * 0.2);
        // confidence=1 is an acceptance flag for the existing crop compiler, not a model probability.
        samples.push(json!({"faceX":fx,"bodyX":bx,"confidence":1.,"personCount":1}));
    }
    if samples.len() < 3 || samples.len() * 2 <= count {
        return Err("Not enough reliable local face detections; framing unchanged".into());
    }
    centers.sort_by(f64::total_cmp);
    if centers.last().unwrap() - centers[0] > 0.12 {
        return Err("Subject moves too far for a stable crop; framing unchanged".into());
    }
    Ok(LocalSubjectFramingResult {
        valid: true,
        accepted_frames: samples.len(),
        body_frames,
        samples_json: json!(samples).to_string(),
        ..Default::default()
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn frame(x: f64, score: f64) -> serde_json::Value {
        json!({"width":640,"height":360,"faces":[{"x":x,"y":60,"width":60,"height":60,"score":score}],"bodies":[]})
    }
    fn run(frames: serde_json::Value) -> LocalSubjectFramingResult {
        resolve_local_subject_framing(LocalSubjectFramingOptions {
            detections_json: json!({"frames":frames}).to_string(),
        })
    }
    #[test]
    fn accepts_majority_and_ignores_weak_false_detections() {
        let mut f = frame(280., 8.);
        f["faces"]
            .as_array_mut()
            .unwrap()
            .push(json!({"x":100,"y":200,"width":50,"height":50,"score":4.9}));
        let r = run(json!([
            f,
            frame(282., 7.),
            frame(279., 8.),
            frame(200., 1.),
            frame(280., 8.)
        ]));
        assert!(r.valid);
        assert_eq!(r.accepted_frames, 4);
        assert_eq!(r.body_frames, 0);
        let s: serde_json::Value = serde_json::from_str(&r.samples_json).unwrap();
        assert_eq!(s[0]["faceX"], s[0]["bodyX"]);
    }
    #[test]
    fn multiple_people_and_low_evidence_fail_closed() {
        let mut f = frame(280., 8.);
        f["faces"]
            .as_array_mut()
            .unwrap()
            .push(json!({"x":100,"y":60,"width":60,"height":60,"score":8.}));
        assert!(!run(json!([f, f, f])).valid);
        assert!(!run(json!([frame(280., 1.), frame(280., 8.), frame(280., 2.)])).valid);
    }
    #[test]
    fn ignores_a_single_strong_background_false_positive() {
        let mut f = frame(280., 8.);
        f["faces"]
            .as_array_mut()
            .unwrap()
            .push(json!({"x":190,"y":220,"width":65,"height":65,"score":7.}));
        assert!(
            run(json!([
                f,
                frame(281., 8.),
                frame(280., 8.),
                frame(279., 8.),
                frame(280., 8.)
            ]))
            .valid
        );
    }
    #[test]
    fn merges_overlapping_rectangles_of_the_same_face() {
        let mut f = frame(280., 8.);
        f["faces"]
            .as_array_mut()
            .unwrap()
            .push(json!({"x":281,"y":45,"width":55,"height":55,"score":6.}));
        let r = run(json!([
            f,
            frame(281., 8.),
            frame(280., 8.),
            frame(279., 8.),
            frame(280., 8.)
        ]));
        assert!(r.valid, "{}", r.error);
        assert_eq!(r.accepted_frames, 5);
    }
    #[test]
    fn fast_motion_fails_closed() {
        assert!(!run(json!([frame(50., 8.), frame(280., 8.), frame(500., 8.)])).valid);
    }
    #[test]
    fn associates_only_a_matching_upper_body() {
        let mut f = frame(280., 8.);
        let mut pose = vec![json!({"x":0.5,"y":0.5,"visibility":0.1,"presence":0.1}); 33];
        pose[0] = json!({"x":0.48,"y":0.25,"visibility":0.99,"presence":0.99});
        pose[11] = json!({"x":0.40,"y":0.45,"visibility":0.99,"presence":0.99});
        pose[12] = json!({"x":0.62,"y":0.45,"visibility":0.99,"presence":0.99});
        f["poses"] = json!([pose]);
        let r = run(json!([f, f, f]));
        assert!(r.valid);
        assert_eq!(r.body_frames, 3);
        let samples: serde_json::Value = serde_json::from_str(&r.samples_json).unwrap();
        assert_eq!(samples[0]["bodyX"], json!(0.51));
        f["poses"][0][0]["x"] = json!(0.1);
        assert_eq!(run(json!([f, f, f])).body_frames, 0);
        f["poses"][0][0]["x"] = json!(0.48);
        f["poses"][0][11]["visibility"] = json!(0.2);
        assert_eq!(run(json!([f, f, f])).body_frames, 0);
    }
}
