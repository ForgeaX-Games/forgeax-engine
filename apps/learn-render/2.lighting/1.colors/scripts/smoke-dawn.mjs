#!/usr/bin/env node
// apps/learn-render/2.lighting/1.colors/scripts/smoke-dawn.mjs
//
// LearnOpenGL section 2.lighting 1.colors dawn-node smoke.
// Mirrors the 7.camera smoke shape but with a static scene (no first-person
// input driving). Verdict: at least one meshed sample site exceeds the
// clear-color threshold, proving the colored cube + lamp rendered non-empty
// pixels.
//
// Output literals (preserved for grep tooling):
//   - `[learn-render-colors] backend=<backend>`
//   - `[smoke] frames observed=<N>`
//   - `[smoke] pixelSamples=<json>`

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const SMOKE_PIXEL_THRESHOLD = Number.parseFloat(process.env.SMOKE_PIXEL_THRESHOLD ?? '0.05');
const MATERIAL_RESPONSE_THRESHOLD = 0.05;
const ROUGHNESS_RESPONSE_THRESHOLD = 0.02;
const SPECULAR_TINT_RESPONSE_THRESHOLD = 0.02;
const SPECULAR_TINT_TEXTURE_RESPONSE_THRESHOLD = 0.02;
const NORMAL_TEXTURE_RESPONSE_THRESHOLD = 0.02;
const NORMAL_SCALE_RESPONSE_THRESHOLD = 0.02;
const EMISSIVE_INTENSITY_RESPONSE_THRESHOLD = 0.02;
const EMISSIVE_TEXTURE_RESPONSE_THRESHOLD = 0.02;
const BASE_COLOR_TEXTURE_RESPONSE_THRESHOLD = 0.02;
const BASE_COLOR_TEXTURE_RED_RESPONSE_THRESHOLD = 0.02;
const BASE_COLOR_TEXTURE_GREEN_RESPONSE_THRESHOLD = 0.02;
const BASE_COLOR_TEXTURE_BLUE_RESPONSE_THRESHOLD = 0.02;
const BASE_COLOR_TEXTURE_RGB_RESPONSE_THRESHOLD = 0.02;
const BASE_COLOR_TEXTURE_ALPHA_RESPONSE_THRESHOLD = 0.02;
const BASE_COLOR_TEXTURE_UV_TRANSFORM_RESPONSE_THRESHOLD = 0.02;
const BASE_COLOR_TEXTURE_UV_TRANSFORM = {
  offset: [0.25, 0.25],
  scale: [0, 0],
  rotation: 0,
};
const BASE_COLOR_TEXTURE_UV_TRANSFORM_RESPONSE = [0.0666666667, 0.0666666667, 0.0666666667];
const BASE_COLOR_TEXTURE_UV_UNTRANSFORMED_RESPONSE = [0.3333333333, 0.168627451, 0.1137254902];
const BASE_COLOR_TEXTURE_UV_SET_RESPONSE_THRESHOLD = 0.02;
const BASE_COLOR_TEXTURE_UV_SET = 1;
const BASE_COLOR_TEXTURE_UV_SET_RESPONSE = [0.5333333333, 0.2666666667, 0.168627451];
const BASE_COLOR_TEXTURE_UV_SET_UNSELECTED_RESPONSE = [0.3333333333, 0.168627451, 0.1137254902];
const BASE_COLOR_TEXTURE_RED_MIDRANGE = 128 / 255;
const BASE_COLOR_TEXTURE_RED_MIDRANGE_RESPONSE = 0.39215686;
const BASE_COLOR_TEXTURE_GREEN_MIDRANGE = 128 / 255;
const BASE_COLOR_TEXTURE_GREEN_MIDRANGE_RESPONSE = 0.19607843;
const BASE_COLOR_TEXTURE_BLUE_MIDRANGE = 128 / 255;
const BASE_COLOR_TEXTURE_BLUE_MIDRANGE_RESPONSE = 0.12941176;
const BASE_COLOR_TEXTURE_RGB_MIDRANGE = 128 / 255;
const BASE_COLOR_TEXTURE_RGB_MIDRANGE_RESPONSE = [0.39215686, 0.19607843, 0.12941176];
const BASE_COLOR_TEXTURE_ALPHA_MIDRANGE = 128 / 255;
const METALLIC_ROUGHNESS_TEXTURE_RESPONSE_THRESHOLD = 0.02;
const METALLIC_CHANNEL_RESPONSE_THRESHOLD = 0.05;
const CLEARCOAT_RESPONSE_THRESHOLD = 0.02;
const CLEARCOAT_ROUGHNESS_RESPONSE_THRESHOLD = 0.01;
const OCCLUSION_TEXTURE_RESPONSE_THRESHOLD = 0.02;
const OCCLUSION_STRENGTH_RESPONSE_THRESHOLD = 0.02;
const ALPHA_CUTOFF_RESPONSE_THRESHOLD = 0.02;
const BASE_COLOR_ALPHA_RESPONSE_THRESHOLD = 0.02;
const FALSIFY_NO_LIGHT = process.env.FALSIFY_NO_LIGHT === '1';
const FALSIFY_LIGHT_COLOR = process.env.FALSIFY_LIGHT_COLOR ?? '';
const FALSIFY_LIGHT_INTENSITY = process.env.FALSIFY_LIGHT_INTENSITY ?? '';
const FALSIFY_LIGHT_DIRECTION = process.env.FALSIFY_LIGHT_DIRECTION ?? '';
const FALSIFY_OBJECT_COLOR = process.env.FALSIFY_OBJECT_COLOR ?? '';
const FALSIFY_MATERIAL_METALLIC = process.env.FALSIFY_MATERIAL_METALLIC ?? '';
const FALSIFY_MATERIAL_ROUGHNESS = process.env.FALSIFY_MATERIAL_ROUGHNESS ?? '';
const FALSIFY_MATERIAL_EMISSIVE = process.env.FALSIFY_MATERIAL_EMISSIVE ?? '';
const FALSIFY_MATERIAL_EMISSIVE_INTENSITY =
  process.env.FALSIFY_MATERIAL_EMISSIVE_INTENSITY ?? '';
const FALSIFY_MATERIAL_SPECULAR_TINT = process.env.FALSIFY_MATERIAL_SPECULAR_TINT ?? '';
const FALSIFY_MATERIAL_SPECULAR_TINT_TEXTURE = process.env.FALSIFY_MATERIAL_SPECULAR_TINT_TEXTURE ?? '';
const FALSIFY_MATERIAL_NORMAL_TEXTURE = process.env.FALSIFY_MATERIAL_NORMAL_TEXTURE ?? '';
const FALSIFY_MATERIAL_NORMAL_SCALE = process.env.FALSIFY_MATERIAL_NORMAL_SCALE ?? '';
const FALSIFY_MATERIAL_EMISSIVE_TEXTURE = process.env.FALSIFY_MATERIAL_EMISSIVE_TEXTURE ?? '';
const FALSIFY_MATERIAL_BASE_COLOR_TEXTURE = process.env.FALSIFY_MATERIAL_BASE_COLOR_TEXTURE ?? '';
const FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED =
  process.env.FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED ?? '';
const FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN =
  process.env.FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN ?? '';
const FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE =
  process.env.FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE ?? '';
const FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB =
  process.env.FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB ?? '';
const FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM =
  process.env.FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM ?? '';
const FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET =
  process.env.FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET ?? '';
const FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA =
  process.env.FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA ?? '';
const FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE =
  process.env.FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE ?? '';
const FALSIFY_MATERIAL_METALLIC_CHANNEL = process.env.FALSIFY_MATERIAL_METALLIC_CHANNEL ?? '';
const FALSIFY_MATERIAL_CLEARCOAT = process.env.FALSIFY_MATERIAL_CLEARCOAT ?? '';
const FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS =
  process.env.FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS ?? '';
const ENABLE_MATERIAL_OCCLUSION_AMBIENT = process.env.ENABLE_MATERIAL_OCCLUSION_AMBIENT ?? '';
const FALSIFY_MATERIAL_OCCLUSION_TEXTURE = process.env.FALSIFY_MATERIAL_OCCLUSION_TEXTURE ?? '';
const FALSIFY_MATERIAL_OCCLUSION_STRENGTH = process.env.FALSIFY_MATERIAL_OCCLUSION_STRENGTH ?? '';
const FALSIFY_MATERIAL_ALPHA_CUTOFF = process.env.FALSIFY_MATERIAL_ALPHA_CUTOFF ?? '';
const FALSIFY_MATERIAL_BASE_COLOR_ALPHA = process.env.FALSIFY_MATERIAL_BASE_COLOR_ALPHA ?? '';
const lightIntensity =
  FALSIFY_LIGHT_INTENSITY === '' ? 1.0 : Number.parseFloat(FALSIFY_LIGHT_INTENSITY);
const WIDTH = 512;
const HEIGHT = 512;

