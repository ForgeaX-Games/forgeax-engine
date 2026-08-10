#define_import_path forgeax_pbr::lighting_directional

// @forgeax/engine-shader - lighting-directional.wgsl
// (feat-20260523-shader-template-instance-split M5 / T02;
//  feat-20260613-csm-cascaded-shadow-maps-unique-shadow-path M5 / w18 rewrite).
//
// Directional-light evaluator extracted from pbr.wgsl. Cook-Torrance
// (D_GGX + V_Smith + F_Schlick) microfacet specular + Lambertian diffuse,
// modulated by a slope-scaled-bias 3x3 PCF shadow lookup against the
// host's CSM shadow atlas (LearnOpenGL 3.1.3 PCF model + Bevy-style
// cascaded shadow maps).
//
// Cascade selection (feat-20260613 AC-03 / AC-06 / AC-10):
//   1. Pick layer in 0..cascadeCount-1 based on viewZ vs splitPlanes[i].
//      The same code path covers a 1-layer config (single tile) and a
//      4-layer config (Bevy default) -- AC-03 forbids any single-cascade
//      fallback branch.
//   2. Project worldPos through the matching lightViewProj. The host emits
//      pure clip-space matrices (orthoProj * lightView with no tile-UV
//      pre-bake); this helper performs atlas tile UV placement on the
//      fragment side so shadow_caster can keep gl_Position in clip space
//      (w28 split-of-roles -- writer and reader share one matrix shape).
//   3. textureSampleCompareLevel against shadowMap (the atlas) with a
//      slope-scaled bias (LO 3.1.3) and 3x3 PCF tap kernel.
//   4. When cascadeBlend > 0 and the fragment lies near the cascade
//      boundary, mix(shadow_curr, shadow_next, t) where t walks 0->1
//      across a band of width splitPlanes[layer] * cascadeBlend.
//
// feat-20260612-point-light-shadows-urp-hdrp M2 / T-M2-2 (plan-strategy D-4):
// 9-tap PCF taps come from shared sample_shadow_2d in forgeax_pbr::shadow_pcf.
// Bias formula and 9-tap kernel are byte-equivalent to the prior inline
// version (research L1.5 lines 47-81); the shared core is the single SSOT
// for directional + point-light PCF.
//
// Pulls View + shadowMap from forgeax_view::common -- the helper inherits
// the group(0) binding namespace from the host material shader (every
// consumer already imports forgeax_view::common). Shadow PCF taps use
// textureSampleCompareLevel against the comparison sampler so the path
// is portable across WebGPU + GLES.
//
// Exports:
//   - evalDirectional(...) -> vec3<f32>  (Cook-Torrance + CSM shadow mod)
//   - evalDirectionalNoShadow(...) -> vec3<f32>  (Cook-Torrance, no shadow;
//     sprite-lit M1' / w3 D-1; also the inner brdf body of evalDirectional)

#import forgeax_view::common::{view, shadowMap, shadowSampler}
#import forgeax_pbr::brdf::{f_schlick, v_smith, d_ggx}
#import forgeax_pbr::shadow_pcf::{sample_shadow_2d}

// feat-20260621-learn-render-5-3-production-shadow-demos M0 / AC-14:
// compile-time upper bound on the PCF half-extent so the WGSL tap loops keep
// a constant trip count (no dynamic loop bounds / shader variants). half=2
// covers pcfKernelSize in {1,3,5} -> {1,9,25} taps; view.pcfKernelSize selects
// the runtime radius via a per-iteration clip (plan-strategy D-1).
const MAX_PCF_HALF : u32 = 2u;

