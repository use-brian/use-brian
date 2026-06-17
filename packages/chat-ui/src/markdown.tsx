import Markdown from 'react-markdown'
import { normalizeBullets } from './normalize-markdown.js'

export type ChatMarkdownProps = {
  text: string
  /** Pass-through for react-markdown components map (custom renderers). */
  components?: Parameters<typeof Markdown>[0]['components']
  /** Pass-through for remarkPlugins. */
  remarkPlugins?: Parameters<typeof Markdown>[0]['remarkPlugins']
}

/**
 * Wraps `react-markdown` with the project's bullet-normalization pre-pass.
 * Consumers can extend rendering via `components` or `remarkPlugins` — the
 * package itself stays plugin-free so it doesn't drag transitive deps into
 * every consumer.
 */
export function ChatMarkdown(props: ChatMarkdownProps) {
  const text = normalizeBullets(props.text)
  return (
    <Markdown components={props.components} remarkPlugins={props.remarkPlugins}>
      {text}
    </Markdown>
  )
}
