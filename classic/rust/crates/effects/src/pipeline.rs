use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use gpu::{FULLSCREEN_SHADER_SOURCE, GpuContext};
use thiserror::Error;
use wgpu::util::DeviceExt;

use crate::{EffectPass, UniformValue};

const GAUSSIAN_BLUR_SHADER_ID: &str = "gaussian-blur";
const GAUSSIAN_BLUR_SHADER_SOURCE: &str = include_str!("shaders/gaussian_blur.wgsl");
const GRAYSCALE_SHADER_ID: &str = "grayscale";
const GRAYSCALE_SHADER_SOURCE: &str = include_str!("shaders/grayscale.wgsl");
const TINT_SHADER_ID: &str = "tint";
const COLOR_WASH_SHADER_ID: &str = "color-wash";
const VIGNETTE_SHADER_ID: &str = "vignette";
const PIXELATE_SHADER_ID: &str = "pixelate";
const RGB_SPLIT_SHADER_ID: &str = "rgb-split";
const CHROMATIC_SHIFT_SHADER_ID: &str = "chromatic-shift";
const SCANLINES_SHADER_ID: &str = "scanlines";
const NOISE_SHADER_ID: &str = "noise";
const SHATTER_SHADER_ID: &str = "shatter";
const TINT_SHADER_SOURCE: &str = include_str!("shaders/tint.wgsl");
const VIGNETTE_SHADER_SOURCE: &str = include_str!("shaders/vignette.wgsl");
const PIXELATE_SHADER_SOURCE: &str = include_str!("shaders/pixelate.wgsl");
const RGB_SPLIT_SHADER_SOURCE: &str = include_str!("shaders/rgb_split.wgsl");
const SCANLINES_SHADER_SOURCE: &str = include_str!("shaders/scanlines.wgsl");
const NOISE_SHADER_SOURCE: &str = include_str!("shaders/noise.wgsl");
const SHATTER_SHADER_SOURCE: &str = include_str!("shaders/shatter.wgsl");

pub struct ApplyEffectsOptions<'a> {
    pub source: &'a wgpu::Texture,
    pub width: u32,
    pub height: u32,
    pub passes: &'a [EffectPass],
}

pub struct EffectPipeline {
    uniform_bind_group_layout: wgpu::BindGroupLayout,
    pipelines: HashMap<String, wgpu::RenderPipeline>,
}

#[derive(Debug, Error)]
pub enum EffectsError {
    #[error("At least one effect pass is required")]
    MissingEffectPasses,
    #[error("Unknown effect shader '{shader}'")]
    UnknownEffectShader { shader: String },
    #[error("Missing uniform '{uniform}' for shader '{shader}'")]
    MissingUniform { shader: String, uniform: String },
    #[error("Uniform '{uniform}' for shader '{shader}' must be a number")]
    InvalidNumberUniform { shader: String, uniform: String },
    #[error(
        "Uniform '{uniform}' for shader '{shader}' must be a vector of length {expected_length}"
    )]
    InvalidVectorUniform {
        shader: String,
        uniform: String,
        expected_length: usize,
    },
    #[error("Shader '{shader}' does not support uniform '{uniform}'")]
    UnsupportedUniform { shader: String, uniform: String },
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
struct EffectUniformBuffer {
    resolution: [f32; 2],
    direction: [f32; 2],
    scalars: [f32; 4],
    color: [f32; 4],
}