// Source: Three.js r184 src/nodes/functions/BSDF/DFGLUT.js. The full 16x16
// RG16F table is decoded to exact f32 constants here; the lookup below mirrors
// the source DataTexture's linear filtering and clamp-to-edge sampling without
// adding a host binding or coupling direct light to the engine IBL LUT.
const THREE_R184_DFG_LUT_SIZE : u32 = 16u;
const THREE_R184_DFG_LUT : array<vec2<f32>, 256> = array<vec2<f32>, 256>(
  vec2<f32>(0.1470947265625, 0.85205078125), vec2<f32>(0.16552734375, 0.78759765625), vec2<f32>(0.244384765625, 0.638671875), vec2<f32>(0.370849609375, 0.51953125),
  vec2<f32>(0.496826171875, 0.41552734375), vec2<f32>(0.60205078125, 0.326416015625), vec2<f32>(0.68408203125, 0.25390625), vec2<f32>(0.74609375, 0.197509765625),
  vec2<f32>(0.79052734375, 0.154296875), vec2<f32>(0.822265625, 0.12164306640625), vec2<f32>(0.84326171875, 0.09698486328125), vec2<f32>(0.8564453125, 0.07843017578125),
  vec2<f32>(0.86328125, 0.06439208984375), vec2<f32>(0.86572265625, 0.0537109375), vec2<f32>(0.8642578125, 0.045440673828125), vec2<f32>(0.85986328125, 0.039031982421875),
  vec2<f32>(0.388671875, 0.611328125), vec2<f32>(0.39306640625, 0.6005859375), vec2<f32>(0.412353515625, 0.5458984375), vec2<f32>(0.45654296875, 0.4482421875),
  vec2<f32>(0.52783203125, 0.3525390625), vec2<f32>(0.607421875, 0.27392578125), vec2<f32>(0.6787109375, 0.21142578125), vec2<f32>(0.7333984375, 0.16259765625),
  vec2<f32>(0.77099609375, 0.1253662109375), vec2<f32>(0.79345703125, 0.0972900390625), vec2<f32>(0.80322265625, 0.07623291015625), vec2<f32>(0.8037109375, 0.06036376953125),
  vec2<f32>(0.79638671875, 0.048431396484375), vec2<f32>(0.78564453125, 0.03936767578125), vec2<f32>(0.77197265625, 0.03240966796875), vec2<f32>(0.7548828125, 0.0269775390625),
  vec2<f32>(0.572265625, 0.427490234375), vec2<f32>(0.57373046875, 0.424072265625), vec2<f32>(0.57958984375, 0.403564453125), vec2<f32>(0.591796875, 0.3544921875),
  vec2<f32>(0.6162109375, 0.2880859375), vec2<f32>(0.6552734375, 0.224853515625), vec2<f32>(0.69873046875, 0.172607421875), vec2<f32>(0.7353515625, 0.1318359375),
  vec2<f32>(0.75927734375, 0.10089111328125), vec2<f32>(0.77001953125, 0.07745361328125), vec2<f32>(0.77197265625, 0.0599365234375), vec2<f32>(0.76611328125, 0.046844482421875),
  vec2<f32>(0.751953125, 0.0369873046875), vec2<f32>(0.732421875, 0.029541015625), vec2<f32>(0.70947265625, 0.023834228515625), vec2<f32>(0.68359375, 0.019439697265625),
  vec2<f32>(0.708984375, 0.291015625), vec2<f32>(0.708984375, 0.289794921875), vec2<f32>(0.7099609375, 0.28125), vec2<f32>(0.7099609375, 0.258544921875),
  vec2<f32>(0.71142578125, 0.220458984375), vec2<f32>(0.7197265625, 0.1768798828125), vec2<f32>(0.734375, 0.1370849609375), vec2<f32>(0.748046875, 0.10479736328125),
  vec2<f32>(0.755859375, 0.07989501953125), vec2<f32>(0.759765625, 0.061004638671875), vec2<f32>(0.75341796875, 0.046844482421875), vec2<f32>(0.73876953125, 0.036224365234375),
  vec2<f32>(0.7177734375, 0.02825927734375), vec2<f32>(0.69189453125, 0.0222625732421875), vec2<f32>(0.6611328125, 0.0177001953125), vec2<f32>(0.62841796875, 0.01419830322265625),
  vec2<f32>(0.80810546875, 0.1917724609375), vec2<f32>(0.8076171875, 0.1912841796875), vec2<f32>(0.80615234375, 0.18798828125), vec2<f32>(0.8017578125, 0.1781005859375),
  vec2<f32>(0.79296875, 0.15869140625), vec2<f32>(0.78369140625, 0.1322021484375), vec2<f32>(0.775390625, 0.1048583984375), vec2<f32>(0.7685546875, 0.08111572265625),
  vec2<f32>(0.7646484375, 0.061981201171875), vec2<f32>(0.75537109375, 0.047271728515625), vec2<f32>(0.740234375, 0.036163330078125), vec2<f32>(0.71875, 0.0277557373046875),
  vec2<f32>(0.69091796875, 0.021484375), vec2<f32>(0.658203125, 0.0167388916015625), vec2<f32>(0.6220703125, 0.01316070556640625), vec2<f32>(0.583984375, 0.01041412353515625),
  vec2<f32>(0.87841796875, 0.1217041015625), vec2<f32>(0.8779296875, 0.1217041015625), vec2<f32>(0.875, 0.12060546875), vec2<f32>(0.869140625, 0.116943359375),
  vec2<f32>(0.85693359375, 0.1080322265625), vec2<f32>(0.837890625, 0.09375), vec2<f32>(0.81494140625, 0.076904296875), vec2<f32>(0.7958984375, 0.060699462890625),
  vec2<f32>(0.7763671875, 0.046875), vec2<f32>(0.75634765625, 0.035919189453125), vec2<f32>(0.732421875, 0.0274505615234375), vec2<f32>(0.703125, 0.021026611328125),
  vec2<f32>(0.6689453125, 0.01617431640625), vec2<f32>(0.63037109375, 0.01251220703125), vec2<f32>(0.58935546875, 0.00974273681640625), vec2<f32>(0.54638671875, 0.007633209228515625),
  vec2<f32>(0.92626953125, 0.07379150390625), vec2<f32>(0.92578125, 0.07391357421875), vec2<f32>(0.9228515625, 0.07391357421875), vec2<f32>(0.9169921875, 0.0731201171875),
  vec2<f32>(0.90380859375, 0.06982421875), vec2<f32>(0.88134765625, 0.0631103515625), vec2<f32>(0.85107421875, 0.053802490234375), vec2<f32>(0.8212890625, 0.043701171875),
  vec2<f32>(0.791015625, 0.034393310546875), vec2<f32>(0.76123046875, 0.026611328125), vec2<f32>(0.72802734375, 0.02044677734375), vec2<f32>(0.69189453125, 0.015655517578125),
  vec2<f32>(0.65087890625, 0.0120086669921875), vec2<f32>(0.607421875, 0.00925445556640625), vec2<f32>(0.56103515625, 0.0071563720703125), vec2<f32>(0.51416015625, 0.005565643310546875),
  vec2<f32>(0.95751953125, 0.042327880859375), vec2<f32>(0.95703125, 0.042449951171875), vec2<f32>(0.95458984375, 0.042816162109375), vec2<f32>(0.94921875, 0.043182373046875),
  vec2<f32>(0.93701171875, 0.04266357421875), vec2<f32>(0.9130859375, 0.040252685546875), vec2<f32>(0.8818359375, 0.035797119140625), vec2<f32>(0.8447265625, 0.0301361083984375),
  vec2<f32>(0.80615234375, 0.0243377685546875), vec2<f32>(0.76708984375, 0.0191497802734375), vec2<f32>(0.7265625, 0.01485443115234375), vec2<f32>(0.6826171875, 0.01142120361328125),
  vec2<f32>(0.63623046875, 0.0087738037109375), vec2<f32>(0.5869140625, 0.006740570068359375), vec2<f32>(0.53662109375, 0.005199432373046875), vec2<f32>(0.486083984375, 0.00402069091796875),
  vec2<f32>(0.9775390625, 0.0226287841796875), vec2<f32>(0.97705078125, 0.0227508544921875), vec2<f32>(0.97509765625, 0.023193359375), vec2<f32>(0.9697265625, 0.0239105224609375),
  vec2<f32>(0.95947265625, 0.0244903564453125), vec2<f32>(0.93603515625, 0.0241241455078125), vec2<f32>(0.9052734375, 0.02252197265625), vec2<f32>(0.865234375, 0.0197601318359375),
  vec2<f32>(0.82177734375, 0.016510009765625), vec2<f32>(0.7744140625, 0.0132904052734375), vec2<f32>(0.7265625, 0.01045989990234375), vec2<f32>(0.67626953125, 0.0081329345703125),
  vec2<f32>(0.6240234375, 0.00627899169921875), vec2<f32>(0.56982421875, 0.004825592041015625), vec2<f32>(0.51513671875, 0.0037136077880859375), vec2<f32>(0.46142578125, 0.0028629302978515625),
  vec2<f32>(0.98876953125, 0.01107025146484375), vec2<f32>(0.98876953125, 0.01116180419921875), vec2<f32>(0.98681640625, 0.01151275634765625), vec2<f32>(0.98291015625, 0.01221466064453125),
  vec2<f32>(0.97314453125, 0.01299285888671875), vec2<f32>(0.953125, 0.013519287109375), vec2<f32>(0.9228515625, 0.01328277587890625), vec2<f32>(0.88232421875, 0.01226043701171875),
  vec2<f32>(0.8349609375, 0.01065826416015625), vec2<f32>(0.783203125, 0.00885009765625), vec2<f32>(0.728515625, 0.007114410400390625), vec2<f32>(0.671875, 0.00560760498046875),
  vec2<f32>(0.61376953125, 0.004360198974609375), vec2<f32>(0.5546875, 0.0033721923828125), vec2<f32>(0.496337890625, 0.0025997161865234375), vec2<f32>(0.439453125, 0.0020046234130859375),
  vec2<f32>(0.9951171875, 0.00479888916015625), vec2<f32>(0.9951171875, 0.004863739013671875), vec2<f32>(0.99365234375, 0.005096435546875), vec2<f32>(0.990234375, 0.005603790283203125),
  vec2<f32>(0.9814453125, 0.0063323974609375), vec2<f32>(0.96435546875, 0.006977081298828125), vec2<f32>(0.93603515625, 0.007297515869140625), vec2<f32>(0.896484375, 0.0071258544921875),
  vec2<f32>(0.8466796875, 0.00649261474609375), vec2<f32>(0.79150390625, 0.005596160888671875), vec2<f32>(0.7314453125, 0.004627227783203125), vec2<f32>(0.6689453125, 0.0037174224853515625),
  vec2<f32>(0.60546875, 0.0029296875), vec2<f32>(0.54150390625, 0.00228118896484375), vec2<f32>(0.479248046875, 0.001766204833984375), vec2<f32>(0.419677734375, 0.00136566162109375),
  vec2<f32>(0.998046875, 0.0017604827880859375), vec2<f32>(0.998046875, 0.0017938613891601562), vec2<f32>(0.99658203125, 0.0019292831420898438), vec2<f32>(0.994140625, 0.002239227294921875),
  vec2<f32>(0.986328125, 0.0027294158935546875), vec2<f32>(0.9716796875, 0.0032501220703125), vec2<f32>(0.94580078125, 0.00366973876953125), vec2<f32>(0.90771484375, 0.003818511962890625),
  vec2<f32>(0.8583984375, 0.003681182861328125), vec2<f32>(0.79931640625, 0.0033206939697265625), vec2<f32>(0.7353515625, 0.0028438568115234375), vec2<f32>(0.66748046875, 0.0023441314697265625),
  vec2<f32>(0.5986328125, 0.0018796920776367188), vec2<f32>(0.5302734375, 0.0014829635620117188), vec2<f32>(0.464111328125, 0.0011587142944335938), vec2<f32>(0.402099609375, 0.0008993148803710938),
  vec2<f32>(0.99951171875, 0.0005011558532714844), vec2<f32>(0.99951171875, 0.0005154609680175781), vec2<f32>(0.998046875, 0.000583648681640625), vec2<f32>(0.99658203125, 0.0007505416870117188),
  vec2<f32>(0.9892578125, 0.00101470947265625), vec2<f32>(0.97607421875, 0.001346588134765625), vec2<f32>(0.95263671875, 0.0016527175903320312), vec2<f32>(0.916015625, 0.0018558502197265625),
  vec2<f32>(0.8671875, 0.0019054412841796875), vec2<f32>(0.8076171875, 0.0018167495727539062), vec2<f32>(0.7392578125, 0.001621246337890625), vec2<f32>(0.6669921875, 0.0013799667358398438),
  vec2<f32>(0.59326171875, 0.0011358261108398438), vec2<f32>(0.52001953125, 0.0009121894836425781), vec2<f32>(0.450439453125, 0.0007219314575195312), vec2<f32>(0.385986328125, 0.0005650520324707031),
  vec2<f32>(1.0, 0.00009316205978393555), vec2<f32>(1.0, 0.0000978708267211914), vec2<f32>(0.9990234375, 0.00012540817260742188), vec2<f32>(0.9970703125, 0.00019216537475585938),
  vec2<f32>(0.99072265625, 0.0003104209899902344), vec2<f32>(0.97900390625, 0.0004699230194091797), vec2<f32>(0.95751953125, 0.0006470680236816406), vec2<f32>(0.92333984375, 0.0007915496826171875),
  vec2<f32>(0.87548828125, 0.0008769035339355469), vec2<f32>(0.81494140625, 0.0008869171142578125), vec2<f32>(0.744140625, 0.0008325576782226562), vec2<f32>(0.66748046875, 0.0007386207580566406),
  vec2<f32>(0.58837890625, 0.0006265640258789062), vec2<f32>(0.51123046875, 0.0005168914794921875), vec2<f32>(0.438232421875, 0.0004165172576904297), vec2<f32>(0.37109375, 0.0003311634063720703),
  vec2<f32>(1.0, 0.000007271766662597656), vec2<f32>(1.0, 0.000008165836334228516), vec2<f32>(0.9990234375, 0.000016987323760986328), vec2<f32>(0.99755859375, 0.00003790855407714844),
  vec2<f32>(0.9921875, 0.00007593631744384766), vec2<f32>(0.9814453125, 0.00013744831085205078), vec2<f32>(0.96142578125, 0.00020754337310791016), vec2<f32>(0.92919921875, 0.00028014183044433594),
  vec2<f32>(0.8828125, 0.0003345012664794922), vec2<f32>(0.82177734375, 0.00036263465881347656), vec2<f32>(0.7490234375, 0.00036215782165527344), vec2<f32>(0.66845703125, 0.0003380775451660156),
  vec2<f32>(0.58544921875, 0.00029969215393066406), vec2<f32>(0.50390625, 0.00025582313537597656), vec2<f32>(0.427001953125, 0.0002117156982421875), vec2<f32>(0.357666015625, 0.00017201900482177734),
  vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 5.960464477539063e-8), vec2<f32>(0.99951171875, 0.0000012516975402832031), vec2<f32>(0.99755859375, 0.000005304813385009766),
  vec2<f32>(0.9931640625, 0.000015079975128173828), vec2<f32>(0.98291015625, 0.00002855062484741211), vec2<f32>(0.96435546875, 0.00004744529724121094), vec2<f32>(0.93408203125, 0.00006842613220214844),
  vec2<f32>(0.88916015625, 0.00008893013000488281), vec2<f32>(0.828125, 0.0001042485237121582), vec2<f32>(0.75390625, 0.00011217594146728516), vec2<f32>(0.67041015625, 0.00011241436004638672),
  vec2<f32>(0.5830078125, 0.00010627508163452148), vec2<f32>(0.4970703125, 0.00009584426879882812), vec2<f32>(0.4169921875, 0.0000833272933959961), vec2<f32>(0.34521484375, 0.00007051229476928711),
);

