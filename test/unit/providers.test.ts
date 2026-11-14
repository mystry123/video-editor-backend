// Provider selection: STORAGE_PROVIDER / RENDER_PROVIDER validation, which
// storage backend runs, and which URLs media tools trust under each.
import { afterEach, describe, expect, it } from 'vitest';
import { checkProviders, env } from '../../src/config/env';
import { parseS3Url } from '../../src/config/aws';
import { storageBackend } from '../../src/services/storage.service';
import { gcsStorage } from '../../src/services/storage/gcs';
import { s3Storage } from '../../src/services/storage/s3';
import { isTrustedMediaUrl } from '../../src/utils/media';
import { isLambdaRenderId, renderChunking, webhookMode } from '../../src/services/lambdaRender.service';

const saved = { ...env };
afterEach(() => Object.assign(env, saved));

/** Settings for checkProviders: nothing set, then `overrides` */
function settings(overrides: Partial<Parameters<typeof checkProviders>[0]> = {}): Parameters<typeof checkProviders>[0] {
  return {
    storageProvider: 'gcs',
    renderProvider: 'local',
    gcsMediaBucket: '',
    gcsRendersBucket: '',
    awsRegion: '',
    awsAccessKeyId: '',
    awsSecretAccessKey: '',
    s3Bucket: '',
    s3RendersBucket: '',
    remotionServeUrl: '',
    remotionFunctionName: '',
    remotionBucket: '',
    remotionAwsAccessKeyID: '',
    remotionAwsSecretAccessKey: '',
    remotionAwsProfile: '',
    remotionWebhookUrl: '',
    remotionWebhookSecret: '',
    ...overrides,
  };
}

const lambdaReady = {
  renderProvider: 'lambda' as const,
  awsRegion: 'us-east-1',
  remotionFunctionName: 'remotion-render-4-0-400',
  remotionBucket: 'remotionlambda-useast1-abc',
  remotionServeUrl: 'https://remotionlambda-useast1-abc.s3.us-east-1.amazonaws.com/sites/shotline/index.html',
  remotionAwsAccessKeyID: 'AKIATEST',
  remotionAwsSecretAccessKey: 'secret',
};

describe('checkProviders', () => {
  it('defaults (gcs + local) only warn, so an existing deploy always starts', () => {
    const result = checkProviders(settings());
    expect(result.fatal).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/GCS_MEDIA_BUCKET/), expect.stringMatching(/GCS_RENDERS_BUCKET/), expect.stringMatching(/REMOTION_SERVE_URL/)])
    );
  });

  it('a complete GCP setup has nothing to report', () => {
    const result = checkProviders(settings({ gcsMediaBucket: 'm', gcsRendersBucket: 'r', remotionServeUrl: '/srv/bundles/current' }));
    expect(result).toEqual({ fatal: [], warnings: [] });
  });

  it('rejects unknown provider names', () => {
    const result = checkProviders(settings({ storageProvider: 'azure' as any, renderProvider: 'cloudrun' as any }));
    expect(result.fatal).toEqual([expect.stringMatching(/STORAGE_PROVIDER must be one of gcs, s3/), expect.stringMatching(/RENDER_PROVIDER must be one of local, lambda/)]);
  });

  it('s3 storage fails fast without a region and buckets', () => {
    const result = checkProviders(settings({ storageProvider: 's3', remotionServeUrl: '/b' }));
    expect(result.fatal).toEqual([
      expect.stringMatching(/AWS_REGION/),
      expect.stringMatching(/S3_BUCKET is not set/),
      expect.stringMatching(/S3_RENDERS_BUCKET is not set/),
    ]);
  });

  it('s3 storage with Lambda renders needs no S3 renders bucket (outputs stay in Remotion\'s)', () => {
    const result = checkProviders(settings({ ...lambdaReady, storageProvider: 's3', s3Bucket: 'media' }));
    expect(result.fatal).toEqual([]);
  });

  it('s3 storage may use the default credential chain (a warning, not an error)', () => {
    const result = checkProviders(settings({ storageProvider: 's3', awsRegion: 'eu-west-1', s3Bucket: 'm', s3RendersBucket: 'r', remotionServeUrl: '/b' }));
    expect(result.fatal).toEqual([]);
    expect(result.warnings).toEqual([expect.stringMatching(/default AWS credential chain/)]);
  });

  it('half a key pair is an error', () => {
    expect(checkProviders(settings({ awsAccessKeyId: 'AKIA' })).fatal).toEqual([expect.stringMatching(/without AWS_SECRET_ACCESS_KEY/)]);
  });

  it('lambda fails fast without its function, bucket, site URL and credentials', () => {
    const result = checkProviders(settings({ renderProvider: 'lambda', gcsMediaBucket: 'm', remotionServeUrl: '/srv/bundles/current' }));
    expect(result.fatal).toEqual([
      expect.stringMatching(/AWS_REGION/),
      expect.stringMatching(/REMOTION_FUNCTION_NAME/),
      expect.stringMatching(/REMOTION_BUCKET/),
      expect.stringMatching(/REMOTION_SERVE_URL must be the https URL/),
      expect.stringMatching(/needs REMOTION_AWS_ACCESS_KEY_ID/),
    ]);
  });

  it('lambda accepts the app keys or an AWS profile instead of Remotion keys', () => {
    const noRemotionKeys = { ...lambdaReady, remotionAwsAccessKeyID: '', remotionAwsSecretAccessKey: '', gcsMediaBucket: 'm' };
    expect(checkProviders(settings({ ...noRemotionKeys, awsAccessKeyId: 'AKIA', awsSecretAccessKey: 's' })).fatal).toEqual([]);
    expect(checkProviders(settings({ ...noRemotionKeys, remotionAwsProfile: 'shotline' })).fatal).toEqual([]);
  });

  it('a complete Lambda setup on GCS storage needs no GCS renders bucket', () => {
    const result = checkProviders(settings({ ...lambdaReady, gcsMediaBucket: 'm' }));
    expect(result).toEqual({ fatal: [], warnings: [] });
  });

  it('warns when only half the webhook settings are there (renders then complete by polling)', () => {
    const result = checkProviders(settings({ ...lambdaReady, gcsMediaBucket: 'm', remotionWebhookUrl: 'https://api.test/api/v1/webhooks/remotion' }));
    expect(result.fatal).toEqual([]);
    expect(result.warnings).toEqual([expect.stringMatching(/REMOTION_WEBHOOK_URL and REMOTION_WEBHOOK_SECRET/)]);
  });
});

