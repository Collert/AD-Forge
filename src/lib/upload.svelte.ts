/** The file the user picked on the landing page, handed to the configurator. */
export const pendingUpload = $state<{ file: File | null }>({ file: null });
