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

fn rand(coord: vec2f, seed: f32) -> f32 {
    return fract(sin(dot(coord, vec2f(12.9898, 78.233)) + seed) * 43758.5453);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let source = textureSample(input_texture, input_sampler, input.tex_coord);
    let intensity = clamp(uniforms.scalars.x, 0.0, 1.0);
    let grain_scale = max(1.0, uniforms.scalars.y);
    let time = uniforms.scalars.z;
    let seed = uniforms.scalars.w;
    let coord = floor(input.tex_coord * uniforms.resolution / grain_scale);
    let grain = rand(coord, seed + floor(time * 24.0)) - 0.5;
    let rgb = source.rgb + vec3f(grain * intensity * 0.38);
    return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), source.a);
}
