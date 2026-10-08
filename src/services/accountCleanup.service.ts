// services/accountCleanup.service.ts
//
// Removes everything a deleted account owned. Runs from the account-cleanup
// queue after the User document is already gone, and is safe to re-run:
// every step deletes by owner, so a retry after a partial failure just
// finishes the job.

import { AwsRegion, deleteRender } from '@remotion/lambda-client';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { ApiKey } from '../models/ApiKey';
import { CaptionProject } from '../models/Caption';
import { CaptionPreset } from '../models/CaptionPreset';
import { File } from '../models/File';
import { RenderJob } from '../models/RenderJob';
import { Template } from '../models/Template';
import { TemplateVersion } from '../models/TemplateVersion';
import { Transcription } from '../models/Transcription';
import { UsageLog } from '../models/UsageLog';
import { UserLoginHistory } from '../models/UserLoginHistory';
import { Session } from '../models/Session';
import { Webhook } from '../models/Webhook';
import { WebhookLog } from '../models/WebhookLog';
import { deleteS3Prefix } from './storage.service';
import { logger } from '../utils/logger';

export interface CleanupReport {
  s3Objects: number;
  renderOutputs: number;
  documents: Record<string, number>;
}

export async function purgeUserData(userId: string): Promise<CleanupReport> {
  if (!Types.ObjectId.isValid(userId)) throw new Error(`Invalid user id ${userId}`);
  const owner = new Types.ObjectId(userId);

  // 1. Files in storage first, while the documents that point at them still exist.
  const s3Objects = await deleteS3Prefix(`users/${userId}/`);

  const renders = await RenderJob.find({ userId: owner, renderId: { $exists: true, $ne: null } })
    .select('renderId bucketName')
    .lean();
  let renderOutputs = 0;
  for (const render of renders) {
    const bucketName = render.bucketName || env.remotionBucket;
    if (!render.renderId || !bucketName) continue;
    try {
      await deleteRender({ bucketName, renderId: render.renderId, region: env.awsRegion as AwsRegion });
      renderOutputs++;
    } catch (error: any) {
      // Already gone is fine; anything else fails the job so it retries.
      if (!/NoSuchKey|not found|404/i.test(error?.message || '')) throw error;
    }
  }

  // 2. Documents. Children before parents so a crash mid-way leaves nothing orphaned
  //    that the next attempt can't find.
  const templateIds = (await Template.find({ userId: owner }).select('_id').lean()).map((t) => t._id);
  const webhookIds = (await Webhook.find({ userId: owner }).select('_id').lean()).map((w) => w._id);

  const documents: Record<string, number> = {};
  const remove = async (label: string, op: Promise<{ deletedCount?: number }>) => {
    documents[label] = (await op).deletedCount || 0;
  };

  await remove('templateVersions', TemplateVersion.deleteMany({ templateId: { $in: templateIds } }));
  await remove('webhookLogs', WebhookLog.deleteMany({ webhookId: { $in: webhookIds } }));
  await remove('templates', Template.deleteMany({ userId: owner }));
  await remove('webhooks', Webhook.deleteMany({ userId: owner }));
  await remove('renderJobs', RenderJob.deleteMany({ userId: owner }));
  await remove('captionProjects', CaptionProject.deleteMany({ userId: owner }));
  await remove('captionPresets', CaptionPreset.deleteMany({ userId: owner, isSystem: false }));
  await remove('transcriptions', Transcription.deleteMany({ userId: owner }));
  await remove('files', File.deleteMany({ userId: owner }));
  await remove('usageLogs', UsageLog.deleteMany({ userId: owner }));
  await remove('loginHistory', UserLoginHistory.deleteMany({ userId: owner }));
  await remove('apiKeys', ApiKey.deleteMany({ userId: owner }));
  await remove('sessions', Session.deleteMany({ userId: owner }));

  const report = { s3Objects, renderOutputs, documents };
  logger.info(`[AccountCleanup] Purged data for user ${userId.slice(-6)}`, report);
  return report;
}