if (FALSIFY_LIGHT_COLOR !== '' && FALSIFY_LIGHT_COLOR !== 'blue') {
  console.error(`[smoke] FAIL - unsupported FALSIFY_LIGHT_COLOR=${FALSIFY_LIGHT_COLOR}; expected blue`);
  process.exit(1);
}
if (!Number.isFinite(lightIntensity) || lightIntensity <= 0) {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_LIGHT_INTENSITY=${FALSIFY_LIGHT_INTENSITY}; expected a positive number`,
  );
  process.exit(1);
}
if (FALSIFY_LIGHT_INTENSITY !== '' && FALSIFY_LIGHT_INTENSITY !== '0.25') {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_LIGHT_INTENSITY=${FALSIFY_LIGHT_INTENSITY}; expected 0.25`,
  );
  process.exit(1);
}
if (FALSIFY_LIGHT_DIRECTION !== '' && FALSIFY_LIGHT_DIRECTION !== 'away') {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_LIGHT_DIRECTION=${FALSIFY_LIGHT_DIRECTION}; expected away`,
  );
  process.exit(1);
}
if (FALSIFY_OBJECT_COLOR !== '' && FALSIFY_OBJECT_COLOR !== 'green') {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_OBJECT_COLOR=${FALSIFY_OBJECT_COLOR}; expected green`,
  );
  process.exit(1);
}
if (FALSIFY_MATERIAL_METALLIC !== '' && FALSIFY_MATERIAL_METALLIC !== '1') {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_METALLIC=${FALSIFY_MATERIAL_METALLIC}; expected 1`,
  );
  process.exit(1);
}
if (FALSIFY_MATERIAL_ROUGHNESS !== '' && !['0', '1'].includes(FALSIFY_MATERIAL_ROUGHNESS)) {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_ROUGHNESS=${FALSIFY_MATERIAL_ROUGHNESS}; expected 0 or 1`,
  );
  process.exit(1);
}
if (FALSIFY_MATERIAL_EMISSIVE !== '' && FALSIFY_MATERIAL_EMISSIVE !== '1') {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_EMISSIVE=${FALSIFY_MATERIAL_EMISSIVE}; expected 1`,
  );
  process.exit(1);
}
if (FALSIFY_MATERIAL_EMISSIVE_INTENSITY !== '' && FALSIFY_MATERIAL_EMISSIVE_INTENSITY !== '0') {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_EMISSIVE_INTENSITY=${FALSIFY_MATERIAL_EMISSIVE_INTENSITY}; expected 0`,
  );
  process.exit(1);
}
if (FALSIFY_MATERIAL_SPECULAR_TINT !== '' && FALSIFY_MATERIAL_SPECULAR_TINT !== '1') {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_SPECULAR_TINT=${FALSIFY_MATERIAL_SPECULAR_TINT}; expected 1`,
  );
  process.exit(1);
}
if (
  FALSIFY_MATERIAL_SPECULAR_TINT_TEXTURE !== '' &&
  FALSIFY_MATERIAL_SPECULAR_TINT_TEXTURE !== '1'
) {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_SPECULAR_TINT_TEXTURE=${FALSIFY_MATERIAL_SPECULAR_TINT_TEXTURE}; expected 1`,
  );
  process.exit(1);
}
if (FALSIFY_MATERIAL_NORMAL_TEXTURE !== '' && FALSIFY_MATERIAL_NORMAL_TEXTURE !== '1') {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_NORMAL_TEXTURE=${FALSIFY_MATERIAL_NORMAL_TEXTURE}; expected 1`,
  );
  process.exit(1);
}
if (FALSIFY_MATERIAL_NORMAL_SCALE !== '' && FALSIFY_MATERIAL_NORMAL_SCALE !== '0') {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_NORMAL_SCALE=${FALSIFY_MATERIAL_NORMAL_SCALE}; expected 0`,
  );
  process.exit(1);
}
if (FALSIFY_MATERIAL_EMISSIVE_TEXTURE !== '' && FALSIFY_MATERIAL_EMISSIVE_TEXTURE !== '1') {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_EMISSIVE_TEXTURE=${FALSIFY_MATERIAL_EMISSIVE_TEXTURE}; expected 1`,
  );
  process.exit(1);
}
if (FALSIFY_MATERIAL_BASE_COLOR_TEXTURE !== '' && FALSIFY_MATERIAL_BASE_COLOR_TEXTURE !== '1') {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_BASE_COLOR_TEXTURE=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE}; expected 1`,
  );
  process.exit(1);
}
if (
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED !== '' &&
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED !== '0.5'
) {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED}; expected 0.5`,
  );
  process.exit(1);
}
if (
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN !== '' &&
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN !== '0.5'
) {
  console.error(
    '[smoke] FAIL - unsupported FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN=' +
      FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN +
      '; expected 0.5',
  );
  process.exit(1);
}
if (
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE !== '' &&
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE !== '0.5'
) {
  console.error(
    '[smoke] FAIL - unsupported FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE=' +
      FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE +
      '; expected 0.5',
  );
  process.exit(1);
}
if (
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB !== '' &&
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB !== '0.5'
) {
  console.error(
    '[smoke] FAIL - unsupported FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB=' +
      FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB +
      '; expected 0.5',
  );
  process.exit(1);
}
if (
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM !== '' &&
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM !== '1'
) {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM}; expected 1`,
  );
  process.exit(1);
}
if (
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET !== '' &&
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET !== '1'
) {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET}; expected 1`,
  );
  process.exit(1);
}
if (
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA !== '' &&
  !['0', '0.5'].includes(FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA)
) {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA}; expected 0 or 0.5`,
  );
  process.exit(1);
}
if (
  (FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE !== '') &&
  (FALSIFY_MATERIAL_BASE_COLOR_TEXTURE !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_ALPHA !== '' ||
    FALSIFY_MATERIAL_ALPHA_CUTOFF !== '')
) {
  console.error(
    '[smoke] FAIL - base-color texture red/green/blue controls cannot be combined with base-color texture, texture alpha, scalar alpha, or alphaCutoff controls',
  );
  process.exit(1);
}
if (
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB !== '' &&
  (FALSIFY_MATERIAL_BASE_COLOR_TEXTURE !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_ALPHA !== '' ||
    FALSIFY_MATERIAL_ALPHA_CUTOFF !== '')
) {
  console.error(
    '[smoke] FAIL - base-color texture RGB control cannot be combined with base-color texture, texture channel, texture alpha, scalar alpha, or alphaCutoff controls',
  );
  process.exit(1);
}
if (
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM !== '' &&
  (FALSIFY_MATERIAL_BASE_COLOR_TEXTURE !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_ALPHA !== '' ||
    FALSIFY_MATERIAL_ALPHA_CUTOFF !== '')
) {
  console.error(
    '[smoke] FAIL - base-color texture UV transform cannot be combined with base-color texture, channel, texture alpha, scalar alpha, or alphaCutoff controls',
  );
  process.exit(1);
}
if (
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET !== '' &&
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM !== ''
) {
  console.error(
    '[smoke] FAIL - base-color texture UV set cannot be combined with the base-color texture UV transform control',
  );
  process.exit(1);
}
if (
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED !== '' &&
  (FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE !== '')
) {
  console.error(
    '[smoke] FAIL - base-color texture red cannot be combined with another channel control; select one channel witness',
  );
  process.exit(1);
}
if (
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN !== '' &&
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE !== ''
) {
  console.error(
    '[smoke] FAIL - base-color texture green and blue controls cannot be combined; select one channel witness',
  );
  process.exit(1);
}
if (
  FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE !== '' &&
  FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE !== '1'
) {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE=${FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE}; expected 1`,
  );
  process.exit(1);
}
if (FALSIFY_MATERIAL_METALLIC_CHANNEL !== '' && !['0', '2'].includes(FALSIFY_MATERIAL_METALLIC_CHANNEL)) {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_METALLIC_CHANNEL=${FALSIFY_MATERIAL_METALLIC_CHANNEL}; expected 0 (R) or 2 (B)`,
  );
  process.exit(1);
}
if (FALSIFY_MATERIAL_METALLIC_CHANNEL !== '' && FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE !== '') {
  console.error(
    '[smoke] FAIL - FALSIFY_MATERIAL_METALLIC_CHANNEL cannot be combined with FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE because both control the same texture slot',
  );
  process.exit(1);
}
if (FALSIFY_MATERIAL_METALLIC_CHANNEL !== '' && FALSIFY_MATERIAL_METALLIC !== '') {
  console.error(
    '[smoke] FAIL - FALSIFY_MATERIAL_METALLIC_CHANNEL owns the authored metallic=1 setup and cannot be combined with FALSIFY_MATERIAL_METALLIC',
  );
  process.exit(1);
}
if (FALSIFY_MATERIAL_CLEARCOAT !== '' && FALSIFY_MATERIAL_CLEARCOAT !== '1') {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_CLEARCOAT=${FALSIFY_MATERIAL_CLEARCOAT}; expected 1`,
  );
  process.exit(1);
}
if (
  FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS !== '' &&
  FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS !== '1'
) {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS=${FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS}; expected 1`,
  );
  process.exit(1);
}
if (ENABLE_MATERIAL_OCCLUSION_AMBIENT !== '' && ENABLE_MATERIAL_OCCLUSION_AMBIENT !== '1') {
  console.error(
    `[smoke] FAIL - unsupported ENABLE_MATERIAL_OCCLUSION_AMBIENT=${ENABLE_MATERIAL_OCCLUSION_AMBIENT}; expected 1`,
  );
  process.exit(1);
}
if (FALSIFY_MATERIAL_OCCLUSION_TEXTURE !== '' && FALSIFY_MATERIAL_OCCLUSION_TEXTURE !== '1') {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_OCCLUSION_TEXTURE=${FALSIFY_MATERIAL_OCCLUSION_TEXTURE}; expected 1`,
  );
  process.exit(1);
}
if (FALSIFY_MATERIAL_OCCLUSION_STRENGTH !== '' && FALSIFY_MATERIAL_OCCLUSION_STRENGTH !== '0') {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_OCCLUSION_STRENGTH=${FALSIFY_MATERIAL_OCCLUSION_STRENGTH}; expected 0`,
  );
  process.exit(1);
}
if (FALSIFY_MATERIAL_ALPHA_CUTOFF !== '' && FALSIFY_MATERIAL_ALPHA_CUTOFF !== '1') {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_ALPHA_CUTOFF=${FALSIFY_MATERIAL_ALPHA_CUTOFF}; expected 1`,
  );
  process.exit(1);
}
if (FALSIFY_MATERIAL_BASE_COLOR_ALPHA !== '' && FALSIFY_MATERIAL_BASE_COLOR_ALPHA !== '0') {
  console.error(
    `[smoke] FAIL - unsupported FALSIFY_MATERIAL_BASE_COLOR_ALPHA=${FALSIFY_MATERIAL_BASE_COLOR_ALPHA}; expected 0`,
  );
  process.exit(1);
}
if (FALSIFY_MATERIAL_BASE_COLOR_ALPHA !== '' && FALSIFY_MATERIAL_ALPHA_CUTOFF !== '') {
  console.error(
    '[smoke] FAIL - FALSIFY_MATERIAL_BASE_COLOR_ALPHA=0 cannot be combined with FALSIFY_MATERIAL_ALPHA_CUTOFF=1',
  );
  process.exit(1);
}
if (
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA !== '' &&
  (FALSIFY_MATERIAL_BASE_COLOR_ALPHA !== '' || FALSIFY_MATERIAL_ALPHA_CUTOFF !== '')
) {
  console.error(
    '[smoke] FAIL - FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA cannot be combined with scalar base-color alpha or alphaCutoff',
  );
  process.exit(1);
}
if (
  (FALSIFY_MATERIAL_OCCLUSION_TEXTURE === '1' || FALSIFY_MATERIAL_OCCLUSION_STRENGTH !== '') &&
  ENABLE_MATERIAL_OCCLUSION_AMBIENT !== '1'
) {
  console.error(
    '[smoke] FAIL - occlusion texture/strength controls require ENABLE_MATERIAL_OCCLUSION_AMBIENT=1 so the ambient AO term is live',
  );
  process.exit(1);
}
if (FALSIFY_MATERIAL_OCCLUSION_STRENGTH !== '' && FALSIFY_MATERIAL_OCCLUSION_TEXTURE !== '1') {
  console.error(
    '[smoke] FAIL - FALSIFY_MATERIAL_OCCLUSION_STRENGTH=0 requires FALSIFY_MATERIAL_OCCLUSION_TEXTURE=1 so the scalar gates a live texture sample',
  );
  process.exit(1);
}
const materialMetallicChannel =
  FALSIFY_MATERIAL_METALLIC_CHANNEL === ''
    ? undefined
    : Number.parseInt(FALSIFY_MATERIAL_METALLIC_CHANNEL, 10);
const materialMetallic =
  FALSIFY_MATERIAL_METALLIC === '' && FALSIFY_MATERIAL_METALLIC_CHANNEL === '' ? 0.0 : 1.0;
const materialRoughness = FALSIFY_MATERIAL_ROUGHNESS === '' ? 0.5 : Number.parseFloat(FALSIFY_MATERIAL_ROUGHNESS);
const materialEmissive =
  FALSIFY_MATERIAL_EMISSIVE === '1' || FALSIFY_MATERIAL_EMISSIVE_INTENSITY !== '';
const materialSpecularTint = FALSIFY_MATERIAL_SPECULAR_TINT === '1';
const materialSpecularTintTexture = FALSIFY_MATERIAL_SPECULAR_TINT_TEXTURE === '1';
const materialNormalTexture =
  FALSIFY_MATERIAL_NORMAL_TEXTURE === '1' || FALSIFY_MATERIAL_NORMAL_SCALE !== '';
const materialEmissiveTexture = FALSIFY_MATERIAL_EMISSIVE_TEXTURE === '1';
const materialEmissiveIntensity =
  FALSIFY_MATERIAL_EMISSIVE_INTENSITY === '0'
    ? 0.0
    : materialEmissive || materialEmissiveTexture
      ? 1.0
      : undefined;
const materialBaseColorTextureAlpha = FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA !== '';
const materialBaseColorTextureAlphaByte =
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA === '0.5' ? 128 : 0;
const materialBaseColorTextureUvTransform =
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM === '1';
const materialBaseColorTextureUvSet = FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET === '1';
const materialBaseColorTexture =
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE === '1' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB !== '' ||
  materialBaseColorTextureUvTransform ||
  materialBaseColorTextureUvSet ||
  materialBaseColorTextureAlpha;
const materialMetallicRoughnessTexture =
  FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE === '1' ||
  FALSIFY_MATERIAL_METALLIC_CHANNEL !== '';
const materialClearcoat =
  FALSIFY_MATERIAL_CLEARCOAT === '1' || FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS !== '';
const materialClearcoatRoughness = FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS === '1' ? 1.0 : 0.5;
const materialOcclusionTexture = FALSIFY_MATERIAL_OCCLUSION_TEXTURE === '1';
const materialOcclusionStrength = FALSIFY_MATERIAL_OCCLUSION_STRENGTH === '0' ? 0.0 : 1.0;
const materialOcclusionAmbient = ENABLE_MATERIAL_OCCLUSION_AMBIENT === '1';
const materialAlphaCutoff = FALSIFY_MATERIAL_ALPHA_CUTOFF === '1' ? 0.5 : undefined;
const materialBaseColorAlpha =
  FALSIFY_MATERIAL_BASE_COLOR_ALPHA === '0'
    ? 0.0
    : materialAlphaCutoff === undefined
      ? 1.0
      : 0.25;

const here = dirname(fileURLToPath(import.meta.url));

// --- 1. dawn.node binding setup ---

let create;
let globals;
try {
  ({ create, globals } = await import('webgpu'));
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn.node import failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-2-lighting-1-colors' smoke",
  );
  process.exit(1);
}
Object.assign(globalThis, globals);
if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
let gpu;
try {
  gpu = create([]);
} catch (err) {
  console.error(
    `[smoke] FAIL - dawn-node create([]) failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('  hint:  on linux ensure libvulkan1 + mesa-vulkan-drivers installed');
  process.exit(1);
}
Object.defineProperty(globalThis.navigator, 'gpu', {
  value: gpu,
  configurable: true,
  writable: true,
});
// bug-20260612 dawn-only stub: pin getPreferredCanvasFormat to 'rgba8unorm' so this
// smoke harness's hardcoded rgba8unorm-srgb viewFormats stay compatible with the
// dawn-node webgpu module's actual UA preference (which is bgra8unorm). Browser
// path (test:browser project) does not run smoke-dawn.mjs; the real Channel 2
// BGRA path is exercised through the helper unmodified there.
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

