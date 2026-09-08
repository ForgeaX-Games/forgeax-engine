# ForgeaX Game 3D

This starter is a playable reference scene for the normal ForgeaX 3D lighting path.

> [!IMPORTANT]
> `assets/` contains only ScriptablePack authoring sources. The analytic daylight,
> meshes, materials, and scene are generated from `*.pack.ts`; there are no image,
> HDR, model, shader, or sidecar asset files to recover.

| Pack | Owns |
|:--|:--|
| `environment.pack.ts` | Procedural HDR equirect daylight used by `Skylight` and `SkyboxBackground` |
| `materials.pack.ts` | Standard PBR material assets |
| `geometry.pack.ts` | Procedural environment and player meshes with their default material slots |
| `fantasy-meshes.pack.ts` | Klein bottle, trefoil knot, and astral bloom generated into multi-submesh meshes |
| `scene.pack.ts` | Third-person player, large walkable scene, camera, daylight, shadows, and point light |

The default scene is loaded from `forge.json`; `src/main.ts` adds one ECS-owned
third-person motor, Rapier `CharacterController` movement, and a smooth follow camera.

> [!TIP]
> Move with <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or the arrow keys.
> Press <kbd>Space</kbd> to jump. Movement is camera-relative and the capsule's
> orange marker shows its forward direction.

## Procedural multi-submesh examples

Each fantasy object is one `MeshAsset`: one vertex buffer, one index buffer,
three `submeshes[]` draw ranges, and three stable `materialSlots[]`. The scene
leaves `MeshRenderer.materials` empty so the mesh-owned defaults demonstrate
the complete Pack → cook → catalog → renderer route.

| Mesh | Procedural idea | Submesh materials |
|:--|:--|:--|
| Klein bottle | Figure-eight immersion with explicit reversed faces and flipped back normals | Azure Flux · Violet Rift · Solar Gold |
| Trefoil knot | Parametric centerline swept by a numerically framed tube | Azure Flux · Violet Rift · Solar Gold |
| Astral bloom | Five-lobed, vertically rippled torus surface | Azure Flux · Violet Rift · Solar Gold |

```bash
pnpm test
pnpm dev
pnpm build
pnpm preview
```
