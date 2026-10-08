import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validate } from '../../src/middleware/validate.middleware';

async function run(schema: z.ZodTypeAny, body: unknown) {
  const req: any = { body, query: {}, params: {} };
  let error: unknown;
  await validate(schema)(req, {} as any, (err?: unknown) => {
    error = err;
  });
  return { body: req.body, error };
}

describe('validate middleware', () => {
  const schema = z.object({
    body: z.object({
      name: z.string().trim(),
      data: z.object({ project: z.object({ width: z.number() }) }),
      words: z.array(z.object({ text: z.string().trim(), start: z.number() })),
    }),
  });

  it('applies parsed values but keeps fields the schema does not list, at every depth', async () => {
    const { body, error } = await run(schema, {
      name: '  Title ',
      extra: true,
      data: { project: { width: 1080, backgroundColorOpacity: 0.5 } },
      words: [{ text: ' hi ', start: 0, speaker_id: 'S1' }],
    });
    expect(error).toBeUndefined();
    expect(body).toEqual({
      name: 'Title',
      extra: true,
      data: { project: { width: 1080, backgroundColorOpacity: 0.5 } },
      words: [{ text: 'hi', start: 0, speaker_id: 'S1' }],
    });
  });

  it('reports the first problem with its path', async () => {
    const { error } = await run(schema, { name: 'x', data: { project: { width: 'wide' } }, words: [] });
    expect((error as any).code).toBe('VALIDATION_ERROR');
    expect((error as any).details[0].path).toBe('data.project.width');
  });
});
