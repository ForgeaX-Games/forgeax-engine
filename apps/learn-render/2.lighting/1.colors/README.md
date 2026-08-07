# Colors (LearnOpenGL section 2.lighting 1)

> [!NOTE]
> **LO original chapter**: [LearnOpenGL 2.lighting 1.colors](https://learnopengl.com/Lighting/Colors)
>
> **Engine surface**: `createApp` + ECS components (`Transform`, `Camera`, `MeshFilter`, `MeshRenderer`, `DirectionalLight`) + `MaterialAsset` (`shadingModel: 'standard'` / `'unlit'`) + builtin `HANDLE_CUBE` mesh.

## What this example shows

LO 2.1 teaches that object color and light color combine via per-component multiplication in the fragment shader. The LO scene places a colored cube at origin, a white lamp cube at the light position, and computes `lightColor * objectColor` in the Phong lighting model.

In forgeax, the same concept is expressed through the engine PBR pipeline: a `StandardMaterialAsset` with `baseColor` on the cube, a `DirectionalLight` component with `color` on a light entity, and a separate `UnlitMaterialAsset` for the lamp marker so it always renders white. The visual result is physically-based rather than Phong, but the conceptual lesson is preserved.

The scene renders:
1. A colored cube (object) at origin with `shadingModel: 'standard'`
2. A small white unlit cube (lamp marker) at the LO light position
3. A directional light pointing from the lamp position toward the cube

## Run

```bash
# Dev server (port 5190)
pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" dev

# Build
pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" build

# RHI-debug Dawn smoke (real WebGPU readback; semantic color/light oracle)
pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Negative control: remove the directional light; the semantic oracle must fail
FALSIFY_NO_LIGHT=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Channel control: replace the white directional light with a blue light;
# the same cube must switch from red-dominant to blue-dominant output
FALSIFY_LIGHT_COLOR=blue pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Magnitude control: lower the same white directional light to intensity 0.25;
# the cube remains orange but its red channel must move below the normal range
FALSIFY_LIGHT_INTENSITY=0.25 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Direction control: reverse the directional vector; the same cube must lose
# its direct-light output and the semantic oracle must fail
FALSIFY_LIGHT_DIRECTION=away pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Object-color control: replace the cube's orange standard-material baseColor
# with green; the same material handle must produce green-dominant output
FALSIFY_OBJECT_COLOR=green pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Material control: make the same standard material fully metallic;
# the cube's PBR response must differ from the default orange material
FALSIFY_MATERIAL_METALLIC=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Material control: make the same standard material fully smooth;
# the cube's PBR response must differ from the default roughness=0.5 material
FALSIFY_MATERIAL_ROUGHNESS=0 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Material control: add a red emissive contribution to the same standard material;
# the cube's PBR response must move away from the default lit-orange material
FALSIFY_MATERIAL_EMISSIVE=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Material emissive-intensity control: keep the same red emissive color but
# set only its producer-owned intensity scalar to zero; the response must
# return to the default material baseline
FALSIFY_MATERIAL_EMISSIVE_INTENSITY=0 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Material control: change the specular tint on the same standard material;
# the cube's PBR response must move away from the default material
FALSIFY_MATERIAL_SPECULAR_TINT=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Material texture control: bind a real black linear TextureAsset to the same
# standard material's specular tint slot; its PBR response must move from default
FALSIFY_MATERIAL_SPECULAR_TINT_TEXTURE=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Material normal-map control: bind a real non-neutral RG normal TextureAsset to the same
# standard material; its TBN/PBR response must move from the neutral fallback
FALSIFY_MATERIAL_NORMAL_TEXTURE=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Material normal-scale control: keep the same normal texture but set its
# nested MaterialTextureValue.normalScale to zero; the normal response must
# return to the flat-normal baseline
FALSIFY_MATERIAL_NORMAL_SCALE=0 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Material emissive-texture control: bind a real black linear TextureAsset to
# the same standard material's emissive slot; its authored emissive response must move from default
FALSIFY_MATERIAL_EMISSIVE_TEXTURE=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Material base-color texture control: bind a real black linear TextureAsset to
# the same standard material's albedo slot; its response must move from default
FALSIFY_MATERIAL_BASE_COLOR_TEXTURE=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Material metallic-roughness texture control: bind a real black linear TextureAsset
# to the same standard material's metallic/roughness slot; its response must move from default
FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Material metallic-channel negative control: keep authored metallic=1, bind a
# linear [R=1,G=1,B=0,A=1] MR texel, and select the default B=2 lane; the cube
# must stay at the default baseline because B is zero
FALSIFY_MATERIAL_METALLIC_CHANNEL=2 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Material metallic-channel positive control: select R=0 from that same texel;
# R and the default G roughness lane are both one, so only metallic changes
FALSIFY_MATERIAL_METALLIC_CHANNEL=0 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Material clearcoat control: enable the same standard material's clearcoat layer;
# its response must move from the default no-coat result
FALSIFY_MATERIAL_CLEARCOAT=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Material clearcoat-roughness control: retain clearcoat=1 while changing only
# the producer-owned clearcoat roughness scalar from its 0.5 baseline to 1
FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Material occlusion control: activate a public solid-color Skylight so the
# ambient AO term is live, then bind a real black linear TextureAsset to the
# same standard material's occlusion slot
ENABLE_MATERIAL_OCCLUSION_AMBIENT=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug
ENABLE_MATERIAL_OCCLUSION_AMBIENT=1 FALSIFY_MATERIAL_OCCLUSION_TEXTURE=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug
ENABLE_MATERIAL_OCCLUSION_AMBIENT=1 FALSIFY_MATERIAL_OCCLUSION_TEXTURE=1 FALSIFY_MATERIAL_OCCLUSION_STRENGTH=0 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Material alpha-cutoff control: lower authored base-color alpha to 0.25 and
# require the Standard PBR alphaCutoff=0.5 fragment discard path
FALSIFY_MATERIAL_ALPHA_CUTOFF=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Material base-color alpha control: keep alphaCutoff disabled and write only
# baseColor alpha=0; the final RGBA target must expose alpha zero while RGB
# stays at the opaque material baseline
FALSIFY_MATERIAL_BASE_COLOR_ALPHA=0 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Material base-color texture alpha control: keep scalar baseColor alpha at 1,
# bind white RGB with texture alpha=0, and require final target alpha zero
FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA=0 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Midrange texture-alpha control: bind white RGB with 8-bit texture alpha=128
# and require final target alpha to remain near 128/255, not just 0 or 1
FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA=0.5 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Midrange base-color red-channel control: bind texture RGBA=[128,255,255,255]
# and require the red response near the calibrated 128/255 texture witness
FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED=0.5 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Midrange base-color green-channel control: bind texture RGBA=[255,128,255,255]
# and require the green response near the calibrated 128/255 texture witness
FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN=0.5 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Midrange base-color blue-channel control: bind texture RGBA=[255,255,128,255]
# and require the blue response near the calibrated 128/255 texture witness
FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE=0.5 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Midrange base-color RGB control: bind one real texture RGBA=[128,128,128,255]
# and require all three channel responses near their calibrated joint witness
FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB=0.5 pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" smoke:rhi-debug

# Preview
pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" preview
```

The Dawn gate renders 300 frames and reads the final target. The normal white
light requires an orange ordering (`red > green > blue`) at `cubeCenter`; the
blue-light control requires `blue > red` and `blue > green`. Both controls use
the same scene and renderer, so the channel change is evidence for the
producer-owned light-color path rather than a separate fixture.

The intensity control keeps the orange ordering but requires the cube red
channel to move into `(0.2, 0.4)`, falsifying an ignored
`DirectionalLight.intensity` path.

The direction control reverses the producer-owned vector and expects the cube
to fall below the direct-light ROI, so an ignored direction path fails even if
the normal color and intensity witnesses remain green.

The object-color control changes only the producer-owned standard-material
`baseColor` from orange to green and requires green to dominate both red and
blue at `cubeCenter`. An ignored material value therefore fails the same
real-render oracle even when the light controls remain correct.

The material control changes only the standard-material `metallic` factor from
`0.0` to `1.0` and requires the same `cubeCenter` response to move away from the
default orange baseline. This proves the PBR energy split is not silently ignored.

The roughness control changes only the standard-material `roughness` factor from
`0.5` to `0.0` and requires the same `cubeCenter` response to move by more than
the material-response threshold (`0.02`) from the default baseline. The other
endpoint (`1.0`) is intentionally not the falsifier: at this fixed readback site
its quantized response is only about `0.011`, below the threshold.

The emissive control adds only the optional Standard PBR values
`emissive=[1.0, 0.1, 0.1]` and `emissiveIntensity=1.0` to the same material
handle. It requires the same `cubeCenter` response to move by more than the
default material threshold, proving that optional emissive values reach the
fragment path rather than being silently ignored.

The emissive-intensity control keeps that same red emissive color but sets only
`emissiveIntensity=0`. It requires the `cubeCenter` response to return within
the calibrated default-material threshold. This isolates the scalar from the
color witness and fails if the intensity is silently ignored or replaced with
the default positive value.

The specular-tint control adds only `specularTint=[1.0, 0.0, 0.0]` to the same material handle.
It requires the same `cubeCenter` response to move beyond the calibrated specular-tint threshold,
proving that the optional specular tint reaches the fragment path rather than being silently
ignored.

The specular-tint-texture control binds only a 1x1 linear black `TextureAsset` to
`specularTintTexture` on the same material handle. It requires the same `cubeCenter` response to
move beyond the calibrated texture threshold, proving that texture upload, binding, and sampling
reach the Standard PBR fragment path rather than being silently ignored.

The normal-texture control binds a 1x1 linear RG normal map with RG=`[255,128]` to the same
material's `normalTexture` slot. It requires the same `cubeCenter` response to move beyond the
calibrated normal threshold, proving that texture upload, binding, tangent-space decoding, TBN
composition, and Standard PBR lighting reach the fragment path rather than being silently ignored.

The normal-scale control keeps that same RG normal map but passes it as the nested texture value
`{ texture, normalScale: 0 }`. The fixed `cubeCenter` must return within the calibrated threshold
of the flat-normal baseline. This proves the existing `MaterialTextureValue.normalScale` contract
survives material extraction, the standard PBR UBO, and WGSL TBN composition instead of being
dropped before the shader.

The emissive-texture control keeps a non-zero authored emissive value and binds a 1x1 linear black
texture to the same material's `emissiveTexture` slot. The black texel must suppress that authored
emissive contribution and keep `cubeCenter` within the calibrated threshold of the default baseline;
an ignored texture would leave the red emissive contribution visible and fail this falsifier. The
separate emissive-factor control remains the positive response witness.

The base-color-texture control binds a 1x1 linear black texture to the same material's
`baseColorTexture` slot. It requires the same `cubeCenter` response to move beyond the calibrated
base-color-texture threshold, proving that texture upload, user-region binding, and sampled albedo
reach the Standard PBR fragment path rather than being silently ignored.

The midrange RGB control binds one 1x1 linear `[128,128,128,255]` texture to that same
`baseColorTexture` slot while leaving scalar `baseColor=[1,1,1,1]`. It compares all three sampled
channels against the independent red, green, and blue witnesses and requires opaque alpha to be
preserved. The control is mutually exclusive with the generic, per-channel, alpha, and discard
controls, so a one-channel fallback cannot satisfy the joint witness.

The metallic-roughness-texture control binds a 1x1 linear black texture to the same material's
`metallicRoughnessTexture` slot. Its G channel drives the default glTF roughness selector, so the
black texel forces the authored roughness multiplier to the calibrated endpoint. The same
`cubeCenter` response must move beyond the calibrated threshold, proving texture upload,
user-region binding, channel selection, and sampled PBR roughness reach the fragment path rather
than being silently ignored.

The metallic-channel controls bind a 1x1 linear `[255,255,0,255]` MR texture and set authored
`metallic=1`. The negative `FALSIFY_MATERIAL_METALLIC_CHANNEL=2` lane uses the glTF default B
selector, so the zero B value returns the cube to the opaque default baseline. The positive
`FALSIFY_MATERIAL_METALLIC_CHANNEL=0` lane selects R=1 while leaving the default G roughness lane
at one, so the cube moves to the fully metallic response. Both controls require the same real
texture upload, binding, UBO selector, and `pick_channel` fragment path; unsupported control values
are rejected before Dawn setup.

The clearcoat control sets `clearcoat=1` and `clearcoatRoughness=0.5` on the same Standard PBR
material. Its `cubeCenter` response must move beyond the calibrated clearcoat threshold, proving
that the producer-owned clearcoat values reach the fragment path rather than being silently
ignored. Clearcoat texture and transmission remain outside this witness.

The clearcoat-roughness control keeps `clearcoat=1` active and sets only
`clearcoatRoughness=1`. Its response must differ from both the no-coat baseline and the prior
clearcoat roughness `0.5` baseline, proving the scalar is consumed by the existing clearcoat lobe
rather than only proving that clearcoat is enabled.

The occlusion control first enables a public solid-color `Skylight` with a dim gray tint, then
binds a 1x1 linear black `TextureAsset` to `occlusionTexture`. The ambient-only baseline moves
`cubeCenter` to approximately `[0.6235, 0.3176, 0.2078]`; the black AO texel must remove that
ambient contribution and return the cube to the direct-light response near
`[0.5333, 0.2667, 0.1686]`, exceeding the calibrated `0.02` response threshold. The falsifier
requires `ENABLE_MATERIAL_OCCLUSION_AMBIENT=1`, so an inactive AO term cannot produce a false
green; omitting the flag is an expected validation failure.

The occlusion-strength control keeps the same public `Skylight` and black `occlusionTexture`, but
sets `occlusionStrength=0` through `FALSIFY_MATERIAL_OCCLUSION_STRENGTH=0`. It must return
`cubeCenter` to the ambient-only baseline within `0.02`, proving the scalar gates the sampled AO
term instead of being silently ignored. The control requires both occlusion flags so it cannot pass
without a live texture sample and ambient contribution.

The alpha-cutoff control lowers only the same material's authored `baseColor.a` to `0.25` and sets
`alphaCutoff=0.5`. The fixed cube-center ROI must return to clear color while the lamp remains
visible, proving the Standard PBR fragment discard path consumes the producer-owned scalar rather
than merely preserving the low-alpha draw.

The base-color-alpha control leaves `alphaCutoff` unset and changes only the same material's
authored `baseColor.a` to `0`. The Dawn RGBA readback at `cubeCenter` must preserve the opaque RGB
baseline while reporting alpha `0`, proving the payload reaches the final render target without
claiming a blend-state contract. Browser capture/replay covers the unchanged opaque scene and its
fresh-Dawn pixel parity separately.

The base-color-texture-alpha control leaves scalar `baseColor.a=1` and `alphaCutoff` unset, then
binds a real linear `TextureAsset` whose texel is white RGB with alpha `0`. The same `cubeCenter`
RGB baseline must remain intact while the final RGBA target reports alpha `0`, proving that sampled
base-color texture alpha reaches the render target independently of scalar alpha and discard.

## forgeax-vs-LearnOpenGL mapping

| LO concept | LO C++ / OpenGL | forgeax equivalent |
|:--|:--|:--|
| Object with color | `objectColor` uniform vec3 fed to fragment shader | `StandardMaterialAsset.baseColor` RGBA array |
| Light color | `lightColor` uniform vec3 | `DirectionalLight.color{R,G,B}` f32 fields |
| Light direction | `normalize(lightPos - FragPos)` in shader | `DirectionalLight.direction{X,Y,Z}` (outgoing: points from light toward surface) |
| Lamp cube | Separate shader that outputs `lightColor` | `UnlitMaterialAsset` (shadingModel: 'unlit') -- ignores lighting, always renders as given baseColor |
| Frag shader formula | `ambient + diffuse` (Phong per-fragment) | `pbr.wgsl` microfacet BRDF (Cook-Torrance specular + Lambertian diffuse) |
| Camera | `Camera` class + WASD movement (LO section 1.7) | `Transform` + `Camera` ECS components + `addFirstPersonSystem` from `apps/shared` (mirrors LO WASD/mouse/scroll controls) |
| Window + render loop | `glfwCreateWindow` + `while(!glfwWindowShouldClose)` | `createApp(canvas, opts)` from `@forgeax/engine-app` |
| Vertex data | Manual `float vertices[]` array + VBO/VAO setup | Built-in `HANDLE_CUBE` procedural geometry from `@forgeax/engine-runtime` |

## Differences from the LearnOpenGL original

| Dimension | LO original (C++ / GLSL / GLFW) | forgeax here (TS / WGSL / WebGPU) |
|:--|:--|:--|
| Lighting model | Phong (ambient + diffuse) | PBR microfacet (Cook-Torrance + Lambertian) |
| Light type | Point-like direction (no attenuation) | `DirectionalLight` component (infinite distance) |
| Lamp shader | Separate `lightCubeShader` C++ object | `shadingModel: 'unlit'` discriminant on `MaterialAsset` |
| Object material | Shader uniform `objectColor` | `MaterialAsset.baseColor` with `shadingModel: 'standard'` |
| Light parameters | `lightPos` vec3 + `lightColor` vec3 | `DirectionalLight` 7 f32 SoA columns (direction + color + intensity) |
| Fragment formula | `(ambientStrength * lightColor + diffuse) * objectColor` | PBR BRDF evaluation in `pbr.wgsl` (no ambient term; directional light contributes via microfacet specular + Lambertian diffuse) |
| Camera | `Camera` class with `glm::lookAt` | `Transform` + `Camera` ECS components; engine `RenderSystem` composes `view = inverse(camera.Transform)` |
| Render loop | `glfwSwapBuffers` + `glfwPollEvents` | `createApp` rAF frame-loop with `Time` resource + auto input |
| Shader management | `Shader` class + compile/link/use calls | `vite-plugin-shader` build-time compile + `/shaders/manifest.json` at runtime |

> [!IMPORTANT]
> The PBR output differs visually from the LO Phong result because the microfacet BRDF includes view-dependent specular and energy conservation terms that Phong does not model. The colored cube will show specular highlights along the reflection vector and the cube faces will darken at grazing angles (Fresnel effect), neither of which appear in the LO screenshot.

## Key files

| File | Lines | Role |
|:--|--:|:--|
| `src/index.ts` | ~250 | Three-section (engine usage + example glue + bootstrap) -- spawns colored cube, lamp marker, DirectionalLight, and a first-person camera (`addFirstPersonSystem` from `apps/shared`) |
| `package.json` | ~40 | Workspace metadata + dependencies (`engine-app`, `engine-runtime`, `engine-ecs`, `engine-types`) |
| `vite.config.ts` | ~30 | Vite config with `forgeaxShader` plugin for shader manifest generation |

## AI user discoverability

- Directory name: `apps/learn-render/2.lighting/1.colors/` mirrors LO chapter ordering
- Package name: `@forgeax/app-learn-render-2-lighting-1-colors` is grep-able by chapter prefix
- Three-section source markers (`// 1. engine usage` / `// 2. example-specific glue` / `// 3. bootstrap`) serve as grep anchors per convention AC-06
