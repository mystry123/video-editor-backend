// utils/safeRequest.ts
//
// Outbound HTTP for URLs a user can influence (URL import, webhooks).
//
// Requests to private, loopback, link-local (incl. the 169.254.169.254
// metadata service), CGNAT, multicast and other reserved addresses are
// refused. The check happens inside the socket's DNS lookup, so the address
// that's checked is the address that's connected to: a hostname can't pass
// the check and then resolve somewhere internal (DNS rebinding), and every
// redirect hop goes through the same lookup. Literal-IP URLs, which skip DNS,
// are checked before the request and on each redirect.

import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';

export class BlockedUrlError extends Error {
  constructor(message = 'That address is not allowed') {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast
];

function isBlockedIPv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped / -compatible (::ffff:a.b.c.d, ::a.b.c.d)
  const mapped = lower.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  const firstHextet = parseInt(lower.split(':')[0] || '0', 16);
  if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((firstHextet & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (lower.startsWith('64:ff9b:')) return true; // NAT64, can reach IPv4 internals
  if (lower.startsWith('2001:db8:')) return true; // documentation
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip.replace(/^\[|\]$/g, ''));
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true; // not an IP at all: refuse rather than guess
}

/** Throws if the URL isn't http(s) or points at a blocked literal IP or local name. */
export function assertPublicUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError('That is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError('Only http and https links are supported');
  }
  if (url.username || url.password) {
    throw new BlockedUrlError('Links with a username or password are not supported');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new BlockedUrlError();
  }
  if (net.isIP(host) && isBlockedAddress(host)) {
    throw new BlockedUrlError();
  }
  return url;
}

// ---------------------------------------------------------------------------
// Agents whose DNS lookup refuses blocked addresses
// ---------------------------------------------------------------------------

type LookupCallback = (err: NodeJS.ErrnoException | null, address: any, family?: number) => void;

function safeLookup(hostname: string, options: any, callback: LookupCallback): void {
  dns.lookup(hostname, { ...(typeof options === 'object' ? options : {}), all: true }, (err, addresses) => {
    if (err) return callback(err, undefined);
    const list = (addresses as unknown as dns.LookupAddress[]) || [];
    if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
      return callback(new BlockedUrlError() as NodeJS.ErrnoException, undefined);
    }
    if (options?.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

const httpAgent = new http.Agent({ lookup: safeLookup as any, keepAlive: false });
const httpsAgent = new https.Agent({ lookup: safeLookup as any, keepAlive: false });

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface SafeRequestOptions extends Omit<AxiosRequestConfig, 'url' | 'httpAgent' | 'httpsAgent' | 'proxy'> {
  /** Max redirects to follow (each is re-checked). Default 3. */
  maxRedirects?: number;
  /** Max response size in bytes for buffered responses. Default 10 MB. */
  maxResponseBytes?: number;
}

/**
 * axios request that can't reach internal addresses. For `responseType:
 * 'stream'`, wrap the stream with `limitStream` to cap its size.
 */
export async function safeRequest<T = any>(rawUrl: string, options: SafeRequestOptions = {}): Promise<AxiosResponse<T>> {
  assertPublicUrl(rawUrl);
  const { maxRedirects = 3, maxResponseBytes = 10 * 1024 * 1024, ...config } = options;
  try {
    return await axios.request<T>({
      timeout: 15_000,
      ...config,
      url: rawUrl,
      httpAgent,
      httpsAgent,
      proxy: false,
      maxRedirects,
      maxContentLength: maxResponseBytes,
      maxBodyLength: maxResponseBytes,
      beforeRedirect: (redirectOptions: any) => {
        // Hostnames are checked by the agent's lookup; literal IPs and
        // local names need checking here.
        assertPublicUrl(redirectOptions.href || `${redirectOptions.protocol}//${redirectOptions.hostname}`);
      },
    });
  } catch (error: any) {
    if (error instanceof BlockedUrlError || error?.cause instanceof BlockedUrlError || error?.name === 'BlockedUrlError') {
      throw new BlockedUrlError();
    }
    throw error;
  }
}

/** Errors a stream once more than `maxBytes` have passed through it. */
export function limitStream<S extends NodeJS.ReadableStream>(stream: S, maxBytes: number, onLimit?: () => void): S {
  let seen = 0;
  stream.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > maxBytes) {
      onLimit?.();
      (stream as any).destroy(new Error(`Download exceeded the ${Math.round(maxBytes / (1024 * 1024))} MB limit`));
    }
  });
  return stream;
}