fn _sampleThreeR184DfgLut(roughness : f32, dotNV : f32) -> vec2<f32> {
  let uv = clamp(vec2<f32>(roughness, dotNV), vec2<f32>(0.0), vec2<f32>(1.0));
  let samplePosition = uv * f32(THREE_R184_DFG_LUT_SIZE) - vec2<f32>(0.5);
  let base = vec2<i32>(floor(samplePosition));
  let weight = fract(samplePosition);
  let last = i32(THREE_R184_DFG_LUT_SIZE - 1u);
  let lo = clamp(base, vec2<i32>(0), vec2<i32>(last));
  let hi = clamp(base + vec2<i32>(1), vec2<i32>(0), vec2<i32>(last));
  let rowLo = mix(
    THREE_R184_DFG_LUT[u32(lo.y) * THREE_R184_DFG_LUT_SIZE + u32(lo.x)],
    THREE_R184_DFG_LUT[u32(lo.y) * THREE_R184_DFG_LUT_SIZE + u32(hi.x)],
    weight.x,
  );
  let rowHi = mix(
    THREE_R184_DFG_LUT[u32(hi.y) * THREE_R184_DFG_LUT_SIZE + u32(lo.x)],
    THREE_R184_DFG_LUT[u32(hi.y) * THREE_R184_DFG_LUT_SIZE + u32(hi.x)],
    weight.x,
  );
  return mix(rowLo, rowHi, weight.y);
}

