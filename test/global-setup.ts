// Downloads the MongoDB test binary once, before test files start in
// parallel; otherwise parallel workers race for the download lock.
import { MongoBinary } from 'mongodb-memory-server';

export default async function setup(): Promise<void> {
  await MongoBinary.getPath();
}
