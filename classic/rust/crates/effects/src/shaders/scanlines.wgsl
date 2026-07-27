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

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let source = textureSample(input_texture, input_sampler, input.tex_coord);
    let intensity = clamp(uniforms.scalars.x, 0.0, 1.0);
    let spacing = max(2.0, uniforms.scalars.y);
    let drift = uniforms.scalars.z * 18.0;
    let stripe = step(0.5, fract((input.tex_coord.y * uniforms.resolution.y + drift) / spacing));
    let darken = stripe * intensity * 0.32;
    let glow = (1.0 - stripe) * intensity * 0.06;
    let rgb = source.rgb * (1.0 - darken) + vec3f(0.0, 0.8, 0.7) * glow;
    return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), source.a);
}