fn _threeR184DirectMultiScatter(
  roughness : f32,
  nDotV     : f32,
  nDotL     : f32,
  F0        : vec3<f32>,
) -> vec3<f32> {
  let dfgV = _sampleThreeR184DfgLut(roughness, nDotV);
  let dfgL = _sampleThreeR184DfgLut(roughness, nDotL);
  let fssEssV = F0 * dfgV.x + vec3<f32>(dfgV.y);
  let fssEssL = F0 * dfgL.x + vec3<f32>(dfgL.y);
  let emsV = 1.0 - dfgV.x - dfgV.y;
  let emsL = 1.0 - dfgL.x - dfgL.y;
  let favg = F0 + (vec3<f32>(1.0) - F0) * 0.047619;
  let energyLoss = emsV * emsL;
  let fms = fssEssV * fssEssL * favg
    / (vec3<f32>(1.0) - energyLoss * favg * favg + vec3<f32>(1e-6));
  return fms * energyLoss;
}

// Pick the cascade layer for a positive view-space depth -- walks
// splitPlanes in order, returns the first split the depth falls below. Last
// layer (count - 1) catches everything beyond splits[count-2]. cascadeCount=1
// returns 0 unconditionally without a special branch (count - 1u == 0
// short-circuits the loop trip count).
//
// NOTE the sign: the vertex stage emits `viewZ = -clipPos.w` (NEGATIVE in
// front of the camera -- the deliberate convention the cluster Z-slice path
// also relies on), but `pssmSplit` host-side produces POSITIVE view-space
// split depths. The caller therefore passes `viewDepth = -viewZ` so this
// comparison is positive-vs-positive. Comparing the raw negative viewZ against
// positive splits collapsed every visible fragment to layer 0 (its near slab),
// projecting far geometry out of the tile -> shadowFactor always 1.0 (no
// occlusion). (downstream template integration #1.)
fn _pickCascadeLayer(viewDepth : f32, count : u32) -> u32 {
  var layer : u32 = count - 1u;
  for (var i : u32 = 0u; i < count - 1u; i = i + 1u) {
    let sp = view.splitPlanes[i].x;
    if (viewDepth < sp) {
      layer = i;
      break;
    }
  }
  return layer;
}

