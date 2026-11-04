// Pure builder: brand/tokens.json -> tokens.css + src/tokens.generated.ts.
// No Node APIs here so the drift test and the CLI share exactly one code path.
// Run `node packages/ui-tokens/src/gen/cli.ts` to regenerate; never edit the outputs by hand.

type Leaf = { $value: string | number | number[]; $type?: string; $description?: string };
type Group = Record<string, unknown>;

export interface BrandTokens {
  color: Record<string, Leaf>;
  contrastPairs?: { pairs: { fg: string; bg: string; min: number; use: string }[] };
  font: {
    family: Record<'latin' | 'arabic' | 'switcher', Leaf> & Record<string, Leaf>;
    weight: Record<'regular' | 'emphasis', Leaf>;
    lineHeight: Record<string, Leaf>;
    letterSpacing: Record<string, Leaf>;
    synthesis: Leaf;
  };
  typeScale: {
    steps: Record<string, { role: string; px360: number; px1440: number; fluid: string }>;
    measure: Leaf;
  };
  space: Group;
  layout: Group;
  breakpoint: Group;
  radius: Group;
  shadow: Group;
  border: Group;
  motion: { duration: Group; easing: Group; distance: Leaf };
  zIndex: Group;
  icon: { grid: Leaf; stroke: Leaf; sizes: Leaf };
}

export interface BuildInput {
  tokens: BrandTokens;
  /** Repo-relative path of the JSON that was read, recorded in the output header. */
  sourcePath: string;
  /** sha256 hex of the source file bytes. */
  sourceSha256: string;
}

export interface BuildOutput {
  css: string;
  ts: string;
  /** The resolved values (same object the TS export serialises). */
  model: {
    fontSize: Record<string, { css: string; px360: number; px1440: number }>;
    space: Record<string, string>;
    radius: Record<string, string>;
    shadow: Record<string, string>;
    motion: { duration: Record<string, string>; easing: Record<string, string>; distance: string };
  };
}

/** Type-scale step index -> CSS name (`--fs-<name>`). A new brand step must be named here. */
export const STEP_NAMES: Record<string, string> = {
  '-2': 'caption',
  '-1': 'small',
  '0': 'body',
  '1': 'lead',
  '2': 'h3',
  '3': 'h2',
  '4': 'h1',
  '5': 'display',
  '6': 'hero',
};

const MIN_VW = 360;
const MAX_VW = 1440;
const TOLERANCE_PX = 0.5;

const leaves = (g: Group): [string, Leaf][] =>
  Object.entries(g).filter(
    (e): e is [string, Leaf] => !e[0].startsWith('$') && typeof e[1] === 'object' && e[1] !== null && '$value' in e[1],
  );

const val = (l: Leaf): string => String(l.$value);

