/**
 * Design-token theme shape for taikocss.
 *
 * Pass an instance of this object to `pigment({ theme })` in your
 * `vite.config.ts`. The values are resolved at build time and baked into
 * the generated CSS — no runtime cost.
 */

type CSSValue = string | number

export interface ColorTokens {
  [key: string]: CSSValue
}

export interface SpacingTokens {
  /** Base spacing unit in pixels. Multiply to derive scale steps. */
  unit: number
  [key: string]: CSSValue
}

export interface TypographyTokens {
  fontFamily?: string
  fontSize?: CSSValue
  fontWeight?: CSSValue
  lineHeight?: CSSValue
  [key: string]: CSSValue | undefined
}

export interface ColorSchemeVariant {
  colors?: ColorTokens
  [key: string]: Record<string, CSSValue> | undefined
}

export interface ColorScheme {
  light?: ColorSchemeVariant
  dark?: ColorSchemeVariant
}

export interface Theme {
  /** Colour tokens — e.g. `{ primary: 'tomato', secondary: 'cyan' }` */
  colors?: ColorTokens
  /** Spacing tokens — e.g. `{ unit: 8 }` */
  spacing?: SpacingTokens
  /** Typography tokens — e.g. `{ fontFamily: 'Inter, sans-serif' }` */
  typography?: TypographyTokens
  /**
   * Named colour schemes, each with optional `light` and `dark` variants.
   * The plugin emits CSS custom-property blocks scoped to
   * `[data-color-scheme="<name>"][data-mode="<light|dark>"]` selectors.
   */
  colorSchemes?: Record<string, ColorScheme>
}