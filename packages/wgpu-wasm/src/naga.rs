// packages/wgpu-wasm/src/naga.rs — three-phase wasm-bindgen exports.
//
// Byte-for-byte equivalent of the lib.rs in the legacy naga wasm-pack shim
// crate (feat-20260508-shader-pipeline-mvp + plan-strategy §S-1 + research
// Finding 6; that crate was deleted in feat-20260511-naga-rhi-wgpu-merge M5)
// — moved here so the merged @forgeax/engine-wgpu-wasm crate produces a single wasm
// artefact sharing the naga 29 instance with the wgpu rhi surface (research
// F-2 Cargo dedup).
//
// Shape invariants (unchanged from the legacy archived crate):
// - Single concern per export: parse / validate / emit_reflection each map to one naga
//   library phase (wgsl::parse_str / Validator::validate / in-house reflection derivation).
// - Error pass-through: Rust-side Result<T, JsValue> → JS-side catch reads .lineNum /
//   .linePos / .message directly (the JS-side ShaderError factory consumes these fields,
//   see plan-strategy §S-7).
// - Opaque handles: ParsedModule / ValidatedModule are wasm-bindgen exported structs,
//   so JS can only hold a handle — it cannot inspect naga IR fields directly
//   (charter proposition 4 + opaque handle invariant).
// - Reflection is fully explicit: emit_reflection emits a JSON with every field present
//   (hasDynamicOffset / minBindingSize defaults written out), and the visibility field
//   is an integer bitmask (plan-strategy §S-9 / D-R9).

use naga::valid::{Capabilities, GlobalUse, ModuleInfo, ValidationFlags, Validator};
use naga::{
    AddressSpace, Expression, Handle, ImageClass, ImageDimension, Module, SampleLevel, ScalarKind,
    ShaderStage, StorageAccess, StorageFormat, TypeInner,
};
use serde::{Deserialize, Serialize};
use serde_json;
use wasm_bindgen::prelude::*;

// === Three-phase export handles ====================================================

/// Handle for the `parse` output. JS holds an opaque struct it cannot inspect; the
/// only legal next move is to feed it into `validate` (plan-strategy §S-1 opaque handle).
#[wasm_bindgen]
pub struct ParsedModule {
    module: Module,
}

/// Handle for the `validate` output. Carries both Module and ModuleInfo; passed into
/// `emit_reflection`.
#[wasm_bindgen]
pub struct ValidatedModule {
    module: Module,
    info: ModuleInfo,
}

// === Phase 1: parse ================================================================

/// WGSL source -> `naga::Module`. On failure throws a `JsError` whose payload carries
/// `message` / `line_num` / `line_pos`.
#[wasm_bindgen]
pub fn parse(source: &str) -> Result<ParsedModule, JsError> {
    match naga::front::wgsl::parse_str(source) {
        Ok(module) => Ok(ParsedModule { module }),
        Err(err) => {
            let loc = err.location(source);
            let summary = err.emit_to_string(source);
            let payload = ParseErrorPayload {
                message: err.message().to_string(),
                summary,
                line_num: loc.as_ref().map(|l| l.line_number),
                line_pos: loc.as_ref().map(|l| l.line_position),
            };
            Err(JsError::new(&serde_json::to_string(&payload).unwrap_or_else(|_| "parse failed".into())))
        }
    }
}

#[derive(Serialize, Deserialize)]
struct ParseErrorPayload {
    message: String,
    summary: String,
    line_num: Option<u32>,
    line_pos: Option<u32>,
}

// === Phase 2: validate =============================================================

/// `naga::Module` -> `ModuleInfo`. On failure throws a `JsError` whose message is the
/// validator's prose diagnostic (no source position is attached).
#[wasm_bindgen]
pub fn validate(parsed: ParsedModule) -> Result<ValidatedModule, JsError> {
    let mut validator = Validator::new(ValidationFlags::all(), Capabilities::all());
    match validator.validate(&parsed.module) {
        Ok(info) => Ok(ValidatedModule {
            module: parsed.module,
            info,
        }),
        Err(err) => Err(JsError::new(&format!("validate failed: {err}"))),
    }
}

