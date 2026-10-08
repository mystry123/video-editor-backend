// Makes an existing account an admin: `pnpm admin:grant you@example.com`.
//
// Admins manage everyone else's plan from Settings → Admin, so the first one
// has to be created here. Writes an AuditLog entry like an in-app change would.
import mongoose from 'mongoose';
import { connectDatabase } from '../config/database';
import { User } from '../models/User';
import { AuditLog } from '../models/AuditLog';
import { logger } from '../utils/logger';

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    throw new Error('Usage: pnpm admin:grant <email>');
  }

  await connectDatabase();
  try {
    const user = await User.findOne({ email });
    if (!user) throw new Error(`No account with email ${email}`);
    if (user.role === 'admin') {
      logger.info(`${email} is already an admin`);
      return;
    }

    const before = user.role;
    user.role = 'admin';
    await user.save();
    await AuditLog.create({
      actorId: user._id,
      actorEmail: 'cli:grant-admin',
      action: 'user.plan.change',
      targetType: 'user',
      targetId: String(user._id),
      summary: `Plan changed from ${before} to admin (command line)`,
      before: { plan: before },
      after: { plan: 'admin' },
    });
    logger.info(`${email} is now an admin (was ${before})`);
  } finally {
    await mongoose.connection.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error.message);
    process.exit(1);
  });
