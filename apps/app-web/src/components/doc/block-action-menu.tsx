"use client";

/**
 * Notion-style block-action menu — opens when the drag handle's grip is
 * CLICKED (vs dragged). Lists, in Notion order: Turn into (submenu), Color
 * (submenu), Copy link to block, Duplicate, Delete, Comment for AI. Every
 * mutating action is a ProseMirror transaction on the handle's target block, so
 * it syncs through y-prosemirror — no REST write-back (see `block-actions.ts`).
 *
 * The full menu is offered for text blocks AND for the opaque `embed` atom
 * (chart / diagram / data / image / file / bookmark / video / audio /
 * child_page) — embeds declare the same color/blockId attrs and can host a
 * whole-block comment, so they're first-class, not stripped to Copy/Dup/Delete.
 * Turn-into on an embed REPLACES it (an atom has no text to convert in place),
 * except callout/toggle which wrap it; Comment-for-AI on an embed opens a
 * `human_block` thread (no inline mark). The divider — the only other
 * block-level atom — stays minimal (colouring / commenting a rule is moot).
 *
 * The menu is **capability-gated**, not doc-page-hardwired, so restricted
 * hosts (the skill body editor's md-only StarterKit schema) reuse it as-is:
 * Turn-into lists only the kinds `editorTurnIntoKinds` finds representable in
 * THIS editor's schema (an unfiltered list would throw on `toggleTaskList`
 * where task lists aren't registered, or no-op on `setHeading` past the
 * configured levels); Color shows only when the node type declares the
 * `color`/`bgColor` attrs (`blockDeclaresColor` — plain StarterKit nodes
 * don't, and `setNodeMarkup` silently drops undeclared attrs); Copy-link
 * needs the `workspaceId`+`pageId` page context (a markdown-string host has
 * no page to deep-link into). The full doc schema passes every gate, so the
 * doc surface renders the complete menu unchanged.
 *
 * Rendered through a portal to `document.body`: the grip lives inside the drag
 * handle's tippy popup (a transformed ancestor), which would trap a `fixed`
 * child — so the menu escapes to the body and positions itself against the
 * grip's viewport rect. A custom popover (mirroring `turn-into-menu.tsx`) rather
 * than base-ui's DropdownMenu, whose Positioner would fight tippy's.
 *
 * Actions read `getTarget()` LIVE at click time, not a frozen snapshot: the
 * drag-handle plugin remaps the target across remote Yjs edits (its view-update
 * path keeps `onNodeChange` firing while pinned), so the freshest `pos` is
 * always in the ref. Delete is the one async path — it captures the block's
 * `blockId` and re-resolves the position AFTER the confirm dialog, since a
 * collaborator could shift the doc during the prompt.
 *
 * [COMP:app-web/block-action-menu]
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  Ban,
  Check,
  ChevronRight,
  CopyPlus,
  Link2,
  MessageSquare,
  Palette,
  Trash2,
  Type,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { useCoarsePointer } from "@/lib/viewport";
import { BLOCK_HASH_PREFIX } from "@/lib/doc-page-url";
import { bestInternalShareLink } from "@/lib/api/internal-links";
import { TURN_INTO_ITEMS, type TurnIntoKind } from "./turn-into-menu";
import {
  applyTurnIntoAt,
  blockDeclaresColor,
  canHoldCaret,
  clearBlockColor,
  deleteBlockSelectionOrAt,
  duplicateBlockAt,
  editorTurnIntoKinds,
  ensureBlockId,
  selectBlockText,
  setBlockColor,
  type BlockTarget,
} from "./block-actions";

/**
 * The named color palette. `id: null` is "Default" (clears the field). The id
 * is the exact string written into the block's `color` / `bgColor` attr; the
 * hex lives ONLY in `globals.css` under `[data-color]` / `[data-bg]`.
 */
const PALETTE = [
  { id: null, labelKey: "colorDefault" },
  { id: "gray", labelKey: "colorGray" },
  { id: "brown", labelKey: "colorBrown" },
  { id: "orange", labelKey: "colorOrange" },
  { id: "yellow", labelKey: "colorYellow" },
  { id: "green", labelKey: "colorGreen" },
  { id: "blue", labelKey: "colorBlue" },
  { id: "purple", labelKey: "colorPurple" },
  { id: "pink", labelKey: "colorPink" },
  { id: "red", labelKey: "colorRed" },
] as const;

