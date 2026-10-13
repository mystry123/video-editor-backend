import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, createUser } from './helpers';
import { setGeminiClient, type GeminiRequest } from '../src/services/ai/gemini';
import { titleFrom } from '../src/controllers/chatSession.controller';
import { describePreferences } from '../src/services/ai/preferences';

const requests: GeminiRequest[] = [];
beforeEach(() => {
  requests.length = 0;
  setGeminiClient({ generate: vi.fn(async (r: GeminiRequest) => (requests.push(r), { text: 'Sure.', calls: [], usage: { input: 1, output: 1 } })) });
});
afterEach(() => setGeminiClient(null));

const msgs = [
  { role: 'user', text: 'make the title yellow' },
  { role: 'model', text: 'Making the title yellow.', note: '[Proposed: Text "Title": colour] (applied)' },
];

describe('chat sessions', () => {
  it('creates, lists, loads, updates and deletes a chat', async () => {
    const user = await createUser();
    const created = await api().post('/api/v1/ai/sessions').set(user.auth).send({ projectId: 'p1', messages: msgs });
    expect(created.status).toBe(201);
    expect(created.body.session).toMatchObject({ title: 'Make the title yellow', messageCount: 2 });
    const id = created.body.session.id;

    await api().post('/api/v1/ai/sessions').set(user.auth).send({ projectId: 'p2' });
    const list = await api().get('/api/v1/ai/sessions?projectId=p1').set(user.auth);
    expect(list.body.sessions).toHaveLength(1);
    expect(list.body.sessions[0]).toMatchObject({ id, title: 'Make the title yellow', messageCount: 2 });

    const loaded = await api().get(`/api/v1/ai/sessions/${id}`).set(user.auth);
    expect(loaded.body.session.messages[1]).toMatchObject({ role: 'model', note: '[Proposed: Text "Title": colour] (applied)' });

    const more = [...msgs, { role: 'user', text: 'and bigger' }];
    const updated = await api().put(`/api/v1/ai/sessions/${id}`).set(user.auth).send({ messages: more, title: 'Title colour' });
    expect(updated.body.session).toMatchObject({ title: 'Title colour', messageCount: 3 });

    expect((await api().delete(`/api/v1/ai/sessions/${id}`).set(user.auth)).status).toBe(204);
    expect((await api().get(`/api/v1/ai/sessions/${id}`).set(user.auth)).status).toBe(404);
  });

  it("never shows one user's chats to another", async () => {
    const a = await createUser();
    const b = await createUser();
    const { body } = await api().post('/api/v1/ai/sessions').set(a.auth).send({ projectId: 'p1', messages: msgs });
    const id = body.session.id;
    expect((await api().get(`/api/v1/ai/sessions/${id}`).set(b.auth)).status).toBe(404);
    expect((await api().put(`/api/v1/ai/sessions/${id}`).set(b.auth).send({ title: 'mine now' })).status).toBe(404);
    await api().delete(`/api/v1/ai/sessions/${id}`).set(b.auth);
    expect((await api().get(`/api/v1/ai/sessions/${id}`).set(a.auth)).status).toBe(200);
    expect((await api().get('/api/v1/ai/sessions?projectId=p1').set(b.auth)).body.sessions).toEqual([]);
  });

  it('a new chat takes its title from the first message once there is one', async () => {
    const user = await createUser();
    const { body } = await api().post('/api/v1/ai/sessions').set(user.auth).send({ projectId: 'p1' });
    expect(body.session.title).toBe('New chat');
    const res = await api().put(`/api/v1/ai/sessions/${body.session.id}`).set(user.auth).send({ messages: [{ role: 'user', text: 'add captions please' }] });
    expect(res.body.session.title).toBe('Add captions please');
    expect(titleFrom([{ role: 'user', text: 'a'.repeat(30) + ' ' + 'b'.repeat(40) }])).toMatch(/…$/);
  });

  it('validates', async () => {
    const user = await createUser();
    expect((await api().get('/api/v1/ai/sessions').set(user.auth)).status).toBe(400);
    expect((await api().get('/api/v1/ai/sessions/not-an-id').set(user.auth)).status).toBe(400);
    expect((await api().get('/api/v1/ai/sessions?projectId=p1')).status).toBe(401);
  });
});

describe('preferences', () => {
  it('saves detailed preferences and Cue follows them', async () => {
    const user = await createUser();
    const prefs = { brandName: 'Goa Diaries', brandColors: ['#FF5A1F', '#111111'], titleFont: 'Poppins', captionStyle: 'bold-highlight', captionPosition: 'bottom', defaultFormat: '9:16', tone: 'energetic', pacing: 'fast', language: 'Hindi', avoid: 'Swearing' };
    const saved = await api().put('/api/v1/ai/preferences').set(user.auth).send({ preferences: { ...prefs, bodyFont: '' } });
    expect(saved.status).toBe(200);
    expect(saved.body.preferences).toEqual(prefs);
    await api().post('/api/v1/ai/memory').set(user.auth).send({ note: 'End every video with Follow for more' });

    const got = await api().get('/api/v1/ai/preferences').set(user.auth);
    expect(got.body.preferences).toEqual(prefs);
    expect(got.body.memory.map((m: any) => m.note)).toEqual(['End every video with Follow for more']);

    await api().post('/api/v1/ai/chat').set(user.auth).send({ messages: [{ role: 'user', text: 'add a title' }], context: 'Project: 1920×1080' });
    const system = requests[0].system;
    expect(system).toContain('Brand colours: #FF5A1F, #111111');
    expect(system).toContain('Titles use the font Poppins.');
    expect(system).toContain('Captions: bold, with the spoken word highlighted, at the bottom of the frame.');
    expect(system).toContain('Write text and voiceovers in Hindi');
    expect(system).toContain('End every video with Follow for more');
  });

  it('rejects bad values and clears everything when emptied', async () => {
    const user = await createUser();
    expect((await api().put('/api/v1/ai/preferences').set(user.auth).send({ preferences: { brandColors: ['red'] } })).status).toBe(400);
    expect((await api().put('/api/v1/ai/preferences').set(user.auth).send({ preferences: { tone: 'angry' } })).status).toBe(400);
    expect((await api().put('/api/v1/ai/preferences').set(user.auth).send({ preferences: { hacker: 'x' } })).status).toBe(400);
    await api().put('/api/v1/ai/preferences').set(user.auth).send({ preferences: { tone: 'calm' } });
    await api().put('/api/v1/ai/preferences').set(user.auth).send({ preferences: { tone: '' } });
    expect((await api().get('/api/v1/ai/preferences').set(user.auth)).body.preferences).toEqual({});
  });

  it('describes nothing when there are no preferences', () => {
    expect(describePreferences(undefined)).toEqual([]);
    expect(describePreferences({ pacing: 'slow' })).toEqual(['Pacing: slow and calm.']);
  });
});
