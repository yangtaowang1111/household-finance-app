/* The same visual language as the web app, ported from public/styles.css.
 *
 * Kept as one file so consistency is structural rather than something anyone
 * has to maintain by hand: if the accent changes on the web, it changes here,
 * and nowhere else in the app names a colour.
 *
 * The web tokens are OKLCH, which React Native cannot parse. These are the same
 * colours converted to hex — visually identical, and the OKLCH values stay in
 * styles.css as the source they were derived from.
 */

const light = {
  bg: '#f7f6f4',
  surface: '#ffffff',
  text: '#3b3733',
  muted: '#7d7770',
  line: '#e4e1dd',
  lineSoft: '#f1efec',
  accent: '#3f8f97',
  accentSoft: '#e2f0f1',
  pos: '#3f8f63',
  attn: '#b26234',
  attnSoft: '#f8ece3',
};

const dark = {
  bg: '#1c1b19',
  surface: '#252320',
  text: '#eceae6',
  muted: '#9e9890',
  line: '#3a3733',
  lineSoft: '#2e2b28',
  accent: '#6fc3cb',
  accentSoft: '#26383a',
  pos: '#6fc98f',
  attn: '#dc9a63',
  attnSoft: '#3a2e24',
};

/* iOS type scale. Deliberately the system font rather than a bundled one: a
   finance app is read, not admired, and San Francisco is what every other app
   on the phone uses — which is most of what "feels native" actually means.
   Sizes follow the platform's own steps so Dynamic Type scales them sensibly. */
export const type = {
  largeTitle: { fontSize: 34, fontWeight: '700', letterSpacing: 0.37 },
  title: { fontSize: 22, fontWeight: '600' },
  headline: { fontSize: 17, fontWeight: '600' },
  body: { fontSize: 17, fontWeight: '400' },
  callout: { fontSize: 16, fontWeight: '400' },
  subhead: { fontSize: 15, fontWeight: '400' },
  footnote: { fontSize: 13, fontWeight: '400' },
  caption: { fontSize: 12, fontWeight: '400' },
  // Figures line up in a column only with tabular digits, which matters more in
  // a finance app than anywhere else.
  figure: { fontVariant: ['tabular-nums'], letterSpacing: -0.2 },
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const radius = { sm: 8, md: 12, lg: 16 };

export const palette = { light, dark };

/** Resolves the palette for the phone's current appearance. */
export function colors(scheme) {
  return scheme === 'dark' ? dark : light;
}
