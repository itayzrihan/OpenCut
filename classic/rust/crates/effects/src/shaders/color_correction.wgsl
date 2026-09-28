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
    if (source.a <= 0.00001) { return source; }
    let rgb = clamp(source.rgb / source.a, vec3f(0.0), vec3f(1.0));
    let temperature = clamp(uniforms.scalars.y, -1.0, 1.0);
    let tint = clamp(uniforms.scalars.z, -1.0, 1.0);
    // Work in linear light; preserve white and black with a bounded exposure curve.
    let linear = pow(rgb, vec3f(2.2));
    let gain = exp2(clamp(uniforms.scalars.x, -2.0, 2.0)) *
        exp2(vec3f(temperature * 0.6 + tint * 0.2, -tint * 0.4, -temperature * 0.6 + tint * 0.2));
    let adjusted = linear * gain / (vec3f(1.0) + linear * (gain - vec3f(1.0)));
    let luma = dot(adjusted, vec3f(0.2126, 0.7152, 0.0722));
    let saturated = mix(vec3f(luma), adjusted, clamp(uniforms.scalars.w, 0.0, 2.0));
    return vec4f(pow(clamp(saturated, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)) * source.a, source.a);
}
