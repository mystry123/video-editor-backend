// The built-in caption style library, curated over the original presets
// (caption-presets.seed.ts keeps their definitions):
// - every style gets one of the gallery categories and a place in the order;
// - near-duplicates are retired: hidden from the galleries, still usable by
//   id, because existing projects may point at them;
// - misnamed styles are renamed in place (same document);
// - new styles cover what creators use now (late 2026): word-by-word pops,
//   pills, karaoke, quiet lowercase, podcast boxes - with animations, which
//   none of the originals had.
// Every style here must pass schemas/captionStyle (a test checks).
//
// Fonts are Google Fonts (open licences), loaded by name in the editor and
// on the render servers.

export interface Curation {
  category: string;
  sortOrder: number;
  hidden?: boolean;
  /** New name (the document keeps its id) */
  rename?: string;
  /** Style fields to change */
  styles?: Record<string, unknown>;
  tags?: string[];
}

/** By original preset name */
export const CURATION: Record<string, Curation> = {
  'Indigo Italic': { category: 'bold', sortOrder: 300 },
  'Impact Bold': { category: 'bold', sortOrder: 310 },
  Cookie: { category: 'elegant', sortOrder: 720 },
  'Comic Pop': { category: 'fun', sortOrder: 600 },
  'Montserrat Bold': { category: 'bold', sortOrder: 320, rename: 'Slab Bold' },
  'Poppins Clean': { category: 'box-pill', sortOrder: 420 },
  'Inter Minimal': { category: 'minimal', sortOrder: 210 },
  'Righteous Glow': { category: 'neon-glow', sortOrder: 510 },
  'Passion One': { category: 'bold', sortOrder: 330 },
  'Rubik Mono': { category: 'neon-glow', sortOrder: 520 },
  'Marker Style': { category: 'fun', sortOrder: 610 },
  'Caveat Casual': { category: 'fun', sortOrder: 620 },
  // The pill is black with yellow text (it had no pill colour: red, and
  // black text on it)
  'Archivo Black': {
    category: 'box-pill',
    sortOrder: 430,
    styles: { highlightBackgroundColor: '#000000', highlightColor: '#FACC15' },
  },
  'Russo One': { category: 'bold', sortOrder: 340 },
  'Teko Sunset': { category: 'bold', sortOrder: 350 },
  'Bungee Neon': { category: 'neon-glow', sortOrder: 530 },
  'Playfair Elegant': { category: 'elegant', sortOrder: 700 },
  'Anton Classic': { category: 'bold', sortOrder: 360 },
  'Luckiest Guy': { category: 'fun', sortOrder: 630 },
  'Fredoka Fun': { category: 'fun', sortOrder: 640 },
  'Clean White': { category: 'minimal', sortOrder: 200 },
  'Bold Red': { category: 'bold', sortOrder: 370 },
  'Golden Bold': { category: 'bold', sortOrder: 380 },
  'Simple Black': { category: 'minimal', sortOrder: 220, tags: ['light videos'] },
  'Green Pop': { category: 'fun', sortOrder: 650 },
  // Near-duplicates of styles kept above
  'Neon Blue': { category: 'neon-glow', sortOrder: 9000, hidden: true },
  'Purple Glow': { category: 'neon-glow', sortOrder: 9001, hidden: true },
  'Comic Orange': { category: 'fun', sortOrder: 9002, hidden: true },
  'Bangers Shadow': { category: 'fun', sortOrder: 9003, hidden: true },
};

const outline = (width: number) => ({ strokeEnabled: true, strokeColor: '#000000', strokeWidth: width, strokeOpacity: 1 });
const softShadow = { shadowEnabled: true, shadowColor: '#000000', shadowOpacity: 0.6, shadowOffsetX: 0, shadowOffsetY: 4, shadowBlur: 10 };
const pop = (startScale = '60%', overshoot = '120%') => ({
  type: 'caption-word-pop',
  duration: 0.25,
  easing: 'back-out',
  params: { startScale, overshoot },
});

