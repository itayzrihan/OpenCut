struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct LayerUniforms {
    resolution: vec2f,
    center: vec2f,
    size: vec2f,
    rotation_radians: f32,
    opacity: f32,
    flip_x: f32,
    flip_y: f32,
    perspective_x_radians: f32,
    perspective_y_radians: f32,
    source_mask_enabled: f32,
    source_mask_inverted: f32,
    _padding: vec2f,
}

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: LayerUniforms;
@group(2) @binding(0) var source_mask_texture: texture_2d<f32>;
@group(2) @binding(1) var source_mask_sampler: sampler;

fn rotate_inverse(point: vec2f, angle: f32) -> vec2f {
    let c = cos(angle);
    let s = sin(angle);
    return vec2f(
        point.x * c + point.y * s,
        -point.x * s + point.y * c,
    );
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let pixel = input.tex_coord * uniforms.resolution;
    let projected = rotate_inverse(pixel - uniforms.center, uniforms.rotation_radians);

    // Invert the projective transform of a plane rotated in 3D. Keeping this
    // in the compositor makes perspective work for every textured layer type.
    let sx = sin(uniforms.perspective_x_radians);
    let cx = cos(uniforms.perspective_x_radians);
    let sy = sin(uniforms.perspective_y_radians);
    let cy = cos(uniforms.perspective_y_radians);
    let distance = max(uniforms.size.x, uniforms.size.y) * 1.5;
    let a = -cx * sy;
    let b = sx;
    let aa = projected.x * a - distance * cy;
    let ab = projected.x * b;
    let ba = projected.y * a - distance * sx * sy;
    let bb = projected.y * b - distance * cx;
    let determinant = aa * bb - ab * ba;
    if (abs(determinant) < 0.0001) {
        return vec4f(0.0);
    }
    let local = vec2f(
        ((-projected.x * distance) * bb - ab * (-projected.y * distance)) / determinant,
        (aa * (-projected.y * distance) - (-projected.x * distance) * ba) / determinant,
    );

    let uv = vec2f(
        local.x / uniforms.size.x + 0.5,
        local.y / uniforms.size.y + 0.5,
    );

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        return vec4f(0.0, 0.0, 0.0, 0.0);
    }

    let sample_uv = vec2f(
        select(uv.x, 1.0 - uv.x, uniforms.flip_x > 0.5),
        select(uv.y, 1.0 - uv.y, uniforms.flip_y > 0.5),
    );
    let color = textureSampleLevel(source_texture, source_sampler, sample_uv, 0.0);
    var source_mask_alpha = 1.0;
    if (uniforms.source_mask_enabled > 0.5) {
        let sampled_mask = textureSampleLevel(
            source_mask_texture,
            source_mask_sampler,
            sample_uv,
            0.0,
        ).a;
        source_mask_alpha = select(
            sampled_mask,
            1.0 - sampled_mask,
            uniforms.source_mask_inverted > 0.5,
        );
    }
    return vec4f(color.rgb, color.a * uniforms.opacity * source_mask_alpha);
}
