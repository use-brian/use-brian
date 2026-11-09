/**
 * Page fade behind a modal. A foreground tint dims a light page and
 * washes a dark page, so the surface behind the dialog reads as faded
 * in both themes. Positioning and z-index stay on the call site.
 * Dialog and alert-dialog backdrops also get this tint from globals.css,
 * which wins over a leftover background wash.
 */
export const modalScrimClassName = "bg-foreground/40 backdrop-blur-sm";
