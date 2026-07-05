/*
 * bridge.c — ufbx → JSON POD bridge for WebAssembly.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) forgeax engine contributors.
 *
 * Emits the engine FBX POD JSON schema consumed by the parse-*.ts /
 * to-asset-pack.ts bridge layer (single ufbx WASM parser, no native addon).
 *
 * Compiled with Emscripten: emcc -O3 ufbx.c bridge.c -o fbx-wasm.mjs
 *
 * Exported functions (called from JS):
 *   parseFbxWasm(ptr, size)  — parse FBX bytes, store result JSON internally
 *   getResultPtr()           — pointer to result JSON string
 *   getResultLen()           — byte length of result JSON string
 *   freeResult()             — free the result buffer
 */

#include "ufbx.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

/* ── Dynamic string buffer ─────────────────────────────────────────── */

typedef struct {
    char *data;
    size_t len;
    size_t cap;
} Buf;

static void buf_init(Buf *b) {
    b->cap = 4096;
    b->data = (char *)malloc(b->cap);
    b->len = 0;
    b->data[0] = '\0';
}

static void buf_ensure(Buf *b, size_t extra) {
    while (b->len + extra + 1 > b->cap) {
        b->cap *= 2;
        b->data = (char *)realloc(b->data, b->cap);
    }
}

static void buf_str(Buf *b, const char *s) {
    size_t n = strlen(s);
    buf_ensure(b, n);
    memcpy(b->data + b->len, s, n);
    b->len += n;
    b->data[b->len] = '\0';
}

static void buf_char(Buf *b, char c) {
    buf_ensure(b, 1);
    b->data[b->len++] = c;
    b->data[b->len] = '\0';
}

static void buf_double(Buf *b, double v) {
    if (!isfinite(v)) v = 0.0;
    char tmp[64];
    snprintf(tmp, sizeof(tmp), "%.17g", v);
    buf_str(b, tmp);
}

static void buf_int(Buf *b, int v) {
    char tmp[32];
    snprintf(tmp, sizeof(tmp), "%d", v);
    buf_str(b, tmp);
}

static void buf_size(Buf *b, size_t v) {
    char tmp[32];
    snprintf(tmp, sizeof(tmp), "%zu", v);
    buf_str(b, tmp);
}

static void buf_quoted(Buf *b, const char *s) {
    buf_char(b, '"');
    for (const char *p = s; *p; p++) {
        if (*p == '"') buf_str(b, "\\\"");
        else if (*p == '\\') buf_str(b, "\\\\");
        else if (*p == '\n') buf_str(b, "\\n");
        else if (*p == '\r') buf_str(b, "\\r");
        else if (*p == '\t') buf_str(b, "\\t");
        else buf_char(b, *p);
    }
    buf_char(b, '"');
}

/* ── Mesh writing ──────────────────────────────────────────────────── */

