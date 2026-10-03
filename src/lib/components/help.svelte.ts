import type { HelpKey } from '$lib/catalog/help';

/** The setting whose explanation is open, shared by every HelpButton and the one HelpDialog. */
export const openHelp = $state<{ key: HelpKey | null }>({ key: null });
