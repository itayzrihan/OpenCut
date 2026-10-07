//! Playhead sampling for canonical edits. Keep Classic's stable equal-time,
//! edge extrapolation and twenty-step Bezier solver semantics.
use super::*;

pub(super) fn path_value(
    data: &Value,
    target: &Value,
    time: f64,
) -> Result<Value, CapabilityError> {
    let fallback = &target["baseValue"];
    if data["keys"].is_array() {
        return channel_value(data, fallback, time);
    }
    if !data.is_object()
        || !fallback.is_string()
        || ["r", "g", "b", "a"].iter().any(|k| data.get(k).is_none())
    {
        return Ok(fallback.clone());
    }
    let color_components = ["r", "g", "b", "a"]
        .map(|key| json!({"key":key,"valueKind":"scalar","defaultInterpolation":"linear"}));
    let color_param = json!({"type":"color", "channelLayout":{
        "kind":"composite", "codec":"linearRgba", "components":
        color_components
    }});
    let Ok(components) = upsert::values(
        &color_param,
        &upsert::ParamValue::Text(fallback.as_str().unwrap().into()),
    ) else {
        return Ok(fallback.clone());
    };
    let mut rgba = [0.0; 4];
    for (i, (key, base, _, _)) in components.iter().enumerate() {
        rgba[i] = channel_value(&data[key], base, time)?
            .as_f64()
            .ok_or_else(|| invalid("invalid sampled color component"))?;
    }
    Ok(format_rgba(rgba))
}

pub(super) fn format_rgba(rgba: [f64; 4]) -> Value {
    let mut text = String::from("#");
    for value in &rgba[..3] {
        let v = value.clamp(0.0, 1.0);
        let srgb = if v <= 0.0031308 {
            v * 12.92
        } else {
            1.055 * v.powf(1.0 / 2.4) - 0.055
        };
        text.push_str(&format!(
            "{:02x}",
            (srgb.clamp(0.0, 1.0) * 255.0).round() as u8
        ));
    }
    if rgba[3] < 1.0 {
        text.push_str(&format!(
            "{:02x}",
            (rgba[3].clamp(0.0, 1.0) * 255.0).round() as u8
        ));
    }
    json!(text)
}

pub(super) fn channel_value(
    data: &Value,
    fallback: &Value,
    time: f64,
) -> Result<Value, CapabilityError> {
    if data.is_null() || is_scalar(data) != fallback.is_number() {
        return Ok(fallback.clone());
    }
    validate_channel(data)?;
    let mut channel = data.clone();
    normalize_channel(&mut channel)?;
    let keys = channel["keys"].as_array().unwrap();
    if keys.is_empty() {
        return Ok(fallback.clone());
    }
    if !fallback.is_number() {
        return Ok(keys
            .iter()
            .take_while(|k| tick(k) <= time)
            .last()
            .map_or(fallback, |k| &k["value"])
            .clone());
    }
    let first = &keys[0];
    let last = keys.last().unwrap();
    let result = if time <= tick(first) {
        edge(
            first,
            keys.get(1),
            time,
            &channel["extrapolation"]["before"],
        )
    } else if time >= tick(last) {
        edge(
            last,
            keys.len().checked_sub(2).map(|i| &keys[i]),
            time,
            &channel["extrapolation"]["after"],
        )
    } else {
        let mut value = number(last);
        for pair in keys.windows(2) {
            let (left, right) = (&pair[0], &pair[1]);
            if time == tick(right) {
                value = number(right);
                break;
            }
            if time < tick(left) || time > tick(right) {
                continue;
            }
            let span = tick(right) - tick(left);
            value = if left["segmentToNext"] == "step" {
                number(left)
            } else if span == 0.0 {
                number(right)
            } else if left["segmentToNext"] == "linear" {
                number(left)
                    + (number(right) - number(left)) * ((time - tick(left)) / span).clamp(0.0, 1.0)
            } else {
                let delta = number(right) - number(left);
                let rdt = left["rightHandle"]["dt"].as_f64().unwrap_or(span / 3.0);
                let ldt = right["leftHandle"]["dt"].as_f64().unwrap_or(-span / 3.0);
                let rdv = left["rightHandle"]["dv"].as_f64().unwrap_or(delta / 3.0);
                let ldv = right["leftHandle"]["dv"].as_f64().unwrap_or(-delta / 3.0);
                let (mut lower, mut upper) = (0.0, 1.0);
                for _ in 0..20 {
                    let mid = (lower + upper) / 2.0;
                    if bezier(
                        mid,
                        tick(left),
                        tick(left) + rdt,
                        tick(right) + ldt,
                        tick(right),
                    ) < time
                    {
                        lower = mid;
                    } else {
                        upper = mid;
                    }
                }
                bezier(
                    (lower + upper) / 2.0,
                    number(left),
                    number(left) + rdv,
                    number(right) + ldv,
                    number(right),
                )
            };
            break;
        }
        value
    };
    if !result.is_finite() {
        return Err(invalid("animation sample overflow"));
    }
    Ok(json!(result))
}
fn tick(key: &Value) -> f64 {
    key["time"].as_f64().unwrap()
}
fn number(key: &Value) -> f64 {
    key["value"].as_f64().unwrap()
}
fn edge(key: &Value, neighbor: Option<&Value>, time: f64, mode: &Value) -> f64 {
    if mode != "linear" || time == tick(key) {
        return number(key);
    }
    let Some(neighbor) = neighbor else {
        return number(key);
    };
    let span = tick(neighbor) - tick(key);
    if span == 0.0 {
        number(key)
    } else {
        number(key) + ((time - tick(key)) / span) * (number(neighbor) - number(key))
    }
}
fn bezier(t: f64, a: f64, b: f64, c: f64, d: f64) -> f64 {
    let m = 1.0 - t;
    m * m * m * a + 3.0 * m * m * t * b + 3.0 * m * t * t * c + t * t * t * d
}
