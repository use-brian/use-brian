'use client'

import { useEffect, useId, useState, type JSX } from 'react'
import type { DiagramWidget } from '../types.js'

/**
 * ELK is registered once, on the first diagram render, alongside mermaid's own
 * lazy import. Mermaid's default engine (dagre) lays out most graphs fine; ELK
 * packs complex, multi-subgraph flowcharts far more tightly and routes their
 * edges cleanly. We only REGISTER the loader here — we never set it as the
 * global default — so default rendering is unchanged and the non-flowchart
 * families ELK doesn't support are never touched. A diagram opts in per-graph
 * with `%%{init: {"layout": "elk"}}%%` (the model emits this on request, e.g.
 * when the user asks to tidy a tangled graph; see the doc authoring soul).
 */
let elkRegistered = false

/**
 * A2UI diagram — Mermaid wrapper. Compiles the widget's `code`
 * (`graph TD`, `sequenceDiagram`, `erDiagram`, `mindmap`, …) to SVG in
 * the browser and paints it inline.
 *
 * Mermaid is **lazy-loaded** (`await import('mermaid')`) inside the
 * effect so the ~heavy parser only enters the bundle when a page
 * actually renders a diagram, and never runs during SSR (it touches
 * `document`). `securityLevel: 'strict'` makes mermaid sanitise labels,
 * so the resulting SVG is safe to inject.
 *
 * **On-brand theming.** Instead of mermaid's stock `default`/`dark`
 * palettes (which read as raw, off-brand boxes), the widget drives the
 * `base` theme with `themeVariables` derived **live from the host's CSS
 * tokens** (`--primary`, `--background`, `--foreground`, `--border`,
 * `--muted` …) read off `document.documentElement` via `getComputedStyle`.
 * Nodes get a faint primary-tinted fill with a soft brand border, edges
 * a muted line, notes/clusters a subtle wash — so a flowchart looks like
 * it belongs on the doc surface. Because the values are read from the
 * host, the diagram is automatically **dark-mode** and **custom-palette**
 * aware: a `MutationObserver` on the root's `class` / `data-palette`
 * re-renders the SVG when the theme switches, with no per-host config.
 *
 * **Modern polish (`polishSvg`).** Mermaid's stock SVG reads flat and
 * dated, and — worse — a model that authors its own `classDef`/`style`
 * fills (stage colours: yellow / orange / green …) keeps the *label* ink
 * at the global foreground colour, so light text lands on a light fill
 * and washes out. After render we walk the SVG once and: round node
 * corners, lift each node with a soft elevation shadow, round subgraph
 * clusters, thicken + round the edges, and run a per-node **auto-contrast**
 * pass — the label ink is recomputed from each fill's relative luminance
 * (dark ink on light fills, light ink on dark), so the author's stage
 * colours survive *and* every label stays legible. The pass is scoped to
 * the diagram's own `<svg id>` so it never leaks onto sibling diagrams,
 * and is wrapped in try/catch — any failure falls back to the raw SVG.
 *
 * On a parse error the source is shown verbatim in a tombstone (the same
 * read as a failed data resolve) rather than throwing — a malformed
 * diagram must never blank the page.
 *
 * [COMP:views/diagram]
 */
