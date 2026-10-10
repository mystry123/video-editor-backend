/**
 * Caption style categories, in the order the galleries show them. Users'
 * own styles are "custom" (shown as "My styles"). Keep in sync with the
 * frontend copy (app/components/editor-v2/captions/captionCategories.ts).
 */
export const PRESET_CATEGORIES = [
  { id: 'trending', name: 'Trending', description: 'What creators are using right now' },
  { id: 'word-by-word', name: 'Word by word', description: 'One word at a time, karaoke and pops' },
  { id: 'bold', name: 'Bold', description: 'Heavy type that grabs attention' },
  { id: 'minimal', name: 'Minimal', description: 'Clean and quiet' },
  { id: 'box-pill', name: 'Box & Pill', description: 'Captions on a box or a pill' },
  { id: 'neon-glow', name: 'Neon & Glow', description: 'Glowing colour' },
  { id: 'fun', name: 'Fun', description: 'Comic, marker and playful fonts' },
  { id: 'elegant', name: 'Elegant', description: 'Serif and script' },
  { id: 'podcast', name: 'Podcast & Education', description: 'Readable, two-line, calm' },
];