static void write_mesh(Buf *b, ufbx_mesh *mesh, int source_index) {
    buf_char(b, '{');

    /* name */
    buf_str(b, "\"name\":");
    const char *name = mesh->element.name.data;
    if (!name || name[0] == '\0') {
        ufbx_node *node = mesh->instances.count > 0 ? mesh->instances.data[0] : NULL;
        name = node ? node->name.data : "";
    }
    buf_quoted(b, name ? name : "");
    buf_char(b, ',');

    /* Triangulate and collect vertex data */
    size_t max_tris = 0;
    for (size_t fi = 0; fi < mesh->num_faces; fi++) {
        ufbx_face face = mesh->faces.data[fi];
        if (face.num_indices >= 3) max_tris += face.num_indices - 2;
    }

    size_t num_tri_indices = max_tris * 3;
    uint32_t *tri_indices = (uint32_t *)calloc(num_tri_indices, sizeof(uint32_t));

    float *positions = (float *)calloc(mesh->num_indices * 3, sizeof(float));
    float *normals = (float *)calloc(mesh->num_indices * 3, sizeof(float));

    for (size_t i = 0; i < mesh->num_indices; i++) {
        uint32_t vi = mesh->vertex_position.indices.data[i];
        ufbx_vec3 p = mesh->vertex_position.values.data[vi];
        positions[i * 3 + 0] = (float)p.x;
        positions[i * 3 + 1] = (float)p.y;
        positions[i * 3 + 2] = (float)p.z;

        if (mesh->vertex_normal.exists) {
            uint32_t ni = mesh->vertex_normal.indices.data[i];
            ufbx_vec3 n = mesh->vertex_normal.values.data[ni];
            normals[i * 3 + 0] = (float)n.x;
            normals[i * 3 + 1] = (float)n.y;
            normals[i * 3 + 2] = (float)n.z;
        }
    }

    /* Re-triangulate all faces into tri_indices */
    size_t max_face_tris = mesh->max_face_triangles;
    size_t temp_size = max_face_tris * 3;
    if (temp_size < 64) temp_size = 64;
    uint32_t *temp = (uint32_t *)malloc(temp_size * sizeof(uint32_t));
    size_t tri_idx = 0;
    for (size_t fi = 0; fi < mesh->num_faces; fi++) {
        ufbx_face face = mesh->faces.data[fi];
        size_t nt = ufbx_triangulate_face(temp, temp_size, mesh, face);
        for (size_t ti = 0; ti < nt * 3 && tri_idx < num_tri_indices; ti++) {
            tri_indices[tri_idx++] = temp[ti];
        }
    }
    free(temp);
    num_tri_indices = tri_idx;

    /* vertices (positions as flat array) */
    buf_str(b, "\"vertices\":[");
    for (size_t i = 0; i < mesh->num_indices * 3; i++) {
        if (i > 0) buf_char(b, ',');
        buf_double(b, positions[i]);
    }
    buf_str(b, "],");

    /* indices (triangulated) */
    buf_str(b, "\"indices\":[");
    for (size_t i = 0; i < num_tri_indices; i++) {
        if (i > 0) buf_char(b, ',');
        buf_int(b, (int)tri_indices[i]);
    }
    buf_str(b, "],");

    /* attributes */
    buf_str(b, "\"attributes\":{");

    if (mesh->vertex_normal.exists) {
        buf_str(b, "\"NORMAL\":[");
        for (size_t i = 0; i < mesh->num_indices * 3; i++) {
            if (i > 0) buf_char(b, ',');
            buf_double(b, normals[i]);
        }
        buf_char(b, ']');
    }

    /* UV layers */
    for (size_t layer = 0; layer < mesh->uv_sets.count; layer++) {
        ufbx_uv_set *uv_set = &mesh->uv_sets.data[layer];
        if (mesh->vertex_normal.exists || layer > 0) buf_char(b, ',');

        char key[32];
        snprintf(key, sizeof(key), "TEXCOORD_%zu", layer);
        buf_char(b, '"'); buf_str(b, key); buf_str(b, "\":[");
        for (size_t i = 0; i < mesh->num_indices; i++) {
            uint32_t ui = uv_set->vertex_uv.indices.data[i];
            ufbx_vec2 uv = uv_set->vertex_uv.values.data[ui];
            if (i > 0) buf_char(b, ',');
            buf_double(b, uv.x); buf_char(b, ','); buf_double(b, uv.y);
        }
        buf_char(b, ']');
    }

    buf_str(b, "},");

    /* polygonCount, sourceIndex, materialIndex */
    buf_str(b, "\"polygonCount\":"); buf_size(b, mesh->num_faces); buf_char(b, ',');
    buf_str(b, "\"sourceIndex\":"); buf_int(b, source_index); buf_char(b, ',');
    buf_str(b, "\"materialIndex\":");
    if (mesh->materials.count > 0) buf_int(b, 0);
    else buf_int(b, -1);

    buf_char(b, '}');

    free(positions);
    free(normals);
    free(tri_indices);
}

/* ── System-node filter ────────────────────────────────────────────── */

/* FBX files carry built-in system objects the Autodesk SDK never surfaces in
 * the node tree: the seven "Producer <view>" viewport cameras and the
 * "Camera Switcher". ufbx exposes them as ordinary nodes, so we filter them by
 * name to match the SDK ScenePod/animation baseline (M0 probe: 93 -> 85 nodes).
 * Authored cameras/lights/bones/empties are kept. */
static int is_system_node(const ufbx_node *node) {
    const char *name = node->name.data;
    if (!name) return 0;
    if (strncmp(name, "Producer ", 9) == 0) return 1;
    if (strcmp(name, "Camera Switcher") == 0) return 1;
    return 0;
}

/* True for nodes that must not appear in the emitted ScenePod / animation. */
static int skip_node(const ufbx_node *node) {
    return node->is_root || is_system_node(node);
}

/* ── Scene nodes writing ───────────────────────────────────────────── */

