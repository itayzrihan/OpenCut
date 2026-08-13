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
    let height = clamp(uniforms.scalars.y, 0.001, 0.5);
    let softness = clamp(uniforms.scalars.z, 0.0, 1.0);
    let distance_to_horizontal_edge = min(input.tex_coord.y, 1.0 - input.tex_coord.y);
    let feather_width = max(height * softness, 0.001);
    let solid_end = max(height - feather_width, 0.0);
    let edge = 1.0 - smoothstep(solid_end, height, distance_to_horizontal_edge);
    let mix_amount = edge * intensity * clamp(uniforms.color.a, 0.0, 1.0);
    let rgb = mix(source.rgb, uniforms.color.rgb, mix_amount);
    return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), source.a);
}
