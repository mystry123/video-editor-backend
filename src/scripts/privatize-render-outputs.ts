// Ends the grace period for renders made while outputs were public
// (decided 2026-10-08: run on or after 2026-10-22).
//
//   pnpm renders:privatize            # dry run: counts what would change
//   pnpm renders:privatize --apply    # does it
//
// For every completed render whose file was stored publicly it:
//   1. sets the S3 object's ACL to private (its old raw link stops working;
//      the Shotline link keeps working through a signed URL), and
//   2. records the file's bucket/key so links no longer depend on the URL.
// Caption projects that stored the raw render URL get the Shotline link.
// Safe to run more than once.
import mongoose from 'mongoose';
import { PutObjectAclCommand, S3Client } from '@aws-sdk/client-s3';
import { connectDatabase } from '../config/database';
import { env } from '../config/env';
import { RenderJob } from '../models/RenderJob';
import { CaptionProject } from '../models/Caption';
import { ensureShareTokens, outputFields, parseS3Url } from '../services/renderOutput.service';
import { logger } from '../utils/logger';

const BATCH = 200;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const accessKeyId = env.remotionAwsAccessKeyID || env.awsAccessKeyId;
  const secretAccessKey = env.remotionAwsSecretAccessKey || env.awsSecretAccessKey;
  const s3 = new S3Client({
    region: env.awsRegion,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });

  await connectDatabase();
  const counts = { renders: 0, madePrivate: 0, alreadyGoneOrFailed: 0, unparseable: 0, captions: 0 };
  try {
    // Renders without a recorded location are the ones from before private outputs.
    const cursor = RenderJob.find({ status: 'completed', outputUrl: { $exists: true }, outputKey: { $exists: false } })
      .select('_id outputUrl')
      .lean()
      .cursor({ batchSize: BATCH });

    for await (const job of cursor) {
      counts.renders++;
      const location = parseS3Url(job.outputUrl);
      if (!location) {
        counts.unparseable++;
        continue;
      }
      if (!apply) continue;
      try {
        await s3.send(new PutObjectAclCommand({ Bucket: location.bucket, Key: location.key, ACL: 'private' }));
        counts.madePrivate++;
      } catch (error: any) {
        // Deleted by a lifecycle rule, or no permission: report and move on.
        counts.alreadyGoneOrFailed++;
        logger.warn('Could not make render private', { jobId: String(job._id), error: error?.name || error?.message });
      }
      await RenderJob.updateOne({ _id: job._id }, { $set: { outputBucket: location.bucket, outputKey: location.key } });
    }

    // Caption projects that kept the raw render URL.
    const captions = await CaptionProject.find({ renderJobId: { $exists: true }, outputUrl: /amazonaws\.com/ })
      .select('_id renderJobId')
      .lean();
    for (const project of captions) {
      counts.captions++;
      if (!apply) continue;
      const render = await RenderJob.findById(project.renderJobId).select('status outputUrl').lean();
      if (!render) continue;
      const [linked] = await ensureShareTokens([render as any]);
      const link = outputFields(linked).outputUrl;
      if (link) await CaptionProject.updateOne({ _id: project._id }, { $set: { outputUrl: link } });
    }

    logger.info(apply ? 'Render outputs made private' : 'Dry run (add --apply to make changes)', counts);
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