/* Emit ScenePod nodes in DFS pre-order from the root's children, matching the
 * SDK binding's WalkNode traversal so entity indices + children[] references
 * line up field-for-field. `order` maps each emitted node -> its flat index;
 * two passes (assign indices, then emit) keep children[] forward-referenceable.
 *
 * A DFS that descends into skipped (system) nodes' subtrees would still hide
 * the system node itself but keep its descendants; the SDK's system cameras are
 * childless leaves, so simply skipping them is equivalent. */

static void dfs_assign(ufbx_node *node, ufbx_node **order, int *count) {
    if (!skip_node(node)) order[(*count)++] = node;
    for (size_t i = 0; i < node->children.count; i++) {
        dfs_assign(node->children.data[i], order, count);
    }
}

static int index_of(ufbx_node **order, int count, const ufbx_node *node) {
    for (int i = 0; i < count; i++) {
        if (order[i] == node) return i;
    }
    return -1;
}

static void write_nodes(Buf *b, ufbx_scene *scene) {
    buf_str(b, "\"nodes\":[");

    /* Build the DFS pre-order emit list (root's subtrees, root excluded). */
    ufbx_node **order = (ufbx_node **)malloc(scene->nodes.count * sizeof(ufbx_node *));
    int count = 0;
    ufbx_node *root = scene->root_node;
    if (root) {
        for (size_t i = 0; i < root->children.count; i++) {
            dfs_assign(root->children.data[i], order, &count);
        }
    }

    for (int n = 0; n < count; n++) {
        ufbx_node *node = order[n];
        if (n > 0) buf_char(b, ',');

        buf_char(b, '{');

        /* name */
        buf_str(b, "\"name\":");
        buf_quoted(b, node->name.data ? node->name.data : "");
        buf_char(b, ',');

        /* transform (local) */
        ufbx_transform xform = node->local_transform;
        buf_str(b, "\"transform\":{");
        buf_str(b, "\"translation\":[");
        buf_double(b, xform.translation.x); buf_char(b, ',');
        buf_double(b, xform.translation.y); buf_char(b, ',');
        buf_double(b, xform.translation.z);
        buf_str(b, "],\"rotation\":[");
        buf_double(b, xform.rotation.x); buf_char(b, ',');
        buf_double(b, xform.rotation.y); buf_char(b, ',');
        buf_double(b, xform.rotation.z); buf_char(b, ',');
        buf_double(b, xform.rotation.w);
        buf_str(b, "],\"scale\":[");
        buf_double(b, xform.scale.x); buf_char(b, ',');
        buf_double(b, xform.scale.y); buf_char(b, ',');
        buf_double(b, xform.scale.z);
        buf_str(b, "]},");

        /* meshIndex */
        buf_str(b, "\"meshIndex\":");
        if (node->mesh) {
            int idx = -1;
            for (size_t mi = 0; mi < scene->meshes.count; mi++) {
                if (scene->meshes.data[mi] == node->mesh) { idx = (int)mi; break; }
            }
            buf_int(b, idx);
        } else {
            buf_int(b, -1);
        }
        buf_char(b, ',');

        /* children (indices into the emitted DFS list) */
        buf_str(b, "\"children\":[");
        int first_child = 1;
        for (size_t ci = 0; ci < node->children.count; ci++) {
            ufbx_node *child = node->children.data[ci];
            if (skip_node(child)) continue;
            if (!first_child) buf_char(b, ',');
            first_child = 0;
            buf_int(b, index_of(order, count, child));
        }
        buf_char(b, ']');

        buf_char(b, '}');
    }
    buf_char(b, ']');
    free(order);
}

/* ── Materials writing ─────────────────────────────────────────────── */

