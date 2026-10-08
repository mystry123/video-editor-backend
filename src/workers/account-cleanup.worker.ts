// workers/account-cleanup.worker.ts

import { Job } from 'bullmq';
import { purgeUserData } from '../services/accountCleanup.service';
import { createWorker, createJobLogger } from '../utils/worker.utils';

interface AccountCleanupJobData {
  userId: string;
}

async function processAccountCleanup(job: Job<AccountCleanupJobData>) {
  const log = createJobLogger('AccountCleanup', job.data.userId.slice(-6));
  log.info(`Purging account data (attempt ${job.attemptsMade + 1})`);
  // Throws on failure so BullMQ retries with backoff; purgeUserData is idempotent.
  return purgeUserData(job.data.userId);
}

const accountCleanupWorker = createWorker({
  name: 'account-cleanup',
  processor: processAccountCleanup,
  concurrency: 1,
  lockDuration: 10 * 60_000,
});

export default accountCleanupWorker;