let sharedDevice;
const originalAmbientRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
  globalThis.navigator.gpu,
);
globalThis.navigator.gpu.requestAdapter = async (opts) => {
  const rawAdapter = await originalAmbientRequestAdapter(opts);
  if (rawAdapter === null) return rawAdapter;
  const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
  rawAdapter.requestDevice = async (desc) => {
    const dev = await originalRequestDevice(desc);
    if (!sharedDevice) sharedDevice = dev;
    return dev;
  };
  return rawAdapter;
};

// --- 2. Mock canvas with offscreen render target ---

let renderTarget;
function ensureRenderTarget(device, format) {
  if (renderTarget) return renderTarget;
  renderTarget = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format,
    usage: 0x10 | 0x01,
    viewFormats: ['rgba8unorm-srgb'],
  });
  return renderTarget;
}

const mockCanvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(desc) {
        ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
      },
      unconfigure() {},
      getCurrentTexture() {
        if (!renderTarget) {
          if (!sharedDevice) throw new Error('no shared device captured');
          ensureRenderTarget(sharedDevice, 'rgba8unorm');
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

// --- 3. Build engine shader manifest for pbr + unlit pipelines ---

const { World } = await import('@forgeax/engine-ecs');
const { Camera, DirectionalLight, MeshFilter, MeshRenderer, Skylight } = await import('@forgeax/engine-render');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { Materials } = await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const { unwrapHandle } = await import('@forgeax/engine-types');
const { HANDLE_CUBE, resolveAssetHandle } = await import('@forgeax/engine-assets-runtime');

const { buildEngineShaderManifest } = await import(
  '@forgeax/engine-vite-plugin-shader'
);
const ENGINE_MANIFEST = await buildEngineShaderManifest();
const MANIFEST_URL = `data:application/json,${encodeURIComponent(JSON.stringify(ENGINE_MANIFEST))}`;

// --- 4. Create renderer and scene ---

let renderer;
try {
  renderer = await createRenderer(mockCanvas, {}, { shaderManifestUrl: MANIFEST_URL });
} catch (err) {
  console.error(
    `[smoke] FAIL - createRenderer threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
} finally {
  globalThis.navigator.gpu.requestAdapter = originalAmbientRequestAdapter;
}

console.log(`[learn-render-colors] backend=${renderer.backend}`);

const assets = renderer.assets;
if (!assets) {
  console.error('[smoke] FAIL - AssetRegistry is null (renderer construction did not complete successfully)');
  process.exit(1);
}

const errors = [];
renderer.onError((err) => errors.push({ code: err.code, hint: err.hint }));

const ready = await renderer.ready;
if (!ready.ok) {
  console.error(`[smoke] FAIL - renderer.ready failed: ${ready.error.code} - ${ready.error.hint}`);
  process.exit(1);
}

const world = new World();

// Bind a real producer-owned TextureAsset to the same Standard PBR material.
// A black linear texel makes an ignored specularTintTexture distinguishable from
// the default white texture at the fixed cubeCenter ROI.
const specularTintTextureHandle = materialSpecularTintTexture
  ? unwrapHandle(
      world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        width: 1,
        height: 1,
        format: 'rgba8unorm',
        data: new Uint8Array([0, 0, 0, 255]),
        colorSpace: 'linear',
        mipmap: false,
      }),
    )
  : undefined;
const normalTextureHandle = materialNormalTexture
  ? unwrapHandle(
      world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        width: 1,
        height: 1,
        format: 'rgba8unorm',
        data: new Uint8Array([255, 128, 255, 255]),
        colorSpace: 'linear',
        mipmap: false,
      }),
    )
  : undefined;
const emissiveTextureHandle = materialEmissiveTexture
  ? unwrapHandle(
      world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        width: 1,
        height: 1,
        format: 'rgba8unorm',
        data: new Uint8Array([0, 0, 0, 255]),
        colorSpace: 'linear',
        mipmap: false,
      }),
    )
  : undefined;
const baseColorTextureHandle = materialBaseColorTexture
  ? unwrapHandle(
      world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        width: materialBaseColorTextureUvTransform || materialBaseColorTextureUvSet ? 2 : 1,
        height: materialBaseColorTextureUvTransform || materialBaseColorTextureUvSet ? 2 : 1,
        format: 'rgba8unorm',
        data: materialBaseColorTextureUvTransform || materialBaseColorTextureUvSet
          ? new Uint8Array([
              0, 0, 0, 255,
              255, 255, 255, 255,
              255, 255, 255, 255,
              255, 255, 255, 255,
            ])
          : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB === '0.5'
            ? new Uint8Array([128, 128, 128, 255])
            : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED === '0.5'
              ? new Uint8Array([128, 255, 255, 255])
              : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN === '0.5'
                ? new Uint8Array([255, 128, 255, 255])
                : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE === '0.5'
                  ? new Uint8Array([255, 255, 128, 255])
                  : materialBaseColorTextureAlpha
                    ? new Uint8Array([255, 255, 255, materialBaseColorTextureAlphaByte])
                    : new Uint8Array([0, 0, 0, 255]),
        colorSpace: 'linear',
        mipmap: false,
      }),
    )
  : undefined;
const metallicRoughnessTextureHandle = materialMetallicRoughnessTexture
  ? unwrapHandle(
      world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        width: 1,
        height: 1,
        format: 'rgba8unorm',
        data:
          FALSIFY_MATERIAL_METALLIC_CHANNEL === ''
            ? new Uint8Array([0, 0, 0, 255])
            : new Uint8Array([255, 255, 0, 255]),
        colorSpace: 'linear',
        mipmap: false,
      }),
    )
  : undefined;
const occlusionTextureHandle = materialOcclusionTexture
  ? unwrapHandle(
      world.allocSharedRef('TextureAsset', {
        kind: 'texture',
        width: 1,
        height: 1,
        format: 'rgba8unorm',
        data: new Uint8Array([0, 0, 0, 255]),
        colorSpace: 'linear',
        mipmap: false,
      }),
    )
  : undefined;

// Mint material column handles (mirrors src/index.ts scene setup; M8 D-17).
const objectMatHandle = world.allocSharedRef(
  'MaterialAsset',
  Materials.standard({
    baseColor:
      FALSIFY_OBJECT_COLOR === 'green'
        ? [0.1, 1.0, 0.1, materialBaseColorAlpha]
        : [1.0, 0.5, 0.31, materialBaseColorAlpha],
    baseColorTexture: materialBaseColorTextureUvTransform || materialBaseColorTextureUvSet
      ? {
          texture: baseColorTextureHandle,
          coordinates: materialBaseColorTextureUvTransform
            ? {
                transform: BASE_COLOR_TEXTURE_UV_TRANSFORM,
              }
            : { set: BASE_COLOR_TEXTURE_UV_SET },
        }
      : baseColorTextureHandle,
    metallicRoughnessTexture: metallicRoughnessTextureHandle,
    metallic: materialMetallic,
    metallicChannel: materialMetallicChannel,
    roughness: materialRoughness,
    clearcoat: materialClearcoat ? 1.0 : undefined,
    clearcoatRoughness: materialClearcoat ? materialClearcoatRoughness : undefined,
    occlusionStrength: materialOcclusionAmbient ? materialOcclusionStrength : undefined,
    alphaCutoff: materialAlphaCutoff,
    emissive: materialEmissive || materialEmissiveTexture ? [1.0, 0.1, 0.1] : undefined,
    emissiveIntensity: materialEmissive || materialEmissiveTexture ? materialEmissiveIntensity : undefined,
    specularTint: materialSpecularTint ? [1.0, 0.0, 0.0] : undefined,
    specularTintTexture: specularTintTextureHandle,
    normalTexture:
      FALSIFY_MATERIAL_NORMAL_SCALE === ''
        ? normalTextureHandle
        : { texture: normalTextureHandle, normalScale: 0.0 },
    emissiveTexture: emissiveTextureHandle,
    occlusionTexture: occlusionTextureHandle,
  }),
);
const lampMatHandle = world.allocSharedRef('MaterialAsset', Materials.unlit([1.0, 1.0, 1.0, 1.0]));

const directionalLightColor =
  FALSIFY_LIGHT_COLOR === 'blue' ? [0.05, 0.05, 1.0] : [1.0, 1.0, 1.0];

const cubeAssetRes = resolveAssetHandle(world, HANDLE_CUBE);
if (!cubeAssetRes.ok) {
  console.error(`[smoke] FAIL - HANDLE_CUBE asset unavailable: ${cubeAssetRes.error.code}`);
  process.exit(1);
}
const cubeAsset = cubeAssetRes.value;
const cubeVertexCount = cubeAsset.attributes.position
  ? cubeAsset.attributes.position.length / 3
  : 0;
const cubeBaseStride = cubeVertexCount > 0 ? cubeAsset.vertices.length / cubeVertexCount : 0;
if (cubeVertexCount === 0 || cubeBaseStride !== 12) {
  console.error(
    `[smoke] FAIL - HANDLE_CUBE expected position data and 12-float base stride; vertexCount=${cubeVertexCount} stride=${cubeBaseStride}`,
  );
  process.exit(1);
}
const multiUvCubeVertices = new Float32Array(cubeVertexCount * (cubeBaseStride + 2));
const multiUvCubeUv1 = new Float32Array(cubeVertexCount * 2);
for (let i = 0; i < cubeVertexCount; i++) {
  const sourceOffset = i * cubeBaseStride;
  const targetOffset = i * (cubeBaseStride + 2);
  multiUvCubeVertices.set(
    cubeAsset.vertices.subarray(sourceOffset, sourceOffset + cubeBaseStride),
    targetOffset,
  );
  multiUvCubeVertices[targetOffset + cubeBaseStride] = 0.75;
  multiUvCubeVertices[targetOffset + cubeBaseStride + 1] = 0.75;
  multiUvCubeUv1[i * 2] = 0.75;
  multiUvCubeUv1[i * 2 + 1] = 0.75;
}
const multiUvCubeAttributes = {
  position: new Float32Array(cubeAsset.attributes.position),
  normal: new Float32Array(cubeAsset.attributes.normal),
  uv: new Float32Array(cubeAsset.attributes.uv),
  tangent: new Float32Array(cubeAsset.attributes.tangent),
  uv1: multiUvCubeUv1,
};
const multiUvCubeAsset = {
  ...cubeAsset,
  vertices: multiUvCubeVertices,
  attributes: multiUvCubeAttributes,
  aabb: new Float32Array(cubeAsset.aabb),
};
const multiUvCubeHandle = world.allocSharedRef('MeshAsset', multiUvCubeAsset);
const objectMeshHandle =
  materialBaseColorTextureUvSet ? multiUvCubeHandle : HANDLE_CUBE;

// Spawn colored cube at origin.
world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    { component: MeshFilter, data: { assetHandle: objectMeshHandle } },
    { component: MeshRenderer, data: { materials: [objectMatHandle] } },
  )
  .unwrap();

// Light direction: from lamp position (1.2, 1.0, 2.0) toward origin.
const LPX = 1.2, LPY = 1.0, LPZ = 2.0;
const ldLen = Math.sqrt(LPX * LPX + LPY * LPY + LPZ * LPZ);
const ldX = -LPX / ldLen;
const ldY = -LPY / ldLen;
const ldZ = -LPZ / ldLen;
const directionalLightDirection =
  FALSIFY_LIGHT_DIRECTION === 'away' ? [-ldX, -ldY, -ldZ] : [ldX, ldY, ldZ];

if (materialOcclusionAmbient) {
  world.spawn({
    component: Skylight,
    data: { color: [0.1, 0.1, 0.1], intensity: 1.0 },
  });
  console.log('[smoke] materialOcclusionAmbient=solid-gray');
}

// Spawn lamp cube (small white unlit marker).
world
  .spawn(
    {
      component: Transform,
      data: {
        pos: [LPX, LPY, LPZ], quat: [0, 0, 0, 1], scale: [0.2, 0.2, 0.2],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [lampMatHandle] } },
  )
  .unwrap();

// Spawn directional light unless the negative control intentionally removes
// the producer-owned detail under test.
if (!FALSIFY_NO_LIGHT) {
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: directionalLightDirection,
      color: directionalLightColor,
      intensity: lightIntensity,
    },
  });
if (FALSIFY_LIGHT_COLOR !== '') {
  console.log(`[smoke] FALSIFY_LIGHT_COLOR=${FALSIFY_LIGHT_COLOR}`);
}
if (FALSIFY_LIGHT_INTENSITY !== '') {
  console.log(`[smoke] FALSIFY_LIGHT_INTENSITY=${FALSIFY_LIGHT_INTENSITY}`);
}
if (FALSIFY_LIGHT_DIRECTION !== '') {
  console.log(`[smoke] FALSIFY_LIGHT_DIRECTION=${FALSIFY_LIGHT_DIRECTION}`);
}
if (FALSIFY_OBJECT_COLOR !== '') {
  console.log(`[smoke] FALSIFY_OBJECT_COLOR=${FALSIFY_OBJECT_COLOR}`);
}
if (FALSIFY_MATERIAL_METALLIC !== '') {
  console.log(`[smoke] FALSIFY_MATERIAL_METALLIC=${FALSIFY_MATERIAL_METALLIC}`);
}
if (FALSIFY_MATERIAL_METALLIC_CHANNEL !== '') {
  console.log(`[smoke] FALSIFY_MATERIAL_METALLIC_CHANNEL=${FALSIFY_MATERIAL_METALLIC_CHANNEL}`);
}
if (FALSIFY_MATERIAL_ROUGHNESS !== '') {
  console.log(`[smoke] FALSIFY_MATERIAL_ROUGHNESS=${FALSIFY_MATERIAL_ROUGHNESS}`);
}
if (FALSIFY_MATERIAL_EMISSIVE !== '') {
  console.log(`[smoke] FALSIFY_MATERIAL_EMISSIVE=${FALSIFY_MATERIAL_EMISSIVE}`);
}
if (FALSIFY_MATERIAL_EMISSIVE_INTENSITY !== '') {
  console.log(
    `[smoke] FALSIFY_MATERIAL_EMISSIVE_INTENSITY=${FALSIFY_MATERIAL_EMISSIVE_INTENSITY}`,
  );
}
if (FALSIFY_MATERIAL_SPECULAR_TINT !== '') {
  console.log(`[smoke] FALSIFY_MATERIAL_SPECULAR_TINT=${FALSIFY_MATERIAL_SPECULAR_TINT}`);
}
if (FALSIFY_MATERIAL_SPECULAR_TINT_TEXTURE !== '') {
  console.log(
    `[smoke] FALSIFY_MATERIAL_SPECULAR_TINT_TEXTURE=${FALSIFY_MATERIAL_SPECULAR_TINT_TEXTURE}`,
  );
}
if (FALSIFY_MATERIAL_NORMAL_TEXTURE !== '') {
  console.log(`[smoke] FALSIFY_MATERIAL_NORMAL_TEXTURE=${FALSIFY_MATERIAL_NORMAL_TEXTURE}`);
}
if (FALSIFY_MATERIAL_NORMAL_SCALE !== '') {
  console.log(`[smoke] FALSIFY_MATERIAL_NORMAL_SCALE=${FALSIFY_MATERIAL_NORMAL_SCALE}`);
}
if (FALSIFY_MATERIAL_EMISSIVE_TEXTURE !== '') {
  console.log(`[smoke] FALSIFY_MATERIAL_EMISSIVE_TEXTURE=${FALSIFY_MATERIAL_EMISSIVE_TEXTURE}`);
}
if (FALSIFY_MATERIAL_BASE_COLOR_TEXTURE !== '') {
  console.log(`[smoke] FALSIFY_MATERIAL_BASE_COLOR_TEXTURE=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE}`);
}
if (FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA !== '') {
  console.log(
    `[smoke] FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA}`,
  );
}
if (FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM !== '') {
  console.log(
    `[smoke] FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM}`,
  );
}
if (FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET !== '') {
  console.log(
    `[smoke] FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET}`,
  );
}
if (FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE !== '') {
  console.log(
    `[smoke] FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE=${FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE}`,
  );
}
if (FALSIFY_MATERIAL_CLEARCOAT !== '') {
  console.log(`[smoke] FALSIFY_MATERIAL_CLEARCOAT=${FALSIFY_MATERIAL_CLEARCOAT}`);
}
if (FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS !== '') {
  console.log(
    `[smoke] FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS=${FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS}`,
  );
}
if (ENABLE_MATERIAL_OCCLUSION_AMBIENT !== '') {
  console.log(`[smoke] ENABLE_MATERIAL_OCCLUSION_AMBIENT=${ENABLE_MATERIAL_OCCLUSION_AMBIENT}`);
}
if (FALSIFY_MATERIAL_OCCLUSION_TEXTURE !== '') {
  console.log(`[smoke] FALSIFY_MATERIAL_OCCLUSION_TEXTURE=${FALSIFY_MATERIAL_OCCLUSION_TEXTURE}`);
}
if (FALSIFY_MATERIAL_OCCLUSION_STRENGTH !== '') {
  console.log(
    `[smoke] FALSIFY_MATERIAL_OCCLUSION_STRENGTH=${FALSIFY_MATERIAL_OCCLUSION_STRENGTH}`,
  );
}
if (FALSIFY_MATERIAL_BASE_COLOR_ALPHA !== '') {
  console.log(`[smoke] FALSIFY_MATERIAL_BASE_COLOR_ALPHA=${FALSIFY_MATERIAL_BASE_COLOR_ALPHA}`);
}
}

// Spawn static camera (LO 1.colors: Camera(0,0,3) Zoom=45 deg).
world.spawn(
  {
    component: Transform,
    data: {
      pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
  },
  {
    component: Camera,
    data: { fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 },
  },
);

// --- 5. Draw frames ---

const frameStart = Date.now();
let framesObserved = 0;
const TARGET_FRAMES = SMOKE_MIN_FRAMES;
for (let i = 0; i < TARGET_FRAMES; i++) {
  world.update(1 / 60).unwrap();
  const r = renderer.draw([world], { owner: 0 });
  if (!r.ok) console.error(`[smoke] draw frame ${i} error: ${r.error.code}`);
  framesObserved++;
}
const device = sharedDevice;
if (!device) {
  console.error('[smoke] FAIL - no shared device captured for readback');
  process.exit(1);
}
await device.queue.onSubmittedWorkDone();
const frameWall = Date.now() - frameStart;
console.log(
  `[smoke] frames observed=${framesObserved} (wall=${frameWall}ms, target=${TARGET_FRAMES})`,
);

// --- 6. Pixel readback ---

if (!renderTarget) {
  console.error('[smoke] FAIL - renderTarget never allocated');
  process.exit(1);
}
const bytesPerPixel = 4;
const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
const readbackBuffer = device.createBuffer({
  size: bytesPerRow * HEIGHT,
  usage: 0x01 | 0x08,
});
{
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
}
try {
  await readbackBuffer.mapAsync(0x01);
} catch (err) {
  console.error(
    `[smoke] FAIL - mapAsync rejected: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
