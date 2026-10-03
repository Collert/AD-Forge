import { error } from '@sveltejs/kit';
import { processes } from '$lib/catalog/config';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, parent }) => {
	const process = processes.find((p) => p.id === params.process);
	if (!process || process.comingSoon) error(404, 'Unknown manufacturing method');

	const { catalog } = await parent();
	const available =
		process.kind === 'resin'
			? catalog.resins.length > 0
			: process.kind === 'machining'
				? catalog.stockMaterials.length > 0
				: catalog.materialCategories.some((c) => c.materials.some((m) => process.enclosed || !m.requiresEnclosure));
	if (!available) error(503, `No materials are available for ${process.title} right now.`);

	return { processId: process.id };
};
