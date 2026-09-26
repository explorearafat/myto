import type { ReactNode } from 'react'
import { fileTypeFor } from './fileTypes'

/**
 * The language brand logo for `path`, coloured with its brand hue (or the current
 * text colour for monochrome marks). `size` is the square px edge (default 16).
 */
export function FileIcon({ path, size = 16 }: { path: string; size?: number }): ReactNode {
  const type = fileTypeFor(path)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      style={type.color ? { color: type.color } : undefined}
    >
      <path d={type.path} />
    </svg>
  )
}