static void write_materials(Buf *b, ufbx_scene *scene) {
    if (scene->materials.count == 0) return;

    buf_str(b, ",\"materials\":[");
    for (size_t i = 0; i < scene->materials.count; i++) {
        ufbx_material *mat = scene->materials.data[i];
        if (i > 0) buf_char(b, ',');
        buf_char(b, '{');

        buf_str(b, "\"name\":");
        buf_quoted(b, mat->name.data ? mat->name.data : "");
        buf_char(b, ',');

        /* Material kind detection (KB §1.7 / appendix B-1, PBR-first).
         *
         * shader_type alone under-classifies: a material whose shader_type is
         * UFBX_SHADER_UNKNOWN (e.g. legacy 3ds Max "Standard") still fills
         * material->fbx.* / material->pbr.* with valid values, so keying only
         * on the shader_type whitelist wrongly drops it to "fallback" grey.
         *
         * Classification (matches the SDK binding's StingrayPBS > Phong >
         * Lambert > fallback priority):
         *   - explicit PBR shader graphs (Stingray/glTF/3ds-Max-PBR/OSL/Arnold/
         *     OpenPBR) or a material with the PBR feature enabled -> stingray-pbs
         *     (read pbr.* maps)
         *   - otherwise a material that has specular (Phong lighting) -> phong
         *     (read fbx.* maps: diffuse + specular_exponent + specular_color)
         *   - otherwise a material with diffuse -> lambert (read fbx.diffuse)
         *   - otherwise -> fallback */
        int is_pbr_shader =
            mat->shader_type == UFBX_SHADER_SHADERFX_GRAPH ||
            mat->shader_type == UFBX_SHADER_GLTF_MATERIAL ||
            mat->shader_type == UFBX_SHADER_3DS_MAX_PBR_METAL_ROUGH ||
            mat->shader_type == UFBX_SHADER_3DS_MAX_PBR_SPEC_GLOSS ||
            mat->shader_type == UFBX_SHADER_3DS_MAX_PHYSICAL_MATERIAL ||
            mat->shader_type == UFBX_SHADER_OSL_STANDARD_SURFACE ||
            mat->shader_type == UFBX_SHADER_ARNOLD_STANDARD_SURFACE ||
            mat->shader_type == UFBX_SHADER_OPENPBR_MATERIAL;

        int is_phong =
            mat->shader_type == UFBX_SHADER_FBX_PHONG ||
            mat->shader_type == UFBX_SHADER_BLENDER_PHONG ||
            mat->features.specular.enabled;

        int has_diffuse =
            mat->features.diffuse.enabled || mat->fbx.diffuse_color.has_value;

        if (is_pbr_shader || mat->features.pbr.enabled) {

            ufbx_material_map bc = mat->pbr.base_color;
            buf_str(b, "\"kind\":\"stingray-pbs\",");
            buf_str(b, "\"stingrayProps\":{");
            buf_str(b, "\"baseColor\":[");
            buf_double(b, bc.value_vec4.x); buf_char(b, ',');
            buf_double(b, bc.value_vec4.y); buf_char(b, ',');
            buf_double(b, bc.value_vec4.z);
            buf_str(b, "],");
            buf_str(b, "\"metallic\":");
            buf_double(b, mat->pbr.metalness.value_real);
            buf_str(b, ",\"roughness\":");
            buf_double(b, mat->pbr.roughness.value_real);
            buf_char(b, '}');

        } else if (is_phong) {
            buf_str(b, "\"kind\":\"phong\",");
            buf_str(b, "\"diffuse\":[");
            buf_double(b, mat->fbx.diffuse_color.value_vec3.x); buf_char(b, ',');
            buf_double(b, mat->fbx.diffuse_color.value_vec3.y); buf_char(b, ',');
            buf_double(b, mat->fbx.diffuse_color.value_vec3.z);
            buf_str(b, "],");
            buf_str(b, "\"shininess\":");
            buf_double(b, mat->fbx.specular_exponent.value_real);
            buf_str(b, ",\"specular\":[");
            buf_double(b, mat->fbx.specular_color.value_vec3.x); buf_char(b, ',');
            buf_double(b, mat->fbx.specular_color.value_vec3.y); buf_char(b, ',');
            buf_double(b, mat->fbx.specular_color.value_vec3.z);
            buf_char(b, ']');

        } else if (has_diffuse || mat->shader_type == UFBX_SHADER_FBX_LAMBERT) {
            buf_str(b, "\"kind\":\"lambert\",");
            buf_str(b, "\"diffuse\":[");
            buf_double(b, mat->fbx.diffuse_color.value_vec3.x); buf_char(b, ',');
            buf_double(b, mat->fbx.diffuse_color.value_vec3.y); buf_char(b, ',');
            buf_double(b, mat->fbx.diffuse_color.value_vec3.z);
            buf_char(b, ']');
        } else {
            buf_str(b, "\"kind\":\"fallback\"");
        }

        buf_str(b, ",\"sourceIndex\":");
        buf_size(b, i);

        buf_char(b, '}');
    }
    buf_char(b, ']');
}

/* ── Skeleton writing ──────────────────────────────────────────────── */

