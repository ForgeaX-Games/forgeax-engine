import type { ShaderPreviewSelection } from '../shader-preview/session';
import type { ViewerModel } from '../viewer-model';

declare const model: ViewerModel;
declare function selectedShaderPreview(
  model: ViewerModel,
  workIndex: number,
  shaderModuleId: string,
): ShaderPreviewSelection | null;

const selection = selectedShaderPreview(model, 0, 'shader:fragment');
if (selection !== null) {
  selection.tapeDigest satisfies string;
  selection.workIndex satisfies number;
  selection.stage satisfies 'vertex' | 'fragment' | 'compute' | null;
  selection.shaderModuleId satisfies string;
  selection.source satisfies string;
}
