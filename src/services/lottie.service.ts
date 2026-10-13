// services/lottie.service.ts
//
// Turning an uploaded or linked Lottie into one safe JSON file for the
// editor. A .lottie (dotLottie, a zip) is unpacked to its first animation,
// with its images inlined. Expressions (JavaScript inside a Lottie, run by
// the player) are removed, so a file can't run code in the editor.

import { unzipSync, strFromU8 } from 'fflate';
import { ApiError } from '../utils/ApiError';

export const LOTTIE_MAX_BYTES = 10 * 1024 * 1024;

export interface LottieInfo {
  json: Buffer;
  width: number;
  height: number;
  fps: number;
  duration: number;
  name?: string;
}

/** LottieFiles' own file hosts, https only (asset links are on lottie.host) */
export function isLottieFilesUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^(lottie\.host|assets\d*\.lottiefiles\.com|assets-v\d\.lottiefiles\.com)$/.test(url.hostname) &&
      /\.(json|lottie)$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

const bad = (message = "That isn't a Lottie animation.") => ApiError.withCode(422, 'NOT_LOTTIE', message);

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };

/** The first animation in a .lottie, with its images put inside it */
function fromDotLottie(bytes: Uint8Array): { data: any; name?: string } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => f.originalSize <= LOTTIE_MAX_BYTES * 3 });
  } catch {
    throw bad();
  }
  let manifest: any = {};
  try {
    manifest = files['manifest.json'] ? JSON.parse(strFromU8(files['manifest.json'])) : {};
  } catch {
    // no manifest: take the first animation found
  }
  const animations = Object.keys(files).filter((p) => /^(animations|a)\/[^/]+\.json$/.test(p));
  const wanted = manifest.animations?.[0]?.id;
  const path = animations.find((p) => p.endsWith(`/${wanted}.json`)) ?? animations[0];
  if (!path) throw bad();
  let data: any;
  try {
    data = JSON.parse(strFromU8(files[path]));
  } catch {
    throw bad();
  }
  // Images live beside it in images/ (v1) or i/ (v2): inline them
  for (const asset of Array.isArray(data.assets) ? data.assets : []) {
    if (typeof asset?.p !== 'string' || asset.e === 1 || asset.p.startsWith('data:')) continue;
    const file = files[`images/${asset.p}`] ?? files[`i/${asset.p}`] ?? files[`${asset.u ?? ''}${asset.p}`.replace(/^\/+/, '')];
    if (!file) continue;
    const ext = asset.p.split('.').pop()?.toLowerCase() ?? '';
    asset.u = '';
    asset.p = `data:${MIME[ext] ?? 'image/png'};base64,${Buffer.from(file).toString('base64')}`;
    asset.e = 1;
  }
  return { data, name: manifest.animations?.[0]?.id };
}

/** Removes expressions (string "x" on animated properties) anywhere in the animation; returns how many */
export function stripExpressions(node: any): number {
  let removed = 0;
  if (Array.isArray(node)) {
    for (const item of node) removed += stripExpressions(item);
  } else if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      if (key === 'x' && typeof node[key] === 'string') {
        delete node[key];
        removed++;
      } else removed += stripExpressions(node[key]);
    }
  }
  return removed;
}

/** A name worth showing: not empty, not a bare letter, not "Comp 1" or a random id */
export function meaningfulName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.replace(/\.(json|lottie)$/i, '').replace(/[_-]+/g, ' ').trim();
  if (name.length < 3) return undefined;
  if (/^(pre\s*)?comp(osition)?\s*\d*$|^(main\s*)?scene\s*\d*$|^untitled|^lottie(\s*animation)?$|^animation\s*\d*$/i.test(name)) return undefined;
  // lottie.host file ids: ten-ish mixed-case letters/digits, no spaces
  if (!/\s/.test(name) && /[a-z]/.test(name) && /[A-Z]/.test(name) && /^[A-Za-z0-9]{8,}$/.test(name)) return undefined;
  return name;
}

/** Bytes of a .json or .lottie → a checked, safe Lottie JSON file */
export function prepareLottie(bytes: Buffer): LottieInfo {
  if (bytes.length > LOTTIE_MAX_BYTES) throw ApiError.withCode(400, 'LOTTIE_TOO_LARGE', 'That animation is too large (10 MB at most).');
  let data: any;
  let name: string | undefined;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) ({ data, name } = fromDotLottie(new Uint8Array(bytes)));
  else {
    try {
      data = JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
    } catch {
      throw bad();
    }
  }
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!data || typeof data !== 'object' || !num(data.fr) || !num(data.ip) || !num(data.op) || !num(data.w) || !num(data.h) || !Array.isArray(data.layers)) throw bad();
  if (data.fr <= 0 || data.op <= data.ip || data.w <= 0 || data.h <= 0) throw bad();
  stripExpressions(data);
  const json = Buffer.from(JSON.stringify(data));
  if (json.length > LOTTIE_MAX_BYTES * 2) throw ApiError.withCode(400, 'LOTTIE_TOO_LARGE', 'That animation is too large (10 MB at most).');
  return {
    json,
    width: Math.round(data.w),
    height: Math.round(data.h),
    fps: data.fr,
    duration: Math.round(((data.op - data.ip) / data.fr) * 100) / 100,
    name: meaningfulName(data.nm) ?? meaningfulName(name),
  };
}