const mapped = readbackBuffer.getMappedRange();
const bytes = new Uint8Array(mapped.slice(0));
readbackBuffer.unmap();
readbackBuffer.destroy();

let nonBlackPixelCount = 0;
for (let py = 0; py < HEIGHT; py++) {
  const row = py * bytesPerRow;
  for (let px = 0; px < WIDTH; px++) {
    const off = row + px * bytesPerPixel;
    if ((bytes[off] ?? 0) > 0 || (bytes[off + 1] ?? 0) > 0 || (bytes[off + 2] ?? 0) > 0) {
      nonBlackPixelCount++;
    }
  }
}

const readRgba = (px, py) => {
  const off = py * bytesPerRow + px * bytesPerPixel;
  const r = (bytes[off + 0] ?? 0) / 255;
  const g = (bytes[off + 1] ?? 0) / 255;
  const b = (bytes[off + 2] ?? 0) / 255;
  const a = (bytes[off + 3] ?? 0) / 255;
  return [r, g, b, a];
};
const sites = [
  { name: 'ndcCenter', x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) },
  { name: 'lampRegion', x: Math.floor(WIDTH * 0.6), y: Math.floor(HEIGHT * 0.45) },
  { name: 'cubeCenter', x: Math.floor(WIDTH * 0.4), y: Math.floor(HEIGHT * 0.55) },
  { name: 'cornerTL', x: Math.floor(WIDTH * 0.05), y: Math.floor(HEIGHT * 0.05) },
  { name: 'cornerBR', x: Math.floor(WIDTH * 0.95), y: Math.floor(HEIGHT * 0.95) },
];
const pixelSamples = {};
for (const s of sites) pixelSamples[s.name] = readRgba(s.x, s.y);
console.log(`[smoke] pixelSamples=${JSON.stringify(pixelSamples)}`);
console.log(`[smoke] nonBlackPixelCount=${nonBlackPixelCount}`);

