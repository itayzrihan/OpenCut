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
    let block_size = max(1.0, uniforms.scalars.y);
    let grid = max(vec2f(1.0, 1.0), uniforms.resolution / block_size);
    let snapped_uv = (floor(input.tex_coord * grid) + vec2f(0.5, 0.5)) / grid;
    let pixelated = textureSample(input_texture, input_sampler, snapped_uv);
    let source = textureSample(input_texture, input_sampler, input.tex_coord);
    return mix(source, pixelated, intensity);
}