// === Phase 3: emit_reflection ======================================================

/// `ValidatedModule` + options JSON -> `BindGroupLayoutDescriptor[]` JSON string.
///
/// `options_json` shape: `{ "dynamicOffsets": [{ "group": u32, "binding": u32 }, ...] }`.
/// The naga IR does not express the dynamic-offset dimension (see research Finding 2
/// footnote), so it is injected via JS-side options.
#[wasm_bindgen]
pub fn emit_reflection(validated: &ValidatedModule, options_json: &str) -> Result<String, JsError> {
    let options: ReflectionOptions = serde_json::from_str(options_json)
        .unwrap_or(ReflectionOptions { dynamic_offsets: Vec::new() });
    let bgls = derive_bgls(&validated.module, &validated.info, &options);
    serde_json::to_string(&bgls)
        .map_err(|e| JsError::new(&format!("reflection serialize failed: {e}")))
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReflectionOptions {
    #[serde(default)]
    dynamic_offsets: Vec<DynamicOffsetSpec>,
}

#[derive(Serialize, Deserialize)]
struct DynamicOffsetSpec {
    group: u32,
    binding: u32,
}

// === BGL JSON shape (matches @forgeax/engine-types BindGroupLayoutDescriptor) ===============

#[derive(Serialize)]
struct Bgl {
    label: String,
    entries: Vec<BglEntry>,
}

#[derive(Serialize)]
struct BglEntry {
    binding: u32,
    visibility: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    buffer: Option<BufferBinding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sampler: Option<SamplerBinding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    texture: Option<TextureBinding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "storageTexture")]
    storage_texture: Option<StorageTextureBinding>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BufferBinding {
    #[serde(rename = "type")]
    ty: &'static str,
    has_dynamic_offset: bool,
    min_binding_size: u32,
}