// --- 7. Verdict ---

const distance = (a, b) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const CLEAR_COLOR = [0.1, 0.1, 0.1];
const DISCARD_COLOR = [0, 0, 0];
const meshSiteNames = ['ndcCenter', 'cubeCenter', 'lampRegion'];
const cubeCenter = pixelSamples.cubeCenter;
const materialResponseBaseline =
  FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS !== ''
    ? [0.5411765, 0.2784314, 0.1921569]
    : materialOcclusionAmbient
    ? [0.6235294, 0.3176471, 0.2078431]
    : [0.5333333, 0.2666667, 0.16862745];
const materialResponseDistance = distance(cubeCenter, materialResponseBaseline);
const materialDefaultResponseBaseline = materialOcclusionAmbient
  ? [0.6235294, 0.3176471, 0.2078431]
  : [0.5333333, 0.2666667, 0.16862745];
const materialDefaultResponseDistance = distance(cubeCenter, materialDefaultResponseBaseline);
const materialAlphaResponseDistance = Math.abs(cubeCenter[3] - 1.0);
const materialBaseColorTextureAlphaExpected =
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA === '0.5'
    ? BASE_COLOR_TEXTURE_ALPHA_MIDRANGE
    : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA === '0'
      ? 0.0
      : 1.0;
const materialBaseColorTextureAlphaResponseDistance = Math.abs(
  cubeCenter[3] - materialBaseColorTextureAlphaExpected,
);
const materialBaseColorTextureRedExpected =
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED === '0.5'
    ? BASE_COLOR_TEXTURE_RED_MIDRANGE_RESPONSE
    : materialDefaultResponseBaseline[0];
const materialBaseColorTextureRedInput =
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED === '0.5'
    ? BASE_COLOR_TEXTURE_RED_MIDRANGE
    : 1.0;
const materialBaseColorTextureRedResponseDistance = Math.abs(
  cubeCenter[0] - materialBaseColorTextureRedExpected,
);
const materialBaseColorTextureRedPreservedDistance = Math.max(
  Math.abs(cubeCenter[1] - materialDefaultResponseBaseline[1]),
  Math.abs(cubeCenter[2] - materialDefaultResponseBaseline[2]),
  Math.abs(cubeCenter[3] - 1.0),
);
const materialBaseColorTextureGreenExpected =
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN === '0.5'
    ? BASE_COLOR_TEXTURE_GREEN_MIDRANGE_RESPONSE
    : materialDefaultResponseBaseline[1];
const materialBaseColorTextureGreenInput =
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN === '0.5'
    ? BASE_COLOR_TEXTURE_GREEN_MIDRANGE
    : 1.0;
const materialBaseColorTextureGreenResponseDistance = Math.abs(
  cubeCenter[1] - materialBaseColorTextureGreenExpected,
);
const materialBaseColorTextureGreenPreservedDistance = Math.max(
  Math.abs(cubeCenter[0] - materialDefaultResponseBaseline[0]),
  Math.abs(cubeCenter[2] - materialDefaultResponseBaseline[2]),
  Math.abs(cubeCenter[3] - 1.0),
);
const materialBaseColorTextureBlueExpected =
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE === '0.5'
    ? BASE_COLOR_TEXTURE_BLUE_MIDRANGE_RESPONSE
    : materialDefaultResponseBaseline[2];
const materialBaseColorTextureBlueInput =
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE === '0.5'
    ? BASE_COLOR_TEXTURE_BLUE_MIDRANGE
    : 1.0;
const materialBaseColorTextureBlueResponseDistance = Math.abs(
  cubeCenter[2] - materialBaseColorTextureBlueExpected,
);
const materialBaseColorTextureBluePreservedDistance = Math.max(
  Math.abs(cubeCenter[0] - materialDefaultResponseBaseline[0]),
  Math.abs(cubeCenter[1] - materialDefaultResponseBaseline[1]),
  Math.abs(cubeCenter[3] - 1.0),
);
const materialBaseColorTextureRgbExpected =
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB === '0.5'
    ? BASE_COLOR_TEXTURE_RGB_MIDRANGE_RESPONSE
    : materialDefaultResponseBaseline;
const materialBaseColorTextureRgbInput =
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB === '0.5' ? BASE_COLOR_TEXTURE_RGB_MIDRANGE : 1.0;
const materialBaseColorTextureRgbResponseDistance = Math.max(
  Math.abs(cubeCenter[0] - materialBaseColorTextureRgbExpected[0]),
  Math.abs(cubeCenter[1] - materialBaseColorTextureRgbExpected[1]),
  Math.abs(cubeCenter[2] - materialBaseColorTextureRgbExpected[2]),
);
const materialBaseColorTextureRgbPreservedDistance = Math.abs(cubeCenter[3] - 1.0);
const materialBaseColorTextureUvTransformExpected = [
  ...BASE_COLOR_TEXTURE_UV_TRANSFORM_RESPONSE,
];
const materialBaseColorTextureUvTransformResponseDistance = Math.max(
  Math.abs(cubeCenter[0] - materialBaseColorTextureUvTransformExpected[0]),
  Math.abs(cubeCenter[1] - materialBaseColorTextureUvTransformExpected[1]),
  Math.abs(cubeCenter[2] - materialBaseColorTextureUvTransformExpected[2]),
);
const materialBaseColorTextureUvTransformBaselineDistance = distance(
  cubeCenter,
  BASE_COLOR_TEXTURE_UV_UNTRANSFORMED_RESPONSE,
);
const materialBaseColorTextureUvSetExpected = [...BASE_COLOR_TEXTURE_UV_SET_RESPONSE];
const materialBaseColorTextureUvSetResponseDistance = Math.max(
  Math.abs(cubeCenter[0] - materialBaseColorTextureUvSetExpected[0]),
  Math.abs(cubeCenter[1] - materialBaseColorTextureUvSetExpected[1]),
  Math.abs(cubeCenter[2] - materialBaseColorTextureUvSetExpected[2]),
);
const materialBaseColorTextureUvSetBaselineDistance = distance(
  cubeCenter,
  BASE_COLOR_TEXTURE_UV_SET_UNSELECTED_RESPONSE,
);
const colorLightWitness =
  FALSIFY_OBJECT_COLOR !== '' ||
  FALSIFY_MATERIAL_METALLIC !== '' ||
  FALSIFY_MATERIAL_METALLIC_CHANNEL !== '' ||
  FALSIFY_MATERIAL_ROUGHNESS !== '' ||
  FALSIFY_MATERIAL_EMISSIVE !== '' ||
  FALSIFY_MATERIAL_EMISSIVE_INTENSITY !== '' ||
  FALSIFY_MATERIAL_SPECULAR_TINT !== '' ||
  FALSIFY_MATERIAL_SPECULAR_TINT_TEXTURE !== '' ||
  FALSIFY_MATERIAL_NORMAL_TEXTURE !== '' ||
  FALSIFY_MATERIAL_NORMAL_SCALE !== '' ||
  FALSIFY_MATERIAL_EMISSIVE_TEXTURE !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA !== '' ||
  FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE !== '' ||
  FALSIFY_MATERIAL_CLEARCOAT !== '' ||
  FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS !== '' ||
  FALSIFY_MATERIAL_OCCLUSION_TEXTURE !== '' ||
  FALSIFY_MATERIAL_OCCLUSION_STRENGTH !== '' ||
  FALSIFY_MATERIAL_ALPHA_CUTOFF !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_ALPHA !== '' ||
  FALSIFY_MATERIAL_OCCLUSION_STRENGTH !== ''
    ? true
    : FALSIFY_LIGHT_COLOR === 'blue'
    ? cubeCenter[2] > cubeCenter[0] * 1.25 && cubeCenter[2] > cubeCenter[1] * 3
    : cubeCenter[0] > 0.25 &&
      cubeCenter[1] > 0.1 &&
      cubeCenter[2] > 0.05 &&
      cubeCenter[0] > cubeCenter[1] * 1.6 &&
      cubeCenter[1] > cubeCenter[2] * 1.2;
