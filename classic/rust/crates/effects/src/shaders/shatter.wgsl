struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec2f,
    direction: vec2f,
    scalars: vec4f,
    color: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

fn hash21(p: vec2f) -> f32 {
    let p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
    let mixed = p3 + dot(p3, p3.yzx + vec3f(33.33));
    return fract((mixed.x + mixed.y) * mixed.z);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let progress = clamp(uniforms.scalars.x, 0.0, 1.0);
    if (progress <= 0.0001) {
        return textureSample(input_texture, input_sampler, input.tex_coord);
    }

    let aspect = uniforms.resolution.x / max(1.0, uniforms.resolution.y);
    let grid = vec2f(max(7.0, round(9.0 * aspect)), 9.0);
    let grid_uv = input.tex_coord * grid;
    let cell = floor(grid_uv);
    let within = fract(grid_uv);
    let upper_triangle = select(0.0, 1.0, within.x + within.y > 1.0);
    let shard = cell + vec2f(upper_triangle * 0.37, upper_triangle * 0.71);
    let random_a = hash21(shard + uniforms.scalars.y);
    let random_b = hash21(shard.yx + uniforms.scalars.y + 19.7);
    let cell_center = (cell + vec2f(0.5)) / grid;
    let radial = normalize((cell_center - vec2f(0.5)) * vec2f(aspect, 1.0) + vec2f(0.0001));
    let scatter = radial * (0.08 + random_a * 0.24) +
        vec2f(random_b - 0.5, random_a - 0.5) * 0.12;

    let local = within - vec2f(0.5);
    let angle = (random_b - 0.5) * progress * 2.4;
    let c = cos(angle);
    let s = sin(angle);
    let rotated = vec2f(c * local.x - s * local.y, s * local.x + c * local.y);
    let source_uv = (cell + rotated + vec2f(0.5)) / grid - scatter * progress;

    // Diagonal and cell-edge gaps create irregular glass-like shard borders.
    let diagonal = abs(within.x + within.y - 1.0);
    let edge = min(min(within.x, 1.0 - within.x), min(within.y, 1.0 - within.y));
    let crack_width = progress * 0.07;
    let crack = min(edge, diagonal * 0.55);
    if (crack < crack_width || any(source_uv < vec2f(0.0)) || any(source_uv > vec2f(1.0))) {
        return vec4f(0.0);
    }

    let source = textureSample(input_texture, input_sampler, source_uv);
    let fade = 1.0 - smoothstep(0.62, 1.0, progress) * (0.55 + random_a * 0.45);
    let glint = (1.0 - smoothstep(crack_width, crack_width * 2.2, crack)) * 0.08 * progress;
    return vec4f(source.rgb + vec3f(glint), source.a * fade);
}