impl EffectPipeline {
    pub fn new(context: &GpuContext) -> Self {
        let uniform_bind_group_layout =
            context
                .device()
                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("effects-uniform-bind-group-layout"),
                    entries: &[wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    }],
                });
        let vertex_shader_module =
            context
                .device()
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("effects-fullscreen-shader"),
                    source: wgpu::ShaderSource::Wgsl(FULLSCREEN_SHADER_SOURCE.into()),
                });
        let pipeline_layout =
            context
                .device()
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("effects-pipeline-layout"),
                    bind_group_layouts: &[
                        Some(context.texture_sampler_bind_group_layout()),
                        Some(&uniform_bind_group_layout),
                    ],
                    immediate_size: 0,
                });
        let pipelines = HashMap::from([
            (
                GAUSSIAN_BLUR_SHADER_ID.to_string(),
                create_effect_pipeline(
                    context,
                    &pipeline_layout,
                    &vertex_shader_module,
                    GAUSSIAN_BLUR_SHADER_ID,
                    GAUSSIAN_BLUR_SHADER_SOURCE,
                ),
            ),
            (
                GRAYSCALE_SHADER_ID.to_string(),
                create_effect_pipeline(
                    context,
                    &pipeline_layout,
                    &vertex_shader_module,
                    GRAYSCALE_SHADER_ID,
                    GRAYSCALE_SHADER_SOURCE,
                ),
            ),
            (
                TINT_SHADER_ID.to_string(),
                create_effect_pipeline(
                    context,
                    &pipeline_layout,
                    &vertex_shader_module,
                    TINT_SHADER_ID,
                    TINT_SHADER_SOURCE,
                ),
            ),
            (
                COLOR_WASH_SHADER_ID.to_string(),
                create_effect_pipeline(
                    context,
                    &pipeline_layout,
                    &vertex_shader_module,
                    COLOR_WASH_SHADER_ID,
                    TINT_SHADER_SOURCE,
                ),
            ),
            (
                VIGNETTE_SHADER_ID.to_string(),
                create_effect_pipeline(
                    context,
                    &pipeline_layout,
                    &vertex_shader_module,
                    VIGNETTE_SHADER_ID,
                    VIGNETTE_SHADER_SOURCE,
                ),
            ),
            (
                PIXELATE_SHADER_ID.to_string(),
                create_effect_pipeline(
                    context,
                    &pipeline_layout,
                    &vertex_shader_module,
                    PIXELATE_SHADER_ID,
                    PIXELATE_SHADER_SOURCE,
                ),
            ),
            (
                RGB_SPLIT_SHADER_ID.to_string(),
                create_effect_pipeline(
                    context,
                    &pipeline_layout,
                    &vertex_shader_module,
                    RGB_SPLIT_SHADER_ID,
                    RGB_SPLIT_SHADER_SOURCE,
                ),
            ),
            (
                CHROMATIC_SHIFT_SHADER_ID.to_string(),
                create_effect_pipeline(
                    context,
                    &pipeline_layout,
                    &vertex_shader_module,
                    CHROMATIC_SHIFT_SHADER_ID,
                    RGB_SPLIT_SHADER_SOURCE,
                ),
            ),
            (
                SCANLINES_SHADER_ID.to_string(),
                create_effect_pipeline(
                    context,
                    &pipeline_layout,
                    &vertex_shader_module,
                    SCANLINES_SHADER_ID,
                    SCANLINES_SHADER_SOURCE,
                ),
            ),
            (
                NOISE_SHADER_ID.to_string(),
                create_effect_pipeline(
                    context,
                    &pipeline_layout,
                    &vertex_shader_module,
                    NOISE_SHADER_ID,
                    NOISE_SHADER_SOURCE,
                ),
            ),
            (
                SHATTER_SHADER_ID.to_string(),
                create_effect_pipeline(
                    context,
                    &pipeline_layout,
                    &vertex_shader_module,
                    SHATTER_SHADER_ID,
                    SHATTER_SHADER_SOURCE,
                ),
            ),
        ]);

        Self {
            uniform_bind_group_layout,
            pipelines,
        }
    }

    pub fn apply(
        &self,
        context: &GpuContext,
        ApplyEffectsOptions {
            source,
            width,
            height,
            passes,
        }: ApplyEffectsOptions<'_>,
    ) -> Result<wgpu::Texture, EffectsError> {
        let mut encoder =
            context
                .device()
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("effects-command-encoder"),
                });
        let output = self.apply_with_encoder(
            context,
            &mut encoder,
            ApplyEffectsOptions {
                source,
                width,
                height,
                passes,
            },
        )?;
        context.queue().submit([encoder.finish()]);
        Ok(output)
    }

    pub fn apply_with_encoder(
        &self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        ApplyEffectsOptions {
            source,
            width,
            height,
            passes,
        }: ApplyEffectsOptions<'_>,
    ) -> Result<wgpu::Texture, EffectsError> {
        let mut current_texture: Option<wgpu::Texture> = None;

        for pass in passes {
            let input_texture = current_texture.as_ref().unwrap_or(source);
            let output_texture =
                context.create_render_texture(width, height, "effects-pass-output");
            let input_view = input_texture.create_view(&wgpu::TextureViewDescriptor::default());
            let output_view = output_texture.create_view(&wgpu::TextureViewDescriptor::default());
            let texture_bind_group =
                context
                    .device()
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("effects-texture-bind-group"),
                        layout: context.texture_sampler_bind_group_layout(),
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: wgpu::BindingResource::TextureView(&input_view),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: wgpu::BindingResource::Sampler(context.linear_sampler()),
                            },
                        ],
                    });
            let uniform_buffer =
                context
                    .device()
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("effects-uniform-buffer"),
                        contents: bytemuck::bytes_of(&pack_effect_uniforms(pass, width, height)?),
                        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    });
            let uniform_bind_group =
                context
                    .device()
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("effects-uniform-bind-group"),
                        layout: &self.uniform_bind_group_layout,
                        entries: &[wgpu::BindGroupEntry {
                            binding: 0,
                            resource: uniform_buffer.as_entire_binding(),
                        }],
                    });
            let pipeline = self.pipelines.get(&pass.shader).ok_or_else(|| {
                EffectsError::UnknownEffectShader {
                    shader: pass.shader.clone(),
                }
            })?;

            {
                let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("effects-render-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &output_view,
                        resolve_target: None,
                        depth_slice: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    occlusion_query_set: None,
                    timestamp_writes: None,
                    multiview_mask: None,
                });
                render_pass.set_pipeline(pipeline);
                render_pass.set_vertex_buffer(0, context.fullscreen_quad().slice(..));
                render_pass.set_bind_group(0, &texture_bind_group, &[]);
                render_pass.set_bind_group(1, &uniform_bind_group, &[]);
                render_pass.draw(0..6, 0..1);
            }

            current_texture = Some(output_texture);
        }

        current_texture.ok_or(EffectsError::MissingEffectPasses)
    }
}