// Look up the lightViewProj matrix for layer index. View UBO carries 4
// distinct fields (lightViewProj_A..D); WGSL has no addressable mat4
// array on a uniform, so a manual switch keeps the path uniform.
fn _cascadeLightViewProj(layer : u32) -> mat4x4<f32> {
  switch (layer) {
    case 0u: { return view.lightViewProj_A; }
    case 1u: { return view.lightViewProj_B; }
    case 2u: { return view.lightViewProj_C; }
    default: { return view.lightViewProj_D; }
  }
}

// Map a cascade layer to its atlas-tile origin in [0,1]^2 UV space.
// tilesPerSide = 2 covers cascadeCount in 1..4 (atlas = 2 × mapSize).
// cascadeCount=1 collapses to tile (0,0); the same code path applies.
fn _atlasTileOrigin(layer : u32, count : u32) -> vec2<f32> {
  // tilesPerSide = ceil(sqrt(count)). count<=1 -> 1; count<=4 -> 2.
  // Branch-free: count<=1 -> 1, else 2.
  let tilesPerSide : u32 = select(2u, 1u, count <= 1u);
  let col = layer % tilesPerSide;
  let row = layer / tilesPerSide;
  let inv = 1.0 / f32(tilesPerSide);
  return vec2<f32>(f32(col) * inv, f32(row) * inv);
}

