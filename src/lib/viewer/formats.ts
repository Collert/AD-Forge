/** Model formats the viewer can open (mesh formats, plus STEP / IGES via OpenCascade). */
export const PREVIEWABLE_FORMATS = ['stl', 'obj', '3mf', 'ply', 'step', 'stp', 'iges', 'igs'] as const;
export type PreviewFormat = (typeof PREVIEWABLE_FORMATS)[number];

/** For `<input type="file" accept>`. */
export const MODEL_ACCEPT = PREVIEWABLE_FORMATS.map((f) => `.${f}`).join(',');
