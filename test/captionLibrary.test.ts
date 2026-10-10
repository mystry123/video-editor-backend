import { describe, expect, it } from 'vitest';
import { api, createUser } from './helpers';
import { CaptionPreset } from '../src/models/CaptionPreset';
import { PRESET_CATEGORIES } from '../src/constants/preset-categories';
import { parseCaptionStyle } from '../src/schemas/captionStyle';
import { presetSlug, seedCaptionPresets, systemCaptionPresets } from '../src/seeds/caption-presets.seed';

describe('built-in caption library', () => {
  const library = systemCaptionPresets();
  const categories = new Set(PRESET_CATEGORIES.map((c) => c.id));

  it('every style is valid, in a known category, with a unique name', () => {
    const names = new Set<string>();
    for (const preset of library) {
      const parsed = parseCaptionStyle(preset.styles);
      expect(parsed.ok, `${preset.name}: ${parsed.ok ? '' : parsed.errors.join(', ')}`).toBe(true);
      expect(categories.has(preset.category), `${preset.name}: ${preset.category}`).toBe(true);
      expect(names.has(presetSlug(preset.name)), preset.name).toBe(false);
      names.add(presetSlug(preset.name));
    }
  });

  it('every category has styles, and trending ones have animations', () => {
    for (const id of categories) {
      expect(library.filter((p) => !p.isHidden && p.category === id).length, id).toBeGreaterThan(0);
    }
    expect(library.filter((p) => (p.styles as any).wordAnimation || (p.styles as any).pageEnter).length).toBeGreaterThanOrEqual(7);
  });

  it('seeding is repeatable: renames keep the document, usage counts survive, retired styles are hidden', async () => {
    // A database seeded with the original library
    const old = await CaptionPreset.create({ name: 'Montserrat Bold', slug: 'montserrat-bold', isSystem: true, styles: { fontFamily: 'Alfa Slab One' }, usageCount: 41 });
    await seedCaptionPresets();
    await seedCaptionPresets();

    const renamed = await CaptionPreset.findById(old._id).lean();
    expect(renamed!.name).toBe('Slab Bold');
    expect(renamed!.usageCount).toBe(41);
    expect(await CaptionPreset.countDocuments({ name: 'Slab Bold' })).toBe(1);
    expect(await CaptionPreset.countDocuments({ isSystem: true })).toBe(library.length);
    expect((await CaptionPreset.findOne({ name: 'Neon Blue' }).lean())!.isHidden).toBe(true);
  });

  it('a renamed style seeded before slugs existed is renamed, not duplicated', async () => {
    const old = await CaptionPreset.create({ name: 'Montserrat Bold', isSystem: true, styles: { fontFamily: 'Alfa Slab One' } });
    await CaptionPreset.collection.updateOne({ _id: old._id }, { $unset: { slug: 1 } });
    await seedCaptionPresets();
    expect(await CaptionPreset.countDocuments({ name: { $in: ['Montserrat Bold', 'Slab Bold'] } })).toBe(1);
    expect((await CaptionPreset.findById(old._id).lean())!.name).toBe('Slab Bold');
  });

  it('the gallery lists visible styles in order, never retired ones', async () => {
    await seedCaptionPresets();
    const { auth } = await createUser();
    const res = await api().get('/api/v1/caption/presets').set(auth);
    expect(res.status).toBe(200);
    const names: string[] = res.body.presets.map((p: any) => p.name);
    expect(names).not.toContain('Neon Blue');
    expect(names[0]).toBe('Hormozi');
    expect(res.body.categories.map((c: any) => c.id)[0]).toBe('trending');
  });

  it('query values are plain strings (no operator injection)', async () => {
    await seedCaptionPresets();
    const { auth } = await createUser();
    // As an operator this would select only the 2 trending styles
    const res = await api().get('/api/v1/caption/presets?category[$in][]=trending').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.presets.length).toBeGreaterThan(5); // ignored instead
  });
});