// Sample the shadow atlas with the LO 3.1.3 slope-scaled bias + dynamic PCF
// kernel (driven by view.pcfKernelSize, MAX_PCF_HALF=2),
// against the lightViewProj for the chosen cascade. The shader maps NDC
// xy to that cascade's atlas tile in fragment space (matrix carries
// clip-space; tile placement happens here so shadow_caster.gl_Position
// stays in the WGSL clip-space contract).
fn _sampleShadowForCascade(
  worldPos : vec3<f32>,
  layer    : u32,
  count    : u32,
  normal   : vec3<f32>,
  l        : vec3<f32>,
) -> f32 {
  let lvp = _cascadeLightViewProj(layer);
  let lightClip = lvp * vec4<f32>(worldPos, 1.0);
  let projCoords = lightClip.xyz / lightClip.w;
  let tilesPerSide : u32 = select(2u, 1u, count <= 1u);
  let inv = 1.0 / f32(tilesPerSide);
  let tileOrigin = _atlasTileOrigin(layer, count);
  // NDC [-1,1] -> tile-local UV [0,inv] -> atlas UV [tileOrigin, tileOrigin+inv].
  let tileUv = vec2<f32>(projCoords.x * 0.5 + 0.5, -projCoords.y * 0.5 + 0.5);
  let uv = tileUv * inv + tileOrigin;
  let currentDepth = projCoords.z;
  // feat-20260621-merge-directionallightshadow-into-directionallight M3 / m3-t4
  // (D-1): the slope-scaled bias is driven by the merged DirectionalLight's
  // shadow fields carried in the View UBO -- normalBias scales the
  // (1 - N.L) slope term, depthBias is the constant floor. Replaces the prior
  // hardcoded max(0.05*(1-N.L), 0.005).
  let bias = max(view.normalBias * (1.0 - dot(normal, l)), view.depthBias);
  let adjustedDepth = currentDepth - bias;
  // NaN-safe bounds: relational < and > do not reject NaN (NaN < 0 is
  // false), so a zero / degenerate lightViewProj matrix that produces
  // 0/0 = NaN would slip through. Use x >= 0 && x <= 1 instead -- NaN
  // makes the conjunction false and the early-return fires (shadow=1.0).
  // Matches the main-line pattern that survived the transform-hierarchy
  // dawn regression test (AC-08 parent-move pixel-diff on main).
  if (!(tileUv.x >= 0.0 && tileUv.x <= 1.0 && tileUv.y >= 0.0 && tileUv.y <= 1.0 && currentDepth <= 1.0)) {
    return 1.0;
  }
  let texelDims = vec2<f32>(textureDimensions(shadowMap, 0));
  let texel = vec2<f32>(1.0 / texelDims.x, 1.0 / texelDims.y);
  // AC-07 (bug-20260619): the OOB guard above is in tile-local space, but the
  // PCF tap offset is applied in atlas space. For count>1 (inv<1) a fragment
  // within one texel of a tile edge would sample into a NEIGHBOURING cascade's
  // tile, reading the wrong depth and producing a 1-texel seam at cascade
  // boundaries. Clamp every tap to this cascade's tile rect
  // [tileOrigin, tileOrigin+inv) (one texel inset) so taps stay in-tile. For
  // count<=1 (single full-atlas tile) this is a no-op widening of the bound.
  let tileLo = tileOrigin + texel;
  let tileHi = tileOrigin + vec2<f32>(inv) - texel;
  // Variable-width PCF kernel driven by view.pcfKernelSize (feat-20260621
  // 5.3-production-shadow-demos AC-14 merged with the DirectionalLightShadow
  // merge). Constant trip count to MAX_PCF_HALF with a per-iteration clip to the
  // runtime radius keeps the shader variant-free (no dynamic loop bound, legal
  // for textureSampleCompareLevel uniform control flow). Host clamps
  // view.pcfKernelSize to {1,3,5}; divisor = actual tap count, so pcfKernelSize=3
  // -> half=1 -> 9 taps / 9.0 (result-identical to the prior hard-coded 3x3);
  // pcfKernelSize=1 -> half=0 -> single centre tap (hard edge); pcfKernelSize=5
  // -> half=2 -> 25-tap soft penumbra.
  let kernel = clamp(u32(round(view.pcfKernelSize)), 1u, 2u * MAX_PCF_HALF + 1u);
  let half = (kernel - 1u) / 2u;
  let halfI = i32(half);
  var blocked = 0.0;
  for (var x = -i32(MAX_PCF_HALF); x <= i32(MAX_PCF_HALF); x++) {
    for (var y = -i32(MAX_PCF_HALF); y <= i32(MAX_PCF_HALF); y++) {
      if (abs(x) > halfI || abs(y) > halfI) {
        continue;
      }
      let offsetUv = clamp(uv + vec2<f32>(f32(x), f32(y)) * texel, tileLo, tileHi);
      let lit = textureSampleCompareLevel(shadowMap, shadowSampler, offsetUv, adjustedDepth);
      blocked = blocked + (1.0 - lit);
    }
  }
  let tapCount = f32((2u * half + 1u) * (2u * half + 1u));
  return 1.0 - blocked / tapCount;
}

