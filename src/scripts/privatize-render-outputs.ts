// Ends the grace period for renders made while outputs were public
// (decided 2026-10-08: run on or after 2026-10-22).
//
//   pnpm renders:privatize            # dry run: counts what would change
//   pnpm renders:privatize --apply    # does it
//
// For every completed render whose file was stored publicly it:
//   1. makes the object private (its old raw link stops working; the
//      Shotline link keeps working through a signed URL): an S3 ACL for
//      Remotion Lambda outputs, the object ACL on GCS (buckets with uniform
//      access already control this per bucket and are reported as skipped), and
//   2. records the file's bucket/key so links no longer depend on the URL.
// Caption projects that stored the raw render URL get the Shotline link.
// Safe to run more than once.
import mongoose from 'mongoose';
import { getAwsClient, type AwsRegion } from '@remotion/lambda-client';
import { connectDatabase } from '../config/database';
import { env } from '../config/env';
import { gcs } from '../config/gcs';
import { RenderJob } from '../models/RenderJob';
import { CaptionProject } from '../models/Caption';
import { ensureShareTokens, outputFields, parseStorageUrl } from '../services/renderOutput.service';
import { logger } from '../utils/logger';

const BATCH = 200;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

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
      const location = parseStorageUrl(job.outputUrl);
      if (!location) {
        counts.unparseable++;
        continue;
      }
      if (!apply) continue;
      try {
        if (location.provider === 'gcs') {
          await gcs().bucket(location.bucket).file(location.key).makePrivate();
        } else {
          const { client, sdk } = getAwsClient({ region: env.awsRegion as AwsRegion, service: 's3' });
          await client.send(new sdk.PutObjectAclCommand({ Bucket: location.bucket, Key: location.key, ACL: 'private' }));
        }
        counts.madePrivate++;
      } catch (error: any) {
        // Deleted by a lifecycle rule, or no permission: report and move on.
        counts.alreadyGoneOrFailed++;
        logger.warn('Could not make render private', { jobId: String(job._id), error: error?.name || error?.message });
      }
      await RenderJob.updateOne({ _id: job._id }, { $set: { outputBucket: location.bucket, outputKey: location.key } });
    }

    // Caption projects that kept the raw render URL.
    const captions = await CaptionProject.find({ renderJobId: { $exists: true }, outputUrl: /amazonaws\.com|storage\.googleapis\.com/ })
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
