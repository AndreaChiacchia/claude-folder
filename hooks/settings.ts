import type { Edge, FoldWhen, Marker, Motion, Settings, Style } from '../types'

export const DEFAULT_SETTINGS: Settings = {
  style: 'rail',
  foldWhen: 'next',
  lines: 2,
  marker: 'triangles',
  edge: 'half',
  motion: 'lively',
}

/** `value` when it is one of `options`, else `fallback`. */
function pick<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : fallback
}

/** The /config values as the module uses them: each falls back to its default when it is not one of its options. */
export function normalizeSettings(options: Record<string, unknown>): Settings {
  return {
    style: pick<Style>(options.style, ['rail', 'boxed', 'zebra', 'rules'], DEFAULT_SETTINGS.style),
    foldWhen: pick<FoldWhen>(options.foldWhen, ['next', 'finish'], DEFAULT_SETTINGS.foldWhen),
    lines: options.lines === '1' ? 1 : options.lines === '3' ? 3 : 2,
    marker: pick<Marker>(options.marker, ['triangles', 'hollow', 'plus', 'ascii'], DEFAULT_SETTINGS.marker),
    edge: pick<Edge>(options.edge, ['half', 'thin', 'line', 'ascii'], DEFAULT_SETTINGS.edge),
    motion: pick<Motion>(options.motion, ['lively', 'subtle', 'off'], DEFAULT_SETTINGS.motion),
  }
}
