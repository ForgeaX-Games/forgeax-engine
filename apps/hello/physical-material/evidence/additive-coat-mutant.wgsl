// Test-only additive-coat falsifier source marker.
// The executable artifact is derived from the product WGSL at smoke time:
// baseRadiance * (1 - F) + coatRadiance * F -> baseRadiance + coatRadiance * F
fn additive_coat_mutation(baseRadiance: vec3<f32>, coatRadiance: vec3<f32>, factor: f32) -> vec3<f32> {
  return baseRadiance + coatRadiance * factor;
}
