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

  it('remembers preferences, and puts them in every request\'s instructions', async () => {
    const user = await createUser();
    const added = await api().post('/api/v1/ai/memory').set(user.auth).send({ note: 'Titles use Poppins Bold, white' });
    expect(added.status).toBe(201);
    expect(added.body.memory.map((m: any) => m.note)).toEqual(['Titles use Poppins Bold, white']);
    // Same note again: not duplicated
    expect((await api().post('/api/v1/ai/memory').set(user.auth).send({ note: 'titles use poppins bold, white' })).body.memory.length).toBe(1);
    replies.push(reply('ok'));
    await api().post('/api/v1/ai/chat').set(user.auth).send(body('add a title'));
    expect(requests[0].system).toContain("SAVED PREFERENCES");
    expect(requests[0].system).toContain('Titles use Poppins Bold, white');
    const id = added.body.memory[0].id;
    const after = await api().delete(`/api/v1/ai/memory/${id}`).set(user.auth);
    expect(after.body.memory).toEqual([]);
  });

  it('offers propose_plan normally, but not while carrying out a plan step', async () => {
    const user = await createUser();
    replies.push(reply('Plan.', [{ name: 'propose_plan', args: { title: 'Reel', steps: ['Trim the intro', 'Add captions'] } }]));
    const planned = await api().post('/api/v1/ai/chat').set(user.auth).send(body('make it a reel'));
    expect(requests[0].tools!.some((t) => t.name === 'propose_plan')).toBe(true);
    expect(planned.body.calls[0]).toMatchObject({ name: 'propose_plan', args: { steps: ['Trim the intro', 'Add captions'] } });

    replies.push(reply('', [{ name: 'propose_plan', args: { title: 'x', steps: ['a step', 'b step'] } }]));
    replies.push(reply('Trimmed.', [{ name: 'trim_clip', args: { id: 'c1', remove_from_start: 1 } }]));
    const step = await api().post('/api/v1/ai/chat').set(user.auth).send(body('Step 1 of 2: Trim the intro', { planStep: true }));
    expect(requests[1].tools!.some((t) => t.name === 'propose_plan')).toBe(false);
    expect(requests[1].system).toContain('one step of a plan');
    expect(step.body.calls).toEqual([{ name: 'trim_clip', args: { id: 'c1', remove_from_start: 1 } }]);
  });

  it('nudges an edit request answered in words into tool calls, but keeps real answers', async () => {
    const user = await createUser();
    replies.push(reply('Here is a plan: 1. trim 2. add captions'));
    replies.push(reply('Plan ready.', [{ name: 'propose_plan', args: { title: 'Reel', steps: ['Trim the intro', 'Add captions'] } }]));
    const planned = await api().post('/api/v1/ai/chat').set(user.auth).send(body('make it a reel'));
    expect(fake.generate).toHaveBeenCalledTimes(2);
    expect(requests[1].messages.at(-1)!.text).toMatch(/make it with tool calls now/);
    expect(planned.body.calls.map((c: any) => c.name)).toEqual(['propose_plan']);

    replies.push(reply('It is 10 seconds long.'));
    replies.push(reply('It is 10 seconds long.'));
    const answer = await api().post('/api/v1/ai/chat').set(user.auth).send(body('how long is it?'));
    expect(answer.body).toMatchObject({ reply: 'It is 10 seconds long.', calls: [] });
  });

  it('treats null options as not given', async () => {
    const user = await createUser();
    replies.push(reply('ok', [{ name: 'update_clip', args: { id: 'c1', font_size: 90, background_color: null, color: null } as any }]));
    const res = await api().post('/api/v1/ai/chat').set(user.auth).send(body('bigger title'));
    expect(fake.generate).toHaveBeenCalledTimes(1);
    expect(res.body.calls).toEqual([{ name: 'update_clip', args: { id: 'c1', font_size: 90 } }]);
  });

  it('auto mode (the default) answers questions without the edit nudge, and edits on requests', async () => {
    const user = await createUser();
    replies.push(reply('Select the clip, open **Animations** in the right panel, then pick **Pop**.'));
    const { mode: _m, ...noMode } = body('how do I make the title pop in?') as any;
    const answer = await api().post('/api/v1/ai/chat').set(user.auth).send(noMode);
    expect(answer.status).toBe(200);
    expect(fake.generate).toHaveBeenCalledTimes(1);
    expect(requests[0].tools?.length).toBeGreaterThan(0);
    expect(answer.body.calls).toEqual([]);

    replies.push(reply('Making the title yellow.', [{ name: 'update_clip', args: { id: 'c1', color: '#FFFF00' } }]));
    const edit = await api().post('/api/v1/ai/chat').set(user.auth).send({ ...body('make the title yellow'), mode: 'auto' });
    expect(edit.body.calls).toEqual([{ name: 'update_clip', args: { id: 'c1', color: '#FFFF00' } }]);
  });

  it('never shows tool names to the user', async () => {
    const user = await createUser();
    replies.push(reply('You can use `set_animation` or set_keyframes() for that; the file my_clip.mp4 stays.'));
    const res = await api().post('/api/v1/ai/chat').set(user.auth).send(body('how do I animate it?'));
    expect(res.body.reply).toBe('You can use animations or keyframes for that; the file my_clip.mp4 stays.');
  });

  it('validates the request', async () => {
    const user = await createUser();
    expect((await api().post('/api/v1/ai/chat').set(user.auth).send({ ...body('x'), messages: [{ role: 'model', text: 'x' }] })).status).toBe(400);
    expect((await api().post('/api/v1/ai/chat').set(user.auth).send({ ...body('x'), mode: 'yolo' })).status).toBe(400);
  });
});

describe('isQuestion', () => {
  it('tells questions from requests', async () => {
    const { isQuestion } = await import('../src/controllers/assistant.controller');
    for (const q of ['how do I add a transition?', 'What is in my project', 'can you explain keyframes', 'Is the music too loud?']) expect(isQuestion(q)).toBe(true);
    for (const r of ['make the title yellow', 'add captions', 'trim the first 2 seconds', 'turn this into a reel']) expect(isQuestion(r)).toBe(false);
  });
});
