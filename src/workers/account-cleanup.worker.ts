// workers/account-cleanup.worker.ts

import { Job } from 'bullmq';
import { purgeUserData } from '../services/accountCleanup.service';
import { createWorker, createJobLogger } from '../utils/worker.utils';

interface AccountCleanupJobData {
  userId: string;
  /** Their own ElevenLabs voice, if they made one */
  ownVoiceId?: string;
  ownVoiceProvider?: 'elevenlabs' | 'sarvam';
}

async function processAccountCleanup(job: Job<AccountCleanupJobData>) {
  const log = createJobLogger('AccountCleanup', job.data.userId.slice(-6));
  log.info(`Purging account data (attempt ${job.attemptsMade + 1})`);
  // Throws on failure so BullMQ retries with backoff; purgeUserData is idempotent.
  return purgeUserData(job.data.userId, { ownVoiceId: job.data.ownVoiceId, ownVoiceProvider: job.data.ownVoiceProvider });
}

const accountCleanupWorker = createWorker({
  name: 'account-cleanup',
  processor: processAccountCleanup,
  concurrency: 1,
  lockDuration: 10 * 60_000,
});

export default accountCleanupWorker;
