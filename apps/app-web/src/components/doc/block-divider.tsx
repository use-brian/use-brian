"use client";

/**
 * Renders a `DividerBlock` as a thin horizontal rule. The renderer
 * package ships an equivalent <Divider/> for inline A2UI dispatch;
 * we render directly here since the block chrome already wraps it.
 *
 * [COMP:app-web/page-renderer]
 */

export function BlockDivider() {
  return <hr className="my-4 border-t border-border" />;
}
