/* @ts-self-types="./wgpu_wasm.d.ts" */

/**
 * Handle for the `parse` output. JS holds an opaque struct it cannot inspect; the
 * only legal next move is to feed it into `validate` (plan-strategy §S-1 opaque handle).
 */
export class ParsedModule {
    static __wrap(ptr) {
        const obj = Object.create(ParsedModule.prototype);
        obj.__wbg_ptr = ptr;
        ParsedModuleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ParsedModuleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_parsedmodule_free(ptr, 0);
    }
}
if (Symbol.dispose) ParsedModule.prototype[Symbol.dispose] = ParsedModule.prototype.free;

export class RhiWgpuAdapter {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuAdapter.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuAdapterFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuAdapterFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpuadapter_free(ptr, 0);
    }
    /**
     * @returns {Promise<RhiWgpuDevice>}
     */
    requestDevice() {
        const ret = wasm.rhiwgpuadapter_requestDevice(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) RhiWgpuAdapter.prototype[Symbol.dispose] = RhiWgpuAdapter.prototype.free;

export class RhiWgpuBindGroup {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuBindGroup.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuBindGroupFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuBindGroupFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpubindgroup_free(ptr, 0);
    }
}
if (Symbol.dispose) RhiWgpuBindGroup.prototype[Symbol.dispose] = RhiWgpuBindGroup.prototype.free;