const objectColorWitness =
  FALSIFY_OBJECT_COLOR === '' ||
  (cubeCenter[1] > cubeCenter[0] * 1.4 && cubeCenter[1] > cubeCenter[2] * 1.4);
const intensityLightWitness =
  FALSIFY_OBJECT_COLOR !== '' ||
  FALSIFY_MATERIAL_METALLIC !== '' ||
  FALSIFY_MATERIAL_METALLIC_CHANNEL !== '' ||
  FALSIFY_MATERIAL_ROUGHNESS !== '' ||
  FALSIFY_MATERIAL_EMISSIVE !== '' ||
  FALSIFY_MATERIAL_EMISSIVE_INTENSITY !== '' ||
  FALSIFY_MATERIAL_SPECULAR_TINT !== '' ||
  FALSIFY_MATERIAL_SPECULAR_TINT_TEXTURE !== '' ||
  FALSIFY_MATERIAL_NORMAL_TEXTURE !== '' ||
  FALSIFY_MATERIAL_NORMAL_SCALE !== '' ||
  FALSIFY_MATERIAL_EMISSIVE_TEXTURE !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA !== '' ||
  FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE !== '' ||
  FALSIFY_MATERIAL_CLEARCOAT !== '' ||
  FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS !== '' ||
  FALSIFY_MATERIAL_OCCLUSION_TEXTURE !== '' ||
  FALSIFY_MATERIAL_OCCLUSION_STRENGTH !== '' ||
  FALSIFY_MATERIAL_ALPHA_CUTOFF !== '' ||
  FALSIFY_MATERIAL_BASE_COLOR_ALPHA !== '' ||
  FALSIFY_LIGHT_INTENSITY === '' ||
  (colorLightWitness && cubeCenter[0] > 0.2 && cubeCenter[0] < 0.4);
const directionLightWitness =
  FALSIFY_LIGHT_DIRECTION === '' ||
  (cubeCenter[0] < 0.05 && cubeCenter[1] < 0.05 && cubeCenter[2] < 0.05);
const noMaterialControl =
  FALSIFY_MATERIAL_METALLIC === '' &&
  FALSIFY_MATERIAL_METALLIC_CHANNEL === '' &&
  FALSIFY_MATERIAL_ROUGHNESS === '' &&
  FALSIFY_MATERIAL_EMISSIVE === '' &&
  FALSIFY_MATERIAL_EMISSIVE_INTENSITY === '' &&
  FALSIFY_MATERIAL_SPECULAR_TINT === '' &&
  FALSIFY_MATERIAL_SPECULAR_TINT_TEXTURE === '' &&
  FALSIFY_MATERIAL_NORMAL_TEXTURE === '' &&
  FALSIFY_MATERIAL_NORMAL_SCALE === '' &&
  FALSIFY_MATERIAL_EMISSIVE_TEXTURE === '' &&
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE === '' &&
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED === '' &&
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN === '' &&
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE === '' &&
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB === '' &&
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM === '' &&
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET === '' &&
  FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA === '' &&
  FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE === '' &&
  FALSIFY_MATERIAL_CLEARCOAT === '' &&
  FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS === '' &&
  FALSIFY_MATERIAL_OCCLUSION_TEXTURE === '' &&
  FALSIFY_MATERIAL_OCCLUSION_STRENGTH === '' &&
  FALSIFY_MATERIAL_ALPHA_CUTOFF === '' &&
  FALSIFY_MATERIAL_BASE_COLOR_ALPHA === '';
const materialWitness = noMaterialControl
  ? true
  : FALSIFY_MATERIAL_METALLIC_CHANNEL !== ''
    ? FALSIFY_MATERIAL_METALLIC_CHANNEL === '0'
      ? materialDefaultResponseDistance > METALLIC_CHANNEL_RESPONSE_THRESHOLD
      : materialDefaultResponseDistance <= METALLIC_CHANNEL_RESPONSE_THRESHOLD
  : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED !== ''
    ? materialBaseColorTextureRedResponseDistance <=
        BASE_COLOR_TEXTURE_RED_RESPONSE_THRESHOLD &&
      materialBaseColorTextureRedPreservedDistance <=
        BASE_COLOR_TEXTURE_RED_RESPONSE_THRESHOLD
  : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN !== ''
    ? materialBaseColorTextureGreenResponseDistance <=
        BASE_COLOR_TEXTURE_GREEN_RESPONSE_THRESHOLD &&
      materialBaseColorTextureGreenPreservedDistance <=
        BASE_COLOR_TEXTURE_GREEN_RESPONSE_THRESHOLD
  : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE !== ''
    ? materialBaseColorTextureBlueResponseDistance <=
        BASE_COLOR_TEXTURE_BLUE_RESPONSE_THRESHOLD &&
      materialBaseColorTextureBluePreservedDistance <=
        BASE_COLOR_TEXTURE_BLUE_RESPONSE_THRESHOLD
  : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB !== ''
    ? materialBaseColorTextureRgbResponseDistance <= BASE_COLOR_TEXTURE_RGB_RESPONSE_THRESHOLD &&
      materialBaseColorTextureRgbPreservedDistance <= BASE_COLOR_TEXTURE_RGB_RESPONSE_THRESHOLD
  : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM !== ''
    ? materialBaseColorTextureUvTransformResponseDistance <=
        BASE_COLOR_TEXTURE_UV_TRANSFORM_RESPONSE_THRESHOLD &&
      materialBaseColorTextureUvTransformBaselineDistance >
        BASE_COLOR_TEXTURE_UV_TRANSFORM_RESPONSE_THRESHOLD
  : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET !== ''
    ? materialBaseColorTextureUvSetResponseDistance <=
        BASE_COLOR_TEXTURE_UV_SET_RESPONSE_THRESHOLD &&
      materialBaseColorTextureUvSetBaselineDistance >
        BASE_COLOR_TEXTURE_UV_SET_RESPONSE_THRESHOLD
  : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA !== ''
    ? materialBaseColorTextureAlphaResponseDistance <= BASE_COLOR_TEXTURE_ALPHA_RESPONSE_THRESHOLD
    : FALSIFY_MATERIAL_BASE_COLOR_ALPHA !== ''
    ? materialAlphaResponseDistance >= 1.0 - BASE_COLOR_ALPHA_RESPONSE_THRESHOLD
    : FALSIFY_MATERIAL_ALPHA_CUTOFF !== ''
    ? distance(cubeCenter, DISCARD_COLOR) <= ALPHA_CUTOFF_RESPONSE_THRESHOLD
    : FALSIFY_MATERIAL_OCCLUSION_STRENGTH !== ''
    ? materialResponseDistance <= OCCLUSION_STRENGTH_RESPONSE_THRESHOLD
    : FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS !== ''
      ? materialResponseDistance > CLEARCOAT_ROUGHNESS_RESPONSE_THRESHOLD &&
        materialDefaultResponseDistance > CLEARCOAT_ROUGHNESS_RESPONSE_THRESHOLD
    : FALSIFY_MATERIAL_NORMAL_SCALE !== ''
      ? materialResponseDistance <= NORMAL_SCALE_RESPONSE_THRESHOLD
    : FALSIFY_MATERIAL_EMISSIVE_INTENSITY !== ''
      ? materialResponseDistance <= EMISSIVE_INTENSITY_RESPONSE_THRESHOLD
    : FALSIFY_MATERIAL_EMISSIVE_TEXTURE !== ''
      ? materialResponseDistance <= EMISSIVE_TEXTURE_RESPONSE_THRESHOLD
      : materialResponseDistance >
        (FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS !== ''
          ? CLEARCOAT_ROUGHNESS_RESPONSE_THRESHOLD
          : FALSIFY_MATERIAL_CLEARCOAT !== ''
            ? CLEARCOAT_RESPONSE_THRESHOLD
          : FALSIFY_MATERIAL_OCCLUSION_TEXTURE !== ''
            ? OCCLUSION_TEXTURE_RESPONSE_THRESHOLD
            : FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE !== ''
              ? METALLIC_ROUGHNESS_TEXTURE_RESPONSE_THRESHOLD
              : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA !== ''
                ? BASE_COLOR_TEXTURE_ALPHA_RESPONSE_THRESHOLD
                : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE !== ''
                ? BASE_COLOR_TEXTURE_RESPONSE_THRESHOLD
                : FALSIFY_MATERIAL_NORMAL_TEXTURE !== ''
                  ? NORMAL_TEXTURE_RESPONSE_THRESHOLD
                  : FALSIFY_MATERIAL_SPECULAR_TINT_TEXTURE !== ''
                    ? SPECULAR_TINT_TEXTURE_RESPONSE_THRESHOLD
                    : FALSIFY_MATERIAL_SPECULAR_TINT !== ''
                      ? SPECULAR_TINT_RESPONSE_THRESHOLD
                      : FALSIFY_MATERIAL_ROUGHNESS !== ''
                        ? ROUGHNESS_RESPONSE_THRESHOLD
                        : MATERIAL_RESPONSE_THRESHOLD);
