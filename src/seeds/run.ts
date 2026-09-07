// Standalone seed runner: `pnpm seed:presets`.
//
// Deliberately not wired into server startup - seeding is an explicit,
// occasional operation, and running it on every boot would mean a database
// write on every deploy.
import mongoose from 'mongoose';
import { connectDatabase } from '../config/database';
import { logger } from '../utils/logger';
import { seedCaptionPresets } from './caption-presets.seed';

async function main(): Promise<void> {
  await connectDatabase();
  try {
    await seedCaptionPresets();
  } finally {
    await mongoose.connection.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Seed failed:', error);
    process.exit(1);
  });
