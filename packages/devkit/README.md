# @forgeax/engine-devkit

Node-only orchestration for external ForgeaX game projects. The public product surface is the `forgeax` CLI; the library entry exposes the same command handlers for CI and hosts.

```text
forgeax init
forgeax doctor
forgeax test
forgeax dev
forgeax build
forgeax preview
forgeax asset add <path>
forgeax asset verify
forgeax asset inspect <guid-or-name>
forgeax asset list
forgeax shader check [path]
```

Game projects keep their authority in `forge.json`, `package.json#forgeax.assets`, source Meta/Pack files, and imported game code. DevKit derives Vite and producer assembly from those facts.

`asset add` is the only command in the asset group that writes source authority. It creates or reuses image and glTF sidecars; `dev` and `build` never mint missing GUIDs. All non-long-running commands support `--json`, and explicit write commands support `--dry-run`.