// `evalDirectionalNoShadow` evaluates the GGX direct-lighting term for the
// single directional light carried in `view.lightDir / view.lightColor`
// WITHOUT applying any shadow factor — pure Cook-Torrance (D_GGX + V_Smith
// + F_Schlick) microfacet specular + Lambertian diffuse, returned scaled
// by `lightColor * nDotL`.
//
// feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / w3 (D-1):
// extracted from evalDirectional so the brdf body matches the
// `evalPoint` / `evalSpot` pattern (no shadow tap inside the brdf
// function — caller multiplies the shadow factor afterwards). Industry
// alignment: Bevy / glTF Sample Renderer / Three.js all keep their
// directional brdf shadow-free; forgeax was the outlier with
// `_sampleShadowForCascade` hard-coded inside the body. Sprite-lit and
// future per-light variants get a clean shadow-free reuse target while
// mesh PBR keeps calling the wrapping `evalDirectional` (mathematically
// equivalent — see plan-strategy R-3D-mesh-PBR-output-shift).
//
// @internal — exported for sprite-lit re-use inside the engine; external
// material shaders should keep calling `evalDirectional` for backward
// compat with the cascaded-shadow pipeline.
fn evalDirectionalNoShadow(
  normal     : vec3<f32>,
  viewDir    : vec3<f32>,
  baseColor  : vec3<f32>,
  metallic   : f32,
  alphaSq    : f32,
  F0         : vec3<f32>,
) -> vec3<f32> {
  let l = normalize(-view.lightDir);
  let h = normalize(viewDir + l);
  let nDotL = max(dot(normal, l), 0.0);
  let nDotV = max(dot(normal, viewDir), 1e-5);
  let nDotH = max(dot(normal, h), 0.0);
  let vDotH = max(dot(viewDir, h), 0.0);
  let fresnel = exp2((-5.55473 * vDotH - 6.98316) * vDotH);
  let f = F0 * (vec3<f32>(1.0) - fresnel) + vec3<f32>(fresnel);
  let roughness = sqrt(max(alphaSq, 0.0));
  let multiScatter = _threeR184DirectMultiScatter(roughness, nDotV, nDotL, F0);
  let specular = d_ggx(nDotH, alphaSq) * v_smith(nDotV, nDotL, alphaSq) * f + multiScatter;
  let diffuse = (1.0 - metallic) * baseColor / 3.14159265;
  return (diffuse + specular) * view.lightColor * nDotL;
}