static void write_skeleton(Buf *b, ufbx_scene *scene) {
    /* Find the first skin deformer with clusters */
    ufbx_skin_deformer *skin = NULL;
    for (size_t i = 0; i < scene->skin_deformers.count; i++) {
        if (scene->skin_deformers.data[i]->clusters.count > 0) {
            skin = scene->skin_deformers.data[i];
            break;
        }
    }
    if (!skin) return;

    size_t cluster_count = skin->clusters.count;

    buf_str(b, ",\"skeletons\":[{");
    buf_str(b, "\"jointCount\":"); buf_size(b, cluster_count); buf_char(b, ',');

    /* Inverse bind matrices: for each cluster, compute IBM */
    buf_str(b, "\"inverseBindMatrices\":[");
    for (size_t c = 0; c < cluster_count; c++) {
        ufbx_skin_cluster *cluster = skin->clusters.data[c];
        ufbx_matrix ibm = cluster->geometry_to_bone;

        if (c > 0) buf_char(b, ',');
        /* 4x4 column-major (matching glTF convention) */
        buf_double(b, ibm.m00); buf_char(b, ',');
        buf_double(b, ibm.m10); buf_char(b, ',');
        buf_double(b, ibm.m20); buf_char(b, ',');
        buf_double(b, 0.0);     buf_char(b, ',');
        buf_double(b, ibm.m01); buf_char(b, ',');
        buf_double(b, ibm.m11); buf_char(b, ',');
        buf_double(b, ibm.m21); buf_char(b, ',');
        buf_double(b, 0.0);     buf_char(b, ',');
        buf_double(b, ibm.m02); buf_char(b, ',');
        buf_double(b, ibm.m12); buf_char(b, ',');
        buf_double(b, ibm.m22); buf_char(b, ',');
        buf_double(b, 0.0);     buf_char(b, ',');
        buf_double(b, ibm.m03); buf_char(b, ',');
        buf_double(b, ibm.m13); buf_char(b, ',');
        buf_double(b, ibm.m23); buf_char(b, ',');
        buf_double(b, 1.0);
    }
    buf_str(b, "],");

    /* Joint paths (bone names) */
    buf_str(b, "\"jointPaths\":[");
    for (size_t c = 0; c < cluster_count; c++) {
        ufbx_skin_cluster *cluster = skin->clusters.data[c];
        if (c > 0) buf_char(b, ',');
        const char *name = cluster->bone_node ?
            cluster->bone_node->name.data : "";
        buf_quoted(b, name ? name : "");
    }
    buf_str(b, "]");

    buf_str(b, "}]");
}

/* ── Skin writing ──────────────────────────────────────────────────── */

/* Emit one influence object (top-4 joints by weight, normalized) for skin
 * control point `cp` (an index into skin->vertices). An out-of-range cp emits a
 * zeroed influence so a corner referencing a control point the deformer never
 * weighted still produces a well-formed entry. */
static void write_skin_influence(Buf *b, const ufbx_skin_deformer *skin, size_t cp) {
    buf_str(b, "{\"jointIndices\":[");

    /* Collect all weights for this control point */
    typedef struct { int joint; double weight; } wp;
    wp pairs[64];
    int pair_count = 0;

    if (cp < skin->vertices.count) {
        ufbx_skin_vertex sv = skin->vertices.data[cp];
        for (size_t wi = 0; wi < sv.num_weights && wi < 64; wi++) {
            ufbx_skin_weight w = skin->weights.data[sv.weight_begin + wi];
            if (pair_count < 64) {
                pairs[pair_count].joint = (int)w.cluster_index;
                pairs[pair_count].weight = w.weight;
                pair_count++;
            }
        }
    }

    /* Sort by weight descending (simple bubble for <=64 elements) */
    for (int a = 0; a < pair_count - 1; a++) {
        for (int bb = a + 1; bb < pair_count; bb++) {
            if (pairs[bb].weight > pairs[a].weight) {
                wp tmp = pairs[a]; pairs[a] = pairs[bb]; pairs[bb] = tmp;
            }
        }
    }

    /* Take top 4, normalize */
    int top = pair_count < 4 ? pair_count : 4;
    double sum = 0;
    for (int k = 0; k < top; k++) sum += pairs[k].weight;

    for (int k = 0; k < 4; k++) {
        if (k > 0) buf_char(b, ',');
        buf_int(b, k < top ? pairs[k].joint : 0);
    }
    buf_str(b, "],\"jointWeights\":[");
    for (int k = 0; k < 4; k++) {
        if (k > 0) buf_char(b, ',');
        buf_double(b, (k < top && sum > 0) ? pairs[k].weight / sum : 0.0);
    }
    buf_str(b, "]}");
}