export class RhiWgpuBindGroupLayout {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuBindGroupLayout.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuBindGroupLayoutFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuBindGroupLayoutFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpubindgrouplayout_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get forgeaxToken() {
        const ret = wasm.rhiwgpubindgrouplayout_forgeaxToken(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) RhiWgpuBindGroupLayout.prototype[Symbol.dispose] = RhiWgpuBindGroupLayout.prototype.free;

export class RhiWgpuBuffer {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuBuffer.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuBufferFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuBufferFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpubuffer_free(ptr, 0);
    }
    destroy() {
        wasm.rhiwgpubuffer_destroy(this.__wbg_ptr);
    }
    /**
     * @returns {number}
     */
    get forgeaxToken() {
        const ret = wasm.rhiwgpubuffer_forgeaxToken(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * bug-20260610 Gap 11: returns the mapped range as a JS `ArrayBuffer`.
     * Copies the wgpu-side mapped slice into a fresh ArrayBuffer so the JS
     * side owns a contiguous block; the wgpu mapping itself is held alive
     * until `unmap()` regardless. (Spec-strict surface would expose a
     * view that aliases the wgpu memory, but wasm-bindgen cannot hand JS
     * a pointer into wgpu's wasm linear memory without lifetime tracking
     * on the JS side; the copy keeps semantics simple.)
     * @param {bigint | null} [offset]
     * @param {bigint | null} [size]
     * @returns {ArrayBuffer}
     */
    getMappedRange(offset, size) {
        const ret = wasm.rhiwgpubuffer_getMappedRange(this.__wbg_ptr, !isLikeNone(offset), isLikeNone(offset) ? BigInt(0) : offset, !isLikeNone(size), isLikeNone(size) ? BigInt(0) : size);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * bug-20260610 Gap 11: spec-shape `mapAsync(mode, offset?, size?)` returning
     * a Promise<void>. Mode: 1 = READ, 2 = WRITE (per WebGPU spec).
     * wgpu's `slice.map_async(mode, callback)` is callback-shaped; we
     * bridge to a Promise via `wasm_bindgen_futures::JsFuture`-style
     * channel-on-Closure. The returned Promise resolves once wgpu's
     * callback fires, regardless of buffer poll timing (the device's
     * `poll` runs on the wgpu wasm event loop).
     * @param {number} mode
     * @param {bigint | null} [offset]
     * @param {bigint | null} [size]
     * @returns {Promise<any>}
     */
    mapAsync(mode, offset, size) {
        const ret = wasm.rhiwgpubuffer_mapAsync(this.__wbg_ptr, mode, !isLikeNone(offset), isLikeNone(offset) ? BigInt(0) : offset, !isLikeNone(size), isLikeNone(size) ? BigInt(0) : size);
        return ret;
    }
    unmap() {
        wasm.rhiwgpubuffer_unmap(this.__wbg_ptr);
    }
}
if (Symbol.dispose) RhiWgpuBuffer.prototype[Symbol.dispose] = RhiWgpuBuffer.prototype.free;

export class RhiWgpuCommandBuffer {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuCommandBuffer.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuCommandBufferFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    static __unwrap(jsValue) {
        if (!(jsValue instanceof RhiWgpuCommandBuffer)) {
            return 0;
        }
        return jsValue.__destroy_into_raw();
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuCommandBufferFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpucommandbuffer_free(ptr, 0);
    }
}
if (Symbol.dispose) RhiWgpuCommandBuffer.prototype[Symbol.dispose] = RhiWgpuCommandBuffer.prototype.free;

export class RhiWgpuCommandEncoder {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuCommandEncoder.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuCommandEncoderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuCommandEncoderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpucommandencoder_free(ptr, 0);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuRenderPass}
     */
    beginRenderPass(desc_js) {
        const ret = wasm.rhiwgpucommandencoder_beginRenderPass(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuRenderPass.__wrap(ret[0]);
    }
    /**
     * bug-20260610 Gap 12: clearBuffer.
     * @param {RhiWgpuBuffer} buffer
     * @param {bigint | null} [offset]
     * @param {bigint | null} [size]
     */
    clearBuffer(buffer, offset, size) {
        _assertClass(buffer, RhiWgpuBuffer);
        wasm.rhiwgpucommandencoder_clearBuffer(this.__wbg_ptr, buffer.__wbg_ptr, !isLikeNone(offset), isLikeNone(offset) ? BigInt(0) : offset, !isLikeNone(size), isLikeNone(size) ? BigInt(0) : size);
    }
    /**
     * bug-20260610 Gap 12: copyBufferToBuffer per WebGPU spec
     * `(source, sourceOffset, destination, destinationOffset, size)`.
     * @param {RhiWgpuBuffer} source
     * @param {bigint} source_offset
     * @param {RhiWgpuBuffer} destination
     * @param {bigint} destination_offset
     * @param {bigint} size
     */
    copyBufferToBuffer(source, source_offset, destination, destination_offset, size) {
        _assertClass(source, RhiWgpuBuffer);
        _assertClass(destination, RhiWgpuBuffer);
        wasm.rhiwgpucommandencoder_copyBufferToBuffer(this.__wbg_ptr, source.__wbg_ptr, source_offset, destination.__wbg_ptr, destination_offset, size);
    }
    /**
     * bug-20260610 Gap 12: copyBufferToTexture flat-args form (handles via
     * borrowed `&T` so wasm pointers survive across the call — see writeTexture
     * note about `try_from_js_value` consuming pointers).
     * @param {RhiWgpuBuffer} source_buffer
     * @param {bigint} source_offset
     * @param {number | null | undefined} source_bytes_per_row
     * @param {number | null | undefined} source_rows_per_image
     * @param {RhiWgpuTexture} dest_texture
     * @param {number} dest_mip_level
     * @param {number} dest_origin_x
     * @param {number} dest_origin_y
     * @param {number} dest_origin_z
     * @param {number} dest_aspect
     * @param {number} size_width
     * @param {number} size_height
     * @param {number} size_depth
     */
    copyBufferToTexture(source_buffer, source_offset, source_bytes_per_row, source_rows_per_image, dest_texture, dest_mip_level, dest_origin_x, dest_origin_y, dest_origin_z, dest_aspect, size_width, size_height, size_depth) {
        _assertClass(source_buffer, RhiWgpuBuffer);
        _assertClass(dest_texture, RhiWgpuTexture);
        wasm.rhiwgpucommandencoder_copyBufferToTexture(this.__wbg_ptr, source_buffer.__wbg_ptr, source_offset, isLikeNone(source_bytes_per_row) ? Number.MAX_SAFE_INTEGER : (source_bytes_per_row) >>> 0, isLikeNone(source_rows_per_image) ? Number.MAX_SAFE_INTEGER : (source_rows_per_image) >>> 0, dest_texture.__wbg_ptr, dest_mip_level, dest_origin_x, dest_origin_y, dest_origin_z, dest_aspect, size_width, size_height, size_depth);
    }
    /**
     * bug-20260610 Gap 12: copyTextureToBuffer flat-args form.
     * @param {RhiWgpuTexture} source_texture
     * @param {number} source_mip_level
     * @param {number} source_origin_x
     * @param {number} source_origin_y
     * @param {number} source_origin_z
     * @param {number} source_aspect
     * @param {RhiWgpuBuffer} dest_buffer
     * @param {bigint} dest_offset
     * @param {number | null | undefined} dest_bytes_per_row
     * @param {number | null | undefined} dest_rows_per_image
     * @param {number} size_width
     * @param {number} size_height
     * @param {number} size_depth
     */
    copyTextureToBuffer(source_texture, source_mip_level, source_origin_x, source_origin_y, source_origin_z, source_aspect, dest_buffer, dest_offset, dest_bytes_per_row, dest_rows_per_image, size_width, size_height, size_depth) {
        _assertClass(source_texture, RhiWgpuTexture);
        _assertClass(dest_buffer, RhiWgpuBuffer);
        wasm.rhiwgpucommandencoder_copyTextureToBuffer(this.__wbg_ptr, source_texture.__wbg_ptr, source_mip_level, source_origin_x, source_origin_y, source_origin_z, source_aspect, dest_buffer.__wbg_ptr, dest_offset, isLikeNone(dest_bytes_per_row) ? Number.MAX_SAFE_INTEGER : (dest_bytes_per_row) >>> 0, isLikeNone(dest_rows_per_image) ? Number.MAX_SAFE_INTEGER : (dest_rows_per_image) >>> 0, size_width, size_height, size_depth);
    }
    /**
     * bug-20260610 Gap 12: copyTextureToTexture flat-args form.
     * @param {RhiWgpuTexture} source_texture
     * @param {number} source_mip_level
     * @param {number} source_origin_x
     * @param {number} source_origin_y
     * @param {number} source_origin_z
     * @param {number} source_aspect
     * @param {RhiWgpuTexture} dest_texture
     * @param {number} dest_mip_level
     * @param {number} dest_origin_x
     * @param {number} dest_origin_y
     * @param {number} dest_origin_z
     * @param {number} dest_aspect
     * @param {number} size_width
     * @param {number} size_height
     * @param {number} size_depth
     */
    copyTextureToTexture(source_texture, source_mip_level, source_origin_x, source_origin_y, source_origin_z, source_aspect, dest_texture, dest_mip_level, dest_origin_x, dest_origin_y, dest_origin_z, dest_aspect, size_width, size_height, size_depth) {
        _assertClass(source_texture, RhiWgpuTexture);
        _assertClass(dest_texture, RhiWgpuTexture);
        wasm.rhiwgpucommandencoder_copyTextureToTexture(this.__wbg_ptr, source_texture.__wbg_ptr, source_mip_level, source_origin_x, source_origin_y, source_origin_z, source_aspect, dest_texture.__wbg_ptr, dest_mip_level, dest_origin_x, dest_origin_y, dest_origin_z, dest_aspect, size_width, size_height, size_depth);
    }
    /**
     * @returns {RhiWgpuCommandBuffer}
     */
    finish() {
        const ret = wasm.rhiwgpucommandencoder_finish(this.__wbg_ptr);
        return RhiWgpuCommandBuffer.__wrap(ret);
    }
    /**
     * @param {string} label
     */
    insertDebugMarker(label) {
        const ptr0 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.rhiwgpucommandencoder_insertDebugMarker(this.__wbg_ptr, ptr0, len0);
    }
    popDebugGroup() {
        wasm.rhiwgpucommandencoder_popDebugGroup(this.__wbg_ptr);
    }
    /**
     * @param {string} label
     */
    pushDebugGroup(label) {
        const ptr0 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.rhiwgpucommandencoder_pushDebugGroup(this.__wbg_ptr, ptr0, len0);
    }
}
if (Symbol.dispose) RhiWgpuCommandEncoder.prototype[Symbol.dispose] = RhiWgpuCommandEncoder.prototype.free;

export class RhiWgpuComputePipeline {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuComputePipeline.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuComputePipelineFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuComputePipelineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpucomputepipeline_free(ptr, 0);
    }
}
if (Symbol.dispose) RhiWgpuComputePipeline.prototype[Symbol.dispose] = RhiWgpuComputePipeline.prototype.free;

export class RhiWgpuDevice {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuDevice.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuDeviceFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuDeviceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpudevice_free(ptr, 0);
    }
    /**
     * bug-20260610 v18: spec-aligned single-descriptor form. The legacy
     * `(desc, layout, entries_arr)` 3-arg shape didn't match the rhi-wgpu
     * shim's `rawDevice.createBindGroup(mirroredDesc)` call; layout +
     * entries arrived undefined, `_assertClass(undefined, ...)` threw
     * "expected instance of RhiWgpuBindGroupLayout" every frame. Reflect
     * `desc.layout.forgeaxToken` (BGL registry path) + `desc.entries` array
     * off the single descriptor so the call shape matches WebGPU spec.
     * Also stops consuming the resource handles (buffer / sampler /
     * textureView) — `try_from_js_value` zeroes their `__wbg_ptr`, which
     * breaks per-frame bind-group recreation that reuses the same UBO.
     * Each resource handle now goes through `read_wbg_ptr` (non-consuming)
     * against the appropriate type.
     * @param {any} desc_js
     * @returns {RhiWgpuBindGroup}
     */
    createBindGroup(desc_js) {
        const ret = wasm.rhiwgpudevice_createBindGroup(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuBindGroup.__wrap(ret[0]);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuBindGroupLayout}
     */
    createBindGroupLayout(desc_js) {
        const ret = wasm.rhiwgpudevice_createBindGroupLayout(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuBindGroupLayout.__wrap(ret[0]);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuBuffer}
     */
    createBuffer(desc_js) {
        const ret = wasm.rhiwgpudevice_createBuffer(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuBuffer.__wrap(ret[0]);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuCommandEncoder}
     */
    createCommandEncoder(desc_js) {
        const ret = wasm.rhiwgpudevice_createCommandEncoder(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuCommandEncoder.__wrap(ret[0]);
    }
    /**
     * @param {any} desc_js
     * @param {RhiWgpuShaderModule} module
     * @param {RhiWgpuPipelineLayout | null} [layout]
     * @returns {RhiWgpuComputePipeline}
     */
    createComputePipeline(desc_js, module, layout) {
        _assertClass(module, RhiWgpuShaderModule);
        let ptr0 = 0;
        if (!isLikeNone(layout)) {
            _assertClass(layout, RhiWgpuPipelineLayout);
            ptr0 = layout.__destroy_into_raw();
        }
        const ret = wasm.rhiwgpudevice_createComputePipeline(this.__wbg_ptr, desc_js, module.__wbg_ptr, ptr0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuComputePipeline.__wrap(ret[0]);
    }
    /**
     * bug-20260610: take ONE descriptor whose `bindGroupLayouts` is an Array
     * of `RhiWgpuBindGroupLayout` handles, mirroring the WebGPU spec
     * (`GPUPipelineLayoutDescriptor.bindGroupLayouts`). The legacy 2-arg form
     * (descriptor + array) was wired through the TS shim's generic `wrap()`
     * helper which calls with **one** arg, so the BGL array always arrived
     * `undefined` and wgpu built a 0-slot layout that later failed validation
     * when bound to a 4-slot pipeline.
     * @param {any} desc_js
     * @returns {RhiWgpuPipelineLayout}
     */
    createPipelineLayout(desc_js) {
        const ret = wasm.rhiwgpudevice_createPipelineLayout(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuPipelineLayout.__wrap(ret[0]);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuQuerySet}
     */
    createQuerySet(desc_js) {
        const ret = wasm.rhiwgpudevice_createQuerySet(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuQuerySet.__wrap(ret[0]);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuRenderBundleEncoder}
     */
    createRenderBundleEncoder(desc_js) {
        const ret = wasm.rhiwgpudevice_createRenderBundleEncoder(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuRenderBundleEncoder.__wrap(ret[0]);
    }
    /**
     * bug-20260610 Gap 14: refactored to spec-aligned single-descriptor form.
     * The earlier `(desc, vertex_module, fragment_module, layout)` form
     * required the TS shim to extract handles + pass them as separate args
     * — but the shim's generic `wrap()` helper only sends 1 arg, so the
     * other three arrived as `undefined` and `_assertClass` blew up before
     * the body ran. Reflect the handles off the descriptor so the call
     * shape matches the WebGPU spec
     * (`device.createRenderPipeline({layout, vertex:{module,...}, fragment:{module,...}, ...})`).
     * @param {any} desc_js
     * @returns {RhiWgpuRenderPipeline}
     */
    createRenderPipeline(desc_js) {
        const ret = wasm.rhiwgpudevice_createRenderPipeline(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuRenderPipeline.__wrap(ret[0]);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuSampler}
     */
    createSampler(desc_js) {
        const ret = wasm.rhiwgpudevice_createSampler(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuSampler.__wrap(ret[0]);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuShaderModule}
     */
    createShaderModule(desc_js) {
        const ret = wasm.rhiwgpudevice_createShaderModule(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuShaderModule.__wrap(ret[0]);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuTexture}
     */
    createTexture(desc_js) {
        const ret = wasm.rhiwgpudevice_createTexture(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuTexture.__wrap(ret[0]);
    }
    /**
     * bug-20260610 Gap 10: device-side texture-view creation. The TS shim
     * (`packages/rhi-wgpu/src/device.ts`) prefers
     * `device.createTextureView(tex, desc)` over `tex.createView(desc)`
     * because some wasm bindings expose `createView` only at the device
     * level. Mirror the spec descriptor surface (label / format / dimension /
     * aspect / mip / array slice).
     * @param {RhiWgpuTexture} texture
     * @param {any} desc_js
     * @returns {RhiWgpuTextureView}
     */
    createTextureView(texture, desc_js) {
        _assertClass(texture, RhiWgpuTexture);
        const ret = wasm.rhiwgpudevice_createTextureView(this.__wbg_ptr, texture.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuTextureView.__wrap(ret[0]);
    }
    /**
     * @returns {number}
     */
    get forgeaxToken() {
        const ret = wasm.rhiwgpudevice_forgeaxToken(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * bug-20260610: surface `wgpu::Limits` to JS as a flat object whose keys
     * match the WebGPU spec / `GPUSupportedLimits` JS naming (camelCase).
     * The TS shim (`packages/rhi-wgpu/src/device.ts`) reads
     * `raw.limits.maxStorageBuffersPerShaderStage` etc. directly into
     * `RhiCaps.storageBuffer`. Without this getter the engine sees `{}` and
     * every limit-gated branch falls through the "WebGPU spec default"
     * happy path — which on the WebGL2 backend explodes inside
     * `Device::create_bind_group_layout` with
     * `Too many bindings of type StorageBuffers in Stage FRAGMENT, limit is 0`.
     *
     * u64 fields are coerced to f64 (JS number) — engine consumers compare
     * against `STORAGE_BUFFER_MIN_REQUIRED` etc. which are <= 2^53, well
     * within JS number precision; downlevel limits never approach the
     * 2^53 boundary so the cast is lossless.
     * @returns {object}
     */
    get limits() {
        const ret = wasm.rhiwgpudevice_limits(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {RhiWgpuQueue}
     */
    get queue() {
        const ret = wasm.rhiwgpudevice_queue(this.__wbg_ptr);
        return RhiWgpuQueue.__wrap(ret);
    }
    /**
     * @param {Function} js_callback
     */
    registerLostCallback(js_callback) {
        wasm.rhiwgpudevice_registerLostCallback(this.__wbg_ptr, js_callback);
    }
}
if (Symbol.dispose) RhiWgpuDevice.prototype[Symbol.dispose] = RhiWgpuDevice.prototype.free;

export class RhiWgpuInstance {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuInstance.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuInstanceFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuInstanceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpuinstance_free(ptr, 0);
    }
    /**
     * @returns {Promise<RhiWgpuInstance>}
     */
    static create() {
        const ret = wasm.rhiwgpuinstance_create();
        return ret;
    }
    /**
     * @param {HTMLCanvasElement} canvas
     * @returns {RhiWgpuSurface}
     */
    createSurface(canvas) {
        const ret = wasm.rhiwgpuinstance_createSurface(this.__wbg_ptr, canvas);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuSurface.__wrap(ret[0]);
    }
    /**
     * @returns {Promise<any>}
     */
    requestAdapter() {
        const ret = wasm.rhiwgpuinstance_requestAdapter(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {HTMLCanvasElement} canvas
     * @returns {Promise<any>}
     */
    requestAdapterWithCanvas(canvas) {
        const ret = wasm.rhiwgpuinstance_requestAdapterWithCanvas(this.__wbg_ptr, canvas);
        return ret;
    }
}
if (Symbol.dispose) RhiWgpuInstance.prototype[Symbol.dispose] = RhiWgpuInstance.prototype.free;

export class RhiWgpuPipelineLayout {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuPipelineLayout.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuPipelineLayoutFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuPipelineLayoutFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpupipelinelayout_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get forgeaxToken() {
        const ret = wasm.rhiwgpupipelinelayout_forgeaxToken(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) RhiWgpuPipelineLayout.prototype[Symbol.dispose] = RhiWgpuPipelineLayout.prototype.free;

export class RhiWgpuQuerySet {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuQuerySet.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuQuerySetFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuQuerySetFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpuqueryset_free(ptr, 0);
    }
}
if (Symbol.dispose) RhiWgpuQuerySet.prototype[Symbol.dispose] = RhiWgpuQuerySet.prototype.free;

export class RhiWgpuQueue {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuQueue.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuQueueFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuQueueFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpuqueue_free(ptr, 0);
    }
    /**
     * @param {Array<any>} buffers
     */
    submit(buffers) {
        const ret = wasm.rhiwgpuqueue_submit(this.__wbg_ptr, buffers);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * bug-20260610: explicit `js_name = writeBuffer` because wasm-bindgen's
     * default snake_case export (`write_buffer`) does not match the WebGPU
     * spec / TS shim's `queue.writeBuffer(...)` call site.
     *
     * TS shim signature: `writeBuffer(buffer, bufferOffset, data, dataOffset?, size?)`.
     * dataOffset / size are optional in the spec — we honour them by slicing
     * the input bytes before forwarding to wgpu.
     * @param {RhiWgpuBuffer} buffer
     * @param {bigint} buffer_offset
     * @param {Uint8Array} data
     * @param {bigint | null} [data_offset]
     * @param {bigint | null} [size]
     */
    writeBuffer(buffer, buffer_offset, data, data_offset, size) {
        _assertClass(buffer, RhiWgpuBuffer);
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.rhiwgpuqueue_writeBuffer(this.__wbg_ptr, buffer.__wbg_ptr, buffer_offset, ptr0, len0, !isLikeNone(data_offset), isLikeNone(data_offset) ? BigInt(0) : data_offset, !isLikeNone(size), isLikeNone(size) ? BigInt(0) : size);
    }
    /**
     * bug-20260610 Gap 9: `queue.writeTexture(...)` flat-args form.
     *
     * The texture handle MUST come in as a `&RhiWgpuTexture` (borrowed) —
     * `try_from_js_value` would consume the JS-side `__wbg_ptr` (zeroes it),
     * breaking the very common writeTexture-then-createView pattern that
     * the engine uses on every fallback texture in `buildReadyWebGPU`.
     *
     * Layout / origin / size are passed as flat numeric args rather than
     * JsValue to keep the wasm boundary cheap and free of additional
     * Reflect lookups. The TS shim flattens
     * `writeTexture(destination, data, dataLayout, size)` →
     * `writeTexture(destination.texture, mipLevel, originX, originY,
     * originZ, aspect, data, layoutOffset, bytesPerRow, rowsPerImage,
     * sizeWidth, sizeHeight, sizeDepth)`.
     * @param {RhiWgpuTexture} texture
     * @param {number} mip_level
     * @param {number} origin_x
     * @param {number} origin_y
     * @param {number} origin_z
     * @param {number} aspect
     * @param {Uint8Array} data
     * @param {bigint} layout_offset
     * @param {number | null | undefined} bytes_per_row
     * @param {number | null | undefined} rows_per_image
     * @param {number} size_width
     * @param {number} size_height
     * @param {number} size_depth
     */
    writeTexture(texture, mip_level, origin_x, origin_y, origin_z, aspect, data, layout_offset, bytes_per_row, rows_per_image, size_width, size_height, size_depth) {
        _assertClass(texture, RhiWgpuTexture);
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.rhiwgpuqueue_writeTexture(this.__wbg_ptr, texture.__wbg_ptr, mip_level, origin_x, origin_y, origin_z, aspect, ptr0, len0, layout_offset, isLikeNone(bytes_per_row) ? Number.MAX_SAFE_INTEGER : (bytes_per_row) >>> 0, isLikeNone(rows_per_image) ? Number.MAX_SAFE_INTEGER : (rows_per_image) >>> 0, size_width, size_height, size_depth);
    }
}
if (Symbol.dispose) RhiWgpuQueue.prototype[Symbol.dispose] = RhiWgpuQueue.prototype.free;

export class RhiWgpuRenderBundleEncoder {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuRenderBundleEncoder.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuRenderBundleEncoderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuRenderBundleEncoderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpurenderbundleencoder_free(ptr, 0);
    }
}
if (Symbol.dispose) RhiWgpuRenderBundleEncoder.prototype[Symbol.dispose] = RhiWgpuRenderBundleEncoder.prototype.free;

export class RhiWgpuRenderPass {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuRenderPass.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuRenderPassFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuRenderPassFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpurenderpass_free(ptr, 0);
    }
    /**
     * @param {number} vertex_count
     * @param {number | null | undefined} instance_count
     * @param {number} first_vertex
     * @param {number} first_instance
     */
    draw(vertex_count, instance_count, first_vertex, first_instance) {
        wasm.rhiwgpurenderpass_draw(this.__wbg_ptr, vertex_count, isLikeNone(instance_count) ? Number.MAX_SAFE_INTEGER : (instance_count) >>> 0, first_vertex, first_instance);
    }
    /**
     * @param {number} index_count
     * @param {number | null | undefined} instance_count
     * @param {number} first_index
     * @param {number} base_vertex
     * @param {number} first_instance
     */
    drawIndexed(index_count, instance_count, first_index, base_vertex, first_instance) {
        wasm.rhiwgpurenderpass_drawIndexed(this.__wbg_ptr, index_count, isLikeNone(instance_count) ? Number.MAX_SAFE_INTEGER : (instance_count) >>> 0, first_index, base_vertex, first_instance);
    }
    /**
     * @param {RhiWgpuBuffer} indirect_buffer
     * @param {bigint} indirect_offset
     */
    drawIndexedIndirect(indirect_buffer, indirect_offset) {
        _assertClass(indirect_buffer, RhiWgpuBuffer);
        wasm.rhiwgpurenderpass_drawIndexedIndirect(this.__wbg_ptr, indirect_buffer.__wbg_ptr, indirect_offset);
    }
    /**
     * @param {RhiWgpuBuffer} indirect_buffer
     * @param {bigint} indirect_offset
     */
    drawIndirect(indirect_buffer, indirect_offset) {
        _assertClass(indirect_buffer, RhiWgpuBuffer);
        wasm.rhiwgpurenderpass_drawIndirect(this.__wbg_ptr, indirect_buffer.__wbg_ptr, indirect_offset);
    }
    end() {
        wasm.rhiwgpurenderpass_end(this.__wbg_ptr);
    }
    /**
     * @param {string} label
     */
    insertDebugMarker(label) {
        const ptr0 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.rhiwgpurenderpass_insertDebugMarker(this.__wbg_ptr, ptr0, len0);
    }
    popDebugGroup() {
        wasm.rhiwgpurenderpass_popDebugGroup(this.__wbg_ptr);
    }
    /**
     * @param {string} label
     */
    pushDebugGroup(label) {
        const ptr0 = passStringToWasm0(label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.rhiwgpurenderpass_pushDebugGroup(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * bug-20260610 Gap 13: setBindGroup variadic spec form. Supports
     * `(index, bindGroup)` and `(index, bindGroup, dynamicOffsets)` and the
     * 3-form `(index, bindGroup, dynamicOffsetsData, start, length)`.
     * Defensive: dynamic offsets default to empty when `dyn_offsets_js` is
     * undefined / null.
     * @param {number} index
     * @param {RhiWgpuBindGroup} bind_group
     * @param {any} dyn_offsets_js
     * @param {number | null} [start]
     * @param {number | null} [length]
     */
    setBindGroup(index, bind_group, dyn_offsets_js, start, length) {
        _assertClass(bind_group, RhiWgpuBindGroup);
        wasm.rhiwgpurenderpass_setBindGroup(this.__wbg_ptr, index, bind_group.__wbg_ptr, dyn_offsets_js, isLikeNone(start) ? Number.MAX_SAFE_INTEGER : (start) >>> 0, isLikeNone(length) ? Number.MAX_SAFE_INTEGER : (length) >>> 0);
    }
    /**
     * @param {any} color_js
     */
    setBlendConstant(color_js) {
        wasm.rhiwgpurenderpass_setBlendConstant(this.__wbg_ptr, color_js);
    }
    /**
     * bug-20260610 Gap 13: setIndexBuffer per WebGPU spec
     * `(buffer, format, offset?, size?)`. Format is `'uint16' | 'uint32'`.
     * @param {RhiWgpuBuffer} buffer
     * @param {string} format
     * @param {bigint | null} [offset]
     * @param {bigint | null} [size]
     */
    setIndexBuffer(buffer, format, offset, size) {
        _assertClass(buffer, RhiWgpuBuffer);
        const ptr0 = passStringToWasm0(format, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.rhiwgpurenderpass_setIndexBuffer(this.__wbg_ptr, buffer.__wbg_ptr, ptr0, len0, !isLikeNone(offset), isLikeNone(offset) ? BigInt(0) : offset, !isLikeNone(size), isLikeNone(size) ? BigInt(0) : size);
    }
    /**
     * @param {RhiWgpuRenderPipeline} pipeline
     */
    setPipeline(pipeline) {
        _assertClass(pipeline, RhiWgpuRenderPipeline);
        wasm.rhiwgpurenderpass_setPipeline(this.__wbg_ptr, pipeline.__wbg_ptr);
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} w
     * @param {number} h
     */
    setScissorRect(x, y, w, h) {
        wasm.rhiwgpurenderpass_setScissorRect(this.__wbg_ptr, x, y, w, h);
    }
    /**
     * @param {number} reference
     */
    setStencilReference(reference) {
        wasm.rhiwgpurenderpass_setStencilReference(this.__wbg_ptr, reference);
    }
    /**
     * @param {number} slot
     * @param {RhiWgpuBuffer} buffer
     * @param {bigint} offset
     * @param {bigint | null} [_size]
     */
    setVertexBuffer(slot, buffer, offset, _size) {
        _assertClass(buffer, RhiWgpuBuffer);
        wasm.rhiwgpurenderpass_setVertexBuffer(this.__wbg_ptr, slot, buffer.__wbg_ptr, offset, !isLikeNone(_size), isLikeNone(_size) ? BigInt(0) : _size);
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     * @param {number} min_depth
     * @param {number} max_depth
     */
    setViewport(x, y, width, height, min_depth, max_depth) {
        wasm.rhiwgpurenderpass_setViewport(this.__wbg_ptr, x, y, width, height, min_depth, max_depth);
    }
}
if (Symbol.dispose) RhiWgpuRenderPass.prototype[Symbol.dispose] = RhiWgpuRenderPass.prototype.free;

export class RhiWgpuRenderPipeline {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuRenderPipeline.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuRenderPipelineFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuRenderPipelineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpurenderpipeline_free(ptr, 0);
    }
}
if (Symbol.dispose) RhiWgpuRenderPipeline.prototype[Symbol.dispose] = RhiWgpuRenderPipeline.prototype.free;

export class RhiWgpuSampler {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuSampler.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuSamplerFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuSamplerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpusampler_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get forgeaxResourceKind() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.rhiwgpusampler_forgeaxResourceKind(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get forgeaxToken() {
        const ret = wasm.rhiwgpusampler_forgeaxToken(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) RhiWgpuSampler.prototype[Symbol.dispose] = RhiWgpuSampler.prototype.free;

export class RhiWgpuShaderModule {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuShaderModule.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuShaderModuleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuShaderModuleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpushadermodule_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get forgeaxToken() {
        const ret = wasm.rhiwgpushadermodule_forgeaxToken(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) RhiWgpuShaderModule.prototype[Symbol.dispose] = RhiWgpuShaderModule.prototype.free;

export class RhiWgpuSurface {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuSurface.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuSurfaceFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuSurfaceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpusurface_free(ptr, 0);
    }
    /**
     * bug-20260610: spec-aligned single-descriptor `configure(desc)` form.
     * WebGPU's GPUCanvasContext.configure takes ONE argument (the config
     * object carries `.device`); the legacy two-arg `(device, desc)` form
     * failed silently when called through the rhi-wgpu shim's polymorphic
     * `rawContext.configure(mirrored)` path — the mirrored config object
     * hit the wasm-bindgen `_assertClass(device, RhiWgpuDevice)` guard,
     * the throw was caught by the shim, but the surface stayed
     * unconfigured, so the next `getCurrentTexture()` panicked with
     * "Surface is not configured for presentation". Reflect the device
     * handle off the descriptor's `device` field via __wbg_ptr (the
     * auto-wbg path that wasm-bindgen would use for `&RhiWgpuDevice`)
     * without consuming it — same pattern as createRenderPipeline's
     * vertex.module / fragment.module / layout.
     * @param {any} desc_js
     */
    configure(desc_js) {
        const ret = wasm.rhiwgpusurface_configure(this.__wbg_ptr, desc_js);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {RhiWgpuSurfaceTexture}
     */
    getCurrentTexture() {
        const ret = wasm.rhiwgpusurface_getCurrentTexture(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuSurfaceTexture.__wrap(ret[0]);
    }
}
if (Symbol.dispose) RhiWgpuSurface.prototype[Symbol.dispose] = RhiWgpuSurface.prototype.free;

export class RhiWgpuSurfaceTexture {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuSurfaceTexture.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuSurfaceTextureFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuSurfaceTextureFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgpusurfacetexture_free(ptr, 0);
    }
    /**
     * bug-20260610: clone the inner Texture (wgpu::Texture is Arc-Clone)
     * rather than ptr::read + mem::forget'ing the SurfaceTexture. The
     * previous shape leaked the SurfaceTexture forever, so wgpu_core
     * never saw the previous frame's release and panicked
     * "Surface image is already acquired" on the second
     * `getCurrentTexture()`. The new shape keeps the SurfaceTexture in
     * `self.inner` so the JS-side `present()` call (added below) can
     * release it.
     * @returns {RhiWgpuTexture}
     */
    getTexture() {
        const ret = wasm.rhiwgpusurfacetexture_getTexture(this.__wbg_ptr);
        return RhiWgpuTexture.__wrap(ret);
    }
    /**
     * bug-20260610: spec-shaped `present()` so the runtime per-frame loop
     * can release the acquired surface image after queue.submit. Without
     * this the next frame's `getCurrentTexture()` panics inside
     * wgpu_core::Storage with "Surface image is already acquired".
     * WebGPU spec auto-presents on next browser frame, but wgpu's GLES /
     * native backend requires explicit present (mirrors the requestSurface
     * flow in winit / glutin programs).
     */
    present() {
        wasm.rhiwgpusurfacetexture_present(this.__wbg_ptr);
    }
}
if (Symbol.dispose) RhiWgpuSurfaceTexture.prototype[Symbol.dispose] = RhiWgpuSurfaceTexture.prototype.free;

export class RhiWgpuTexture {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuTexture.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuTextureFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuTextureFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgputexture_free(ptr, 0);
    }
    /**
     * @param {any} desc_js
     * @returns {RhiWgpuTextureView}
     */
    createView(desc_js) {
        const ret = wasm.rhiwgputexture_createView(this.__wbg_ptr, desc_js);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return RhiWgpuTextureView.__wrap(ret[0]);
    }
    /**
     * @returns {number}
     */
    get depthOrArrayLayers() {
        const ret = wasm.rhiwgputexture_depthOrArrayLayers(this.__wbg_ptr);
        return ret >>> 0;
    }
    destroy() {
        wasm.rhiwgputexture_destroy(this.__wbg_ptr);
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.rhiwgputexture_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * bug-20260610: spec-aligned getters so the engine can read swap-chain
     * texture dimensions. Without these, `currentTexture.width` reads
     * `undefined`, the runtime computes `targetW = (undefined | 0) === 0`,
     * and `Device::create_texture` for the depth attachment trips
     * `Dimension X is zero`.
     * @returns {number}
     */
    get width() {
        const ret = wasm.rhiwgputexture_width(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) RhiWgpuTexture.prototype[Symbol.dispose] = RhiWgpuTexture.prototype.free;

export class RhiWgpuTextureView {
    static __wrap(ptr) {
        const obj = Object.create(RhiWgpuTextureView.prototype);
        obj.__wbg_ptr = ptr;
        RhiWgpuTextureViewFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RhiWgpuTextureViewFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rhiwgputextureview_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get forgeaxResourceKind() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.rhiwgputextureview_forgeaxResourceKind(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get forgeaxToken() {
        const ret = wasm.rhiwgputextureview_forgeaxToken(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) RhiWgpuTextureView.prototype[Symbol.dispose] = RhiWgpuTextureView.prototype.free;

/**
 * Handle for the `validate` output. Carries both Module and ModuleInfo; passed into
 * `emit_reflection`.
 */
export class ValidatedModule {
    static __wrap(ptr) {
        const obj = Object.create(ValidatedModule.prototype);
        obj.__wbg_ptr = ptr;
        ValidatedModuleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ValidatedModuleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_validatedmodule_free(ptr, 0);
    }
}
if (Symbol.dispose) ValidatedModule.prototype[Symbol.dispose] = ValidatedModule.prototype.free;

/**
 * Compose a WGSL shader via naga_oil and serialise the composed naga module
 * back to WGSL text (plan-strategy D-01 Rust-side composer).
 * @param {string} entry_source
 * @param {string} imports_json
 * @param {string} defines_json
 * @returns {string}
 */
export function compose_shader(entry_source, imports_json, defines_json) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(entry_source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(imports_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(defines_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.compose_shader(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * `ValidatedModule` + options JSON -> `BindGroupLayoutDescriptor[]` JSON string.
 *
 * `options_json` shape: `{ "dynamicOffsets": [{ "group": u32, "binding": u32 }, ...] }`.
 * The naga IR does not express the dynamic-offset dimension (see research Finding 2
 * footnote), so it is injected via JS-side options.
 * @param {ValidatedModule} validated
 * @param {string} options_json
 * @returns {string}
 */
export function emit_reflection(validated, options_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        _assertClass(validated, ValidatedModule);
        const ptr0 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.emit_reflection(validated.__wbg_ptr, ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * WGSL source -> `naga::Module`. On failure throws a `JsError` whose payload carries
 * `message` / `line_num` / `line_pos`.
 * @param {string} source
 * @returns {ParsedModule}
 */
export function parse(source) {
    const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ParsedModule.__wrap(ret[0]);
}

export function start() {
    wasm.start();
}

/**
 * `naga::Module` -> `ModuleInfo`. On failure throws a `JsError` whose message is the
 * validator's prose diagnostic (no source position is attached).
 * @param {ParsedModule} parsed
 * @returns {ValidatedModule}
 */
export function validate(parsed) {
    _assertClass(parsed, ParsedModule);
    var ptr0 = parsed.__destroy_into_raw();
    const ret = wasm.validate(ptr0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ValidatedModule.__wrap(ret[0]);
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_bce6d499ff0a4aff: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_Number_b7972a139bfbfdf0: function(arg0) {
            const ret = Number(arg0);
            return ret;
        },
        __wbg_String_8564e559799eccda: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_bigint_get_as_i64_410e28c7b761ad83: function(arg0, arg1) {
            const v = arg1;
            const ret = typeof(v) === 'bigint' ? v : undefined;
            getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_boolean_get_2304fb8c853028c8: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_edece8177ad01481: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_in_07056af4f902c445: function(arg0, arg1) {
            const ret = arg0 in arg1;
            return ret;
        },
        __wbg___wbindgen_is_bigint_aeae3893f30ed54e: function(arg0) {
            const ret = typeof(arg0) === 'bigint';
            return ret;
        },
        __wbg___wbindgen_is_function_5cd60d5cf78b4eef: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_null_2042690d351e14f0: function(arg0) {
            const ret = arg0 === null;
            return ret;
        },
        __wbg___wbindgen_is_object_b4593df85baada48: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_dde0fd9020db4434: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_35bb9f4c7fd651d5: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_jsval_eq_c0ed08b3e0f393b9: function(arg0, arg1) {
            const ret = arg0 === arg1;
            return ret;
        },
        __wbg___wbindgen_jsval_loose_eq_0ad77b7717db155c: function(arg0, arg1) {
            const ret = arg0 == arg1;
            return ret;
        },
        __wbg___wbindgen_number_get_f73a1244370fcc2c: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_d109740c0d18f4d7: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_9c31b086c2b26051: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg__wbg_cb_unref_3fa391f3fcdb55f8: function(arg0) {
            arg0._wbg_cb_unref();
        },
        __wbg_activeTexture_37cff0753870753b: function(arg0, arg1) {
            arg0.activeTexture(arg1 >>> 0);
        },
        __wbg_activeTexture_4d2afad7cfda1396: function(arg0, arg1) {
            arg0.activeTexture(arg1 >>> 0);
        },
        __wbg_attachShader_0a37c762590e5e1c: function(arg0, arg1, arg2) {
            arg0.attachShader(arg1, arg2);
        },
        __wbg_attachShader_515800f4051247dc: function(arg0, arg1, arg2) {
            arg0.attachShader(arg1, arg2);
        },
        __wbg_beginQuery_6c6c5b6d0d8a2c72: function(arg0, arg1, arg2) {
            arg0.beginQuery(arg1 >>> 0, arg2);
        },
        __wbg_bindAttribLocation_07b2841d89fca977: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.bindAttribLocation(arg1, arg2 >>> 0, getStringFromWasm0(arg3, arg4));
        },
        __wbg_bindAttribLocation_1bbbcdee8d08ba2a: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.bindAttribLocation(arg1, arg2 >>> 0, getStringFromWasm0(arg3, arg4));
        },
        __wbg_bindBufferRange_b3fd6bf5761eb1af: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.bindBufferRange(arg1 >>> 0, arg2 >>> 0, arg3, arg4, arg5);
        },
        __wbg_bindBuffer_1a31fd3809dc22c8: function(arg0, arg1, arg2) {
            arg0.bindBuffer(arg1 >>> 0, arg2);
        },
        __wbg_bindBuffer_4bf3ab31e8e200ed: function(arg0, arg1, arg2) {
            arg0.bindBuffer(arg1 >>> 0, arg2);
        },
        __wbg_bindFramebuffer_751e5064f23ee1c4: function(arg0, arg1, arg2) {
            arg0.bindFramebuffer(arg1 >>> 0, arg2);
        },
        __wbg_bindFramebuffer_92449a44405b6557: function(arg0, arg1, arg2) {
            arg0.bindFramebuffer(arg1 >>> 0, arg2);
        },
        __wbg_bindRenderbuffer_1742855b643a7566: function(arg0, arg1, arg2) {
            arg0.bindRenderbuffer(arg1 >>> 0, arg2);
        },
        __wbg_bindRenderbuffer_c46a8b6f3f8ba246: function(arg0, arg1, arg2) {
            arg0.bindRenderbuffer(arg1 >>> 0, arg2);
        },
        __wbg_bindSampler_708d9901a5e548b8: function(arg0, arg1, arg2) {
            arg0.bindSampler(arg1 >>> 0, arg2);
        },
        __wbg_bindTexture_7fd7f85d6f942f6f: function(arg0, arg1, arg2) {
            arg0.bindTexture(arg1 >>> 0, arg2);
        },
        __wbg_bindTexture_85abbde679bce760: function(arg0, arg1, arg2) {
            arg0.bindTexture(arg1 >>> 0, arg2);
        },
        __wbg_bindVertexArrayOES_fb7e8c5e8e106919: function(arg0, arg1) {
            arg0.bindVertexArrayOES(arg1);
        },
        __wbg_bindVertexArray_f8587a616356d307: function(arg0, arg1) {
            arg0.bindVertexArray(arg1);
        },
        __wbg_blendColor_82716e22a8f522ff: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.blendColor(arg1, arg2, arg3, arg4);
        },
        __wbg_blendColor_f877221c780bdbaf: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.blendColor(arg1, arg2, arg3, arg4);
        },
        __wbg_blendEquationSeparate_946c10181ab6c6cf: function(arg0, arg1, arg2) {
            arg0.blendEquationSeparate(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_blendEquationSeparate_985f782fb54b29fe: function(arg0, arg1, arg2) {
            arg0.blendEquationSeparate(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_blendEquation_519c57992eed79c1: function(arg0, arg1) {
            arg0.blendEquation(arg1 >>> 0);
        },
        __wbg_blendEquation_f496fde4a67ecc1e: function(arg0, arg1) {
            arg0.blendEquation(arg1 >>> 0);
        },
        __wbg_blendFuncSeparate_6f525092629a20ae: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.blendFuncSeparate(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
        },
        __wbg_blendFuncSeparate_ea29c928bc1c4984: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.blendFuncSeparate(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
        },
        __wbg_blendFunc_2e7b7adf253717a0: function(arg0, arg1, arg2) {
            arg0.blendFunc(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_blendFunc_d29c837f8be35d6e: function(arg0, arg1, arg2) {
            arg0.blendFunc(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_blitFramebuffer_8fd7726fe3c57e1a: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
            arg0.blitFramebuffer(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0);
        },
        __wbg_bufferData_74a0b79b4c9d8f96: function(arg0, arg1, arg2, arg3) {
            arg0.bufferData(arg1 >>> 0, arg2, arg3 >>> 0);
        },
        __wbg_bufferData_886f34df840b0814: function(arg0, arg1, arg2, arg3) {
            arg0.bufferData(arg1 >>> 0, arg2, arg3 >>> 0);
        },
        __wbg_bufferData_aebf4ed69e98d559: function(arg0, arg1, arg2, arg3) {
            arg0.bufferData(arg1 >>> 0, arg2, arg3 >>> 0);
        },
        __wbg_bufferData_e8afecf0042a3eb9: function(arg0, arg1, arg2, arg3) {
            arg0.bufferData(arg1 >>> 0, arg2, arg3 >>> 0);
        },
        __wbg_bufferSubData_0e5936ef36f518d2: function(arg0, arg1, arg2, arg3) {
            arg0.bufferSubData(arg1 >>> 0, arg2, arg3);
        },
        __wbg_bufferSubData_ca02a13879fa62e8: function(arg0, arg1, arg2, arg3) {
            arg0.bufferSubData(arg1 >>> 0, arg2, arg3);
        },
        __wbg_buffer_8d6798e32d1afd34: function(arg0) {
            const ret = arg0.buffer;
            return ret;
        },
        __wbg_call_13665d9f14390edc: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_call_dfde26266607c996: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_call_faa0a261f288f846: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_clearBufferfv_a0bddf84cc04ef84: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.clearBufferfv(arg1 >>> 0, arg2, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_clearBufferiv_9a3f2d1ec3f2296f: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.clearBufferiv(arg1 >>> 0, arg2, getArrayI32FromWasm0(arg3, arg4));
        },
        __wbg_clearBufferuiv_d52433002e7330f8: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.clearBufferuiv(arg1 >>> 0, arg2, getArrayU32FromWasm0(arg3, arg4));
        },
        __wbg_clearDepth_1eae37358a24b9db: function(arg0, arg1) {
            arg0.clearDepth(arg1);
        },
        __wbg_clearDepth_f42ada4795e5a943: function(arg0, arg1) {
            arg0.clearDepth(arg1);
        },
        __wbg_clearStencil_999f2e1ef49323e6: function(arg0, arg1) {
            arg0.clearStencil(arg1);
        },
        __wbg_clearStencil_a58c15a1dcbf1fbe: function(arg0, arg1) {
            arg0.clearStencil(arg1);
        },
        __wbg_clear_252bb7b11d5bea06: function(arg0, arg1) {
            arg0.clear(arg1 >>> 0);
        },
        __wbg_clear_7d0a8d124c2a4b66: function(arg0, arg1) {
            arg0.clear(arg1 >>> 0);
        },
        __wbg_clientWaitSync_fb0623a14def0f1e: function(arg0, arg1, arg2, arg3) {
            const ret = arg0.clientWaitSync(arg1, arg2 >>> 0, arg3 >>> 0);
            return ret;
        },
        __wbg_colorMask_0f86a23bfc7696a7: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.colorMask(arg1 !== 0, arg2 !== 0, arg3 !== 0, arg4 !== 0);
        },
        __wbg_colorMask_2d4b38c34bf55a02: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.colorMask(arg1 !== 0, arg2 !== 0, arg3 !== 0, arg4 !== 0);
        },
        __wbg_compileShader_a20e7b68d3edcd8a: function(arg0, arg1) {
            arg0.compileShader(arg1);
        },
        __wbg_compileShader_b77bd79d00a03b02: function(arg0, arg1) {
            arg0.compileShader(arg1);
        },
        __wbg_compressedTexSubImage2D_12adc86b34c12d28: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
            arg0.compressedTexSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8);
        },
        __wbg_compressedTexSubImage2D_5336c9efcad92150: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
            arg0.compressedTexSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8);
        },
        __wbg_compressedTexSubImage2D_7eb545d3f1d37773: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.compressedTexSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8, arg9);
        },
        __wbg_compressedTexSubImage3D_1bca0af82425d03d: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
            arg0.compressedTexSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10, arg11);
        },
        __wbg_compressedTexSubImage3D_7f820492cb5a6d5e: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
            arg0.compressedTexSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10);
        },
        __wbg_copyBufferSubData_8855e4c7f24415d6: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.copyBufferSubData(arg1 >>> 0, arg2 >>> 0, arg3, arg4, arg5);
        },
        __wbg_copyTexSubImage2D_68eb6addf3f910bb: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
            arg0.copyTexSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
        },
        __wbg_copyTexSubImage2D_c56507367f94e004: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
            arg0.copyTexSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
        },
        __wbg_copyTexSubImage3D_7f30d563975b3710: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.copyTexSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
        },
        __wbg_createBuffer_1c3448547584bc5a: function(arg0) {
            const ret = arg0.createBuffer();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createBuffer_77da03de0620a199: function(arg0) {
            const ret = arg0.createBuffer();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createFramebuffer_22f50a7a9f8afdf0: function(arg0) {
            const ret = arg0.createFramebuffer();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createFramebuffer_73699dac20f72ffb: function(arg0) {
            const ret = arg0.createFramebuffer();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createProgram_a175fc4c32429a24: function(arg0) {
            const ret = arg0.createProgram();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createProgram_c9d6396ea0bc7522: function(arg0) {
            const ret = arg0.createProgram();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createQuery_5d92b56f0ca718af: function(arg0) {
            const ret = arg0.createQuery();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createRenderbuffer_483c206d1b62e6bd: function(arg0) {
            const ret = arg0.createRenderbuffer();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createRenderbuffer_f26e2b467988cc7e: function(arg0) {
            const ret = arg0.createRenderbuffer();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createSampler_80eb58b226692482: function(arg0) {
            const ret = arg0.createSampler();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createShader_25e11081fd48d141: function(arg0, arg1) {
            const ret = arg0.createShader(arg1 >>> 0);
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createShader_9c5e52918428bd27: function(arg0, arg1) {
            const ret = arg0.createShader(arg1 >>> 0);
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createTexture_5e721dc1ddd865e3: function(arg0) {
            const ret = arg0.createTexture();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createTexture_f1cc0c64fa9e22cf: function(arg0) {
            const ret = arg0.createTexture();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createVertexArrayOES_03fccccc43c10f77: function(arg0) {
            const ret = arg0.createVertexArrayOES();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createVertexArray_050d27763dfd72fa: function(arg0) {
            const ret = arg0.createVertexArray();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_cullFace_632c5f88d252b4d7: function(arg0, arg1) {
            arg0.cullFace(arg1 >>> 0);
        },
        __wbg_cullFace_962911677f1c30c6: function(arg0, arg1) {
            arg0.cullFace(arg1 >>> 0);
        },
        __wbg_deleteBuffer_5c5c23d034945b7c: function(arg0, arg1) {
            arg0.deleteBuffer(arg1);
        },
        __wbg_deleteBuffer_dd1d6f71883058cb: function(arg0, arg1) {
            arg0.deleteBuffer(arg1);
        },
        __wbg_deleteFramebuffer_4d8be9eb882b0525: function(arg0, arg1) {
            arg0.deleteFramebuffer(arg1);
        },
        __wbg_deleteFramebuffer_712016837ba2592e: function(arg0, arg1) {
            arg0.deleteFramebuffer(arg1);
        },
        __wbg_deleteProgram_35e4ff7b82f1c4d5: function(arg0, arg1) {
            arg0.deleteProgram(arg1);
        },
        __wbg_deleteProgram_771559436a63e7c1: function(arg0, arg1) {
            arg0.deleteProgram(arg1);
        },
        __wbg_deleteQuery_1c30cae3b68f3fd7: function(arg0, arg1) {
            arg0.deleteQuery(arg1);
        },
        __wbg_deleteRenderbuffer_16d1501ab6903d8e: function(arg0, arg1) {
            arg0.deleteRenderbuffer(arg1);
        },
        __wbg_deleteRenderbuffer_aee8ffc30e0e35cb: function(arg0, arg1) {
            arg0.deleteRenderbuffer(arg1);
        },
        __wbg_deleteSampler_ec0248a7607fb5e6: function(arg0, arg1) {
            arg0.deleteSampler(arg1);
        },
        __wbg_deleteShader_5f66fd162cd9b6b4: function(arg0, arg1) {
            arg0.deleteShader(arg1);
        },
        __wbg_deleteShader_718c5020e3d4f188: function(arg0, arg1) {
            arg0.deleteShader(arg1);
        },
        __wbg_deleteSync_b589decdc7180f91: function(arg0, arg1) {
            arg0.deleteSync(arg1);
        },
        __wbg_deleteTexture_3472fc261bb7ff34: function(arg0, arg1) {
            arg0.deleteTexture(arg1);
        },
        __wbg_deleteTexture_6990124dfb5053bd: function(arg0, arg1) {
            arg0.deleteTexture(arg1);
        },
        __wbg_deleteVertexArrayOES_b1b88aa74410f620: function(arg0, arg1) {
            arg0.deleteVertexArrayOES(arg1);
        },
        __wbg_deleteVertexArray_85b79d70fae1d1da: function(arg0, arg1) {
            arg0.deleteVertexArray(arg1);
        },
        __wbg_depthFunc_11c361d188403f52: function(arg0, arg1) {
            arg0.depthFunc(arg1 >>> 0);
        },
        __wbg_depthFunc_cd5ad66da02ddb7c: function(arg0, arg1) {
            arg0.depthFunc(arg1 >>> 0);
        },
        __wbg_depthMask_a00e4725581ef05d: function(arg0, arg1) {
            arg0.depthMask(arg1 !== 0);
        },
        __wbg_depthMask_e15ec83686756c88: function(arg0, arg1) {
            arg0.depthMask(arg1 !== 0);
        },
        __wbg_depthRange_2ed081b96c5c19be: function(arg0, arg1, arg2) {
            arg0.depthRange(arg1, arg2);
        },
        __wbg_depthRange_7f3fef7f421c00d4: function(arg0, arg1, arg2) {
            arg0.depthRange(arg1, arg2);
        },
        __wbg_disableVertexAttribArray_18b9a9fe235412a1: function(arg0, arg1) {
            arg0.disableVertexAttribArray(arg1 >>> 0);
        },
        __wbg_disableVertexAttribArray_40a8f7d4d882728e: function(arg0, arg1) {
            arg0.disableVertexAttribArray(arg1 >>> 0);
        },
        __wbg_disable_79f65722e686303b: function(arg0, arg1) {
            arg0.disable(arg1 >>> 0);
        },
        __wbg_disable_df908054ffee7971: function(arg0, arg1) {
            arg0.disable(arg1 >>> 0);
        },
        __wbg_document_3540635616a18455: function(arg0) {
            const ret = arg0.document;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_done_54b8da57023b7ed2: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_drawArraysInstancedANGLE_a7a04432fa5e1577: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.drawArraysInstancedANGLE(arg1 >>> 0, arg2, arg3, arg4);
        },
        __wbg_drawArraysInstanced_0e6f9f2102461c2a: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.drawArraysInstanced(arg1 >>> 0, arg2, arg3, arg4);
        },
        __wbg_drawArrays_7f9a3dcec5315ce5: function(arg0, arg1, arg2, arg3) {
            arg0.drawArrays(arg1 >>> 0, arg2, arg3);
        },
        __wbg_drawArrays_bceea06128f9d778: function(arg0, arg1, arg2, arg3) {
            arg0.drawArrays(arg1 >>> 0, arg2, arg3);
        },
        __wbg_drawBuffersWEBGL_5fbba2b83de4c122: function(arg0, arg1) {
            arg0.drawBuffersWEBGL(arg1);
        },
        __wbg_drawBuffers_217bd25bf75ccebd: function(arg0, arg1) {
            arg0.drawBuffers(arg1);
        },
        __wbg_drawElementsInstancedANGLE_6794fe36875c5120: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.drawElementsInstancedANGLE(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
        },
        __wbg_drawElementsInstanced_767ab401cd072fd4: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.drawElementsInstanced(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
        },
        __wbg_enableVertexAttribArray_9963bb377f60317c: function(arg0, arg1) {
            arg0.enableVertexAttribArray(arg1 >>> 0);
        },
        __wbg_enableVertexAttribArray_9e6e81b8b603d999: function(arg0, arg1) {
            arg0.enableVertexAttribArray(arg1 >>> 0);
        },
        __wbg_enable_5c8f846164bc8138: function(arg0, arg1) {
            arg0.enable(arg1 >>> 0);
        },
        __wbg_enable_ee1b63abdc3fdeb5: function(arg0, arg1) {
            arg0.enable(arg1 >>> 0);
        },
        __wbg_endQuery_42d36ba1d568a37a: function(arg0, arg1) {
            arg0.endQuery(arg1 >>> 0);
        },
        __wbg_entries_564a7e8b1e54ede5: function(arg0) {
            const ret = Object.entries(arg0);
            return ret;
        },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_fenceSync_59d6455faf4ba50a: function(arg0, arg1, arg2) {
            const ret = arg0.fenceSync(arg1 >>> 0, arg2 >>> 0);
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_flush_1e5245bab2bbc54b: function(arg0) {
            arg0.flush();
        },
        __wbg_flush_279c03f2320388de: function(arg0) {
            arg0.flush();
        },
        __wbg_framebufferRenderbuffer_49b9288b6a7b5629: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.framebufferRenderbuffer(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4);
        },
        __wbg_framebufferRenderbuffer_9417c925d5389962: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.framebufferRenderbuffer(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4);
        },
        __wbg_framebufferTexture2D_8882fef6f47df627: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.framebufferTexture2D(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4, arg5);
        },
        __wbg_framebufferTexture2D_91e307404924ae24: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.framebufferTexture2D(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4, arg5);
        },
        __wbg_framebufferTextureLayer_8256c57e84c45762: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.framebufferTextureLayer(arg1 >>> 0, arg2 >>> 0, arg3, arg4, arg5);
        },
        __wbg_framebufferTextureMultiviewOVR_fd3136c9d479feb2: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
            arg0.framebufferTextureMultiviewOVR(arg1 >>> 0, arg2 >>> 0, arg3, arg4, arg5, arg6);
        },
        __wbg_from_fa561fa561dc8031: function(arg0) {
            const ret = Array.from(arg0);
            return ret;
        },
        __wbg_frontFace_1ab53137f5dcd7a2: function(arg0, arg1) {
            arg0.frontFace(arg1 >>> 0);
        },
        __wbg_frontFace_53fc2aad7ead45c9: function(arg0, arg1) {
            arg0.frontFace(arg1 >>> 0);
        },
        __wbg_getBufferSubData_f3d6368ec0319180: function(arg0, arg1, arg2, arg3) {
            arg0.getBufferSubData(arg1 >>> 0, arg2, arg3);
        },
        __wbg_getContext_32d5f94659d12566: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.getContext(getStringFromWasm0(arg1, arg2), arg3);
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_getContext_50a6668bd78d1120: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.getContext(getStringFromWasm0(arg1, arg2), arg3);
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_getExtension_c76ccfc25e343ce6: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.getExtension(getStringFromWasm0(arg1, arg2));
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_getIndexedParameter_b83fcd0ac4c3a462: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.getIndexedParameter(arg1 >>> 0, arg2 >>> 0);
            return ret;
        }, arguments); },
        __wbg_getParameter_5f25c05c9a0f445a: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.getParameter(arg1 >>> 0);
            return ret;
        }, arguments); },
        __wbg_getParameter_827c3142b1ce3364: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.getParameter(arg1 >>> 0);
            return ret;
        }, arguments); },
        __wbg_getProgramInfoLog_6d6e22f0179f1acf: function(arg0, arg1, arg2) {
            const ret = arg1.getProgramInfoLog(arg2);
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_getProgramInfoLog_e2fe4bdd00a597bc: function(arg0, arg1, arg2) {
            const ret = arg1.getProgramInfoLog(arg2);
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_getProgramParameter_6927dedbc507dfc7: function(arg0, arg1, arg2) {
            const ret = arg0.getProgramParameter(arg1, arg2 >>> 0);
            return ret;
        },
        __wbg_getProgramParameter_c7abe52a31622ce2: function(arg0, arg1, arg2) {
            const ret = arg0.getProgramParameter(arg1, arg2 >>> 0);
            return ret;
        },
        __wbg_getQueryParameter_6817ddd38edd8e5c: function(arg0, arg1, arg2) {
            const ret = arg0.getQueryParameter(arg1, arg2 >>> 0);
            return ret;
        },
        __wbg_getShaderInfoLog_246aba1bd0b04ad2: function(arg0, arg1, arg2) {
            const ret = arg1.getShaderInfoLog(arg2);
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_getShaderInfoLog_edfc45fd76ba8c81: function(arg0, arg1, arg2) {
            const ret = arg1.getShaderInfoLog(arg2);
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_getShaderParameter_07fb35844118558b: function(arg0, arg1, arg2) {
            const ret = arg0.getShaderParameter(arg1, arg2 >>> 0);
            return ret;
        },
        __wbg_getShaderParameter_ac9e7f81d3268efe: function(arg0, arg1, arg2) {
            const ret = arg0.getShaderParameter(arg1, arg2 >>> 0);
            return ret;
        },
        __wbg_getSupportedExtensions_76f42c1e788da832: function(arg0) {
            const ret = arg0.getSupportedExtensions();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_getSupportedProfiles_e4f6fd61b7c0362c: function(arg0) {
            const ret = arg0.getSupportedProfiles();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_getSyncParameter_9f6e0bba77b398fa: function(arg0, arg1, arg2) {
            const ret = arg0.getSyncParameter(arg1, arg2 >>> 0);
            return ret;
        },
        __wbg_getUniformBlockIndex_3aa1c4c48062a404: function(arg0, arg1, arg2, arg3) {
            const ret = arg0.getUniformBlockIndex(arg1, getStringFromWasm0(arg2, arg3));
            return ret;
        },
        __wbg_getUniformLocation_1717b4ed42e2ccee: function(arg0, arg1, arg2, arg3) {
            const ret = arg0.getUniformLocation(arg1, getStringFromWasm0(arg2, arg3));
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_getUniformLocation_46373021b59d8832: function(arg0, arg1, arg2, arg3) {
            const ret = arg0.getUniformLocation(arg1, getStringFromWasm0(arg2, arg3));
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_get_3e9a707ab7d352eb: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_98fdf51d029a75eb: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_dcf82ab8aad1a593: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_unchecked_1dfe6d05ad91d9b7: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_with_ref_key_6412cf3094599694: function(arg0, arg1) {
            const ret = arg0[arg1];
            return ret;
        },
        __wbg_includes_0ec85e8f9acc8cac: function(arg0, arg1, arg2) {
            const ret = arg0.includes(arg1, arg2);
            return ret;
        },
        __wbg_instanceof_ArrayBuffer_53db37b06f6b9afe: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_HtmlCanvasElement_a02da0a417f1bf3f: function(arg0) {
            let result;
            try {
                result = arg0 instanceof HTMLCanvasElement;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint32Array_6aece1e91fed8df4: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint32Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_abd07d4bd221d50b: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_WebGl2RenderingContext_419098f7bf88e87e: function(arg0) {
            let result;
            try {
                result = arg0 instanceof WebGL2RenderingContext;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Window_faa5cf994f49cca7: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Window;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_invalidateFramebuffer_02a63100f262d6cb: function() { return handleError(function (arg0, arg1, arg2) {
            arg0.invalidateFramebuffer(arg1 >>> 0, arg2);
        }, arguments); },
        __wbg_isArray_74b636a53056fecb: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_isArray_94898ed3aad6947b: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_isSafeInteger_01e964d144ad3a55: function(arg0) {
            const ret = Number.isSafeInteger(arg0);
            return ret;
        },
        __wbg_is_032c49d03f47f420: function(arg0, arg1) {
            const ret = Object.is(arg0, arg1);
            return ret;
        },
        __wbg_iterator_1441b47f341dc34f: function() {
            const ret = Symbol.iterator;
            return ret;
        },
        __wbg_length_2591a0f4f659a55c: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_3a1b902b6cde9e2c: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_56fcd3e2b7e0299d: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_linkProgram_7689cb555b14a359: function(arg0, arg1) {
            arg0.linkProgram(arg1);
        },
        __wbg_linkProgram_ec865896be2835c2: function(arg0, arg1) {
            arg0.linkProgram(arg1);
        },
        __wbg_new_02d162bc6cf02f60: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_310879b66b6e95e1: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_7ddec6de44ff8f5d: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_d8dfd33fa007511d: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen_e1691a7b45d7b08b___convert__closures_____invoke___js_sys_b297d463e24e6fe4___Function_fn_wasm_bindgen_e1691a7b45d7b08b___JsValue_____wasm_bindgen_e1691a7b45d7b08b___sys__Undefined___js_sys_b297d463e24e6fe4___Function_fn_wasm_bindgen_e1691a7b45d7b08b___JsValue_____wasm_bindgen_e1691a7b45d7b08b___sys__Undefined_______true_(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_new_typed_c072c4ce9a2a0cdf: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen_e1691a7b45d7b08b___convert__closures_____invoke___js_sys_b297d463e24e6fe4___Function_fn_wasm_bindgen_e1691a7b45d7b08b___JsValue_____wasm_bindgen_e1691a7b45d7b08b___sys__Undefined___js_sys_b297d463e24e6fe4___Function_fn_wasm_bindgen_e1691a7b45d7b08b___JsValue_____wasm_bindgen_e1691a7b45d7b08b___sys__Undefined_______true_(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_new_with_length_99887c91eae4abab: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_next_2a4e19f4f5083b0f: function(arg0) {
            const ret = arg0.next;
            return ret;
        },
        __wbg_next_6429a146bf756f93: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_of_d694dacacb7afa7f: function(arg0) {
            const ret = Array.of(arg0);
            return ret;
        },
        __wbg_pixelStorei_06b86995306b01dc: function(arg0, arg1, arg2) {
            arg0.pixelStorei(arg1 >>> 0, arg2);
        },
        __wbg_pixelStorei_171e6a6629fd9e3c: function(arg0, arg1, arg2) {
            arg0.pixelStorei(arg1 >>> 0, arg2);
        },
        __wbg_polygonOffset_690c52c5bfca2a27: function(arg0, arg1, arg2) {
            arg0.polygonOffset(arg1, arg2);
        },
        __wbg_polygonOffset_cd648f07839ab009: function(arg0, arg1, arg2) {
            arg0.polygonOffset(arg1, arg2);
        },
        __wbg_prototypesetcall_303283bf37c9f014: function(arg0, arg1, arg2) {
            Uint32Array.prototype.set.call(getArrayU32FromWasm0(arg0, arg1), arg2);
        },
        __wbg_prototypesetcall_5f9bdc8d75e07276: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_push_b77c476b01548d0a: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_queryCounterEXT_d92c246603070eed: function(arg0, arg1, arg2) {
            arg0.queryCounterEXT(arg1, arg2 >>> 0);
        },
        __wbg_querySelector_54149fe79b2a2091: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.querySelector(getStringFromWasm0(arg1, arg2));
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        }, arguments); },
        __wbg_queueMicrotask_78d584b53af520f5: function(arg0) {
            const ret = arg0.queueMicrotask;
            return ret;
        },
        __wbg_queueMicrotask_b39ea83c7f01971a: function(arg0) {
            queueMicrotask(arg0);
        },
        __wbg_readBuffer_dc685ea6f3a7d5aa: function(arg0, arg1) {
            arg0.readBuffer(arg1 >>> 0);
        },
        __wbg_readPixels_0529efa834a6960a: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7) {
            arg0.readPixels(arg1, arg2, arg3, arg4, arg5 >>> 0, arg6 >>> 0, arg7);
        }, arguments); },
        __wbg_readPixels_3509816172f67b8a: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7) {
            arg0.readPixels(arg1, arg2, arg3, arg4, arg5 >>> 0, arg6 >>> 0, arg7);
        }, arguments); },
        __wbg_readPixels_76225de67eebec03: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7) {
            arg0.readPixels(arg1, arg2, arg3, arg4, arg5 >>> 0, arg6 >>> 0, arg7);
        }, arguments); },
        __wbg_renderbufferStorageMultisample_25941e0e73e50cd2: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.renderbufferStorageMultisample(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
        },
        __wbg_renderbufferStorage_e46ef4833287e3bf: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.renderbufferStorage(arg1 >>> 0, arg2 >>> 0, arg3, arg4);
        },
        __wbg_renderbufferStorage_fd35a40ea121e819: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.renderbufferStorage(arg1 >>> 0, arg2 >>> 0, arg3, arg4);
        },
        __wbg_resolve_d17db9352f5a220e: function(arg0) {
            const ret = Promise.resolve(arg0);
            return ret;
        },
        __wbg_rhiwgpuadapter_new: function(arg0) {
            const ret = RhiWgpuAdapter.__wrap(arg0);
            return ret;
        },
        __wbg_rhiwgpucommandbuffer_unwrap: function(arg0) {
            const ret = RhiWgpuCommandBuffer.__unwrap(arg0);
            return ret;
        },
        __wbg_rhiwgpudevice_new: function(arg0) {
            const ret = RhiWgpuDevice.__wrap(arg0);
            return ret;
        },
        __wbg_rhiwgpuinstance_new: function(arg0) {
            const ret = RhiWgpuInstance.__wrap(arg0);
            return ret;
        },
        __wbg_samplerParameterf_eb39264d0b3431ea: function(arg0, arg1, arg2, arg3) {
            arg0.samplerParameterf(arg1, arg2 >>> 0, arg3);
        },
        __wbg_samplerParameteri_7a90e6197a393b63: function(arg0, arg1, arg2, arg3) {
            arg0.samplerParameteri(arg1, arg2 >>> 0, arg3);
        },
        __wbg_scissor_eefeb709a030fe62: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.scissor(arg1, arg2, arg3, arg4);
        },
        __wbg_scissor_ffbc9d8b3e5bb99b: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.scissor(arg1, arg2, arg3, arg4);
        },
        __wbg_set_24d0fa9e104112f9: function(arg0, arg1, arg2) {
            arg0.set(getArrayU8FromWasm0(arg1, arg2));
        },
        __wbg_set_a0e911be3da02782: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_height_bb0dc35fd1d941f5: function(arg0, arg1) {
            arg0.height = arg1 >>> 0;
        },
        __wbg_set_height_bdd58e6b04e88cca: function(arg0, arg1) {
            arg0.height = arg1 >>> 0;
        },
        __wbg_set_width_25112eb6bf1148df: function(arg0, arg1) {
            arg0.width = arg1 >>> 0;
        },
        __wbg_set_width_9d385df435c1f79d: function(arg0, arg1) {
            arg0.width = arg1 >>> 0;
        },
        __wbg_shaderSource_a304cd4ebd95c11b: function(arg0, arg1, arg2, arg3) {
            arg0.shaderSource(arg1, getStringFromWasm0(arg2, arg3));
        },
        __wbg_shaderSource_eceb56c4b827824d: function(arg0, arg1, arg2, arg3) {
            arg0.shaderSource(arg1, getStringFromWasm0(arg2, arg3));
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_static_accessor_GLOBAL_THIS_02344c9b09eb08a9: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_ac6d4ac874d5cd54: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_9b2406c23aeb2023: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_b34d2126934e16ba: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_stencilFuncSeparate_00281c346ccf1e19: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.stencilFuncSeparate(arg1 >>> 0, arg2 >>> 0, arg3, arg4 >>> 0);
        },
        __wbg_stencilFuncSeparate_5f7154fe74881dab: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.stencilFuncSeparate(arg1 >>> 0, arg2 >>> 0, arg3, arg4 >>> 0);
        },
        __wbg_stencilMaskSeparate_bd7c034fdfc6620c: function(arg0, arg1, arg2) {
            arg0.stencilMaskSeparate(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_stencilMaskSeparate_d14d6ba494aeff5f: function(arg0, arg1, arg2) {
            arg0.stencilMaskSeparate(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_stencilMask_15dfb3e60c15e612: function(arg0, arg1) {
            arg0.stencilMask(arg1 >>> 0);
        },
        __wbg_stencilMask_2d63c2d3e068aca1: function(arg0, arg1) {
            arg0.stencilMask(arg1 >>> 0);
        },
        __wbg_stencilOpSeparate_1fea3ed309a817f9: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.stencilOpSeparate(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
        },
        __wbg_stencilOpSeparate_32876bf4c07b7065: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.stencilOpSeparate(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
        },
        __wbg_texImage2D_17593ae6c467ae79: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texImage2D_2495ff54823b531b: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texImage2D_364c83aae17ba6d2: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texImage3D_3bcfec50659cc5ae: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
            arg0.texImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8 >>> 0, arg9 >>> 0, arg10);
        }, arguments); },
        __wbg_texImage3D_79d27507fa4470dd: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
            arg0.texImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8 >>> 0, arg9 >>> 0, arg10);
        }, arguments); },
        __wbg_texParameteri_2ef5b781bcfbdd64: function(arg0, arg1, arg2, arg3) {
            arg0.texParameteri(arg1 >>> 0, arg2 >>> 0, arg3);
        },
        __wbg_texParameteri_c22838926a5dca2b: function(arg0, arg1, arg2, arg3) {
            arg0.texParameteri(arg1 >>> 0, arg2 >>> 0, arg3);
        },
        __wbg_texStorage2D_afb762382f8a4678: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.texStorage2D(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
        },
        __wbg_texStorage3D_66ff900ad02f2247: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
            arg0.texStorage3D(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5, arg6);
        },
        __wbg_texSubImage2D_0f88243806532534: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texSubImage2D_203ff6bcf48e4d08: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texSubImage2D_57a710f2064ab4ef: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texSubImage2D_62d9e38e9378faff: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texSubImage2D_668c5714e23e0e83: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texSubImage2D_781892a0e05abd13: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texSubImage2D_ad417daf4e038863: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texSubImage2D_e1be0f65e9a35343: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
            arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9);
        }, arguments); },
        __wbg_texSubImage3D_11a4e6f278359fc4: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
            arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
        }, arguments); },
        __wbg_texSubImage3D_36a195d4f535cfe6: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
            arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
        }, arguments); },
        __wbg_texSubImage3D_54374f7f12d16e40: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
            arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
        }, arguments); },
        __wbg_texSubImage3D_5cfc6bdc70a23b0d: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
            arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
        }, arguments); },
        __wbg_texSubImage3D_72a9517857b52f44: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
            arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
        }, arguments); },
        __wbg_texSubImage3D_a5b225452b0d7de3: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
            arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
        }, arguments); },
        __wbg_texSubImage3D_ebb4d2dbc4680374: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
            arg0.texSubImage3D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0, arg11);
        }, arguments); },
        __wbg_then_837494e384b37459: function(arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        },
        __wbg_uniform1f_429e664ea89191db: function(arg0, arg1, arg2) {
            arg0.uniform1f(arg1, arg2);
        },
        __wbg_uniform1f_709baed741125e5e: function(arg0, arg1, arg2) {
            arg0.uniform1f(arg1, arg2);
        },
        __wbg_uniform1i_2be01a75c6619c15: function(arg0, arg1, arg2) {
            arg0.uniform1i(arg1, arg2);
        },
        __wbg_uniform1i_717096cfb8ca6bc1: function(arg0, arg1, arg2) {
            arg0.uniform1i(arg1, arg2);
        },
        __wbg_uniform1ui_eafd8b7523d6d39e: function(arg0, arg1, arg2) {
            arg0.uniform1ui(arg1, arg2 >>> 0);
        },
        __wbg_uniform2fv_63f8c49c9f57e258: function(arg0, arg1, arg2, arg3) {
            arg0.uniform2fv(arg1, getArrayF32FromWasm0(arg2, arg3));
        },
        __wbg_uniform2fv_9f8ce1c86ee13440: function(arg0, arg1, arg2, arg3) {
            arg0.uniform2fv(arg1, getArrayF32FromWasm0(arg2, arg3));
        },
        __wbg_uniform2iv_c67b4ee9d082abdf: function(arg0, arg1, arg2, arg3) {
            arg0.uniform2iv(arg1, getArrayI32FromWasm0(arg2, arg3));
        },
        __wbg_uniform2iv_ec7e5887f2386d2c: function(arg0, arg1, arg2, arg3) {
            arg0.uniform2iv(arg1, getArrayI32FromWasm0(arg2, arg3));
        },
        __wbg_uniform2uiv_55a0e084de75c7b9: function(arg0, arg1, arg2, arg3) {
            arg0.uniform2uiv(arg1, getArrayU32FromWasm0(arg2, arg3));
        },
        __wbg_uniform3fv_2fb5418c1304ba72: function(arg0, arg1, arg2, arg3) {
            arg0.uniform3fv(arg1, getArrayF32FromWasm0(arg2, arg3));
        },
        __wbg_uniform3fv_7c2935b7f05414ef: function(arg0, arg1, arg2, arg3) {
            arg0.uniform3fv(arg1, getArrayF32FromWasm0(arg2, arg3));
        },
        __wbg_uniform3iv_ad46bb9ddf29111f: function(arg0, arg1, arg2, arg3) {
            arg0.uniform3iv(arg1, getArrayI32FromWasm0(arg2, arg3));
        },
        __wbg_uniform3iv_d82127ddeebb5154: function(arg0, arg1, arg2, arg3) {
            arg0.uniform3iv(arg1, getArrayI32FromWasm0(arg2, arg3));
        },
        __wbg_uniform3uiv_30e97efe980f53c9: function(arg0, arg1, arg2, arg3) {
            arg0.uniform3uiv(arg1, getArrayU32FromWasm0(arg2, arg3));
        },
        __wbg_uniform4f_7bc8db9ead983de4: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.uniform4f(arg1, arg2, arg3, arg4, arg5);
        },
        __wbg_uniform4f_be0bd0ea203aedfe: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.uniform4f(arg1, arg2, arg3, arg4, arg5);
        },
        __wbg_uniform4fv_622c64d35acf9214: function(arg0, arg1, arg2, arg3) {
            arg0.uniform4fv(arg1, getArrayF32FromWasm0(arg2, arg3));
        },
        __wbg_uniform4fv_b0c5721b35cd3f06: function(arg0, arg1, arg2, arg3) {
            arg0.uniform4fv(arg1, getArrayF32FromWasm0(arg2, arg3));
        },
        __wbg_uniform4iv_24df1fbc803c05db: function(arg0, arg1, arg2, arg3) {
            arg0.uniform4iv(arg1, getArrayI32FromWasm0(arg2, arg3));
        },
        __wbg_uniform4iv_2cccd5ae55d77224: function(arg0, arg1, arg2, arg3) {
            arg0.uniform4iv(arg1, getArrayI32FromWasm0(arg2, arg3));
        },
        __wbg_uniform4uiv_6f594d049d6d0038: function(arg0, arg1, arg2, arg3) {
            arg0.uniform4uiv(arg1, getArrayU32FromWasm0(arg2, arg3));
        },
        __wbg_uniformBlockBinding_25e6ae614200cf4d: function(arg0, arg1, arg2, arg3) {
            arg0.uniformBlockBinding(arg1, arg2 >>> 0, arg3 >>> 0);
        },
        __wbg_uniformMatrix2fv_6918fd0909b6a167: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix2fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix2fv_840e6434707032cd: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix2fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix2x3fv_4a2dd969ec740f7d: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix2x3fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix2x4fv_e3cdd10c182a5354: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix2x4fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix3fv_6abd62dbed68830a: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix3fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix3fv_e380a7aa532c175a: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix3fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix3x2fv_2b07ce888bfa37c8: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix3x2fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix3x4fv_0439a4fdd88af9de: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix3x4fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix4fv_b5f678dc15314524: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix4fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix4fv_d2b5005a92d27115: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix4fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix4x2fv_7d12ae09d4b61a26: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix4x2fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_uniformMatrix4x3fv_f60d424ca4a02635: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix4x3fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_useProgram_3cc1a6d58dac88b4: function(arg0, arg1) {
            arg0.useProgram(arg1);
        },
        __wbg_useProgram_e45f506b921ab3f8: function(arg0, arg1) {
            arg0.useProgram(arg1);
        },
        __wbg_value_9cc0518af87a489c: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_vertexAttribDivisorANGLE_47b6b82921bbf062: function(arg0, arg1, arg2) {
            arg0.vertexAttribDivisorANGLE(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_vertexAttribDivisor_74454522a4976fc2: function(arg0, arg1, arg2) {
            arg0.vertexAttribDivisor(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_vertexAttribIPointer_e65b21fd97a67466: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.vertexAttribIPointer(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
        },
        __wbg_vertexAttribPointer_7f7185558bcaf24b: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
            arg0.vertexAttribPointer(arg1 >>> 0, arg2, arg3 >>> 0, arg4 !== 0, arg5, arg6);
        },
        __wbg_vertexAttribPointer_85566c79cb366300: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
            arg0.vertexAttribPointer(arg1 >>> 0, arg2, arg3 >>> 0, arg4 !== 0, arg5, arg6);
        },
        __wbg_viewport_3c149d0c6435f0ed: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.viewport(arg1, arg2, arg3, arg4);
        },
        __wbg_viewport_c25030cfbe3cddf4: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.viewport(arg1, arg2, arg3, arg4);
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 1267, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_e1691a7b45d7b08b___convert__closures_____invoke___wasm_bindgen_e1691a7b45d7b08b___JsValue__core_f4ce2b6cc8c3b44d___result__Result_____wasm_bindgen_e1691a7b45d7b08b___JsError___true_);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [String, String], shim_idx: 14, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen_e1691a7b45d7b08b___convert__closures_____invoke___alloc_864af3eab0b4f693___string__String__alloc_864af3eab0b4f693___string__String______true_);
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000004: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(F32)) -> NamedExternref("Float32Array")`.
            const ret = getArrayF32FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000005: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(I16)) -> NamedExternref("Int16Array")`.
            const ret = getArrayI16FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000006: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(I32)) -> NamedExternref("Int32Array")`.
            const ret = getArrayI32FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000007: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(I8)) -> NamedExternref("Int8Array")`.
            const ret = getArrayI8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000008: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U16)) -> NamedExternref("Uint16Array")`.
            const ret = getArrayU16FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000009: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U32)) -> NamedExternref("Uint32Array")`.
            const ret = getArrayU32FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_000000000000000a: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_000000000000000b: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_000000000000000c: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./wgpu_wasm_bg.js": import0,
    };
}

