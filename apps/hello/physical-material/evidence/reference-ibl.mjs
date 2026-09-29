/** Diffuse term in the independent physical-material reference model. */
export function diffuseIblReference(albedo, incoming) {
  return albedo.map((value, channel) => value * incoming[channel]);
}

/** Source-only solid-angle quadrature of E/pi, with no GPU convolution inputs.
 * Equirect convention: u = atan2(z, x)/(2*pi)+.5, v = asin(y)/pi+.5.
 * Samples are texel centers; their latitude bands supply exact solid angles.
 */
export function integrateDiffuseEnvironment({ width, height, data }, normals) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || data.length !== width * height * 4) {
    throw new Error('Expected a nonempty linear RGBA equirectangular image');
  }
  const sums = normals.map(() => [0, 0, 0]);
  for (const normal of normals) {
    if (normal.length !== 3 || !normal.every(Number.isFinite) || Math.abs(Math.hypot(...normal) - 1) > 1e-8) {
      throw new Error('Expected unit reference normals');
    }
  }
  for (let y = 0; y < height; y += 1) {
    const latitude = ((y + 0.5) / height - 0.5) * Math.PI;
    const solidAngle = (2 * Math.PI / width)
      * (Math.sin(((y + 1) / height - 0.5) * Math.PI) - Math.sin((y / height - 0.5) * Math.PI));
    for (let x = 0; x < width; x += 1) {
      const longitude = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
      const direction = [Math.cos(latitude) * Math.cos(longitude), Math.sin(latitude), Math.cos(latitude) * Math.sin(longitude)];
      const offset = (y * width + x) * 4;
      for (let n = 0; n < normals.length; n += 1) {
        const cosine = Math.max(0, normals[n].reduce((sum, value, axis) => sum + value * direction[axis], 0));
        for (let channel = 0; channel < 3; channel += 1) {
          sums[n][channel] += data[offset + channel] * cosine * solidAngle / Math.PI;
        }
      }
    }
  }
  return sums;
}
