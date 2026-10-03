/// <reference lib="webworker" />
import { analyzeMachining } from './machining';
import { measureThickness } from './thickness';

export type AnalysisKind = 'thickness' | 'machining';
export type AnalysisRequest = { kind: AnalysisKind; id: number; positions: Float32Array };

self.onmessage = (e: MessageEvent<AnalysisRequest>) => {
	const { kind, id, positions } = e.data;
	if (kind === 'thickness') {
		const profile = measureThickness(positions);
		self.postMessage({ kind, id, profile }, [profile.thickness.buffer, profile.cumulativeArea.buffer]);
	} else {
		const profile = analyzeMachining(positions);
		self.postMessage({ kind, id, profile }, [profile.floors.buffer]);
	}
};
