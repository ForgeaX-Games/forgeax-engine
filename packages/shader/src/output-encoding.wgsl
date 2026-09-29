#define_import_path forgeax_view::output_encoding

// The single explicit output encoding owner for raw surface writes.
#import forgeax_view::common::{linearToSrgbOetf}

// Convert linear-LDR RGB once and preserve the source alpha channel exactly.
fn encodeOutput(linearColor : vec3<f32>, alpha : f32) -> vec4<f32> {
  let encoded = linearToSrgbOetf(linearColor);
  return vec4<f32>(encoded, alpha);
}