static void write_skin(Buf *b, ufbx_scene *scene) {
    ufbx_skin_deformer *skin = NULL;
    ufbx_mesh *skinned_mesh = NULL;

    for (size_t i = 0; i < scene->skin_deformers.count; i++) {
        ufbx_skin_deformer *sd = scene->skin_deformers.data[i];
        if (sd->clusters.count == 0) continue;
        skin = sd;
        /* Find the mesh this deformer is attached to */
        for (size_t mi = 0; mi < scene->meshes.count; mi++) {
            ufbx_mesh *m = scene->meshes.data[mi];
            for (size_t di = 0; di < m->skin_deformers.count; di++) {
                if (m->skin_deformers.data[di] == sd) { skinned_mesh = m; break; }
            }
            if (skinned_mesh) break;
        }
        break;
    }
    if (!skin || !skinned_mesh) return;

    /* write_mesh de-indexes geometry to one vertex per polygon corner (positions
     * sized mesh->num_indices), while ufbx stores skin influences per control
     * point (skin->vertices, indexed by control-point index). Emit influences in
     * the same corner order the mesh uses: for each corner, look up its control
     * point via vertex_position.indices and expand that control point's weights.
     * This keeps influences.length == the emitted mesh vertex count, which
     * to-asset-pack.ts requires (influences.length === vc) to write the skinned
     * 18-float vertex layout. A control-point-length array (1605) against a
     * corner-length mesh (9618 for humanoid) makes that check fail, silently
     * drops skinIndex/skinWeight, and the render-system then fail-fasts with
     * material-skin-attr-missing. Mirrors the per-vertex contract glTF skins
     * already satisfy. */
    size_t corner_count = skinned_mesh->num_indices;
    size_t cluster_count = skin->clusters.count;

    buf_str(b, ",\"skins\":[{");
    buf_str(b, "\"meshSourceIndex\":0,");

    /* Joint paths */
    buf_str(b, "\"jointPaths\":[");
    for (size_t c = 0; c < cluster_count; c++) {
        if (c > 0) buf_char(b, ',');
        const char *name = skin->clusters.data[c]->bone_node ?
            skin->clusters.data[c]->bone_node->name.data : "";
        buf_quoted(b, name ? name : "");
    }
    buf_str(b, "],");

    buf_str(b, "\"vertexCount\":"); buf_size(b, corner_count); buf_char(b, ',');

    /* Per-corner influences (top 4, normalized), expanded from control points. */
    buf_str(b, "\"influences\":[");
    for (size_t corner = 0; corner < corner_count; corner++) {
        if (corner > 0) buf_char(b, ',');
        uint32_t cp = skinned_mesh->vertex_position.indices.data[corner];
        write_skin_influence(b, skin, cp);
    }
    buf_char(b, ']');

    buf_str(b, "}]");
}

/* ── Node path helper ──────────────────────────────────────────────── */

static void build_node_path(char *out, size_t out_size, ufbx_node *node) {
    /* Build "Root/Parent/Child" from bottom up, then reverse segments. */
    const char *segments[128];
    int depth = 0;
    ufbx_node *cur = node;
    while (cur && !cur->is_root && depth < 128) {
        segments[depth++] = cur->name.data ? cur->name.data : "";
        cur = cur->parent;
    }
    size_t pos = 0;
    for (int i = depth - 1; i >= 0; i--) {
        if (i < depth - 1 && pos < out_size - 1) out[pos++] = '/';
        const char *s = segments[i];
        while (*s && pos < out_size - 1) out[pos++] = *s++;
    }
    out[pos] = '\0';
}

/* ── Animation writing ─────────────────────────────────────────────── */

/* Does an anim_value carry at least one keyframe on any of its curves? */
static int anim_value_has_keys(const ufbx_anim_value *av) {
    if (!av) return 0;
    for (int i = 0; i < 3; i++) {
        const ufbx_anim_curve *cv = av->curves[i];
        if (cv && cv->keyframes.count > 0) return 1;
    }
    return 0;
}

/* Append every keyframe time (seconds) from an anim_value's curves. */
static size_t append_key_times(const ufbx_anim_value *av, double *times,
                               size_t n, size_t cap) {
    if (!av) return n;
    for (int i = 0; i < 3; i++) {
        const ufbx_anim_curve *cv = av->curves[i];
        if (!cv) continue;
        for (size_t k = 0; k < cv->keyframes.count && n < cap; k++) {
            times[n++] = cv->keyframes.data[k].time;
        }
    }
    return n;
}