#[derive(Serialize)]
struct SamplerBinding {
    #[serde(rename = "type")]
    ty: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextureBinding {
    sample_type: &'static str,
    view_dimension: &'static str,
    multisampled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageTextureBinding {
    access: &'static str,
    format: &'static str,
    view_dimension: &'static str,
}

// === Reflection derivation main flow ===============================================

fn derive_bgls(module: &Module, info: &ModuleInfo, options: &ReflectionOptions) -> Vec<Bgl> {
    use std::collections::BTreeMap;

    let mut groups: BTreeMap<u32, BTreeMap<u32, BglEntry>> = BTreeMap::new();

    for (handle, var) in module.global_variables.iter() {
        let Some(rb) = &var.binding else { continue };
        let visibility = compute_visibility(module, info, handle);
        let entry = derive_entry(module, info, handle, var, rb.binding, visibility, options);
        groups.entry(rb.group).or_default().insert(rb.binding, entry);
    }

    groups
        .into_iter()
        .map(|(group_idx, entries)| Bgl {
            label: format!("@group({group_idx})"),
            entries: entries.into_values().collect(),
        })
        .collect()
}

fn compute_visibility(
    module: &Module,
    info: &ModuleInfo,
    handle: Handle<naga::GlobalVariable>,
) -> u32 {
    let mut bits: u32 = 0;
    for (idx, ep) in module.entry_points.iter().enumerate() {
        let fn_info = &info.get_entry_point(idx);
        let usage = fn_info[handle];
        if usage.is_empty() {
            continue;
        }
        bits |= match ep.stage {
            ShaderStage::Vertex => 0x1,
            ShaderStage::Fragment => 0x2,
            ShaderStage::Compute => 0x4,
            _ => 0,
        };
        let _ = usage.contains(GlobalUse::READ) || usage.contains(GlobalUse::WRITE) || usage.contains(GlobalUse::QUERY);
    }
    bits
}

fn derive_entry(
    module: &Module,
    _info: &ModuleInfo,
    handle: Handle<naga::GlobalVariable>,
    var: &naga::GlobalVariable,
    binding: u32,
    visibility: u32,
    options: &ReflectionOptions,
) -> BglEntry {
    let ty = &module.types[var.ty];
    let mut entry = BglEntry {
        binding,
        visibility,
        buffer: None,
        sampler: None,
        texture: None,
        storage_texture: None,
    };

    match (&var.space, &ty.inner) {
        (AddressSpace::Uniform, _) => {
            let has_dynamic_offset = is_dynamic_offset(&var.binding, options);
            entry.buffer = Some(BufferBinding {
                ty: "uniform",
                has_dynamic_offset,
                min_binding_size: 0,
            });
        }
        (AddressSpace::Storage { access }, _) => {
            let ty_str: &'static str = if access.contains(StorageAccess::STORE) {
                "storage"
            } else {
                "read-only-storage"
            };
            let has_dynamic_offset = is_dynamic_offset(&var.binding, options);
            entry.buffer = Some(BufferBinding {
                ty: ty_str,
                has_dynamic_offset,
                min_binding_size: 0,
            });
        }
        (AddressSpace::Handle, TypeInner::Sampler { comparison }) => {
            let ty_str: &'static str = if *comparison {
                "comparison"
            } else if module_uses_filtered_sample_with_global(module, handle) {
                "filtering"
            } else {
                "non-filtering"
            };
            entry.sampler = Some(SamplerBinding { ty: ty_str });
        }
        (AddressSpace::Handle, TypeInner::Image { dim, arrayed: _, class }) => match class {
            ImageClass::Storage { format, access } => {
                let access_str: &'static str = if access.contains(StorageAccess::LOAD) && access.contains(StorageAccess::STORE) {
                    "read-write"
                } else if access.contains(StorageAccess::STORE) {
                    "write-only"
                } else {
                    "read-only"
                };
                entry.storage_texture = Some(StorageTextureBinding {
                    access: access_str,
                    format: storage_format_str(*format),
                    view_dimension: image_dim_str(*dim),
                });
            }
            ImageClass::Sampled { kind, multi } => {
                let sample_type: &'static str = match kind {
                    ScalarKind::Sint => "sint",
                    ScalarKind::Uint => "uint",
                    ScalarKind::Float => {
                        if module_uses_filtered_sample_with_image(module, handle) {
                            "float"
                        } else {
                            "unfilterable-float"
                        }
                    }
                    _ => "unfilterable-float",
                };
                entry.texture = Some(TextureBinding {
                    sample_type,
                    view_dimension: image_dim_str(*dim),
                    multisampled: *multi,
                });
            }
            ImageClass::Depth { multi } => {
                entry.texture = Some(TextureBinding {
                    sample_type: "depth",
                    view_dimension: image_dim_str(*dim),
                    multisampled: *multi,
                });
            }
            ImageClass::External => {}
        },
        _ => {}
    }
    entry
}

fn is_dynamic_offset(rb: &Option<naga::ResourceBinding>, options: &ReflectionOptions) -> bool {
    let Some(rb) = rb else { return false };
    options
        .dynamic_offsets
        .iter()
        .any(|d| d.group == rb.group && d.binding == rb.binding)
}

fn image_dim_str(dim: ImageDimension) -> &'static str {
    match dim {
        ImageDimension::D1 => "1d",
        ImageDimension::D2 => "2d",
        ImageDimension::D3 => "3d",
        ImageDimension::Cube => "cube",
    }
}

fn module_uses_filtered_sample_with_global(
    module: &Module,
    sampler_handle: Handle<naga::GlobalVariable>,
) -> bool {
    for (_, func) in module.functions.iter() {
        if function_filtered_sample_with(func, module, sampler_handle, true) {
            return true;
        }
    }
    for ep in module.entry_points.iter() {
        if function_filtered_sample_with(&ep.function, module, sampler_handle, true) {
            return true;
        }
    }
    false
}