export function Diagram(props: { widget: DiagramWidget }): JSX.Element {
  const { widget } = props
  // A DOM-safe, render-stable id for mermaid's internal <svg> handle.
  const rawId = useId()
  const renderId = `mermaid-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<boolean>(false)
  // Bumped when the host swaps theme / palette, forcing a re-read + re-render.
  const [themeTick, setThemeTick] = useState(0)

  // Re-render on host theme / palette change so the diagram recolours live.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    const obs = new MutationObserver(() => setThemeTick((t) => t + 1))
    obs.observe(root, { attributes: true, attributeFilter: ['class', 'data-palette'] })
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    setError(false)
    setSvg(null)
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        if (!elkRegistered) {
          try {
            const elk = (await import('@mermaid-js/layout-elk')).default
            mermaid.registerLayoutLoaders(elk)
            elkRegistered = true
          } catch {
            // ELK is a progressive enhancement: if it can't load, a
            // `layout: elk` directive falls back to the default engine rather
            // than failing the diagram. Never block a render on it.
          }
        }
        const theme = readMermaidTheme()
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          // On a parse/draw failure mermaid otherwise builds its built-in
          // "Syntax error in text" diagram, appends it to <body>, and throws
          // `parseEncounteredException` *before* its own removeTempElements()
          // runs (see render() in mermaid 11's mermaid.core.mjs) — orphaning
          // that error graphic at the page bottom-left, where it accumulates
          // one node per invalid render (e.g. every keystroke while the model
          // streams a half-written diagram). suppressErrorRendering makes
          // mermaid removeTempElements() and rethrow cleanly instead, so the
          // `catch` below renders our tombstone as the only failure surface.
          suppressErrorRendering: true,
          theme: 'base',
          themeVariables: theme.vars,
          // Smooth, rounded connectors read more polished than the default
          // straight links; generous spacing gives the graph room to breathe.
          flowchart: {
            curve: 'basis',
            padding: 16,
            nodeSpacing: 50,
            rankSpacing: 58,
            useMaxWidth: true,
          },
        })
        // Vary the render id per theme tick so mermaid never collides with a
        // stale element of the same id from the previous (pre-recolour) pass.
        const { svg: out } = await mermaid.render(`${renderId}-${themeTick}`, widget.code)
        if (!cancelled) setSvg(polishSvg(out, theme.nodeFill))
      } catch {
        if (!cancelled) setError(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [widget.code, renderId, themeTick])

  return (
    <figure className="flex w-full flex-col gap-2">
      {widget.title && (
        <h3 className="text-lg font-medium text-foreground">{widget.title}</h3>
      )}
      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <div className="mb-1 font-medium">Couldn’t render this diagram</div>
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs">
            {widget.code}
          </pre>
        </div>
      ) : svg ? (
        <div
          className="mermaid-diagram w-full overflow-x-auto rounded-xl border border-border bg-muted/30 p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          // Mermaid output is sanitised under securityLevel: 'strict'.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          Rendering diagram…
        </div>
      )}
    </figure>
  )
}

/** Mermaid `base` theme variables plus the derived node fill the polish
 * pass uses as its auto-contrast fallback for un-styled nodes. */
interface MermaidTheme {
  vars: Record<string, string>
  nodeFill: string
}

/**
 * Build mermaid `base` theme variables from the host's live CSS tokens.
 * Reads `document.documentElement`'s computed custom properties so the
 * diagram tracks whatever palette (light / dark / AI-generated custom)
 * the host has applied. Colours are blended down to concrete hex so
 * mermaid's internal colour maths (khroma) can parse them.
 */
function readMermaidTheme(): MermaidTheme {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string => {
    const got = cs.getPropertyValue(name).trim()
    return got || fallback
  }

  const bg = v('--background', '#ffffff')
  const fg = v('--foreground', '#37352f')
  const primary = v('--primary', '#2383e2')
  const border = v('--border', '#ededec')
  const muted = v('--muted', '#f7f6f3')
  const mutedFg = v('--muted-foreground', '#787774')

  // Derived, on-brand surfaces.
  const nodeFill = mix(primary, bg, 0.12) // faint primary wash for node bodies
  const nodeBorder = mix(primary, border, 0.5) // soft brand-tinted hairline
  const noteFill = mix(primary, bg, 0.16) // slightly deeper for sticky notes
  const clusterFill = mix(muted, bg, 0.55) // subtle subgraph backdrop
  const lineColor = mix(mutedFg, fg, 0.2) // calm, legible edges

  const vars = {
    fontFamily: 'inherit',
    fontSize: '14px',
    background: bg,
    // Core palette
    primaryColor: nodeFill,
    primaryTextColor: fg,
    primaryBorderColor: nodeBorder,
    secondaryColor: clusterFill,
    secondaryTextColor: fg,
    secondaryBorderColor: border,
    tertiaryColor: bg,
    tertiaryTextColor: fg,
    tertiaryBorderColor: border,
    lineColor,
    textColor: fg,
    titleColor: fg,
    // Flowchart nodes / clusters / edges
    mainBkg: nodeFill,
    nodeBorder,
    nodeTextColor: fg,
    clusterBkg: clusterFill,
    clusterBorder: border,
    defaultLinkColor: lineColor,
    edgeLabelBackground: bg,
    // Sequence diagrams
    actorBkg: nodeFill,
    actorBorder: nodeBorder,
    actorTextColor: fg,
    actorLineColor: lineColor,
    signalColor: fg,
    signalTextColor: fg,
    labelBoxBkgColor: nodeFill,
    labelBoxBorderColor: nodeBorder,
    labelTextColor: fg,
    loopTextColor: fg,
    noteBkgColor: noteFill,
    noteBorderColor: nodeBorder,
    noteTextColor: fg,
    activationBkgColor: clusterFill,
    activationBorderColor: border,
  }

  return { vars, nodeFill }
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Modernise a freshly-rendered mermaid SVG: round node + cluster corners,
 * lift nodes with a soft elevation shadow, refine the edges, and run a
 * per-node auto-contrast pass so labels stay legible on whatever fill the
 * node ended up with (theme wash *or* a model-authored `classDef` colour).
 *
 * Pure string-in / string-out: parses the SVG into a detached document,
 * mutates it, re-serialises. All rules are scoped to the SVG's own `id`
 * (mermaid stamps it with our render id) so nothing leaks onto sibling
 * diagrams. Any parse/serialise failure returns the input untouched — the
 * diagram must never blank on a polish error.
 */
function polishSvg(svgText: string, fallbackFill: string): string {
  if (typeof DOMParser === 'undefined') return svgText
  try {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
    if (doc.querySelector('parsererror')) return svgText
    const svg = doc.querySelector('svg')
    if (!svg) return svgText

    // Soft elevation shadow — reads as depth in light mode, stays neutral on
    // the near-black dark surface (where the fill + border carry the shape).
    let defs = svg.querySelector('defs')
    if (!defs) {
      defs = doc.createElementNS(SVG_NS, 'defs')
      svg.insertBefore(defs, svg.firstChild)
    }
    const filter = doc.createElementNS(SVG_NS, 'filter')
    filter.setAttribute('id', 'mm-elevation')
    filter.setAttribute('x', '-30%')
    filter.setAttribute('y', '-30%')
    filter.setAttribute('width', '160%')
    filter.setAttribute('height', '160%')
    const drop = doc.createElementNS(SVG_NS, 'feDropShadow')
    drop.setAttribute('dx', '0')
    drop.setAttribute('dy', '1.5')
    drop.setAttribute('stdDeviation', '3')
    drop.setAttribute('flood-color', '#0b1220')
    drop.setAttribute('flood-opacity', '0.18')
    filter.appendChild(drop)
    defs.appendChild(filter)

    // Scoped polish CSS — typography + rounded clusters/edge-labels + refined
    // edges. Scoped by the svg's id so it can't bleed onto other diagrams.
    const id = svg.getAttribute('id') ?? ''
    const s = id ? `#${id} ` : ''
    const style = doc.createElementNS(SVG_NS, 'style')
    style.textContent = [
      `${s}.nodeLabel,${s}.node text{font-weight:500;letter-spacing:-0.006em}`,
      `${s}.edgePaths path,${s}.flowchart-link{stroke-width:1.6px;stroke-linecap:round;stroke-linejoin:round}`,
      `${s}.cluster rect{rx:14px;ry:14px}`,
      `${s}.edgeLabel rect,${s}.edgeLabel foreignObject{rx:6px;ry:6px}`,
    ].join('')
    svg.insertBefore(style, svg.firstChild)

    // Per node: round the body, lift it, and force legible label ink.
    svg.querySelectorAll('g.node').forEach((node) => {
      node.querySelectorAll('rect').forEach((r) => {
        r.setAttribute('rx', '10')
        r.setAttribute('ry', '10')
      })
      const shape = node.querySelector('rect,polygon,ellipse,circle,path')
      if (shape) shape.setAttribute('filter', 'url(#mm-elevation)')
      const ink = readableInk(readFill(shape) ?? fallbackFill)
      node.querySelectorAll('text,tspan,.nodeLabel').forEach((label) => {
        const el = label as SVGElement
        el.style.setProperty('fill', ink)
        el.style.setProperty('color', ink)
      })
    })

    return new XMLSerializer().serializeToString(svg)
  } catch {
    return svgText
  }
}

