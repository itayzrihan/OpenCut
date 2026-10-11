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

// A small unsharp mask in premultiplied space. Preserve alpha and keep colors
// bounded by it, so transparent overlays do not acquire bright edge fringes.
@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let uv = input.tex_coord;
    let pixel = 1.0 / uniforms.resolution;
    let source = textureSample(input_texture, input_sampler, uv);
    let left = textureSample(input_texture, input_sampler, uv - vec2f(pixel.x, 0.0));
    let right = textureSample(input_texture, input_sampler, uv + vec2f(pixel.x, 0.0));
    let top = textureSample(input_texture, input_sampler, uv - vec2f(0.0, pixel.y));
    let bottom = textureSample(input_texture, input_sampler, uv + vec2f(0.0, pixel.y));
    let blurred = (left + right + top + bottom + 4.0 * source) / 8.0;
    let rgb = source.rgb + (source.rgb - blurred.rgb) * clamp(uniforms.scalars.x, 0.0, 1.0) * 4.0;
    return vec4f(clamp(rgb, vec3f(0.0), vec3f(source.a)), source.a);
}