describe('storage backend selection', () => {
  it('is GCS by default and S3 when STORAGE_PROVIDER=s3', () => {
    expect(env.storageProvider).toBe('gcs');
    expect(storageBackend()).toBe(gcsStorage);
    env.storageProvider = 's3';
    expect(storageBackend()).toBe(s3Storage);
  });
});

describe('render provider helpers', () => {
  it('webhook mode needs Lambda and both webhook settings', () => {
    expect(webhookMode()).toBe(false);
    Object.assign(env, { remotionWebhookUrl: 'https://api.test/hook', remotionWebhookSecret: 's' });
    expect(webhookMode()).toBe(false); // still local renders
    env.renderProvider = 'lambda';
    expect(webhookMode()).toBe(true);
  });

  it('tells Lambda render ids from local ones', () => {
    expect(isLambdaRenderId('abc123xyz')).toBe(true);
    expect(isLambdaRenderId('local-worker-1-1700000000000')).toBe(false);
    expect(isLambdaRenderId(undefined)).toBe(false);
  });

  it('splits renders into 60-frame chunks unless that needs more Lambdas than allowed', () => {
    expect(renderChunking({ duration: 10, fps: 30 }, 8)).toEqual({ framesPerLambda: 60 });
    expect(renderChunking({ duration: 600, fps: 30 }, 8)).toEqual({ concurrency: 8 });
  });
});

describe('trusted media URLs per provider', () => {
  it('GCS: our GCS buckets, not S3', () => {
    expect(isTrustedMediaUrl('https://storage.googleapis.com/test-bucket/users/u/a.mp4')).toBe(true);
    expect(isTrustedMediaUrl('https://test-bucket.s3.us-east-1.amazonaws.com/users/u/a.mp4')).toBe(false);
  });

  it('S3: our S3 buckets in every URL style, no longer the GCS ones', () => {
    Object.assign(env, { storageProvider: 's3', awsRegion: 'us-east-1', s3Bucket: 'shotline-media', s3RendersBucket: 'shotline-renders' });
    for (const url of [
      'https://shotline-media.s3.us-east-1.amazonaws.com/users/u/a.mp4',
      'https://shotline-media.s3.amazonaws.com/users/u/a.mp4',
      'https://s3.us-east-1.amazonaws.com/shotline-media/users/u/a.mp4',
      'https://s3.amazonaws.com/shotline-renders/renders/u/j.mp4',
    ]) {
      expect(isTrustedMediaUrl(url), url).toBe(true);
    }
    expect(isTrustedMediaUrl('https://storage.googleapis.com/test-bucket/users/u/a.mp4')).toBe(false);
    expect(isTrustedMediaUrl('https://someone-else.s3.us-east-1.amazonaws.com/x.mp4')).toBe(false);
  });

  it('Lambda: Remotion\'s bucket too, only while renders run there', () => {
    Object.assign(env, { awsRegion: 'us-east-1', remotionBucket: 'remotionlambda-useast1-abc' });
    const output = 'https://remotionlambda-useast1-abc.s3.us-east-1.amazonaws.com/renders/u/j.mp4';
    expect(isTrustedMediaUrl(output)).toBe(false);
    env.renderProvider = 'lambda';
    expect(isTrustedMediaUrl(output)).toBe(true);
  });
});

describe('parseS3Url', () => {
  it('reads virtual-hosted, path-style and s3:// URLs', () => {
    expect(parseS3Url('https://b.s3.us-east-1.amazonaws.com/renders/u/j%20k.mp4')).toEqual({ bucket: 'b', key: 'renders/u/j k.mp4' });
    expect(parseS3Url('https://b.s3.amazonaws.com/a.mp4')).toEqual({ bucket: 'b', key: 'a.mp4' });
    expect(parseS3Url('https://s3.eu-west-1.amazonaws.com/b/a/b.mp4')).toEqual({ bucket: 'b', key: 'a/b.mp4' });
    expect(parseS3Url('s3://b/a.mp4')).toEqual({ bucket: 'b', key: 'a.mp4' });
    expect(parseS3Url('https://s3.amazonaws.com/only-bucket')).toBeNull();
    expect(parseS3Url('https://storage.googleapis.com/b/a.mp4')).toBeNull();
    expect(parseS3Url('not a url')).toBeNull();
  });
});
