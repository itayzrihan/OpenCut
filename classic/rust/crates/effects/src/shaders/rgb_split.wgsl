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
    let intensity = clamp(uniforms.scalars.x, 0.0, 1.0);
    let amount = max(0.0, uniforms.scalars.y);
    let offset = vec2f(amount / max(uniforms.resolution.x, 1.0), 0.0);
    let source = textureSample(input_texture, input_sampler, input.tex_coord);
    let red = textureSample(input_texture, input_sampler, clamp(input.tex_coord + offset, vec2f(0.0), vec2f(1.0))).r;
    let green = source.g;
    let blue = textureSample(input_texture, input_sampler, clamp(input.tex_coord - offset, vec2f(0.0), vec2f(1.0))).b;
    let split = vec4f(red, green, blue, source.a);
    return mix(source, split, intensity);
}
