import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { compile } from '@tailwindcss/node'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

/** Compile the canonical app theme and chat primitives locally for MV3. */
export async function buildSidepanel(root) {
  const cssSource = `@import "${require.resolve('tailwindcss/index.css')}"; @import "../../packages/chat-ui/src/theme.css"; @import "../../packages/chat-ui/src/appearance.css";`
  const source = readFileSync(join(root, 'src/sidepanel.tsx'), 'utf8')
  const compiler = await compile(cssSource, {
    base: root, onDependency: () => {},
  })
  const candidates = [...new Set(source.match(/[^\s"'`<>{}=;]+/g) ?? [])]
  const css = compiler.build(candidates)
  writeFileSync(join(root, 'dist/app-chat.css'), css)
  await build({
    entryPoints: [join(root, 'src/sidepanel.tsx')],
    outfile: join(root, 'dist/sidepanel.js'), bundle: true, format: 'esm',
    platform: 'browser', target: 'chrome116', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, minify: true,
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildSidepanel(join(dirname(fileURLToPath(import.meta.url)), '..'))