let meshedCount = 0;
const perSite = {};
for (const name of meshSiteNames) {
  const site = pixelSamples[name];
  const dist = distance(site, CLEAR_COLOR);
  perSite[name] = Number(dist.toFixed(4));
  if (dist > SMOKE_PIXEL_THRESHOLD) meshedCount++;
}
console.log(`[smoke] perSiteDistance=${JSON.stringify(perSite)}`);
console.log(
  `[smoke] materialResponseDistance=${materialResponseDistance.toFixed(4)} materialDefaultResponseDistance=${materialDefaultResponseDistance.toFixed(4)}`,
);
console.log(
  `[smoke] materialAlpha=${cubeCenter[3].toFixed(4)} materialAlphaResponseDistance=${materialAlphaResponseDistance.toFixed(4)}`,
);
console.log(
  `[smoke] materialBaseColorTextureAlpha=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA || '1'} materialBaseColorTextureAlphaExpected=${materialBaseColorTextureAlphaExpected.toFixed(4)} materialBaseColorTextureAlphaResponseDistance=${materialBaseColorTextureAlphaResponseDistance.toFixed(4)}`,
);
console.log(
  `[smoke] oracle=color-object-material cubeCenter=${JSON.stringify(cubeCenter)} lightWitness=${colorLightWitness} objectColor=${FALSIFY_OBJECT_COLOR || 'orange'} objectWitness=${objectColorWitness} materialMetallic=${FALSIFY_MATERIAL_METALLIC_CHANNEL !== '' ? '1' : FALSIFY_MATERIAL_METALLIC || '0'} materialMetallicChannel=${FALSIFY_MATERIAL_METALLIC_CHANNEL || '2'} materialRoughness=${FALSIFY_MATERIAL_ROUGHNESS || '0.5'} materialEmissive=${materialEmissive ? '1' : '0'} materialEmissiveIntensity=${FALSIFY_MATERIAL_EMISSIVE_INTENSITY || (materialEmissive ? '1' : '0')} materialSpecularTint=${FALSIFY_MATERIAL_SPECULAR_TINT || '0'} materialSpecularTintTexture=${FALSIFY_MATERIAL_SPECULAR_TINT_TEXTURE || '0'} materialNormalTexture=${FALSIFY_MATERIAL_NORMAL_TEXTURE || '0'} materialNormalScale=${FALSIFY_MATERIAL_NORMAL_SCALE || '1'} materialEmissiveTexture=${FALSIFY_MATERIAL_EMISSIVE_TEXTURE || '0'} materialBaseColorTexture=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE || '0'} materialBaseColorTextureRgb=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB || '1'} materialBaseColorTextureUvTransform=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM || '0'} materialBaseColorTextureUvSet=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET || '0'} materialBaseColorTextureAlpha=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA || '1'} materialMetallicRoughnessTexture=${FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE || (FALSIFY_MATERIAL_METALLIC_CHANNEL !== '' ? '1' : '0')} materialClearcoat=${materialClearcoat ? '1' : '0'} materialClearcoatRoughness=${materialClearcoatRoughness} materialOcclusionTexture=${FALSIFY_MATERIAL_OCCLUSION_TEXTURE || '0'} materialOcclusionStrength=${FALSIFY_MATERIAL_OCCLUSION_STRENGTH || '1'} materialAlphaCutoff=${FALSIFY_MATERIAL_ALPHA_CUTOFF || '0'} materialBaseColorAlpha=${FALSIFY_MATERIAL_BASE_COLOR_ALPHA || '1'} materialWitness=${materialWitness} lightColor=${FALSIFY_LIGHT_COLOR || 'white'} lightIntensity=${FALSIFY_LIGHT_INTENSITY || 'default'} intensityWitness=${intensityLightWitness} lightDirection=${FALSIFY_LIGHT_DIRECTION || 'toward-cube'} directionWitness=${directionLightWitness} falsifier=${FALSIFY_MATERIAL_METALLIC_CHANNEL ? 'metallic-channel' : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM ? 'base-color-texture-uv-transform' : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET ? 'base-color-texture-uv-set' : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB ? 'base-color-texture-rgb' : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA ? 'base-color-texture-alpha' : FALSIFY_MATERIAL_BASE_COLOR_ALPHA ? 'base-color-alpha' : FALSIFY_MATERIAL_ALPHA_CUTOFF ? 'alpha-cutoff' : FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS ? 'clearcoat-roughness' : FALSIFY_MATERIAL_NORMAL_SCALE ? 'normal-scale' : FALSIFY_MATERIAL_EMISSIVE_INTENSITY ? 'emissive-intensity' : FALSIFY_NO_LIGHT ? 'no-light' : FALSIFY_MATERIAL_OCCLUSION_STRENGTH ? 'occlusion-strength' : FALSIFY_MATERIAL_OCCLUSION_TEXTURE ? 'occlusion-texture' : FALSIFY_MATERIAL_CLEARCOAT ? 'clearcoat' : FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE ? 'metallic-roughness-texture' : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE ? 'base-color-texture' : FALSIFY_MATERIAL_EMISSIVE_TEXTURE ? 'emissive-texture' : FALSIFY_MATERIAL_NORMAL_TEXTURE ? 'normal-texture' : FALSIFY_MATERIAL_SPECULAR_TINT_TEXTURE ? 'specular-tint-texture' : FALSIFY_MATERIAL_SPECULAR_TINT ? 'specular-tint' : FALSIFY_MATERIAL_EMISSIVE ? 'emissive' : FALSIFY_MATERIAL_ROUGHNESS ? 'roughness' : FALSIFY_MATERIAL_METALLIC ? 'metallic' : FALSIFY_OBJECT_COLOR ? 'green-object' : FALSIFY_LIGHT_COLOR ? 'blue-light' : FALSIFY_LIGHT_INTENSITY ? 'low-intensity' : FALSIFY_LIGHT_DIRECTION ? 'away-direction' : 'none'}`,
);
console.log(
  `[smoke] materialClearcoat=${materialClearcoat ? '1' : '0'} materialClearcoatRoughness=${materialClearcoatRoughness} clearcoatResponseThreshold=${CLEARCOAT_RESPONSE_THRESHOLD} clearcoatRoughnessResponseThreshold=${CLEARCOAT_ROUGHNESS_RESPONSE_THRESHOLD}`,
);
console.log(
  `[smoke] materialFalsifier=${FALSIFY_MATERIAL_METALLIC_CHANNEL ? 'metallic-channel' : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM ? 'base-color-texture-uv-transform' : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET ? 'base-color-texture-uv-set' : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB ? 'base-color-texture-rgb' : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED ? 'base-color-texture-red' : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN ? 'base-color-texture-green' : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE ? 'base-color-texture-blue' : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA ? 'base-color-texture-alpha' : FALSIFY_MATERIAL_BASE_COLOR_ALPHA ? 'base-color-alpha' : FALSIFY_MATERIAL_ALPHA_CUTOFF ? 'alpha-cutoff' : FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS ? 'clearcoat-roughness' : FALSIFY_MATERIAL_NORMAL_SCALE ? 'normal-scale' : FALSIFY_MATERIAL_EMISSIVE_INTENSITY ? 'emissive-intensity' : FALSIFY_MATERIAL_EMISSIVE ? 'emissive' : FALSIFY_MATERIAL_OCCLUSION_STRENGTH ? 'occlusion-strength' : FALSIFY_MATERIAL_OCCLUSION_TEXTURE ? 'occlusion-texture' : FALSIFY_MATERIAL_EMISSIVE_TEXTURE ? 'emissive-texture' : FALSIFY_MATERIAL_CLEARCOAT ? 'clearcoat' : 'none'}`,
);

const wallTotalMs = Date.now() - frameStart;
console.log(`[smoke] wallTotalMs=${wallTotalMs}`);

const failures = [];
if (renderer.backend !== 'webgpu')
  failures.push(`(a) backend=${renderer.backend} (expected webgpu)`);
if (framesObserved < SMOKE_MIN_FRAMES)
  failures.push(`(b) frames=${framesObserved} < ${SMOKE_MIN_FRAMES}`);
if (meshedCount < 1) {
  failures.push(
    `(c) 0 of ${meshSiteNames.length} meshed sites exceed threshold=${SMOKE_PIXEL_THRESHOLD} from clear color; perSite=${JSON.stringify(perSite)}`,
  );
}
if (!colorLightWitness) {
  failures.push(
    FALSIFY_LIGHT_COLOR === 'blue'
      ? `(d) blue-light oracle rejected cubeCenter=${JSON.stringify(cubeCenter)}; expected blue>red and blue>green`
      : `(d) white-light oracle rejected cubeCenter=${JSON.stringify(cubeCenter)}; expected lit orange ordering red>green>blue`,
  );
}
if (FALSIFY_LIGHT_INTENSITY !== '' && !intensityLightWitness) {
  failures.push(`(d) intensity oracle rejected cubeCenter=${JSON.stringify(cubeCenter)}; expected 0.25 light intensity to preserve orange ordering with red in (0.2,0.4)`);
}
if (FALSIFY_LIGHT_DIRECTION !== '' && !directionLightWitness) {
  failures.push(
    `(d) direction falsifier rejected cubeCenter=${JSON.stringify(cubeCenter)}; expected away-facing light to remove direct-light output`,
  );
}
if (FALSIFY_OBJECT_COLOR !== '' && !objectColorWitness) {
  failures.push(
    `(d) object-color oracle rejected cubeCenter=${JSON.stringify(cubeCenter)}; expected green>red and green>blue`,
  );
}
if (
  (FALSIFY_MATERIAL_CLEARCOAT !== '' ||
    FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS !== '' ||
    FALSIFY_MATERIAL_METALLIC !== '' ||
    FALSIFY_MATERIAL_METALLIC_CHANNEL !== '' ||
    FALSIFY_MATERIAL_ROUGHNESS !== '' ||
    FALSIFY_MATERIAL_EMISSIVE !== '' ||
    FALSIFY_MATERIAL_EMISSIVE_INTENSITY !== '' ||
    FALSIFY_MATERIAL_SPECULAR_TINT !== '' ||
    FALSIFY_MATERIAL_SPECULAR_TINT_TEXTURE !== '' ||
    FALSIFY_MATERIAL_NORMAL_TEXTURE !== '' ||
    FALSIFY_MATERIAL_NORMAL_SCALE !== '' ||
    FALSIFY_MATERIAL_EMISSIVE_TEXTURE !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA !== '' ||
    FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE !== '' ||
    FALSIFY_MATERIAL_OCCLUSION_TEXTURE !== '' ||
    FALSIFY_MATERIAL_OCCLUSION_STRENGTH !== '' ||
    FALSIFY_MATERIAL_ALPHA_CUTOFF !== '' ||
    FALSIFY_MATERIAL_BASE_COLOR_ALPHA !== '') &&
  !materialWitness
) {
  failures.push(
    FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB !== ''
      ? '(d) base-color-texture-rgb oracle rejected cubeCenter=' +
        JSON.stringify(cubeCenter) +
        '; expected RGB=' +
        JSON.stringify(materialBaseColorTextureRgbExpected) +
        ' within ' +
        BASE_COLOR_TEXTURE_RGB_RESPONSE_THRESHOLD +
        ' and alpha preservation within the same threshold'
      : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM !== ''
      ? '(d) base-color-texture-uv-transform oracle rejected cubeCenter=' +
        JSON.stringify(cubeCenter) +
        '; expected transformed UV to sample the black-origin response at RGB=' +
        JSON.stringify(materialBaseColorTextureUvTransformExpected) +
        ' within ' +
        BASE_COLOR_TEXTURE_UV_TRANSFORM_RESPONSE_THRESHOLD +
        ' and differ from the same 2x2 texture without the transform by more than the same threshold'
      : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET !== ''
      ? '(d) base-color-texture-uv-set oracle rejected cubeCenter=' +
        JSON.stringify(cubeCenter) +
        '; expected coordinates.set=' +
        BASE_COLOR_TEXTURE_UV_SET +
        ' to select the authored UV1 white response=' +
        JSON.stringify(materialBaseColorTextureUvSetExpected) +
        ' within ' +
        BASE_COLOR_TEXTURE_UV_SET_RESPONSE_THRESHOLD +
        ' and differ from the UV0 response by more than the same threshold'
      : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE !== ''
      ? '(d) base-color-texture-blue oracle rejected cubeCenter=' +
        JSON.stringify(cubeCenter) +
        '; expected blue=' +
        materialBaseColorTextureBlueExpected.toFixed(4) +
        ' within ' +
        BASE_COLOR_TEXTURE_BLUE_RESPONSE_THRESHOLD +
        ' and red/green/alpha baseline preservation within the same threshold'
      : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN !== ''
      ? '(d) base-color-texture-green oracle rejected cubeCenter=' +
        JSON.stringify(cubeCenter) +
        '; expected green=' +
        materialBaseColorTextureGreenExpected.toFixed(4) +
        ' within ' +
        BASE_COLOR_TEXTURE_GREEN_RESPONSE_THRESHOLD +
        ' and red/blue/alpha baseline preservation within the same threshold'
      : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED !== ''
      ? `(d) base-color-texture-red oracle rejected cubeCenter=${JSON.stringify(cubeCenter)}; expected red=${materialBaseColorTextureRedExpected.toFixed(4)} within ${BASE_COLOR_TEXTURE_RED_RESPONSE_THRESHOLD} and green/blue/alpha baseline preservation within the same threshold`
      : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA !== ''
      ? `(d) base-color-texture-alpha oracle rejected cubeCenter=${JSON.stringify(cubeCenter)} alpha=${cubeCenter[3].toFixed(4)}; expected white RGB/A=${materialBaseColorTextureAlphaExpected.toFixed(4)} texture to reach the final render target within ${BASE_COLOR_TEXTURE_ALPHA_RESPONSE_THRESHOLD}`
      : FALSIFY_MATERIAL_BASE_COLOR_ALPHA !== ''
      ? `(d) base-color-alpha oracle rejected cubeCenter=${JSON.stringify(cubeCenter)} alpha=${cubeCenter[3].toFixed(4)}; expected baseColor alpha 0 to reach the final render target within ${BASE_COLOR_ALPHA_RESPONSE_THRESHOLD}`
      : FALSIFY_MATERIAL_ALPHA_CUTOFF !== ''
      ? `(d) alpha-cutoff oracle rejected cubeCenter=${JSON.stringify(cubeCenter)}; expected alphaCutoff=0.5 to discard the low-alpha cube and restore clear color`
      : FALSIFY_MATERIAL_CLEARCOAT_ROUGHNESS !== ''
      ? `(d) clearcoat-roughness oracle rejected cubeCenter=${JSON.stringify(cubeCenter)}; expected clearcoatRoughness=1 to differ from both the clearcoat=0.5 and no-coat cubeCenter baselines by more than ${CLEARCOAT_ROUGHNESS_RESPONSE_THRESHOLD}`
      : FALSIFY_MATERIAL_NORMAL_SCALE !== ''
      ? `(d) normal-scale oracle rejected cubeCenter=${JSON.stringify(cubeCenter)}; expected normalScale=0 to restore the flat-normal baseline within ${NORMAL_SCALE_RESPONSE_THRESHOLD}`
      : FALSIFY_MATERIAL_EMISSIVE_INTENSITY !== ''
      ? `(d) emissive-intensity oracle rejected cubeCenter=${JSON.stringify(cubeCenter)}; expected emissiveIntensity=0 to restore the default material response within ${EMISSIVE_INTENSITY_RESPONSE_THRESHOLD}`
      : FALSIFY_MATERIAL_OCCLUSION_STRENGTH !== ''
      ? `(d) occlusion-strength oracle rejected cubeCenter=${JSON.stringify(cubeCenter)}; expected strength 0 to restore the ambient baseline while sampling the black occlusion texture`
      : FALSIFY_MATERIAL_EMISSIVE_TEXTURE !== ''
        ? `(d) emissive-texture oracle rejected cubeCenter=${JSON.stringify(cubeCenter)}; expected the black texture to suppress the authored emissive contribution`
      : FALSIFY_MATERIAL_METALLIC_CHANNEL !== ''
        ? `(d) metallic-channel oracle rejected cubeCenter=${JSON.stringify(cubeCenter)}; expected channel ${FALSIFY_MATERIAL_METALLIC_CHANNEL} on the [R=1,G=1,B=0,A=1] texture to ${FALSIFY_MATERIAL_METALLIC_CHANNEL === '0' ? 'change' : 'preserve'} the default material response within ${METALLIC_CHANNEL_RESPONSE_THRESHOLD}`
      : `(d) material oracle rejected cubeCenter=${JSON.stringify(cubeCenter)}; expected material control to change the default material response`,
  );
}
if (errors.length > 0) {
  const codes = errors.map((e) => e.code).join(', ');
  failures.push(`(e) Renderer.onError fired ${errors.length} times: [${codes}]`);
}

