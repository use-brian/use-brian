import type { JSX } from 'react'

/**
 * A2UI Image — avatar slot only in v1. Constrained size keeps the
 * renderer's surface narrow and prevents arbitrary-image spam.
 */
export function Image(props: {
  src: string
  alt: string
}): JSX.Element {
  return (
    <img
      src={props.src}
      alt={props.alt}
      className="h-6 w-6 rounded-full object-cover"
      // eslint-disable-next-line @next/next/no-img-element
    />
  )
}
