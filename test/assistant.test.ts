import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, createUser } from './helpers';
import { UsageCounter } from '../src/models/Usage';
import { currentPeriod } from '../src/services/usage.service';
import { setGeminiClient, type GeminiRequest, type GeminiResult } from '../src/services/ai/gemini';

const replies: GeminiResult[] = [];
const requests: GeminiRequest[] = [];
const fake = {
  generate: vi.fn(async (req: GeminiRequest) => {
    requests.push(req);
    const next = replies.shift();
    if (!next) throw new Error('no fake reply');
    return next;
  }),
};
const reply = (text: string, calls: GeminiResult['calls'] = []): GeminiResult => ({ text, calls, usage: { input: 100, output: 20 } });

beforeEach(() => {
  replies.length = 0;
  requests.length = 0;
  fake.generate.mockClear();
  setGeminiClient(fake);
});
afterEach(() => setGeminiClient(null));

const caps = { animations: { in: ['pop', 'fade'], out: ['fade'], loop: ['pulse'] }, transitions: ['cross-zoom', 'fade'], fonts: ['Inter', 'Poppins'], dubLanguages: ['hi', 'es'] };
const body = (text: string, extra: Record<string, unknown> = {}) => ({
  mode: 'edit',
  messages: [{ role: 'user', text }],
  context: 'Project 1080x1920, 10s\nc1 text "Hello" 0–3s',
  capabilities: caps,
  ...extra,
});
const used = async (userId: unknown) => (await UsageCounter.findOne({ userId, kind: 'aiMessages', period: currentPeriod() }).lean())?.total ?? 0;

describe('assistant', () => {
  it('returns valid tool calls, with the project summary and the tools sent to the model', async () => {
    const user = await createUser();
    replies.push(reply('Making the title pop in.', [
      { name: 'update_clip', args: { id: 'c1', font_size: 96, color: '#FFCC00' } },
      { name: 'set_animation', args: { id: 'c1', slot: 'in', preset: 'pop', duration: 0.4 } },
    ]));
    const res = await api().post('/api/v1/ai/chat').set(user.auth).send(body('make the title pop and yellow'));
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Making the title pop in.');
    expect(res.body.calls.map((c: any) => c.name)).toEqual(['update_clip', 'set_animation']);
    expect(res.body.problems).toEqual([]);
    const sent = requests[0];
    expect(sent.messages.at(-1)!.text).toContain('PROJECT SUMMARY');
    expect(sent.messages.at(-1)!.text).toContain('make the title pop and yellow');
    const tools = sent.tools!.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['add_text', 'update_clip', 'set_keyframes', 'set_animation', 'set_transition', 'add_voiceover', 'dub_clip']));
    // Allow-lists became enums
    const animation = sent.tools!.find((t) => t.name === 'set_animation')!.parameters as any;
    expect(animation.properties.preset.enum).toEqual(['none', 'pop', 'fade', 'pulse']);
    expect(await used(user.user._id)).toBe(1);
  });

  it('sends invalid calls back once, then to the stronger model, and returns only valid ones', async () => {
    const user = await createUser();
    replies.push(reply('', [{ name: 'set_animation', args: { id: 'c1', slot: 'out', preset: 'pop' } }, { name: 'launch_rockets', args: {} }]));
    replies.push(reply('', [{ name: 'update_clip', args: { id: 'c1', color: 'yellow' } }]));
    replies.push(reply('Fixed.', [{ name: 'update_clip', args: { id: 'c1', color: '#FFFF00' } }]));
    const res = await api().post('/api/v1/ai/chat').set(user.auth).send(body('...'));
    expect(res.status).toBe(200);
    expect(fake.generate).toHaveBeenCalledTimes(3);
    expect(requests[1].messages.at(-1)!.text).toMatch(/not available for that slot/);
    expect(requests[1].messages.at(-1)!.text).toMatch(/launch_rockets: there is no such tool/);
    expect(requests[2].model).toBe('gemini-2.5-pro');
    expect(res.body).toMatchObject({ reply: 'Fixed.', model: 'gemini-2.5-pro', problems: [] });
    expect(res.body.calls).toEqual([{ name: 'update_clip', args: { id: 'c1', color: '#FFFF00' } }]);
  });

  it('Ask mode sends no tools and returns no edits', async () => {
    const user = await createUser();
    replies.push(reply('Select the clip, then use Clean up audio.', [{ name: 'delete_clips', args: { ids: ['c1'] } }]));
    const res = await api().post('/api/v1/ai/chat').set(user.auth).send(body('how do I remove noise?', { mode: 'ask' }));
    expect(requests[0].tools).toBeUndefined();
    expect(res.body.calls).toEqual([]);
  });

  it('stops at the monthly message limit, and refunds when the model fails', async () => {
    const user = await createUser(); // free: 20
    await UsageCounter.create({ userId: user.user._id, kind: 'aiMessages', period: currentPeriod(), total: 20 });
    const over = await api().post('/api/v1/ai/chat').set(user.auth).send(body('hi'));
    expect(over.status).toBe(403);
    expect(JSON.stringify(over.body)).toMatch(/AI_MESSAGES_EXCEEDED/);

    const other = await createUser();
    fake.generate.mockRejectedValueOnce(new Error('vertex down'));
    const failed = await api().post('/api/v1/ai/chat').set(other.auth).send(body('hi'));
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(await used(other.user._id)).toBe(0);
  });

  it('validates the request', async () => {
    const user = await createUser();
    expect((await api().post('/api/v1/ai/chat').set(user.auth).send({ ...body('x'), messages: [{ role: 'model', text: 'x' }] })).status).toBe(400);
    expect((await api().post('/api/v1/ai/chat').set(user.auth).send({ ...body('x'), mode: 'yolo' })).status).toBe(400);
  });
});