type ColorLabelKey = (typeof PALETTE)[number]["labelKey"];

/**
 * Map the menu's TARGET block node to its `TurnIntoKind`, so the turn-into
 * submenu can mark the current type with a checkmark (CHROME-4). Derived from
 * the node — NOT `editor.isActive`, which reads the caret selection that may
 * differ from the handle's target block. Returns null for kinds turn-into
 * can't represent (embed atoms, divider).
 */
function turnIntoKindForNode(node: PMNode): TurnIntoKind | null {
  switch (node.type.name) {
    case "paragraph":
      return "paragraph";
    case "heading": {
      const lvl = node.attrs.level as number;
      return lvl >= 1 && lvl <= 4 ? (`heading_${lvl}` as TurnIntoKind) : null;
    }
    case "bulletList":
      return "bulleted_list";
    case "orderedList":
      return "numbered_list";
    case "taskList":
      return "to_do";
    case "blockquote":
      return "quote";
    case "callout":
      return "callout";
    case "toggle":
      return "toggle";
    case "codeBlock":
      return "code";
    default:
      return null;
  }
}

/**
 * Grace period before a hover submenu (Turn into / Color) closes after the
 * cursor leaves its row. The flyout sits a few px to the right of the row
 * (`ml-1`), so the pointer crosses dead space — or clips a sibling row — on its
 * way to a swatch; closing instantly unmounted the flyout mid-travel (the
 * reported "the colour picker disappeared when I moved to select"). The delay
 * keeps it mounted long enough to reach, and re-entering the row or its flyout
 * cancels the close.
 */
const SUBMENU_CLOSE_DELAY_MS = 180;

export type BlockActionMenuProps = {
  editor: Editor;
  /** Reads the CURRENT drag-handle target (node + remapped pos) at action time.
   *  Returns null if the handle no longer points at a block. */
  getTarget: () => BlockTarget | null;
  /** The grip element to anchor against. */
  anchorEl: HTMLElement | null;
  onClose: () => void;
  /** Comment for AI on a TEXT block — reuses the selection-based `onComment`;
   *  the menu selects the block's text first. Absent when comments unavailable. */
  onComment?: () => void;
  /** Comment for AI on an ATOM block (chart / image / data / …) — opens a
   *  whole-block (`human_block`) comment keyed on the block's id (minted here if
   *  absent). Absent when comments are unavailable. */
  onBlockComment?: (blockId: string) => void;
  /** Page context backing "Copy link to block". Absent on a non-page host
   *  (the skill body editor — a markdown string, no deep-linkable page), which
   *  hides the row instead of minting a link that resolves to nothing. */
  workspaceId?: string;
  pageId?: string;
};