fn create_effect_pipeline(
    context: &GpuContext,
    pipeline_layout: &wgpu::PipelineLayout,
    vertex_shader_module: &wgpu::ShaderModule,
    shader_id: &str,
    shader_source: &str,
) -> wgpu::RenderPipeline {
    let fragment_shader_module =
        context
            .device()
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(&format!("effects-{shader_id}-shader")),
                source: wgpu::ShaderSource::Wgsl(shader_source.into()),
            });

    context
        .device()
        .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(&format!("effects-{shader_id}-pipeline")),
            layout: Some(pipeline_layout),
            vertex: wgpu::VertexState {
                module: vertex_shader_module,
                entry_point: Some("vertex_main"),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<[f32; 2]>() as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[wgpu::VertexAttribute {
                        format: wgpu::VertexFormat::Float32x2,
                        offset: 0,
                        shader_location: 0,
                    }],
                }],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &fragment_shader_module,
                entry_point: Some("fragment_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: context.texture_format(),
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        })
}

fn pack_effect_uniforms(
    pass: &EffectPass,
    width: u32,
    height: u32,
) -> Result<EffectUniformBuffer, EffectsError> {
    let shader = pass.shader.as_str();

    match shader {
        GRAYSCALE_SHADER_ID => {
            ensure_supported_uniforms(pass, &[])?;
            Ok(EffectUniformBuffer {
                resolution: [width as f32, height as f32],
                direction: [0.0, 0.0],
                scalars: [0.0; 4],
                color: [0.0; 4],
            })
        }
        GAUSSIAN_BLUR_SHADER_ID => {
            ensure_supported_uniforms(pass, &["u_sigma", "u_step", "u_direction"])?;
            Ok(EffectUniformBuffer {
                resolution: [width as f32, height as f32],
                direction: read_vec2_uniform(pass, "u_direction")?,
                scalars: [
                    read_number_uniform(pass, "u_sigma")?,
                    read_number_uniform(pass, "u_step")?,
                    0.0,
                    0.0,
                ],
                color: [0.0, 0.0, 0.0, 0.0],
            })
        }
        TINT_SHADER_ID | COLOR_WASH_SHADER_ID | VIGNETTE_SHADER_ID => {
            ensure_supported_uniforms(pass, &["u_intensity", "u_color"])?;
            Ok(EffectUniformBuffer {
                resolution: [width as f32, height as f32],
                direction: [0.0, 0.0],
                scalars: [read_number_uniform(pass, "u_intensity")?, 0.0, 0.0, 0.0],
                color: read_vec4_uniform(pass, "u_color")?,
            })
        }
        PIXELATE_SHADER_ID => {
            ensure_supported_uniforms(pass, &["u_amount", "u_intensity"])?;
            Ok(EffectUniformBuffer {
                resolution: [width as f32, height as f32],
                direction: [0.0, 0.0],
                scalars: [
                    read_number_uniform(pass, "u_intensity")?,
                    read_number_uniform(pass, "u_amount")?,
                    0.0,
                    0.0,
                ],
                color: [0.0, 0.0, 0.0, 0.0],
            })
        }
        RGB_SPLIT_SHADER_ID | CHROMATIC_SHIFT_SHADER_ID => {
            ensure_supported_uniforms(pass, &["u_amount", "u_intensity"])?;
            Ok(EffectUniformBuffer {
                resolution: [width as f32, height as f32],
                direction: [0.0, 0.0],
                scalars: [
                    read_number_uniform(pass, "u_intensity")?,
                    read_number_uniform(pass, "u_amount")?,
                    0.0,
                    0.0,
                ],
                color: [0.0, 0.0, 0.0, 0.0],
            })
        }
        SCANLINES_SHADER_ID => {
            ensure_supported_uniforms(pass, &["u_intensity", "u_amount", "u_time"])?;
            Ok(EffectUniformBuffer {
                resolution: [width as f32, height as f32],
                direction: [0.0, 0.0],
                scalars: [
                    read_number_uniform(pass, "u_intensity")?,
                    read_number_uniform(pass, "u_amount")?,
                    read_number_uniform(pass, "u_time")?,
                    0.0,
                ],
                color: [0.0, 0.0, 0.0, 0.0],
            })
        }
        NOISE_SHADER_ID => {
            ensure_supported_uniforms(pass, &["u_intensity", "u_amount", "u_time", "u_seed"])?;
            Ok(EffectUniformBuffer {
                resolution: [width as f32, height as f32],
                direction: [0.0, 0.0],
                scalars: [
                    read_number_uniform(pass, "u_intensity")?,
                    read_number_uniform(pass, "u_amount")?,
                    read_number_uniform(pass, "u_time")?,
                    read_number_uniform(pass, "u_seed")?,
                ],
                color: [0.0, 0.0, 0.0, 0.0],
            })
        }
        SHATTER_SHADER_ID => {
            ensure_supported_uniforms(pass, &["u_progress", "u_seed"])?;
            Ok(EffectUniformBuffer {
                resolution: [width as f32, height as f32],
                direction: [0.0, 0.0],
                scalars: [
                    read_number_uniform(pass, "u_progress")?,
                    read_number_uniform(pass, "u_seed")?,
                    0.0,
                    0.0,
                ],
                color: [0.0, 0.0, 0.0, 0.0],
            })
        }
        _ => Err(EffectsError::UnknownEffectShader {
            shader: shader.to_string(),
        }),
    }
}