// `evalDirectional` evaluates the GGX direct-lighting term for the single
// directional light carried in `view.lightDir / view.lightColor`. CSM
// pathway: pick cascade layer from viewZ + splitPlanes, sample the atlas
// tile via the matching lightViewProj, optionally blend with the next
// cascade across a `cascadeBlend`-wide boundary band.
//
// feat-20260624 M1' / w3 (D-1): body now delegates the brdf math to
// `evalDirectionalNoShadow` and multiplies the cascade shadow factor at
// the call site (mirrors `evalPoint` / `evalSpot` shape). Output is
// mathematically equivalent to the pre-refactor inline form — mesh PBR
// pixel-parity bench is the regression guard (w8).
fn evalDirectional(
  normal     : vec3<f32>,
  viewDir    : vec3<f32>,
  baseColor  : vec3<f32>,
  metallic   : f32,
  alphaSq    : f32,
  F0         : vec3<f32>,
  worldPos   : vec3<f32>,
  viewZ      : f32,
) -> vec3<f32> {
  // No-shadow brdf body (factored out — same expression as the prior
  // inline form, multiplied by shadow factor below). Reuse keeps the
  // mesh PBR output byte-equivalent and gives sprite-lit a shared
  // shadow-free entry point.
  let lit = evalDirectionalNoShadow(normal, viewDir, baseColor, metallic, alphaSq, F0);

  // Cascade selection + atlas sampling (AC-03 / AC-05 / AC-06 / AC-10).
  // feat-20260613-csm-cascaded-shadow-maps M5 / w18: uses inline 9-tap PCF
  // inside `_sampleShadowForCascade` rather than the shared sample_shadow_2d
  // (forgeax_pbr::shadow_pcf used by point-light) — the cascade dispatch
  // wraps the kernel per-tile so the shared core's `(uv, currentDepth)`
  // entry shape doesn't fit (it expects pre-projected light-space coords;
  // CSM derives them per-cascade after dispatch). F-J-1 future-tracks the
  // dedup once `forgeax_view::cascade` lands as its own module (post-#387).
  let l = normalize(-view.lightDir);
  let count = u32(max(view.cascadeCount, 1.0));
  // viewZ is negative in front of the camera; splitPlanes are positive
  // view-space depths. Convert once so cascade selection + blend math are
  // positive-vs-positive (see _pickCascadeLayer).
  let viewDepth = -viewZ;
  let layer = _pickCascadeLayer(viewDepth, count);
  let shadowCurr = _sampleShadowForCascade(worldPos, layer, count, normal, l);

  // cascadeBlend mixes the current cascade with the next one across a
  // band of width `splitPlanes[layer] * cascadeBlend` immediately before
  // the boundary. cascadeBlend=0 -> hard cut. Last cascade has no
  // successor; mix collapses to shadowCurr.
  var shadow = shadowCurr;
  if (view.cascadeBlend > 0.0 && layer + 1u < count) {
    let spCurr = view.splitPlanes[layer].x;
    let blendWidth = spCurr * view.cascadeBlend;
    if (blendWidth > 0.0) {
      // Positive view-space depth (viewDepth), matching spCurr's sign;
      // `dist` shrinks to 0 as the fragment approaches the split boundary.
      let dist = spCurr - viewDepth;
      let t = clamp(1.0 - dist / blendWidth, 0.0, 1.0);
      if (t > 0.0) {
        let shadowNext = _sampleShadowForCascade(worldPos, layer + 1u, count, normal, l);
        shadow = mix(shadowCurr, shadowNext, t);
      }
    }
  }

  return lit * shadow;
}