export function BlockActionMenu({
  editor,
  getTarget,
  anchorEl,
  onClose,
  onComment,
  onBlockComment,
  workspaceId,
  pageId,
}: BlockActionMenuProps) {
  const t = useT().docPage;
  const ba = t.blockActions;
  const ref = useRef<HTMLDivElement | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const subCloseTimer = useRef<number | undefined>(undefined);
  const [sub, setSub] = useState<null | "turn" | "color">(null);

  // Hover submenus open on enter and close on a short INTENT DELAY, not
  // instantly — see SUBMENU_CLOSE_DELAY_MS. The panel is portalled beside
  // the row, so it wires its own enter/leave to the same open/close pair:
  // re-entering the panel clears the pending close; opening one submenu also
  // cancels the other's scheduled close so they never both linger.
  const openSub = (name: "turn" | "color") => {
    window.clearTimeout(subCloseTimer.current);
    setSub(name);
  };
  const scheduleCloseSub = () => {
    window.clearTimeout(subCloseTimer.current);
    subCloseTimer.current = window.setTimeout(() => setSub(null), SUBMENU_CLOSE_DELAY_MS);
  };
  const [copied, setCopied] = useState(false);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: "hidden" });
  // Touch mode (responsive contract M2 / M5): submenus open on TAP and render
  // as a second level INSIDE the menu (a hover fly-out beside a 240px menu
  // has nowhere to go on a 390px phone), and every row is a 44px target.
  const coarse = useCoarsePointer();
  // Desktop fly-outs open to the right; when the menu sits against the right
  // edge (a wide-column layout, a narrow window) the fly-out would run
  // off-screen, so it opens to the LEFT instead.
  const [flyoutSide, setFlyoutSide] = useState<"right" | "left">("right");

  // Position against the grip's viewport rect (fixed; the portal escapes the
  // tippy transform). Opens just below the grip, clamped inside the viewport:
  // on a phone the grip sits at the block's RIGHT edge, so an unclamped menu
  // would open off-screen, and an inline submenu can grow the menu past the
  // bottom edge. Layout effect + measured height so the clamp lands before
  // paint; re-run when a submenu opens or closes (`sub`).
  useLayoutEffect(() => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    const margin = 8;
    const menuWidth = ref.current?.offsetWidth || 240;
    const menuHeight = ref.current?.offsetHeight || 0;
    const left = Math.max(margin, Math.min(r.left, window.innerWidth - menuWidth - margin));
    let top = r.bottom + 4;
    if (menuHeight > 0 && top + menuHeight > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - margin - menuHeight);
    }
    setStyle({ position: "fixed", top, left });
    // The widest fly-out is the colour grid (`w-56` = 224px) plus its 4px gap.
    setFlyoutSide(left + menuWidth + 4 + 224 > window.innerWidth - margin ? "left" : "right");
  }, [anchorEl, sub]);

  // Outside-click + Esc dismissal (turn-into-menu.tsx idiom).
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      const node = e.target as Node;
      if (ref.current?.contains(node)) return;
      if (anchorEl?.contains(node)) return; // re-clicking the grip is handled there
      // The hover panel is portalled beside the menu, so it is not inside
      // `ref`. A press on it is part of the menu, not an outside dismiss.
      const el = node instanceof Element ? node : node.parentElement;
      if (el?.closest("[data-popover='block-actions-flyout']")) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchorEl, onClose]);

  // Clear pending timers (the "copied" flash reset and the submenu close-intent
  // grace period) if the menu unmounts mid-flight.
  useEffect(
    () => () => {
      window.clearTimeout(copyTimer.current);
      window.clearTimeout(subCloseTimer.current);
    },
    [],
  );

  if (typeof document === "undefined") return null;
  // Render-time snapshot, for display only (the active swatch, which rows show).
  // Actions re-read getTarget() so they act on the freshest remapped position.
  const target = getTarget();
  if (!target) return null;
  const node = target.node;
  const currentKind = turnIntoKindForNode(node); // for the turn-into checkmark (CHROME-4)
  const isTextblock = node.isTextblock;
  const caretBlock = canHoldCaret(node); // non-atom: colourable + caret-hostable
  const hasText = caretBlock && node.textContent.trim().length > 0;
  // The opaque `embed` atom (chart / diagram / data / image / file / bookmark /
  // video / audio / child_page) is a first-class block: it declares the same
  // color + blockId attrs (doc-model schema) and can host a whole-block
  // comment, so it gets the FULL menu — Turn into / Color / Comment for AI —
  // not the stripped Copy/Duplicate/Delete subset. (The divider, the only other
  // block-level atom, stays minimal — `node.type.name !== "embed"`.)
  const isEmbed = node.type.name === "embed";
  const activeColor = (node.attrs.color as string | null) ?? null;
  const activeBg = (node.attrs.bgColor as string | null) ?? null;
  // Comment for AI: text blocks anchor a precise range (`onComment`); embeds
  // anchor the whole block (`onBlockComment`, a `human_block` thread).
  const showComment = (!!onComment && hasText) || (!!onBlockComment && isEmbed);
  // ── Capability gates — the menu offers what THIS editor can do ──────────
  // The same menu serves the full doc surface and restricted hosts (the skill
  // body editor's md-only schema), so each doc-schema-dependent section keys
  // off a capability, not the host: Turn-into lists only schema-representable
  // kinds, Color needs the node to declare the `color`/`bgColor` attrs, and
  // Copy-link needs a page to deep-link into.
  const schemaKinds = editorTurnIntoKinds(editor);
  const turnIntoItems = TURN_INTO_ITEMS.filter((it) => schemaKinds.has(it.id));
  const colorable = (caretBlock || isEmbed) && blockDeclaresColor(node);
  const canCopyLink = Boolean(workspaceId && pageId);

  /** Run a mutating action on the LIVE target, then close. */
  const act = (fn: (target: BlockTarget) => void) => () => {
    const tg = getTarget();
    if (tg) fn(tg);
    onClose();
  };

  const onCopyLink = () => {
    const tg = getTarget();
    if (!tg || !workspaceId || !pageId || typeof window === "undefined") return;
    const id = ensureBlockId(editor, tg.pos);
    if (!id) return; // node type can't carry a blockId — don't mint a dead link
    const hashHref = `${BLOCK_HASH_PREFIX}${id}`;
    // `navigator.clipboard` is undefined in an insecure context — calling
    // .writeText would throw synchronously (before any promise), so the
    // promise-chain catch can't cover it. Guard the API, fall back to the hash.
    if (!navigator.clipboard?.writeText) {
      window.location.hash = hashHref;
      return;
    }
    void bestInternalShareLink({ workspaceId, pageId, blockId: id })
      .then(({ url }) => navigator.clipboard.writeText(url))
      .then(() => {
        setCopied(true);
        window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {
        window.location.hash = hashHref;
      });
    // Copy intentionally keeps the menu open to show the "copied" state.
  };

  const onDelete = () => {
    const tg = getTarget();
    if (!tg) {
      onClose();
      return;
    }
    // Delete immediately — no confirmation. The handle's trash affordance is
    // explicit enough, and block deletion is undoable via the editor history.
    // When a multi-block area selection is active and this block is part of it,
    // delete the WHOLE selection (not just the single handle target).
    onClose();
    deleteBlockSelectionOrAt(editor, tg.pos);
  };

  const onCommentClick = () => {
    const tg = getTarget();
    if (!tg) {
      onClose();
      return;
    }
    // Atom embed → whole-block comment: mint/read its id and hand it to the
    // block-anchored flow (no text range to select). Text block → the precise
    // range comment, selecting the block's text first.
    if (tg.node.type.name === "embed") {
      const id = ensureBlockId(editor, tg.pos);
      if (id && onBlockComment) onBlockComment(id);
    } else if (onComment && selectBlockText(editor, tg.pos)) {
      onComment();
    }
    onClose();
  };

  const menu = (
    <div
      ref={ref}
      role="menu"
      aria-label={ba.menuLabel}
      data-popover="block-actions"
      style={style}
      // Keep the editor selection/focus intact when clicking inside the menu.
      onMouseDown={(e) => e.preventDefault()}
      data-coarse={coarse ? "true" : undefined}
      className={
        "z-[60] w-60 max-w-[calc(100vw-1rem)] max-h-[calc(100dvh-1rem)] overflow-y-auto rounded-md border border-border bg-popover py-1 text-sm shadow-lg" +
        // 44px rows on touch (M3): every menu item and radio swatch.
        (coarse
          ? " [&_[role=menuitem]]:min-h-11 [&_[role=menuitemradio]]:min-h-11 [&_[role=menuitemradio]]:min-w-11"
          : "")
      }
    >
      {(isTextblock || isEmbed) && turnIntoItems.length > 0 ? (
        <SubmenuRow
          icon={Type}
          label={ba.turnInto}
          open={sub === "turn"}
          onOpen={() => openSub("turn")}
          onClose={scheduleCloseSub}
          inline={coarse}
          flyoutSide={flyoutSide}
          onToggle={() => setSub((cur) => (cur === "turn" ? null : "turn"))}
        >
          {turnIntoItems.map((it) => {
            const Ic = it.icon;
            const active = currentKind === it.id;
            return (
              <MenuButton
                key={it.id}
                checked={active}
                onClick={act((tg) => applyTurnIntoAt(editor, tg.pos, it.id))}
              >
                <Ic className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex-1 truncate">{t.slashMenu.items[it.labelKey]}</span>
                {active ? (
                  <Check className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden />
                ) : null}
              </MenuButton>
            );
          })}
        </SubmenuRow>
      ) : null}

      {colorable ? (
        <SubmenuRow
          icon={Palette}
          label={ba.color}
          open={sub === "color"}
          onOpen={() => openSub("color")}
          onClose={scheduleCloseSub}
          inline={coarse}
          flyoutSide={flyoutSide}
          onToggle={() => setSub((cur) => (cur === "color" ? null : "color"))}
          wide
        >
          <ColorGrid
            heading={ba.colorText}
            active={activeColor}
            swatch={(id) => (id ? { color: `var(--doc-color-${id})` } : { color: "var(--foreground)" })}
            glyph="A"
            label={(key) => ba[key]}
            // Color picks keep the menu open so text + background can be set in
            // one pass (Notion behaviour); read the LIVE target each pick.
            onPick={(id) => {
              const tg = getTarget();
              if (tg) setBlockColor(editor, tg.pos, "color", id);
            }}
          />
          <ColorGrid
            heading={ba.colorBackground}
            active={activeBg}
            swatch={(id) => (id ? { background: `var(--doc-bg-${id})` } : { background: "transparent" })}
            label={(key) => ba[key]}
            onPick={(id) => {
              const tg = getTarget();
              if (tg) setBlockColor(editor, tg.pos, "bgColor", id);
            }}
          />
          {activeColor || activeBg ? (
            <MenuButton
              onClick={() => {
                const tg = getTarget();
                if (tg) clearBlockColor(editor, tg.pos);
              }}
            >
              <Ban className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
              <span className="flex-1 truncate">{ba.colorClear}</span>
            </MenuButton>
          ) : null}
        </SubmenuRow>
      ) : null}

      <Divider />

      {canCopyLink ? (
        <MenuButton onClick={onCopyLink} keepFocus>
          {copied ? (
            <Check className="h-4 w-4 flex-shrink-0 text-primary" aria-hidden />
          ) : (
            <Link2 className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="flex-1 truncate">{copied ? ba.copied : ba.copyLink}</span>
        </MenuButton>
      ) : null}

      <MenuButton onClick={act((tg) => duplicateBlockAt(editor, tg.pos))}>
        <CopyPlus className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
        <span className="flex-1 truncate">{ba.duplicate}</span>
      </MenuButton>

      <MenuButton onClick={() => void onDelete()} destructive>
        <Trash2 className="h-4 w-4 flex-shrink-0" aria-hidden />
        <span className="flex-1 truncate">{ba.delete}</span>
      </MenuButton>

      {showComment ? <Divider /> : null}

      {showComment ? (
        <MenuButton onClick={onCommentClick}>
          <MessageSquare className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1 truncate">{ba.comment}</span>
        </MenuButton>
      ) : null}
    </div>
  );

  return createPortal(menu, document.body);
}

function Divider() {
  return <div className="my-1 h-px bg-border" aria-hidden />;
}

/** A plain menu row. `keepFocus` lets a row (Copy) avoid stealing editor
 *  focus while still being clickable. */
function MenuButton({
  onClick,
  destructive,
  keepFocus,
  checked,
  children,
}: {
  onClick: () => void;
  destructive?: boolean;
  keepFocus?: boolean;
  /** When defined, the row is a radio item (turn-into) with a checked state. */
  checked?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      onMouseDown={keepFocus ? (e) => e.preventDefault() : undefined}
      onClick={onClick}
      className={
        "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted " +
        (destructive ? "text-destructive [&_svg]:text-destructive" : "text-foreground")
      }
    >
      {children}
    </button>
  );
}

/**
 * A row that opens its child list as its own panel on hover (Notion submenu).
 *
 * `inline` is the touch mode (responsive contract M2 / M5): there is no hover
 * to open on and no room beside a 240px menu on a phone, so the row toggles on
 * TAP (`onToggle`) and the child list renders as a second level INSIDE the
 * menu, directly under the row, with the chevron turned down. The hover
 * handlers are not bound in that mode: a tap fires a synthetic `mouseenter`
 * first, which would open the panel before the tap could toggle it.
 *
 * On a fine pointer the panel is portalled to `document.body`. The parent
 * menu scrolls (`overflow-y-auto`) when the viewport is short; a flyout
 * inside that box is clipped and becomes more scroll height, so hovering
 * Turn into made people scroll the menu to see the options. The panel sits
 * beside the row instead. A click (or Enter / Space) opens it too, so a
 * keyboard user and a stylus have a path that does not depend on
 * `mouseenter`. `flyoutSide` flips it to the left when the menu sits against
 * the right edge. Entering the panel cancels the row's close delay; the
 * panel is not a DOM child, so it wires that itself.
 */
function SubmenuRow({
  icon: Icon,
  label,
  open,
  onOpen,
  onClose,
  onToggle,
  inline = false,
  flyoutSide = "right",
  wide,
  children,
}: {
  icon: LucideIcon;
  label: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Tap toggle for `inline` mode. */
  onToggle?: () => void;
  /** Render the child list inside the menu instead of a hover panel. */
  inline?: boolean;
  /** Which side the panel opens on (fly-out mode only). */
  flyoutSide?: "right" | "left";
  wide?: boolean;
  children: React.ReactNode;
}) {
  const rowRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({
    position: "fixed",
    visibility: "hidden",
  });

  useLayoutEffect(() => {
    if (inline || !open || !rowRef.current || !panelRef.current) return;
    const row = rowRef.current.getBoundingClientRect();
    const panel = panelRef.current.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const width = panel.width || (wide ? 224 : 208);
    const height = panel.height;
    const openLeft =
      flyoutSide === "left" || row.right + gap + width > window.innerWidth - margin;
    const top = Math.max(margin, Math.min(row.top, window.innerHeight - margin - height));
    const left = openLeft
      ? Math.max(margin, row.left - gap - width)
      : row.right + gap;
    setPanelStyle({ position: "fixed", top, left, visibility: "visible" });
  }, [inline, open, flyoutSide, wide, children]);

  const panel =
    open && !inline && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={panelRef}
            role="menu"
            data-submenu="flyout"
            data-flyout-side={flyoutSide}
            data-popover="block-actions-flyout"
            style={panelStyle}
            onMouseEnter={onOpen}
            onMouseLeave={onClose}
            onMouseDown={(e) => e.preventDefault()}
            className={
              "z-[61] max-h-[min(24rem,calc(100dvh-1rem))] overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg " +
              (wide ? "w-56" : "w-52")
            }
          >
            {children}
          </div>,
          document.body,
        )
      : null;

  return (
    <div
      onMouseEnter={inline ? undefined : onOpen}
      onMouseLeave={inline ? undefined : onClose}
    >
      <button
        ref={rowRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={inline ? onToggle : onOpen}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground transition-colors hover:bg-muted"
      >
        <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
        <span className="flex-1 truncate">{label}</span>
        <ChevronRight
          size={14}
          className={"text-muted-foreground" + (inline && open ? " rotate-90" : "")}
          aria-hidden
        />
      </button>
      {inline && open ? (
        <div
          role="menu"
          data-submenu="inline"
          className="mx-2 mb-1 rounded-md border border-border/70 bg-muted/30 p-1"
        >
          {children}
        </div>
      ) : null}
      {panel}
    </div>
  );
}

/** A labelled grid of color swatches (Text or Background). */
function ColorGrid({
  heading,
  active,
  swatch,
  glyph,
  label,
  onPick,
}: {
  heading: string;
  active: string | null;
  swatch: (id: string | null) => React.CSSProperties;
  glyph?: string;
  label: (key: ColorLabelKey) => string;
  onPick: (id: string | null) => void;
}) {
  return (
    <div className="px-1 pb-1">
      <div className="px-1 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {heading}
      </div>
      <div className="grid grid-cols-5 gap-1">
        {PALETTE.map((c) => (
          <button
            key={c.labelKey}
            type="button"
            role="menuitemradio"
            aria-checked={active === c.id}
            aria-label={label(c.labelKey)}
            title={label(c.labelKey)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(c.id)}
            style={swatch(c.id)}
            className="relative flex h-7 w-7 items-center justify-center rounded border border-border text-xs font-semibold"
          >
            {c.id === null ? <Ban size={12} aria-hidden /> : (glyph ?? null)}
            {active === c.id && c.id !== null ? (
              <Check size={10} className="absolute -right-0.5 -top-0.5 rounded-full bg-background" aria-hidden />
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
