# Workspace icon themes

The bottom-left theme picker opens the existing CreateThemeDialog. When the current workspace has an uploaded icon (`iconUrl`), the dialog offers **Use workspace icon**. Selecting it makes the description optional; any description steers the icon-grounded palette. Generation saves and immediately applies the theme through CustomThemesProvider, with the same shared-theme cap as prompt generation. Without an uploaded icon, the existing prompt-only flow is unchanged.

## API

`POST /api/workspaces/:workspaceId/doc-themes` also accepts `{ fromIcon: true, prompt?: string }`. The optional prompt must be nonempty when supplied and at most 600 characters. This is exclusive of `fromBrand`. Authentication and workspace membership are checked before reading the icon.

The server resolves the stored workspace icon pointer via workspace storage, checks image MIME and size, and supplies base64 image bytes to the configured background model. No caller-provided image URL is accepted. PNG, JPEG, WebP and GIF up to 5 MB are supported; generated landmark fallbacks and AVIF are not. Text-only workspace models cannot perform icon generation.

Errors are localized in the dialog:
- `no_workspace_icon` (409): upload an icon first.
- `unusable_workspace_icon` (422): upload a supported readable image.
- `theme_model_no_vision` (422): use a vision-capable background model or a description instead.

Existing prompt/brand generation, theme token validation, membership enforcement and theme-cap behavior are preserved.

## Tests

- `packages/api/src/routes/__tests__/doc-themes.test.ts`: authorization, trusted icon reads, validation, model routing and persistence.
- `packages/api/src/doc/__tests__/theme-generator.test.ts`: multimodal content and token generation.
- `apps/app-web/src/components/doc/create-theme-dialog.test.tsx`: visibility, prompt/icon submission and localized errors.
- `apps/app-web/src/lib/api/__tests__/doc-themes.test.ts`: request and error contracts.
- `apps/app-web/src/lib/__tests__/custom-themes.test.tsx`: generate, save and apply behavior.