if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "  rerun: pnpm --filter '@forgeax/app-learn-render-2-lighting-1-colors' smoke",
  );
  device.destroy?.();
  process.exit(1);
}

console.log(
  `[smoke] PASS - 5 criteria GREEN: backend=webgpu, frames=${framesObserved}, meshed sites above threshold=${meshedCount}/${meshSiteNames.length}, oracle=color-object-material/${FALSIFY_OBJECT_COLOR || 'orange'}, materialMetallic=${FALSIFY_MATERIAL_METALLIC_CHANNEL !== '' ? '1' : FALSIFY_MATERIAL_METALLIC || '0'}, materialMetallicChannel=${FALSIFY_MATERIAL_METALLIC_CHANNEL || '2'}, materialRoughness=${FALSIFY_MATERIAL_ROUGHNESS || '0.5'}, materialBaseColorAlpha=${FALSIFY_MATERIAL_BASE_COLOR_ALPHA || '1'}, materialAlpha=${cubeCenter[3].toFixed(4)}, materialClearcoat=${materialClearcoat ? '1' : '0'}, materialClearcoatRoughness=${materialClearcoatRoughness}, materialOcclusionTexture=${FALSIFY_MATERIAL_OCCLUSION_TEXTURE || '0'}, materialOcclusionStrength=${FALSIFY_MATERIAL_OCCLUSION_STRENGTH || '1'}, materialEmissive=${materialEmissive ? '1' : '0'}, materialEmissiveIntensity=${FALSIFY_MATERIAL_EMISSIVE_INTENSITY || (materialEmissive ? '1' : '0')}, materialSpecularTint=${FALSIFY_MATERIAL_SPECULAR_TINT || '0'}, materialSpecularTintTexture=${FALSIFY_MATERIAL_SPECULAR_TINT_TEXTURE || '0'}, materialNormalTexture=${FALSIFY_MATERIAL_NORMAL_TEXTURE || '0'}, materialNormalScale=${FALSIFY_MATERIAL_NORMAL_SCALE || '1'}, materialEmissiveTexture=${FALSIFY_MATERIAL_EMISSIVE_TEXTURE || '0'}, materialBaseColorTexture=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE || '0'}, materialBaseColorTextureRgb=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB || '1'}, materialBaseColorTextureUvTransform=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM || '0'}, materialBaseColorTextureUvSet=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET || '0'}, materialBaseColorTextureAlpha=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA || '1'}, materialBaseColorTextureAlphaExpected=${materialBaseColorTextureAlphaExpected.toFixed(4)}, materialMetallicRoughnessTexture=${FALSIFY_MATERIAL_METALLIC_ROUGHNESS_TEXTURE || (FALSIFY_MATERIAL_METALLIC_CHANNEL !== '' ? '1' : '0')}, lightIntensity=${FALSIFY_LIGHT_INTENSITY || 'default'}, lightDirection=${FALSIFY_LIGHT_DIRECTION || 'toward-cube'}, materialFalsifier=${FALSIFY_MATERIAL_METALLIC_CHANNEL ? 'metallic-channel' : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM ? 'base-color-texture-uv-transform' : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET ? 'base-color-texture-uv-set' : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB ? 'base-color-texture-rgb' : FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_ALPHA ? 'base-color-texture-alpha' : FALSIFY_MATERIAL_BASE_COLOR_ALPHA ? 'base-color-alpha' : FALSIFY_MATERIAL_ALPHA_CUTOFF ? 'alpha-cutoff' : 'none'}, RhiError count=0, wallTotalMs=${wallTotalMs}`,
);
console.log(
  `[smoke] PASS materialBaseColorTextureRed=${FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RED || '1'} expected=${materialBaseColorTextureRedExpected.toFixed(4)} responseDistance=${materialBaseColorTextureRedResponseDistance.toFixed(4)} preservedDistance=${materialBaseColorTextureRedPreservedDistance.toFixed(4)}`,
);
console.log(
  '[smoke] PASS materialBaseColorTextureGreen=' +
    (FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_GREEN || '1') +
    ' input=' +
    materialBaseColorTextureGreenInput.toFixed(4) +
    ' expected=' +
    materialBaseColorTextureGreenExpected.toFixed(4) +
    ' responseDistance=' +
    materialBaseColorTextureGreenResponseDistance.toFixed(4) +
    ' preservedDistance=' +
    materialBaseColorTextureGreenPreservedDistance.toFixed(4),
);
console.log(
  '[smoke] PASS materialBaseColorTextureBlue=' +
    (FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_BLUE || '1') +
    ' input=' +
    materialBaseColorTextureBlueInput.toFixed(4) +
    ' expected=' +
    materialBaseColorTextureBlueExpected.toFixed(4) +
    ' responseDistance=' +
    materialBaseColorTextureBlueResponseDistance.toFixed(4) +
    ' preservedDistance=' +
    materialBaseColorTextureBluePreservedDistance.toFixed(4),
);
console.log(
  '[smoke] PASS materialBaseColorTextureRgb=' +
    (FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_RGB || '1') +
    ' input=' +
    materialBaseColorTextureRgbInput.toFixed(4) +
    ' expected=' +
    JSON.stringify(materialBaseColorTextureRgbExpected) +
    ' responseDistance=' +
    materialBaseColorTextureRgbResponseDistance.toFixed(4) +
    ' preservedDistance=' +
    materialBaseColorTextureRgbPreservedDistance.toFixed(4),
);
console.log(
  '[smoke] PASS materialBaseColorTextureUvTransform=' +
    (FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_TRANSFORM || '0') +
    ' textureSize=' +
    (materialBaseColorTextureUvTransform ? '2x2' : '1x1') +
    ' transform=' +
    JSON.stringify(BASE_COLOR_TEXTURE_UV_TRANSFORM) +
    ' expected=' +
    JSON.stringify(materialBaseColorTextureUvTransformExpected) +
    ' responseDistance=' +
    materialBaseColorTextureUvTransformResponseDistance.toFixed(4) +
    ' baselineDistance=' +
    materialBaseColorTextureUvTransformBaselineDistance.toFixed(4),
);
console.log(
  '[smoke] PASS materialBaseColorTextureUvSet=' +
    (FALSIFY_MATERIAL_BASE_COLOR_TEXTURE_UV_SET || '0') +
    ' uvSet=' +
    BASE_COLOR_TEXTURE_UV_SET +
    ' textureSize=' +
    (materialBaseColorTextureUvSet ? '2x2' : '1x1') +
    ' uv1=[0.75,0.75]' +
    ' expected=' +
    JSON.stringify(materialBaseColorTextureUvSetExpected) +
    ' responseDistance=' +
    materialBaseColorTextureUvSetResponseDistance.toFixed(4) +
    ' baselineDistance=' +
    materialBaseColorTextureUvSetBaselineDistance.toFixed(4),
);

device.destroy?.();
delete globalThis.navigator.gpu;
process.exit(0);
