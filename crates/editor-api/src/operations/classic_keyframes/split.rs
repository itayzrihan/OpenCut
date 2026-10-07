//! Seek-safe curve splitting for Classic timeline edits. Both halves share
//! one boundary sample and De Casteljau handles, including composite channels.
use super::*;
fn point(a: (f64, f64), b: (f64, f64), t: f64) -> (f64, f64) {
    (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
}
fn tick(v: &Value) -> i64 {
    v["time"].as_i64().unwrap()
}
fn js_round(n: f64) -> i64 {
    (n + 0.5).floor() as i64
}
fn channel(data: &Value, time: i64, id: &str) -> Result<(Value, Value), CapabilityError> {
    validate_channel(data)?;
    let mut normalized = data.clone();
    normalize_channel(&mut normalized)?;
    let keys = normalized["keys"].as_array().unwrap();
    if keys.is_empty() {
        return Ok((Value::Null, Value::Null));
    }
    let scalar = is_scalar(data);
    let mut left: Vec<Value> = keys.iter().filter(|k| tick(k) <= time).cloned().collect();
    let mut right: Vec<Value> = keys
        .iter()
        .filter(|k| tick(k) >= time)
        .map(|k| {
            let mut k = k.clone();
            k["time"] = json!(tick(&k) - time);
            k
        })
        .collect();
    let boundary = keys.iter().any(|k| tick(k) == time);
    if !boundary {
        let value = sample::channel_value(&normalized, &keys[0]["value"], time as f64)?;
        if !scalar {
            left.push(json!({"id":format!("{id}-left"),"time":time,"value":value}));
            right.insert(
                0,
                json!({"id":format!("{id}-right"),"time":0,"value":value}),
            );
        } else if let Some(pair) = keys
            .windows(2)
            .find(|p| tick(&p[0]) < time && tick(&p[1]) > time)
        {
            let (a, b) = (&pair[0], &pair[1]);
            let mut l = json!({"id":format!("{id}-left"),"time":time,"value":value,"segmentToNext":"linear","tangentMode":"flat"});
            let mut r = json!({"id":format!("{id}-right"),"time":0,"value":value,"segmentToNext":a["segmentToNext"],"tangentMode":"flat"});
            if a["segmentToNext"] == "bezier" {
                let span = (tick(b) - tick(a)) as f64;
                let av = a["value"].as_f64().unwrap();
                let bv = b["value"].as_f64().unwrap();
                let delta = bv - av;
                let p0 = (tick(a) as f64, av);
                let p1 = (
                    p0.0 + a["rightHandle"]["dt"].as_f64().unwrap_or(span / 3.0),
                    av + a["rightHandle"]["dv"].as_f64().unwrap_or(delta / 3.0),
                );
                let p3 = (tick(b) as f64, bv);
                let p2 = (
                    p3.0 + b["leftHandle"]["dt"].as_f64().unwrap_or(-span / 3.0),
                    bv + b["leftHandle"]["dv"].as_f64().unwrap_or(-delta / 3.0),
                );
                let (mut lower, mut upper) = (0.0, 1.0);
                for _ in 0..20 {
                    let t = (lower + upper) / 2.0;
                    let q0 = point(p0, p1, t);
                    let q1 = point(p1, p2, t);
                    let q2 = point(p2, p3, t);
                    let middle = point(point(q0, q1, t), point(q1, q2, t), t);
                    if middle.0 < time as f64 {
                        lower = t;
                    } else {
                        upper = t;
                    }
                }
                let t = (lower + upper) / 2.0;
                let q0 = point(p0, p1, t);
                let q1 = point(p1, p2, t);
                let q2 = point(p2, p3, t);
                let r0 = point(q0, q1, t);
                let r1 = point(q1, q2, t);
                let middle = point(r0, r1, t);
                left.last_mut().unwrap()["rightHandle"] =
                    json!({"dt":js_round(q0.0-p0.0),"dv":q0.1-p0.1});
                l["leftHandle"] = json!({"dt":js_round(r0.0-middle.0),"dv":r0.1-middle.1});
                l["segmentToNext"] = a["segmentToNext"].clone();
                l["tangentMode"] = a["tangentMode"].clone();
                r["rightHandle"] = json!({"dt":js_round(r1.0-middle.0),"dv":r1.1-middle.1});
                r["tangentMode"] = a["tangentMode"].clone();
                right.first_mut().unwrap()["leftHandle"] =
                    json!({"dt":js_round(q2.0-p3.0),"dv":q2.1-p3.1});
            }
            left.push(l);
            right.insert(0, r);
        }
    }
    let build = |keys: Vec<Value>| -> Result<Value, CapabilityError> {
        if keys.is_empty() {
            return Ok(Value::Null);
        }
        let mut next = normalized.clone();
        next["keys"] = json!(keys);
        normalize_channel(&mut next)?;
        Ok(next)
    };
    Ok((build(left)?, build(right)?))
}
pub(in super::super) fn animations(
    data: &Value,
    time: i64,
    prefix: &str,
) -> Result<(Value, Value), CapabilityError> {
    if data.is_null() {
        return Ok((Value::Null, Value::Null));
    }
    let mut left = serde_json::Map::new();
    let mut right = serde_json::Map::new();
    let mut count = 0;
    for (path, value) in data
        .as_object()
        .ok_or_else(|| invalid("Invalid animation object"))?
    {
        if value.is_null() || matches!(path.as_str(), "bindings" | "channels") {
            continue;
        }
        let mut split = |value: &Value| {
            count += 1;
            channel(value, time, &format!("{prefix}-{count}"))
        };
        let (l, r) = if value["keys"].is_array() {
            split(value)?
        } else {
            let (mut l, mut r) = (serde_json::Map::new(), serde_json::Map::new());
            for (component, channel) in value
                .as_object()
                .ok_or_else(|| invalid("Invalid composite animation"))?
            {
                let (a, b) = split(channel)?;
                if !a.is_null() {
                    l.insert(component.clone(), a);
                }
                if !b.is_null() {
                    r.insert(component.clone(), b);
                }
            }
            (Value::Object(l), Value::Object(r))
        };
        if !l.is_null() && l.as_object().is_some_and(|v| !v.is_empty()) {
            left.insert(path.clone(), l);
        }
        if !r.is_null() && r.as_object().is_some_and(|v| !v.is_empty()) {
            right.insert(path.clone(), r);
        }
    }
    Ok((
        if left.is_empty() {
            Value::Null
        } else {
            Value::Object(left)
        },
        if right.is_empty() {
            Value::Null
        } else {
            Value::Object(right)
        },
    ))
}
