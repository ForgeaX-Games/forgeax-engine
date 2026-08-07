# 10k cubes + punctual lights admission

This is one parameterized `engine-performance` pressure consumer. Its no-argument run is the canonical admission point.

| Fact | Fixed contract |
|:--|:--|
| Cubes | `10,000` individually queryable entities, each with `Transform`, `MeshFilter`, and `MeshRenderer` |
| Shared assets | Built-in `HANDLE_CUBE` and one shared standard `MaterialAsset` handle |
| Distribution | Uniform PRNG samples in `[-24,24] x [-16,16] x [-24,24]` |
| Seed | `0x010c0b35` (`PERF_WORKLOAD_SEED`, version `1`) |
| Camera | Transform at the exact volume center `[0,0,0]`, rotating continuously in place |
| ECS work | Named `perf-10k-cubes-rotate` Update system writes every cube quaternion every measured frame |
| Lights | Defaults `16 PointLight + 16 SpotLight`; total is fail-fast bounded to the HDRP `256` light contract |

Scale parameters are query-string values (`cubes`, `pointLights`, `spotLights`) and are included in the workload fingerprint. They change counts only; seed, volume, mesh, material, camera law, pipeline, viewport, and rotation laws remain fixed.

```text
http://127.0.0.1:5207/?cubes=1000&pointLights=8&spotLights=8
```

`smoke` drives the same built app contract through Dawn-node and records the post-spawn query oracle, frame progress, processed-cube count, renderer errors, raw frame samples, and a complete CPU `ProfileCapture`. `smoke:browser` drives the Vite dev-server front door and records screenshot/readback plus browser errors. Neither smoke is an optimization claim.
