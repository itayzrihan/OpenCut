//! Classic path insertion semantics: sampled closest point, de Casteljau split and recenter.
use super::*;

fn number(value: &Value, key: &str) -> Result<f64, CapabilityError> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .ok_or_else(|| invalid(&format!("freeform {key} must be finite")))
}

pub(super) fn validate_points(points: &[Value]) -> Result<(), CapabilityError> {
    if points.len() > 10000 {
        return Err(invalid("freeform path exceeds 10000 points"));
    }
    let mut ids = HashSet::new();
    for p in points {
        let id = p["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| invalid("freeform point ID missing"))?;
        if !ids.insert(id) {
            return Err(invalid("duplicate freeform point ID"));
        }
        for key in ["x", "y", "inX", "inY", "outX", "outY"] {
            number(p, key)?;
        }
    }
    Ok(())
}

impl Point {
    fn add(self, b: Self) -> Self {
        Self {
            x: self.x + b.x,
            y: self.y + b.y,
        }
    }
    fn sub(self, b: Self) -> Self {
        Self {
            x: self.x - b.x,
            y: self.y - b.y,
        }
    }
    fn lerp(self, b: Self, t: f64) -> Self {
        Self {
            x: self.x + (b.x - self.x) * t,
            y: self.y + (b.y - self.y) * t,
        }
    }
    fn rotate(self, degrees: f64) -> Self {
        let rad = degrees * std::f64::consts::PI / 180.0;
        Self {
            x: self.x * rad.cos() - self.y * rad.sin(),
            y: self.x * rad.sin() + self.y * rad.cos(),
        }
    }
    fn distance2(self, b: Self) -> f64 {
        (self.x - b.x).powi(2) + (self.y - b.y).powi(2)
    }
}
fn pair(p: &Value, x: &str, y: &str) -> Point {
    Point {
        x: p[x].as_f64().unwrap(),
        y: p[y].as_f64().unwrap(),
    }
}
fn cubic(p: [Point; 4], t: f64) -> Point {
    let w = [
        (1.0 - t).powi(3),
        3.0 * (1.0 - t).powi(2) * t,
        3.0 * (1.0 - t) * t.powi(2),
        t.powi(3),
    ];
    Point {
        x: (0..4).map(|i| p[i].x * w[i]).sum(),
        y: (0..4).map(|i| p[i].y * w[i]).sum(),
    }
}
fn canvas(p: Point, center: Point, rotation: f64, scale: f64, b: &Bounds) -> Point {
    Point {
        x: p.x * b.width * scale,
        y: p.y * b.height * scale,
    }
    .rotate(rotation)
    .add(center)
}
fn local(p: Point, center: Point, rotation: f64, scale: f64, b: &Bounds) -> Point {
    let p = p.sub(center).rotate(-rotation);
    Point {
        x: if b.width == 0.0 {
            0.0
        } else {
            p.x / (b.width * scale)
        },
        y: if b.height == 0.0 {
            0.0
        } else {
            p.y / (b.height * scale)
        },
    }
}
fn write_pair(p: &mut Value, x: &str, y: &str, v: Point) -> Result<(), CapabilityError> {
    if !v.x.is_finite() || !v.y.is_finite() {
        return Err(invalid("mask geometry overflow"));
    }
    p[x] = json!(v.x);
    p[y] = json!(v.y);
    Ok(())
}

pub(super) fn insert(
    params: &mut Map<String, Value>,
    segment: usize,
    click: Point,
    b: &Bounds,
    id: &str,
) -> Result<(), CapabilityError> {
    if ![click.x, click.y, b.cx, b.cy, b.width, b.height, b.rotation]
        .iter()
        .all(|v| v.is_finite())
        || b.width < 0.0
        || b.height < 0.0
    {
        return Err(invalid(
            "mask canvas bounds and point must be finite; dimensions cannot be negative",
        ));
    }
    let original = Value::Object(params.clone());
    let center_x = number(&original, "centerX")?;
    let center_y = number(&original, "centerY")?;
    let rotation = number(&original, "rotation")?;
    let scale = number(&original, "scale")?;
    if scale == 0.0 {
        return Err(invalid("cannot insert into a zero-scale mask"));
    }
    let closed = original["closed"]
        .as_bool()
        .ok_or_else(|| invalid("freeform closed flag must be boolean"))?;
    let points = params
        .get_mut("path")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| invalid("freeform path must be an array"))?;
    validate_points(points)?;
    if points.len() >= 10000 {
        return Err(invalid("freeform path point limit reached"));
    }
    if points.len() < 2
        || segment
            >= if closed {
                points.len()
            } else {
                points.len() - 1
            }
    {
        return Err(invalid("freeform segment index out of range"));
    }
    let end = (segment + 1) % points.len();
    let a = pair(&points[segment], "x", "y");
    let z = pair(&points[end], "x", "y");
    let ah = pair(&points[segment], "outX", "outY");
    let zh = pair(&points[end], "inX", "inY");
    let curve = [a, a.add(ah), z.add(zh), z];
    let center = Point {
        x: b.cx + center_x * b.width,
        y: b.cy + center_y * b.height,
    };
    let screen = curve.map(|p| canvas(p, center, rotation, scale, b));
    if !screen.iter().all(|p| p.x.is_finite() && p.y.is_finite()) {
        return Err(invalid("mask geometry overflow"));
    }
    let mut t = 0.0;
    let mut distance = click.distance2(screen[0]);
    for i in 0..=24 {
        let candidate = i as f64 / 24.0;
        let d = click.distance2(cubic(screen, candidate));
        if d < distance {
            distance = d;
            t = candidate;
        }
    }
    let mut step = 1.0 / 24.0;
    for _ in 0..8 {
        for candidate in [t - step, t, t + step].map(|v| v.clamp(0.0, 1.0)) {
            let d = click.distance2(cubic(screen, candidate));
            if d < distance {
                distance = d;
                t = candidate;
            }
        }
        step /= 2.0;
    }
    let t = t.clamp(0.001, 0.999);
    let mut point = json!({"id":id,"x":0,"y":0,"inX":0,"inY":0,"outX":0,"outY":0});
    if [ah.x, ah.y, zh.x, zh.y].iter().all(|v| v.abs() <= 1e-9) {
        write_pair(&mut point, "x", "y", a.lerp(z, t))?;
    } else {
        let p01 = curve[0].lerp(curve[1], t);
        let p12 = curve[1].lerp(curve[2], t);
        let p23 = curve[2].lerp(curve[3], t);
        let p012 = p01.lerp(p12, t);
        let p123 = p12.lerp(p23, t);
        let split = p012.lerp(p123, t);
        write_pair(&mut points[segment], "outX", "outY", p01.sub(a))?;
        write_pair(&mut points[end], "inX", "inY", p23.sub(z))?;
        write_pair(&mut point, "x", "y", split)?;
        write_pair(&mut point, "inX", "inY", p012.sub(split))?;
        write_pair(&mut point, "outX", "outY", p123.sub(split))?;
    }
    points.insert(end, point);
    // Recenter around all anchors and handles using the same canvas-space bounds as Classic.
    let screen_points: Vec<[Point; 3]> = points
        .iter()
        .map(|p| {
            let a = pair(p, "x", "y");
            [
                a,
                a.add(pair(p, "inX", "inY")),
                a.add(pair(p, "outX", "outY")),
            ]
            .map(|p| canvas(p, center, rotation, scale, b))
        })
        .collect();
    let all: Vec<_> = screen_points.iter().flatten().collect();
    let min_x = all.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
    let max_x = all.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
    let min_y = all.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
    let max_y = all.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
    let center_x = if b.width == 0.0 {
        0.0
    } else {
        ((min_x + max_x) / 2.0 - b.cx) / b.width
    };
    let center_y = if b.height == 0.0 {
        0.0
    } else {
        ((min_y + max_y) / 2.0 - b.cy) / b.height
    };
    let next_center = Point {
        x: b.cx + center_x * b.width,
        y: b.cy + center_y * b.height,
    };
    for (point, screen) in points.iter_mut().zip(screen_points) {
        let [a, i, o] = screen.map(|p| local(p, next_center, rotation, scale, b));
        write_pair(point, "x", "y", a)?;
        write_pair(point, "inX", "inY", i.sub(a))?;
        write_pair(point, "outX", "outY", o.sub(a))?;
    }
    if !center_x.is_finite() || !center_y.is_finite() {
        return Err(invalid("mask geometry overflow"));
    }
    params.insert("centerX".into(), json!(center_x));
    params.insert("centerY".into(), json!(center_y));
    Ok(())
}
