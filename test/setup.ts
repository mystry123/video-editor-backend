// Each test file gets its own in-memory MongoDB, so tests never touch a real
// database and can run in parallel. Collections are wiped between tests.
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Queues need Redis; tests assert on what would have been enqueued instead.
vi.mock('../src/queues', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/queues')>();
  const fakeQueue = () => ({ add: vi.fn().mockResolvedValue({ id: 'test-job' }), getJob: vi.fn().mockResolvedValue(null) });
  const getters = Object.fromEntries(
    ['getRenderQueue', 'getTranscriptionQueue', 'getFileProcessingQueue', 'getWebhookQueue', 'getCaptionQueue',
      'getFileImportQueue', 'getReframeQueue', 'getAccountCleanupQueue', 'getMaintenanceQueue'].map((name) => {
      const queue = fakeQueue();
      return [name, () => queue];
    })
  );
  return {
    ...actual,
    ...getters,
    renderQueue: fakeQueue(),
    transcriptionQueue: fakeQueue(),
    fileProcessingQueue: fakeQueue(),
    webhookQueue: fakeQueue(),
    captionQueue: fakeQueue(),
    fileImportQueue: fakeQueue(),
    reframeQueue: fakeQueue(),
    accountCleanupQueue: fakeQueue(),
  };
});

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const { initializeQuotaSystem } = await import('../src/config/quota-init');
  const { initPlans } = await import('../src/services/plan.service');
  initializeQuotaSystem();
  await initPlans();
});

afterEach(async () => {
  vi.clearAllMocks();
  const collections = await mongoose.connection.db!.collections();
  // Plans are seeded once per file; keep them so plan lookups keep working.
  await Promise.all(collections.filter((c) => c.collectionName !== 'plans').map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
