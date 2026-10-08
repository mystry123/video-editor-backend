import { describe, expect, it } from 'vitest';
import { api, createUser } from './helpers';
import { Template } from '../src/models/Template';

const keyframedBackground = [
  { time: 0, value: '#000000' },
  { time: 2, value: '#ff0000', easing: 'ease-in-out' },
];

describe('template project settings', () => {
  it('keeps every setting the editor saves, on create and on update', async () => {
    const { auth } = await createUser();
    const created = await api()
      .post('/api/v1/templates')
      .set(auth)
      .send({
        name: 'T',
        data: {
          project: { width: 1080, height: 1920, fps: 30, duration: 12, backgroundColorOpacity: 0.4, selectedVoice: 'v1' },
          elements: [],
        },
      });
    expect(created.status).toBe(201);
    expect(created.body.data.project).toMatchObject({ backgroundColorOpacity: 0.4, width: 1080, selectedVoice: 'v1' });

    const updated = await api()
      .put(`/api/v1/templates/${created.body._id}`)
      .set(auth)
      .send({
        data: {
          project: { width: 1080, height: 1920, fps: 30, duration: 12, backgroundColorOpacity: 0.7, backgroundColor: keyframedBackground, someFutureSetting: { a: 1 } },
          elements: [],
        },
      });
    expect(updated.status).toBe(200);

    const stored = await Template.findById(created.body._id).lean();
    expect(stored!.data.project).toMatchObject({
      backgroundColorOpacity: 0.7,
      backgroundColor: keyframedBackground,
      someFutureSetting: { a: 1 },
    });

    const fetched = await api().get(`/api/v1/templates/${created.body._id}`).set(auth);
    expect(fetched.body.data.project.backgroundColor).toEqual(keyframedBackground);
  });

  it('still fills in defaults for missing settings', async () => {
    const { auth } = await createUser();
    const res = await api().post('/api/v1/templates').set(auth).send({ name: 'T', data: { project: { duration: 5 }, elements: [] } });
    expect(res.body.data.project).toMatchObject({ width: 1920, height: 1080, fps: 30, duration: 5, backgroundColor: '#000000' });
  });
});
