import { describe, expect, it } from 'vitest';
import { api, createUser } from './helpers';
import { Template } from '../src/models/Template';
import { RenderJob } from '../src/models/RenderJob';
import { renderQueue } from '../src/queues';
import { applyVariables, validateRenderInput } from '../src/services/renderInput.service';

const project = { fps: 30, outputFormat: 'mp4', width: 1280, height: 720, duration: 5 };
const text = { id: 't1', type: 'text', text: 'Hi', name: 'Title' };

async function template(userId: unknown, elements: unknown[] = [text]) {
  return Template.create({ userId, name: 'T', data: { project, elements } });
}

describe('render start', () => {
  it('returns 409 STALE_VERSION when the template moved on, and renders the matching version', async () => {
    const { user, auth } = await createUser();
    const t = await template(user._id);
    await Template.updateOne({ _id: t._id }, { $set: { version: 3 } });

    const stale = await api().post('/api/v1/render').set(auth).send({ templateId: String(t._id), version: 2 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    expect(stale.body.details).toMatchObject({ currentVersion: 3 });

    const ok = await api().post('/api/v1/render').set(auth).send({ templateId: String(t._id), version: 3 });
    expect(ok.status).toBe(202);
    expect(ok.body.templateVersion).toBe(3);
    expect((await RenderJob.findById(ok.body.id))!.templateVersion).toBe(3);
  });

  it('the same Idempotency-Key returns the same job, even in parallel', async () => {
    const { user, auth } = await createUser();
    await RenderJob.init(); // the unique index must exist before racing on it
    const t = await template(user._id);
    const send = () => api().post('/api/v1/render').set(auth).set('Idempotency-Key', 'click-12345678').send({ templateId: String(t._id) });
    const [a, b, c] = await Promise.all([send(), send(), send()]);
    const ids = new Set([a.body.id, b.body.id, c.body.id]);
    expect(ids.size).toBe(1);
    expect(await RenderJob.countDocuments({ userId: user._id })).toBe(1);
    expect(renderQueue.add).toHaveBeenCalledTimes(1);
    expect([a, b, c].filter((r) => r.body.deduplicated)).toHaveLength(2);
  });

  it('names the element that is still uploading', async () => {
    const { user, auth } = await createUser();
    const t = await template(user._id, [text, { id: 'i1', type: 'image', name: 'Logo', source: 'blob:http://localhost/abc' }]);
    const res = await api().post('/api/v1/render').set(auth).send({ templateId: String(t._id) });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_RENDER_INPUT');
    expect(res.body.message).toMatch(/"Logo" is still uploading/);
    expect(res.body.details[0]).toMatchObject({ elementId: 'i1' });
    expect(renderQueue.add).not.toHaveBeenCalled();
  });

  it('rejects an empty timeline', async () => {
    const { user, auth } = await createUser();
    const t = await template(user._id, []);
    const res = await api().post('/api/v1/render').set(auth).send({ templateId: String(t._id) });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('EMPTY_PROJECT');
  });

  it('warns about variables that match no element', async () => {
    const { user, auth } = await createUser();
    const t = await template(user._id);
    const res = await api().post('/api/v1/render').set(auth).send({ templateId: String(t._id), variables: { Title: 'New', Nope: 'x' } });
    expect(res.status).toBe(202);
    expect(res.body.warnings).toEqual([expect.stringContaining('"Nope"')]);
    const job = await RenderJob.findById(res.body.id).select('+inputProps');
    expect(job!.inputProps.elements[0].text).toBe('New');
  });
});

describe('render input', () => {
  it('media variables set `source` (what the composition reads), including in compositions', () => {
    const { elements, unmatched } = applyVariables(
      [{ type: 'composition', elements: [{ type: 'image', name: 'Logo', source: 'https://cdn.test/a.png' }] }],
      { Logo: 'https://cdn.test/b.png' }
    );
    expect(elements[0].elements[0].source).toBe('https://cdn.test/b.png');
    expect(unmatched).toEqual([]);
  });

  it('accepts inline Lottie data and reports media with no file', () => {
    expect(() =>
      validateRenderInput({ project, elements: [{ type: 'lottie', animationData: { v: '5' } }] })
    ).not.toThrow();
    expect(() => validateRenderInput({ project, elements: [{ type: 'video', source: '' }] })).toThrow(/Video #1 has no media/);
  });
});
