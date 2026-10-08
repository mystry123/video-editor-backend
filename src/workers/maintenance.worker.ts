// workers/maintenance.worker.ts
//
// Runs the maintenance sweep (services/maintenance.service.ts) every minute as
// a BullMQ job scheduler: one run at a time across all worker processes.

import { getMaintenanceQueue } from '../queues';
import { runMaintenanceSweep } from '../services/maintenance.service';
import { createWorker } from '../utils/worker.utils';
import { logger } from '../utils/logger';
import { env } from '../config/env';

const SWEEP_EVERY_MS = 60_000;

const maintenanceWorker = createWorker({
  name: 'maintenance',
  processor: () => runMaintenanceSweep(),
  concurrency: 1,
  lockDuration: 5 * 60_000,
});

// Sweeps change and delete records, so they only run where that's intended:
// production, or when MAINTENANCE_SWEEPS=true. A developer machine pointed at
// a shared database must not start repairing (or deleting) real data.
const SWEEPS_ENABLED =
  process.env.MAINTENANCE_SWEEPS === 'true' || (env.nodeEnv === 'production' && process.env.MAINTENANCE_SWEEPS !== 'false');

if (SWEEPS_ENABLED) {
  // Idempotent upsert by id, shared by all worker processes.
  getMaintenanceQueue()
    .upsertJobScheduler('maintenance-sweep', { every: SWEEP_EVERY_MS }, { name: 'sweep' })
    .then(() => logger.info(`[Maintenance] Sweep scheduled every ${SWEEP_EVERY_MS / 1000}s`))
    .catch((error) => logger.error('[Maintenance] Could not schedule sweeps', { error: error.message }));
} else {
  // Remove a schedule left from an earlier enabled run, so it doesn't keep firing.
  getMaintenanceQueue()
    .removeJobScheduler('maintenance-sweep')
    .catch(() => undefined);
  logger.info('[Maintenance] Sweeps disabled (set MAINTENANCE_SWEEPS=true to enable outside production)');
}

export default maintenanceWorker;