fn ensure_supported_uniforms(
    pass: &EffectPass,
    supported_uniforms: &[&str],
) -> Result<(), EffectsError> {
    for uniform in pass.uniforms.keys() {
        if supported_uniforms.contains(&uniform.as_str()) {
            continue;
        }
        return Err(EffectsError::UnsupportedUniform {
            shader: pass.shader.clone(),
            uniform: uniform.clone(),
        });
    }
    Ok(())
}

fn read_number_uniform(pass: &EffectPass, uniform: &str) -> Result<f32, EffectsError> {
    let Some(value) = pass.uniforms.get(uniform) else {
        return Err(EffectsError::MissingUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        });
    };
    match value {
        UniformValue::Number(value) => Ok(*value),
        UniformValue::Vector(_) => Err(EffectsError::InvalidNumberUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        }),
    }
}

fn read_vec2_uniform(pass: &EffectPass, uniform: &str) -> Result<[f32; 2], EffectsError> {
    let Some(value) = pass.uniforms.get(uniform) else {
        return Err(EffectsError::MissingUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        });
    };
    let UniformValue::Vector(values) = value else {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: 2,
        });
    };
    if values.len() != 2 {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: 2,
        });
    }
    Ok([values[0], values[1]])
}

fn read_vec4_uniform(pass: &EffectPass, uniform: &str) -> Result<[f32; 4], EffectsError> {
    let Some(value) = pass.uniforms.get(uniform) else {
        return Err(EffectsError::MissingUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        });
    };
    let UniformValue::Vector(values) = value else {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: 4,
        });
    };
    if values.len() != 4 {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: 4,
        });
    }
    Ok([values[0], values[1], values[2], values[3]])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::UniformValue;

    fn pass(shader: &str, uniforms: &[(&str, UniformValue)]) -> EffectPass {
        EffectPass {
            shader: shader.to_string(),
            uniforms: uniforms
                .iter()
                .map(|(name, value)| ((*name).to_string(), value.clone()))
                .collect(),
        }
    }

    #[test]
    fn packs_tint_uniforms() {
        let packed = pack_effect_uniforms(
            &pass(
                TINT_SHADER_ID,
                &[
                    ("u_intensity", UniformValue::Number(0.5)),
                    ("u_color", UniformValue::Vector(vec![0.2, 0.3, 0.4, 1.0])),
                ],
            ),
            1920,
            1080,
        )
        .expect("tint uniforms should pack");

        assert_eq!(packed.scalars[0], 0.5);
        assert_eq!(packed.color, [0.2, 0.3, 0.4, 1.0]);
    }

    #[test]
    fn rejects_unsupported_shader_uniforms() {
        let error = pack_effect_uniforms(
            &pass(
                PIXELATE_SHADER_ID,
                &[
                    ("u_amount", UniformValue::Number(12.0)),
                    ("u_intensity", UniformValue::Number(0.8)),
                    ("u_color", UniformValue::Vector(vec![1.0, 0.0, 0.0, 1.0])),
                ],
            ),
            1920,
            1080,
        )
        .expect_err("unexpected uniforms should fail");

        assert!(matches!(error, EffectsError::UnsupportedUniform { .. }));
    }
}