fn module_uses_filtered_sample_with_image(
    module: &Module,
    image_handle: Handle<naga::GlobalVariable>,
) -> bool {
    for (_, func) in module.functions.iter() {
        if function_filtered_sample_with(func, module, image_handle, false) {
            return true;
        }
    }
    for ep in module.entry_points.iter() {
        if function_filtered_sample_with(&ep.function, module, image_handle, false) {
            return true;
        }
    }
    false
}

fn function_filtered_sample_with(
    func: &naga::Function,
    module: &Module,
    target: Handle<naga::GlobalVariable>,
    is_sampler: bool,
) -> bool {
    for (_, expr) in func.expressions.iter() {
        if let Expression::ImageSample { image, sampler, level, .. } = expr {
            if !matches!(level, SampleLevel::Auto) {
                continue;
            }
            let probe = if is_sampler { *sampler } else { *image };
            if expression_resolves_to_global(func, module, probe, target) {
                return true;
            }
        }
    }
    false
}

fn expression_resolves_to_global(
    func: &naga::Function,
    _module: &Module,
    expr: Handle<Expression>,
    target: Handle<naga::GlobalVariable>,
) -> bool {
    match func.expressions[expr] {
        Expression::GlobalVariable(handle) => handle == target,
        Expression::Load { pointer } => expression_resolves_to_global(func, _module, pointer, target),
        _ => false,
    }
}

fn storage_format_str(fmt: StorageFormat) -> &'static str {
    match fmt {
        StorageFormat::R8Unorm => "r8unorm",
        StorageFormat::R8Snorm => "r8snorm",
        StorageFormat::R8Uint => "r8uint",
        StorageFormat::R8Sint => "r8sint",
        StorageFormat::R16Uint => "r16uint",
        StorageFormat::R16Sint => "r16sint",
        StorageFormat::R16Float => "r16float",
        StorageFormat::Rg8Unorm => "rg8unorm",
        StorageFormat::Rg8Snorm => "rg8snorm",
        StorageFormat::Rg8Uint => "rg8uint",
        StorageFormat::Rg8Sint => "rg8sint",
        StorageFormat::R32Uint => "r32uint",
        StorageFormat::R32Sint => "r32sint",
        StorageFormat::R32Float => "r32float",
        StorageFormat::Rg16Uint => "rg16uint",
        StorageFormat::Rg16Sint => "rg16sint",
        StorageFormat::Rg16Float => "rg16float",
        StorageFormat::Rgba8Unorm => "rgba8unorm",
        StorageFormat::Rgba8Snorm => "rgba8snorm",
        StorageFormat::Rgba8Uint => "rgba8uint",
        StorageFormat::Rgba8Sint => "rgba8sint",
        StorageFormat::Bgra8Unorm => "bgra8unorm",
        StorageFormat::Rgb10a2Uint => "rgb10a2uint",
        StorageFormat::Rgb10a2Unorm => "rgb10a2unorm",
        StorageFormat::Rg11b10Ufloat => "rg11b10ufloat",
        StorageFormat::Rg32Uint => "rg32uint",
        StorageFormat::Rg32Sint => "rg32sint",
        StorageFormat::Rg32Float => "rg32float",
        StorageFormat::Rgba16Uint => "rgba16uint",
        StorageFormat::Rgba16Sint => "rgba16sint",
        StorageFormat::Rgba16Float => "rgba16float",
        StorageFormat::Rgba32Uint => "rgba32uint",
        StorageFormat::Rgba32Sint => "rgba32sint",
        StorageFormat::Rgba32Float => "rgba32float",
        StorageFormat::R64Uint => "r64uint",
        StorageFormat::R16Unorm => "r16unorm",
        StorageFormat::R16Snorm => "r16snorm",
        StorageFormat::Rg16Unorm => "rg16unorm",
        StorageFormat::Rg16Snorm => "rg16snorm",
        StorageFormat::Rgba16Unorm => "rgba16unorm",
        StorageFormat::Rgba16Snorm => "rgba16snorm",
    }
}
