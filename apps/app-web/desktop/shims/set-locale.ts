/**
 * The bundled file:// SPA has no Next server action or locale cookie endpoint.
 * Keep the settings call inert instead of bundling next/headers and next/cache
 * (and their server-only tracing runtime) into Electron's renderer process.
 */
export async function setLocaleAction(_formData: FormData): Promise<void> {}
