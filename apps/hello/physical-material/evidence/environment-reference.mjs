// Independent CPU quadrature of linear incident radiance. No renderer, shader,
// baked cube, GPU readback, or candidate measurements enter this oracle.
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const normalize = (v) => { const length = Math.hypot(...v); return v.map((x) => x / length); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const fresnel = (cosine) => 0.04 + 0.96 * (1 - Math.max(0, Math.min(1, cosine))) ** 5;

function radicalInverse(bits) {
  let value = 0;
  let weight = 0.5;
  while (bits > 0) { value += (bits % 2) * weight; bits = Math.floor(bits / 2); weight *= 0.5; }
  return value;
}

export function equirectRadiance({ width, height, data }) {
  return (direction) => {
    const n = normalize(direction);
    const x = (Math.atan2(n[2], n[0]) / (2 * Math.PI) + 0.5) * width - 0.5;
    const y = Math.acos(Math.max(-1, Math.min(1, n[1]))) / Math.PI * height - 0.5;
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const result = [0, 0, 0];
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const offset = (Math.max(0, Math.min(height - 1, iy + dy)) * width + ((ix + dx) % width + width) % width) * 4;
      const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      for (let c = 0; c < 3; c++) result[c] += data[offset + c] * weight;
    }
    return result;
  };
}

export function integrateEnvironment(normal, view, material, radiance, samples = 16384) {
  const nv = Math.max(dot(normal, view), 0.001);
  const tangent = normalize(cross(Math.abs(normal[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0], normal));
  const bitangent = cross(normal, tangent);
  const direction = (x, y, z) => normal.map((n, c) => tangent[c] * x + bitangent[c] * y + n * z);
  const diffuse = [0, 0, 0];
  const specular = [0, 0, 0];
  const coat = [0, 0, 0];
  const smith = (cosine, alphaSquared) => 2 * cosine / (cosine + Math.sqrt(alphaSquared + (1 - alphaSquared) * cosine * cosine));
  const integrateSpecular = (u, phi, roughness, result) => {
    const alphaSquared = Math.max(roughness, 0.04) ** 4;
    const nh = Math.sqrt((1 - u) / (1 + (alphaSquared - 1) * u));
    const sinTheta = Math.sqrt(Math.max(0, 1 - nh * nh));
    const half = direction(sinTheta * Math.cos(phi), sinTheta * Math.sin(phi), nh);
    const vh = dot(view, half);
    if (vh <= 0) return;
    const light = half.map((h, c) => 2 * vh * h - view[c]);
    const nl = dot(normal, light);
    if (nl <= 0) return;
    const weight = fresnel(vh) * smith(nv, alphaSquared) * smith(nl, alphaSquared) * vh / (nh * nv);
    const sample = radiance(light);
    for (let c = 0; c < 3; c++) result[c] += sample[c] * weight / samples;
  };
  for (let i = 0; i < samples; i++) {
    const u = (i + 0.5) / samples;
    const phi = 2 * Math.PI * radicalInverse(i);
    const radius = Math.sqrt(u);
    const sample = radiance(direction(radius * Math.cos(phi), radius * Math.sin(phi), Math.sqrt(1 - u)));
    for (let c = 0; c < 3; c++) diffuse[c] += sample[c] / samples;
    integrateSpecular(u, phi, material.roughness, specular);
    integrateSpecular(u, phi, material.clearcoatRoughness, coat);
  }
  const coatF = material.clearcoat * fresnel(nv);
  return diffuse.map((value, c) =>
    ((1 - fresnel(nv)) * material.baseColor[c] * value + specular[c]) * (1 - coatF) + material.clearcoat * coat[c],
  );
}
