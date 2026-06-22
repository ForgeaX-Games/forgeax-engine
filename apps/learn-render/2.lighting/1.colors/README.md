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

# Preview
pnpm --filter "@forgeax/app-learn-render-2-lighting-1-colors" preview
```

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