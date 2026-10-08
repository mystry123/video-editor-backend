import { describe, expect, it } from 'vitest';
import { api, createUser } from './helpers';
import { Template } from '../src/models/Template';
import { renderQueue } from '../src/queues';

describe('server-side requests to internal addresses', () => {
  it('URL import refuses private and metadata addresses', async () => {
    const { auth } = await createUser();
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:6379/', 'http://localhost:8000/detect']) {
      const res = await api().post('/api/v1/files/import/url').set(auth).send({ url });
      expect(res.status, url).toBe(400);
      expect(res.body.code, url).toBe('URL_NOT_ALLOWED');
    }
  });

  it('webhooks cannot target internal addresses', async () => {
    const { auth } = await createUser();
    const res = await api().post('/api/v1/webhooks').set(auth).send({ name: 'x', url: 'http://10.0.0.5/hook', events: ['render.completed'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('render media overrides must be public http(s) URLs, including inside object overrides', async () => {
    const { user, auth } = await createUser();
    const t = await Template.create({
      userId: user._id,
      name: 'T',
      data: {
        project: { width: 1280, height: 720, fps: 30, duration: 5, outputFormat: 'mp4' },
        elements: [{ id: 'e1', name: 'Logo', type: 'image', src: 'https://cdn.test/logo.png' }],
      },
    });
    const bad = [
      { Logo: 'file:///etc/passwd' },
      { Logo: 'http://169.254.169.254/latest/meta-data/' },
      { Logo: { src: 'file:///etc/passwd' } },
    ];
    for (const variables of bad) {
      const res = await api().post('/api/v1/render').set(auth).send({ templateId: String(t._id), variables });
      expect(res.status, JSON.stringify(variables)).toBe(400);
      expect(res.body.code).toBe('INVALID_MEDIA_URL');
    }
    expect(renderQueue.add).not.toHaveBeenCalled();

    const ok = await api().post('/api/v1/render').set(auth).send({ templateId: String(t._id), variables: { Logo: 'https://example.com/new-logo.png' } });
    expect(ok.status).toBe(202);
  });

  it('object overrides cannot pollute prototypes', async () => {
    const { user, auth } = await createUser();
    const t = await Template.create({
      userId: user._id,
      name: 'T',
      data: { project: { width: 1280, height: 720, fps: 30, duration: 5, outputFormat: 'mp4' }, elements: [{ id: 'e1', name: 'Title', type: 'text', text: 'Hi' }] },
    });
    const res = await api()
      .post('/api/v1/render')
      .set(auth)
      .set('Content-Type', 'application/json')
      .send('{"templateId":"' + t._id + '","variables":{"Title":{"__proto__":{"polluted":true},"text":"Hello"}}}');
    expect(res.status).toBe(202);
    expect(({} as any).polluted).toBeUndefined();
  });
});