/* Sort + dedupe an unordered times array in place; returns deduped count. */
static int cmp_double(const void *a, const void *b) {
    double x = *(const double *)a, y = *(const double *)b;
    return (x < y) ? -1 : (x > y) ? 1 : 0;
}
static size_t sort_unique(double *times, size_t n) {
    if (n == 0) return 0;
    qsort(times, n, sizeof(double), cmp_double);
    size_t m = 1;
    for (size_t i = 1; i < n; i++) {
        if (times[i] > times[m - 1] + 1e-9) times[m++] = times[i];
    }
    return m;
}

/* An anim_stack is empty (produces no clip) when it has zero duration, no
 * layers, or no layer carries any animated property (KB §4.3). */
static int anim_stack_is_empty(const ufbx_anim_stack *stack) {
    if (stack->time_begin == stack->time_end) return 1;
    if (stack->layers.count == 0) return 1;
    for (size_t i = 0; i < stack->layers.count; i++) {
        if (stack->layers.data[i]->anim_props.count > 0) return 0;
    }
    return 1;
}

/* Locate the anim_value bound to a node's Lcl property on a layer, if any. */
static ufbx_anim_value *find_lcl_value(const ufbx_anim_layer *layer,
                                       const ufbx_node *node, const char *prop) {
    ufbx_anim_prop *ap = ufbx_find_anim_prop(layer, &node->element, prop);
    return (ap && anim_value_has_keys(ap->anim_value)) ? ap->anim_value : NULL;
}

/* Emit one animation channel: keyTimes = union of the node's animated
 * properties' key times, keyValues = ufbx_evaluate_transform sampled at each
 * key time and decomposed to the requested TRS component. Matches the SDK
 * binding (EvaluateLocalTransform + quaternion sign canonicalization). */
static void write_channel(Buf *b, ufbx_anim *anim, ufbx_node *node,
                          const char *node_path, const char *property,
                          const double *times, size_t nt, double time_begin) {
    buf_str(b, "{\"targetNode\":");
    buf_quoted(b, node_path);
    buf_str(b, ",\"property\":\"");
    buf_str(b, property);
    buf_str(b, "\",\"keyTimes\":[");
    for (size_t k = 0; k < nt; k++) {
        if (k > 0) buf_char(b, ',');
        buf_double(b, times[k] - time_begin);
    }
    buf_str(b, "],\"keyValues\":[");

    int is_rot = strcmp(property, "rotation") == 0;
    int is_trans = strcmp(property, "translation") == 0;
    double pqx = 0, pqy = 0, pqz = 0, pqw = 1;

    for (size_t k = 0; k < nt; k++) {
        ufbx_transform tr = ufbx_evaluate_transform(anim, node, times[k]);
        if (k > 0) buf_char(b, ',');
        if (is_rot) {
            double cx = tr.rotation.x, cy = tr.rotation.y,
                   cz = tr.rotation.z, cw = tr.rotation.w;
            /* Canonicalize sign for short-arc continuity across keys. */
            if (cx * pqx + cy * pqy + cz * pqz + cw * pqw < 0) {
                cx = -cx; cy = -cy; cz = -cz; cw = -cw;
            }
            pqx = cx; pqy = cy; pqz = cz; pqw = cw;
            buf_double(b, cx); buf_char(b, ',');
            buf_double(b, cy); buf_char(b, ',');
            buf_double(b, cz); buf_char(b, ',');
            buf_double(b, cw);
        } else {
            ufbx_vec3 v = is_trans ? tr.translation : tr.scale;
            buf_double(b, v.x); buf_char(b, ',');
            buf_double(b, v.y); buf_char(b, ',');
            buf_double(b, v.z);
        }
    }
    buf_str(b, "]}");
}