const round = (n: number, d = 4): string => {
  const s = n.toFixed(d).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

/** Linear clamp() between two viewport widths, rem-based so it respects user font size. */
export function fluid(minPx: number, maxPx: number, minVw = MIN_VW, maxVw = MAX_VW): string {
  if (minPx === maxPx) return `${round(minPx / 16)}rem`;
  const slope = (maxPx - minPx) / (maxVw - minVw);
  const intercept = minPx - slope * minVw;
  return `clamp(${round(minPx / 16)}rem, ${round(intercept / 16)}rem + ${round(slope * 100)}vw, ${round(maxPx / 16)}rem)`;
}

/** Evaluate a `clamp(Arem, Brem + Cvw, Drem)` or `Nrem` string at a viewport width, in px (16px root). */
export function evalFluid(expr: string, vw: number): number {
  const plain = /^([\d.]+)rem$/.exec(expr.trim());
  if (plain) return Number(plain[1]) * 16;
  const m = /^clamp\(\s*([\d.]+)rem\s*,\s*(-?[\d.]+)rem\s*\+\s*([\d.]+)vw\s*,\s*([\d.]+)rem\s*\)$/.exec(expr.trim());
  if (!m) throw new Error(`Unsupported fluid expression: ${expr}`);
  const [lo, b, c, hi] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  return Math.min(hi * 16, Math.max(lo * 16, b * 16 + (c * vw) / 100));
}

function checkFluid(name: string, expr: string, px360: number, px1440: number): void {
  for (const [vw, want] of [
    [MIN_VW, px360],
    [MAX_VW, px1440],
  ] as const) {
    const got = evalFluid(expr, vw);
    if (Math.abs(got - want) > TOLERANCE_PX) {
      throw new Error(`${name}: ${expr} gives ${round(got, 2)}px at ${vw}px, brand says ${want}px`);
    }
  }
}

function px(v: string): number {
  const m = /^(-?[\d.]+)px$/.exec(v);
  if (!m) throw new Error(`Expected a px value, got ${v}`);
  return Number(m[1]);
}

export function buildTokens({ tokens: t, sourcePath, sourceSha256 }: BuildInput): BuildOutput {
  // ---- validation: the contract's hard rules (CLAUDE.md) ----
  for (const role of ['surface', 'text', 'text-secondary', 'accent', 'accent-text', 'focus', 'border-control', 'danger', 'on-accent']) {
    if (!t.color[role]) throw new Error(`color.${role} missing`);
  }
  const lh = t.font.lineHeight;
  for (const k of ['latin-body', 'latin-heading', 'latin-display', 'latin-ui', 'arabic-body', 'arabic-heading', 'arabic-ui']) {
    if (!lh[k]) throw new Error(`font.lineHeight.${k} missing`);
  }
  for (const [k, l] of leaves(lh)) {
    const n = Number(l.$value);
    if (!Number.isFinite(n)) throw new Error(`font.lineHeight.${k} must be unitless, got ${l.$value}`);
    if (k.startsWith('arabic') && (n < 1.6 || n > 1.8)) throw new Error(`font.lineHeight.${k}=${n}: Arabic must be 1.6–1.8`);
  }
  const ls = t.font.letterSpacing;
  if (!ls.arabic || Number.parseFloat(val(ls.arabic)) !== 0) throw new Error('font.letterSpacing.arabic must be 0');
  if (val(t.font.synthesis) !== 'none') throw new Error('font.synthesis must be none (Arabic is one static 400 weight)');
  for (const k of Object.keys(t.typeScale.steps)) if (!STEP_NAMES[k]) throw new Error(`typeScale step ${k} has no CSS name`);

  const layout = t.layout as Record<string, Record<string, unknown>>;
  const L = (k: string): Record<string, unknown> => {
    const v = layout[k];
    if (!v) throw new Error(`layout.${k} missing`);
    return v;
  };

  // ---- resolved values ----
  const fontSize: Record<string, { css: string; px360: number; px1440: number }> = {};
  for (const [k, s] of Object.entries(t.typeScale.steps).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    checkFluid(`typeScale.steps.${k}`, s.fluid, s.px360, s.px1440);
    fontSize[STEP_NAMES[k] as string] = { css: s.fluid, px360: s.px360, px1440: s.px1440 };
  }

  const fluidLayout = (k: string): { css: string; px360: number; px1440: number } => {
    const g = L(k);
    const css = String(g.fluid);
    checkFluid(`layout.${k}`, css, Number(g.px360), Number(g.px1440));
    return { css, px360: Number(g.px360), px1440: Number(g.px1440) };
  };
  const grid = L('grid');
  const gridGap = { css: fluid(px(String(grid.gap360)), px(String(grid.gap1440))), px360: px(String(grid.gap360)), px1440: px(String(grid.gap1440)) };
  const layoutVal = (k: string): string => String(L(k).$value);

  const arabicDisplay = lh['arabic-display'] ?? lh['arabic-heading'];
  const icon = t.icon;
  const iconSizes = icon.sizes.$value as number[];
  const iconNames = ['sm', 'md', 'lg'];
  if (iconSizes.length !== iconNames.length) throw new Error('icon.sizes must have 3 entries');

  const model = {
    color: Object.fromEntries(leaves(t.color).map(([k, l]) => [k, val(l)])),
    font: {
      family: { latin: val(t.font.family.latin), arabic: val(t.font.family.arabic), switcher: val(t.font.family.switcher) },
      weight: { regular: Number(t.font.weight.regular.$value), emphasis: Number(t.font.weight.emphasis.$value) },
      lineHeight: {
        latin: { body: Number(lh['latin-body']!.$value), heading: Number(lh['latin-heading']!.$value), display: Number(lh['latin-display']!.$value), ui: Number(lh['latin-ui']!.$value) },
        arabic: { body: Number(lh['arabic-body']!.$value), heading: Number(lh['arabic-heading']!.$value), display: Number(arabicDisplay!.$value), ui: Number(lh['arabic-ui']!.$value) },
      },
      letterSpacing: {
        latin: Object.fromEntries(leaves(ls).filter(([k]) => k.startsWith('latin-')).map(([k, l]) => [k.slice(6), val(l)])),
        arabic: '0',
      },
      synthesis: val(t.font.synthesis),
    },
    fontSize,
    measure: val(t.typeScale.measure),
    space: Object.fromEntries(leaves(t.space).map(([k, l]) => [k, val(l)])),
    layout: {
      gutter: fluidLayout('gutter'),
      sectionBlock: fluidLayout('section-block'),
      containerMax: layoutVal('container-max'),
      readingMax: layoutVal('reading-max'),
      headerH: layoutVal('header-height'),
      bottomBarH: layoutVal('bottom-bar-height'),
      tapMin: layoutVal('tap-min'),
      gridGap,
      gridColumns: { 360: Number(grid.columns360), 768: Number(grid.columns768), 1024: Number(grid.columns1024) },
    },
    breakpoint: Object.fromEntries(leaves(t.breakpoint).map(([k, l]) => [k, px(val(l))])),
    radius: Object.fromEntries(leaves(t.radius).map(([k, l]) => [k, val(l)])),
    shadow: Object.fromEntries(leaves(t.shadow).map(([k, l]) => [k, val(l)])),
    borderWidth: Object.fromEntries(leaves(t.border).map(([k, l]) => [k, val(l)])),
    motion: {
      duration: Object.fromEntries(leaves(t.motion.duration).map(([k, l]) => [k, val(l)])),
      easing: Object.fromEntries(leaves(t.motion.easing).map(([k, l]) => [k, val(l)])),
      distance: val(t.motion.distance),
    },
    zIndex: Object.fromEntries(leaves(t.zIndex).map(([k, l]) => [k, Number(l.$value)])),
    icon: {
      grid: px(val(icon.grid)),
      stroke: Number.parseFloat(val(icon.stroke)),
      size: Object.fromEntries(iconSizes.map((s, i) => [iconNames[i] as string, s])),
    },
  };

  // ---- CSS ----
  const decl: string[] = ['color-scheme:light'];
  const add = (name: string, value: string | number): void => {
    decl.push(`--${name}:${value}`);
  };
  for (const [k, v] of Object.entries(model.color)) add(`color-${k}`, v);
  add('font-latin', model.font.family.latin);
  add('font-arabic', model.font.family.arabic);
  add('font-switcher', model.font.family.switcher);
  add('font-body', 'var(--font-latin)');
  add('fw-regular', model.font.weight.regular);
  add('fw-emphasis', model.font.weight.emphasis);
  for (const [k, v] of Object.entries(model.font.lineHeight.latin)) add(`lh-${k}`, v);
  for (const [k, v] of Object.entries(model.font.letterSpacing.latin)) add(`ls-${k}`, v);
  for (const [k, v] of Object.entries(model.fontSize)) add(`fs-${k}`, v.css);
  add('measure', model.measure);
  for (const [k, v] of Object.entries(model.space)) add(`space-${k}`, v);
  add('gutter', model.layout.gutter.css);
  add('section-block', model.layout.sectionBlock.css);
  add('container-max', model.layout.containerMax);
  add('reading-max', model.layout.readingMax);
  add('header-h', model.layout.headerH);
  add('bottom-bar-h', model.layout.bottomBarH);
  add('tap-min', model.layout.tapMin);
  add('grid-gap', model.layout.gridGap.css);
  if (!model.space['2']) throw new Error('space.2 missing (scroll padding)');
  add('scroll-pad-start', 'calc(var(--header-h) + var(--space-2))');
  add('scroll-pad-end', 'calc(var(--bottom-bar-h) + var(--space-2))');
  for (const [k, v] of Object.entries(model.radius)) add(`radius-${k}`, v);
  for (const [k, v] of Object.entries(model.shadow)) add(`shadow-${k}`, v);
  // border.focus -> --focus-width, border.focus-offset -> --focus-offset, the rest -> --bw-<name>.
  for (const [k, v] of Object.entries(model.borderWidth)) add(k === 'focus' ? 'focus-width' : k === 'focus-offset' ? k : `bw-${k}`, v);
  for (const [k, v] of Object.entries(model.motion.duration)) add(`dur-${k}`, v);
  for (const [k, v] of Object.entries(model.motion.easing)) add(`ease-${k}`, v);
  add('motion-distance', model.motion.distance);
  for (const [k, v] of Object.entries(model.zIndex)) add(`z-${k}`, v);
  for (const [k, v] of Object.entries(model.icon.size)) add(`icon-${k}`, `${v}px`);

  // Arabic, on every Arabic element (:lang matches descendants, unlike [lang]).
  // Custom properties give components the Arabic values. The three real properties are needed
  // because letter-spacing / font-weight / font-synthesis are inherited as *computed* values: a
  // lang="ar" span inside a French h1 would otherwise keep the h1's resolved letter-spacing.
  // They are CLAUDE.md/brand invariants (no letter-spacing, one 400 weight, no faux bold), so they
  // are unlayered and !important: no component rule can bring them back.
  const ar: string[] = [
    'letter-spacing:0!important',
    `font-weight:${model.font.weight.regular}!important`,
    `font-synthesis:${model.font.synthesis}!important`,
    '--font-body:var(--font-arabic)',
    `--fw-emphasis:${model.font.weight.regular}`,
    ...Object.entries(model.font.lineHeight.arabic).map(([k, v]) => `--lh-${k}:${v}`),
    ...Object.keys(model.font.letterSpacing.latin).map((k) => `--ls-${k}:0`),
  ];
  const reduced = Object.keys(model.motion.duration).map((k) => `--dur-${k}:0.01ms`);
  const bp = Object.entries(model.breakpoint)
    .map(([k, v]) => `${k} ${v}px`)
    .join(', ');

  const header = `GENERATED by packages/ui-tokens/src/gen/cli.ts from ${sourcePath} (sha256 ${sourceSha256}). Do not edit.`;
  const css =
    `/* ${header}\n` +
    `   Breakpoints (min-width; custom properties cannot be used in @media, write the literal): ${bp}. */\n` +
    `:root{\n${decl.map((d) => `  ${d};`).join('\n')}\n}\n` +
    `:lang(ar){\n${ar.map((d) => `  ${d};`).join('\n')}\n}\n` +
    `@media (prefers-reduced-motion:reduce){:root{${reduced.join(';')}}}\n`;

  const ts =
    `// ${header}\n` +
    `// Same values as tokens.css. Admin and build scripts import this; the storefront uses tokens.css.\n\n` +
    `export const tokensSource = ${JSON.stringify({ path: sourcePath, sha256: sourceSha256 })} as const;\n\n` +
    `export const tokens = ${JSON.stringify(model, null, 2)} as const;\n\n` +
    `export type Tokens = typeof tokens;\n\n` +
    `/** tokens.css as a string, for server-rendered pages (admin) that inline it. */\n` +
    `export const tokensCss = ${JSON.stringify(css)};\n`;

  return { css, ts, model };
}
