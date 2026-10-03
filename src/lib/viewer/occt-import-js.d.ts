declare module 'occt-import-js' {
	export type OcctMesh = {
		name: string;
		attributes: { position: { array: number[] }; normal?: { array: number[] } };
		index: { array: number[] };
	};
	export type OcctResult = { success: boolean; meshes: OcctMesh[] };
	export type OcctParams = {
		linearUnit?: 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot';
		linearDeflectionType?: 'bounding_box_ratio' | 'absolute_value';
		linearDeflection?: number;
		angularDeflection?: number;
	} | null;
	export type Occt = {
		ReadStepFile(content: Uint8Array, params: OcctParams): OcctResult;
		ReadIgesFile(content: Uint8Array, params: OcctParams): OcctResult;
	};
	export default function occtimportjs(overrides?: { locateFile?: (path: string) => string }): Promise<Occt>;
}