/** The fill a shape actually paints with — inline `style="fill:…"` wins
 * (mermaid's base theme and model `classDef`s both inline it), else the
 * `fill` attribute. `none` / unset reads as "no explicit fill". */
function readFill(el: Element | null): string | null {
  if (!el) return null
  const inline = (el.getAttribute('style') ?? '').match(/fill:\s*([^;]+)/i)
  if (inline && inline[1].trim().toLowerCase() !== 'none') return inline[1].trim()
  const attr = el.getAttribute('fill')
  return attr && attr.toLowerCase() !== 'none' ? attr : null
}

/** Pick a near-black or near-white label ink for legibility against `color`,
 * via WCAG relative luminance. Unparseable colours fall back to dark ink.
 * Exported for unit test (`[COMP:views/diagram]`); not part of the package API. */
export function readableInk(color: string): string {
  const rgb = parseColor(color)
  if (!rgb) return '#1c2330'
  const lin = rgb.map((c) => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  })
  const luminance = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
  return luminance > 0.5 ? '#1c2330' : '#f4f6fb'
}

/** Parse a hex (`#rgb`/`#rrggbb`) or `rgb()`/`rgba()` colour to [r,g,b].
 * Exported for unit test (`[COMP:views/diagram]`); not part of the package API. */
export function parseColor(color: string): [number, number, number] | null {
  const hex = parseHex(color)
  if (hex) return hex
  const m = color.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Parse `#rgb` / `#rrggbb` (with or without the hash) to an [r,g,b] triple. */
function parseHex(hex: string): [number, number, number] | null {
  const m = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex(r: number, g: number, b: number): string {
  const c = (x: number): string =>
    Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/**
 * Blend `t` of colour `a` into colour `b` (`t=0` → `b`, `t=1` → `a`),
 * returning a concrete hex string. If either side isn't a parseable hex
 * (e.g. a custom palette authored in another colour space), fall back to
 * the foreground colour `a` unchanged — worst case the node is solid
 * brand colour, still on-theme.
 */
function mix(a: string, b: string, t: number): string {
  const ca = parseHex(a)
  const cb = parseHex(b)
  if (!ca || !cb) return a
  return toHex(
    cb[0] + (ca[0] - cb[0]) * t,
    cb[1] + (ca[1] - cb[1]) * t,
    cb[2] + (ca[2] - cb[2]) * t,
  )
}
