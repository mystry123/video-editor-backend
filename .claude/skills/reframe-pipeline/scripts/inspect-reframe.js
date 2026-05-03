#!/usr/bin/env node
// Inspect the reframe state stored on a File doc in MongoDB.
// Usage: node inspect-reframe.js <fileId> [aspectRatio]
//
// Reads MONGODB_URI from env. If aspectRatio is omitted, prints all ratios.

const { MongoClient, ObjectId } = require('mongodb');

async function main() {
  const [, , fileId, aspectRatioArg] = process.argv;
  if (!fileId) {
    console.error('usage: node inspect-reframe.js <fileId> [aspectRatio]');
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    const file = await db
      .collection('files')
      .findOne(
        { _id: new ObjectId(fileId) },
        { projection: { name: 1, originalName: 1, metadata: 1, reframe: 1 } }
      );

    if (!file) {
      console.error(`✗ no file with _id=${fileId}`);
      process.exit(1);
    }

    const name = file.name || file.originalName || '(unnamed)';
    const meta = file.metadata || {};
    console.log(`file: ${name}  (${meta.width || '?'}x${meta.height || '?'}, ${meta.duration || '?'}s)`);

    const reframe = file.reframe || {};
    const keys = Object.keys(reframe);
    if (keys.length === 0) {
      console.log('  no reframe data');
      return;
    }

    const ratios = aspectRatioArg
      ? [aspectRatioArg.replace(':', '_')]
      : keys;

    for (const key of ratios) {
      const r = reframe[key];
      if (!r) {
        console.log(`  [${key}]  (no data)`);
        continue;
      }
      const status = r.status || 'unknown';
      const layout = r.layoutDecision?.layout_type || '—';
      const conf = r.layoutDecision?.confidence;
      const zoneCount = (r.zones || []).length;
      const stats = r.sceneStats || {};

      console.log(`  [${key.replace('_', ':')}]  status=${status}  layout=${layout}` +
        (conf ? `  confidence=${(conf * 100).toFixed(0)}%` : '') +
        `  zones=${zoneCount}`);

      if (stats.person_count !== undefined) {
        console.log(`     person_count=${stats.person_count}` +
          `  max_simultaneous=${stats.max_simultaneous ?? '?'}` +
          `  multi_person_fraction=${stats.multi_person_fraction ?? '?'}` +
          `  unique_ids_raw=${stats.unique_ids_raw ?? '?'}`);
        console.log(`     scene_type=${stats.scene_type}  motion=${stats.motion_level}  spread=${stats.spatial_spread}`);
      }

      if (r.error) console.log(`     error: ${r.error}`);
      if (r.layoutDecision?.reasoning) {
        console.log(`     reasoning: ${r.layoutDecision.reasoning}`);
      }
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