function wasm_bindgen_e1691a7b45d7b08b___convert__closures_____invoke___wasm_bindgen_e1691a7b45d7b08b___JsValue__core_f4ce2b6cc8c3b44d___result__Result_____wasm_bindgen_e1691a7b45d7b08b___JsError___true_(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen_e1691a7b45d7b08b___convert__closures_____invoke___wasm_bindgen_e1691a7b45d7b08b___JsValue__core_f4ce2b6cc8c3b44d___result__Result_____wasm_bindgen_e1691a7b45d7b08b___JsError___true_(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen_e1691a7b45d7b08b___convert__closures_____invoke___js_sys_b297d463e24e6fe4___Function_fn_wasm_bindgen_e1691a7b45d7b08b___JsValue_____wasm_bindgen_e1691a7b45d7b08b___sys__Undefined___js_sys_b297d463e24e6fe4___Function_fn_wasm_bindgen_e1691a7b45d7b08b___JsValue_____wasm_bindgen_e1691a7b45d7b08b___sys__Undefined_______true_(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen_e1691a7b45d7b08b___convert__closures_____invoke___js_sys_b297d463e24e6fe4___Function_fn_wasm_bindgen_e1691a7b45d7b08b___JsValue_____wasm_bindgen_e1691a7b45d7b08b___sys__Undefined___js_sys_b297d463e24e6fe4___Function_fn_wasm_bindgen_e1691a7b45d7b08b___JsValue_____wasm_bindgen_e1691a7b45d7b08b___sys__Undefined_______true_(arg0, arg1, arg2, arg3);
}

function wasm_bindgen_e1691a7b45d7b08b___convert__closures_____invoke___alloc_864af3eab0b4f693___string__String__alloc_864af3eab0b4f693___string__String______true_(arg0, arg1, arg2, arg3) {
    const ptr0 = passStringToWasm0(arg2, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(arg3, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    wasm.wasm_bindgen_e1691a7b45d7b08b___convert__closures_____invoke___alloc_864af3eab0b4f693___string__String__alloc_864af3eab0b4f693___string__String______true_(arg0, arg1, ptr0, len0, ptr1, len1);
}

const ParsedModuleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_parsedmodule_free(ptr, 1));
const RhiWgpuAdapterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpuadapter_free(ptr, 1));
const RhiWgpuBindGroupFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpubindgroup_free(ptr, 1));
const RhiWgpuBindGroupLayoutFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpubindgrouplayout_free(ptr, 1));
const RhiWgpuBufferFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpubuffer_free(ptr, 1));
const RhiWgpuCommandBufferFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpucommandbuffer_free(ptr, 1));
const RhiWgpuCommandEncoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpucommandencoder_free(ptr, 1));
const RhiWgpuComputePipelineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpucomputepipeline_free(ptr, 1));
const RhiWgpuDeviceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpudevice_free(ptr, 1));
const RhiWgpuInstanceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpuinstance_free(ptr, 1));
const RhiWgpuPipelineLayoutFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpupipelinelayout_free(ptr, 1));
const RhiWgpuQuerySetFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpuqueryset_free(ptr, 1));
const RhiWgpuQueueFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpuqueue_free(ptr, 1));
const RhiWgpuRenderBundleEncoderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpurenderbundleencoder_free(ptr, 1));
const RhiWgpuRenderPassFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpurenderpass_free(ptr, 1));
const RhiWgpuRenderPipelineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpurenderpipeline_free(ptr, 1));
const RhiWgpuSamplerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpusampler_free(ptr, 1));
const RhiWgpuShaderModuleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpushadermodule_free(ptr, 1));
const RhiWgpuSurfaceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpusurface_free(ptr, 1));
const RhiWgpuSurfaceTextureFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgpusurfacetexture_free(ptr, 1));
const RhiWgpuTextureFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgputexture_free(ptr, 1));
const RhiWgpuTextureViewFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rhiwgputextureview_free(ptr, 1));
const ValidatedModuleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_validatedmodule_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayI16FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len);
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayI8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getArrayU16FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedInt16ArrayMemory0 = null;
function getInt16ArrayMemory0() {
    if (cachedInt16ArrayMemory0 === null || cachedInt16ArrayMemory0.byteLength === 0) {
        cachedInt16ArrayMemory0 = new Int16Array(wasm.memory.buffer);
    }
    return cachedInt16ArrayMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

let cachedInt8ArrayMemory0 = null;
function getInt8ArrayMemory0() {
    if (cachedInt8ArrayMemory0 === null || cachedInt8ArrayMemory0.byteLength === 0) {
        cachedInt8ArrayMemory0 = new Int8Array(wasm.memory.buffer);
    }
    return cachedInt8ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
    if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
        cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
    }
    return cachedUint16ArrayMemory0;
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedInt16ArrayMemory0 = null;
    cachedInt32ArrayMemory0 = null;
    cachedInt8ArrayMemory0 = null;
    cachedUint16ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('wgpu_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