/** New styles (system, public). */
export const NEW_PRESETS = [
  {
    name: 'Word Pop',
    description: 'One word at a time, popping in - the short-form classic',
    category: 'word-by-word',
    sortOrder: 100,
    tags: ['trending', 'word by word', 'pop'],
    styles: {
      fontFamily: 'Montserrat', fontWeight: 900, textTransform: 'uppercase', fillColor: '#FFFFFF',
      ...outline(10), ...softShadow,
      displayMode: 'word', highlightStyle: 'none', lineHeight: 1.1,
      wordAnimation: pop('50%', '125%'),
    },
  },
  {
    name: 'Hormozi',
    description: 'Heavy caps, three words, the active word in yellow',
    category: 'trending',
    sortOrder: 10,
    tags: ['trending', 'bold', 'business'],
    styles: {
      fontFamily: 'Montserrat', fontWeight: 900, textTransform: 'uppercase', fillColor: '#FFFFFF',
      ...outline(9), ...softShadow,
      displayMode: 'tiktok', wordsPerLine: 3, linesPerPage: 1,
      highlightStyle: 'color', highlightColor: '#FFE600',
      inactiveColor: '#FFFFFF', inactiveOpacity: 1, upcomingOpacity: 1, lineHeight: 1.1,
      wordAnimation: { type: 'caption-word-scale', duration: 0.18, easing: 'quadratic-out', params: {} },
    },
  },
  {
    name: 'Dynamic Minimal',
    description: 'White heavy type with an outline and a subtle pop, no colour',
    category: 'trending',
    sortOrder: 20,
    tags: ['trending', 'minimal'],
    styles: {
      fontFamily: 'Montserrat', fontWeight: 800, fillColor: '#FFFFFF', ...outline(7),
      displayMode: 'tiktok', wordsPerLine: 3, linesPerPage: 1,
      highlightStyle: 'none', inactiveOpacity: 1, upcomingOpacity: 0.55, lineHeight: 1.1,
      wordAnimation: pop('85%', '108%'),
    },
  },
  {
    name: 'Black Pill',
    description: 'The active word on a black pill',
    category: 'box-pill',
    sortOrder: 30,
    tags: ['trending', 'pill'],
    styles: {
      fontFamily: 'Poppins', fontWeight: 700, fillColor: '#FFFFFF', ...outline(5),
      displayMode: 'tiktok', wordsPerLine: 3, linesPerPage: 1,
      highlightStyle: 'background', highlightBackgroundColor: '#000000', highlightColor: '#FFFFFF',
      inactiveOpacity: 1, upcomingOpacity: 1, lineHeight: 1.2,
    },
  },
  {
    name: 'Yellow Pill',
    description: 'Bold caps, the active word on a yellow pill',
    category: 'box-pill',
    sortOrder: 40,
    tags: ['trending', 'pill', 'bold'],
    styles: {
      fontFamily: 'Archivo Black', fontWeight: 400, textTransform: 'uppercase', fillColor: '#FFFFFF', ...outline(6),
      displayMode: 'tiktok', wordsPerLine: 3, linesPerPage: 1,
      highlightStyle: 'background', highlightBackgroundColor: '#FFE600', highlightColor: '#000000',
      inactiveOpacity: 1, upcomingOpacity: 1, lineHeight: 1.15,
      wordAnimation: pop('80%', '110%'),
    },
  },
  {
    name: 'Karaoke Sweep',
    description: 'Colour sweeps through each word as it is spoken',
    category: 'word-by-word',
    sortOrder: 110,
    tags: ['karaoke', 'music'],
    styles: {
      fontFamily: 'Poppins', fontWeight: 800, fillColor: '#FFFFFF', ...outline(6),
      displayMode: 'karaoke', wordsPerLine: 4, linesPerPage: 1,
      highlightColor: '#22C55E', lineHeight: 1.15,
    },
  },
  {
    name: 'Quiet Lowercase',
    description: 'Soft lowercase line for lifestyle and vlog content',
    category: 'minimal',
    sortOrder: 50,
    tags: ['trending', 'aesthetic', 'vlog'],
    styles: {
      fontFamily: 'Poppins', fontWeight: 500, textTransform: 'lowercase', fillColor: '#FFFFFF',
      ...softShadow, strokeEnabled: false,
      displayMode: 'static', wordsPerLine: 6, linesPerPage: 1, lineHeight: 1.25,
      pageEnter: { type: 'caption-page-fade', category: 'enter', duration: 0.2, easing: 'linear' },
    },
  },
  {
    name: 'Podcast Box',
    description: 'Two calm lines on a dark box, new box at each pause',
    category: 'podcast',
    sortOrder: 800,
    tags: ['podcast', 'education', 'interview'],
    styles: {
      fontFamily: 'Inter', fontWeight: 700, fillColor: '#FFFFFF',
      displayMode: 'tiktok', wordsPerLine: 5, linesPerPage: 2, pauseSplitMs: 700,
      highlightStyle: 'color', highlightColor: '#60A5FA', inactiveOpacity: 1, upcomingOpacity: 0.7,
      backgroundColor: 'rgba(0,0,0,0.72)', backgroundXPadding: 30, backgroundYPadding: 14, backgroundBorderRadius: 14,
      lineHeight: 1.3,
      pageEnter: { type: 'caption-page-fade', category: 'enter', duration: 0.18, easing: 'linear' },
    },
  },
  {
    name: 'Glow Pop',
    description: 'Caps with a cyan glow on the active word',
    category: 'neon-glow',
    sortOrder: 500,
    tags: ['neon', 'gaming'],
    styles: {
      fontFamily: 'Montserrat', fontWeight: 900, textTransform: 'uppercase', fillColor: '#FFFFFF', ...outline(5),
      displayMode: 'tiktok', wordsPerLine: 3, linesPerPage: 1,
      highlightStyle: 'glow', highlightColor: '#22D3EE', inactiveOpacity: 1, upcomingOpacity: 0.8, lineHeight: 1.1,
      wordAnimation: pop('75%', '115%'),
    },
  },
  {
    name: 'Lead & Fade',
    description: 'Readable lines that light words slightly early, fading between pages',
    category: 'podcast',
    sortOrder: 810,
    tags: ['education', 'tutorial'],
    styles: {
      fontFamily: 'Inter', fontWeight: 600, fillColor: '#FFFFFF', ...softShadow,
      displayMode: 'line', wordsPerLine: 6, linesPerPage: 2, leadMs: 80,
      highlightStyle: 'color', highlightColor: '#FFFFFF', inactiveOpacity: 1, upcomingOpacity: 0.5, lineHeight: 1.3,
      pageEnter: { type: 'caption-page-fade', category: 'enter', duration: 0.2, easing: 'linear' },
      pageExit: { type: 'caption-page-fade', category: 'exit', duration: 0.15, easing: 'linear' },
    },
  },
];
