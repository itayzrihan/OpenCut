//! Source-anchored retime curves. Integrate playback speed over each segment so
//! the stored source boundaries survive cuts and easing follows playback time.
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Interpolation {
    Hold,
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpeedKeyframe {
    time: i64,
    rate: f64,
    interpolation: Interpolation,
}

impl Interpolation {
    fn integral(&self, u: f64) -> f64 {
        match self {
            Self::Hold => 0.0,
            Self::Linear => u * u / 2.0,
            Self::EaseIn => u.powi(3) / 3.0,
            Self::EaseOut => u * u - u.powi(3) / 3.0,
            Self::EaseInOut => u.powi(3) * (1.0 - u / 2.0),
        }
    }
}

impl SpeedKeyframe {
    fn source_distance(&self, right: &Self, width: f64, elapsed: f64) -> f64 {
        elapsed * self.rate
            + width * (right.rate - self.rate) * self.interpolation.integral(elapsed / width)
    }
}

pub struct SpeedCurve {
    points: Vec<(SpeedKeyframe, f64)>,
}

impl SpeedCurve {
    pub fn parse(retime: &Value) -> Result<Self, &'static str> {
        let Some(raw) = retime.get("speedKeyframes") else {
            return Ok(Self { points: Vec::new() });
        };
        if !raw.as_array().is_some_and(|keys| keys.len() <= 1000) {
            return Err("Speed keyframes must be an array with at most 1000 entries");
        }
        let mut points: Vec<(SpeedKeyframe, f64)> = Vec::new();
        for raw_key in raw.as_array().unwrap() {
            let key: SpeedKeyframe = serde_json::from_value(raw_key.clone())
                .map_err(|_| "Speed keyframes require time, rate and interpolation")?;
            if !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&key.time)
                || !(0.01..=5.0).contains(&key.rate)
            {
                return Err("Speed keyframes require safe source ticks and rates from 0.01 to 5");
            }
            let mapped = if let Some((previous, mapped)) = points.last() {
                if key.time <= previous.time {
                    return Err("Speed keyframe times must be strictly increasing");
                }
                let average = previous.rate
                    + (key.rate - previous.rate) * previous.interpolation.integral(1.0);
                mapped + (key.time - previous.time) as f64 / average
            } else {
                key.time as f64 / key.rate
            };
            points.push((key, mapped));
        }
        if !points.is_empty() && retime["maintainPitch"] == true {
            return Err("Pitch preservation is available only for constant speed");
        }
        Ok(Self { points })
    }

    pub fn timeline_span(&self, start: f64, span: f64, rate: f64) -> f64 {
        if self.points.is_empty() {
            return span / rate;
        }
        self.timeline_at(start + span, rate) - self.timeline_at(start, rate)
    }

    pub fn source_span(&self, start: f64, duration: f64, rate: f64) -> f64 {
        if self.points.is_empty() {
            return duration * rate;
        }
        let time = self.timeline_at(start, rate) + duration;
        let index = self.points.partition_point(|(_, mapped)| *mapped <= time);
        let (left, mapped) = &self.points[index.saturating_sub(1)];
        let elapsed = time - mapped;
        let distance = match self.points.get(index).filter(|_| index > 0) {
            Some((right, right_time)) => left.source_distance(right, right_time - mapped, elapsed),
            None => elapsed * left.rate,
        };
        left.time as f64 + distance - start
    }

    fn timeline_at(&self, source: f64, rate: f64) -> f64 {
        if self.points.is_empty() {
            return source / rate;
        }
        let index = self
            .points
            .partition_point(|(point, _)| point.time as f64 <= source);
        let (left, mapped) = &self.points[index.saturating_sub(1)];
        let elapsed = source - left.time as f64;
        let Some((right, right_time)) = self.points.get(index).filter(|_| index > 0) else {
            return mapped + elapsed / left.rate;
        };
        if elapsed == 0.0
            || left.rate == right.rate
            || matches!(left.interpolation, Interpolation::Hold)
        {
            return mapped + elapsed / left.rate;
        }
        let width = right_time - mapped;
        let mut lower = 0.0;
        let mut upper = width;
        for _ in 0..52 {
            let middle = (lower + upper) / 2.0;
            if left.source_distance(right, width, middle) < elapsed {
                lower = middle;
            } else {
                upper = middle;
            }
        }
        mapped + (lower + upper) / 2.0
    }
}
