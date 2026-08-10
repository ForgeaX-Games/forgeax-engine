declare module 'three' {
  export const BackSide: number;
  export const PerspectiveCamera: new (fov: number, aspect: number, near: number, far: number) => any;
  export const Color: new (value?: number) => any;
  export const DataTexture: new (...args: any[]) => any;
  export const DoubleSide: number;
  export const DirectionalLight: new (...args: any[]) => any;
  export const LinearSRGBColorSpace: string;
  export const Mesh: new (...args: any[]) => any;
  export const MeshBasicMaterial: new (...args: any[]) => any;
  export const MeshStandardMaterial: new (...args: any[]) => any;
  export const NearestFilter: number;
  export const NoBlending: number;
  export const PlaneGeometry: new (...args: any[]) => any;
  export const RGBAFormat: number;
  export const RenderTarget: new (width: number, height: number, options?: object) => any;
  export const Scene: new () => any;
  export const SRGBColorSpace: string;
  export const SphereGeometry: new (...args: any[]) => any;
  export const UnsignedByteType: number;
  export const WebGLRenderer: new (options?: object) => any;
}

declare module 'three/webgpu' {
  export const PMREMGenerator: new (...args: any[]) => {
    fromScene(scene: any, sigma?: number, near?: number, far?: number, options?: object): {
      texture: { dispose(): void };
      dispose(): void;
    };
    dispose(): void;
  };
  export const WebGPURenderer: new (options?: object) => any;
}