static void write_animation(Buf *b, ufbx_scene *scene) {
    if (scene->anim_stacks.count == 0) return;

    /* Buffer for union key times; humanoid clips have <= a few hundred keys. */
    enum { MAX_KEYS = 8192 };
    double *times = (double *)malloc(MAX_KEYS * sizeof(double));

    buf_str(b, ",\"clips\":[");
    int first_clip = 1;
    for (size_t si = 0; si < scene->anim_stacks.count; si++) {
        ufbx_anim_stack *stack = scene->anim_stacks.data[si];

        /* Empty-take filter: no clip for zero-duration / no-layer / no-prop
         * stacks (KB §4.3), and no assigning a fake 1.0 duration. */
        if (anim_stack_is_empty(stack)) continue;
        ufbx_anim_layer *layer = stack->layers.data[0];

        double duration = stack->time_end - stack->time_begin;

        if (!first_clip) buf_char(b, ',');
        first_clip = 0;

        buf_char(b, '{');
        buf_str(b, "\"name\":");
        buf_quoted(b, stack->name.data ? stack->name.data : "");
        buf_str(b, ",\"duration\":"); buf_double(b, duration);
        buf_str(b, ",\"channels\":[");

        int first_channel = 1;
        for (size_t ni = 0; ni < scene->nodes.count; ni++) {
            ufbx_node *node = scene->nodes.data[ni];
            if (skip_node(node)) continue;

            ufbx_anim_value *tv = find_lcl_value(layer, node, UFBX_Lcl_Translation);
            ufbx_anim_value *rv = find_lcl_value(layer, node, UFBX_Lcl_Rotation);
            ufbx_anim_value *sv = find_lcl_value(layer, node, UFBX_Lcl_Scaling);
            if (!tv && !rv && !sv) continue;

            char node_path[1024];
            build_node_path(node_path, sizeof(node_path), node);

            /* One shared timeline per node = union of every animated property's
             * key times, so a single evaluate feeds each channel (SDK parity). */
            size_t nraw = 0;
            nraw = append_key_times(tv, times, nraw, MAX_KEYS);
            nraw = append_key_times(rv, times, nraw, MAX_KEYS);
            nraw = append_key_times(sv, times, nraw, MAX_KEYS);
            size_t nt = sort_unique(times, nraw);

            /* A property gets a channel only if it owns curves (no static
             * slots), mirroring glTF / the SDK binding. */
            if (tv) {
                if (!first_channel) buf_char(b, ','); first_channel = 0;
                write_channel(b, stack->anim, node, node_path, "translation",
                              times, nt, stack->time_begin);
            }
            if (rv) {
                if (!first_channel) buf_char(b, ','); first_channel = 0;
                write_channel(b, stack->anim, node, node_path, "rotation",
                              times, nt, stack->time_begin);
            }
            if (sv) {
                if (!first_channel) buf_char(b, ','); first_channel = 0;
                write_channel(b, stack->anim, node, node_path, "scale",
                              times, nt, stack->time_begin);
            }
        }

        buf_str(b, "]}");
    }
    buf_char(b, ']');
    free(times);
}

/* ── Main entry point ──────────────────────────────────────────────── */

static char *g_result = NULL;
static size_t g_result_len = 0;

__attribute__((used))
void parseFbxWasm(const void *data, size_t size) {
    /* Free previous result */
    if (g_result) { free(g_result); g_result = NULL; g_result_len = 0; }

    /* Load FBX from memory via ufbx */
    ufbx_load_opts opts = { 0 };
    opts.target_axes = ufbx_axes_right_handed_y_up;
    opts.target_unit_meters = 1.0;
    opts.space_conversion = UFBX_SPACE_CONVERSION_TRANSFORM_ROOT;

    ufbx_error error;
    ufbx_scene *scene = ufbx_load_memory(data, size, &opts, &error);

    if (!scene) {
        /* Return error JSON */
        Buf b; buf_init(&b);
        buf_str(&b, "{\"error\":{\"code\":\"fbx-parse-failed\",\"message\":");
        buf_quoted(&b, error.description.data ? error.description.data : "unknown error");
        buf_str(&b, "}}");
        g_result = b.data;
        g_result_len = b.len;
        return;
    }

    Buf b;
    buf_init(&b);
    buf_char(&b, '{');

    /* Meshes */
    buf_str(&b, "\"meshes\":[");
    for (size_t i = 0; i < scene->meshes.count; i++) {
        if (i > 0) buf_char(&b, ',');
        write_mesh(&b, scene->meshes.data[i], (int)i);
    }
    buf_str(&b, "],");

    /* Nodes */
    write_nodes(&b, scene);

    /* Materials */
    write_materials(&b, scene);

    /* Skeleton */
    write_skeleton(&b, scene);

    /* Skin */
    write_skin(&b, scene);

    /* Animation */
    write_animation(&b, scene);

    buf_char(&b, '}');

    g_result = b.data;
    g_result_len = b.len;

    ufbx_free_scene(scene);
}

__attribute__((used))
const char *getResultPtr(void) { return g_result; }

__attribute__((used))
size_t getResultLen(void) { return g_result_len; }

__attribute__((used))
void freeResult(void) {
    if (g_result) { free(g_result); g_result = NULL; g_result_len = 0; }
}
