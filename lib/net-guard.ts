import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/**
 * Is an address on the public internet? Used before the server fetches a URL someone else chose (a business's backup bucket,
 * a paywalled API), so it cannot be pointed at this server, its network or a cloud metadata address. IPv6 forms that carry an
 * IPv4 address inside them (::ffff:127.0.0.1, NAT64 64:ff9b::/96, 6to4 2002::/16) are judged by that IPv4 address.
 */
const PRIVATE_V4: [number, number][] = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24],
  [0xc0000200, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
];
const v4Number = (ip: string) => ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);
const v4Private = (n: number) => PRIVATE_V4.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));

/** The eight 16-bit groups of an IPv6 address (dotted IPv4 tails included), or null if it is not one. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    if (isIP(dotted[1]) !== 4) return null;
    const n = v4Number(dotted[1]);
    s = s.slice(0, -dotted[1].length) + `${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  if (s.split("::").length > 2) return null;
  const parse = (part: string) => (part ? part.split(":").map((g) => parseInt(g, 16)) : []);
  const h = parse(head), t = tail === undefined ? [] : parse(tail);
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill(0), ...t];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return v4Private(v4Number(ip));
  const g = v6Groups(ip);
  if (!g) return true; // not an address we can read: never treat it as public
  const embedded = (hi: number, lo: number) => v4Private(hi * 65536 + lo);
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return g[5] === 0 && g[6] === 0 && g[7] <= 1 ? true : embedded(g[6], g[7]); // ::, ::1, ::ffff:a.b.c.d, ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return embedded(g[6], g[7]); // NAT64
  if (g[0] === 0x2002) return embedded(g[1], g[2]); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link local fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/**
 * Refuse a URL that points anywhere but the public internet. `what` names it in the error ("The bucket's endpoint").
 * The name is resolved and every address it has must be public. (A name that changes its answer between this check and
 * the fetch is not covered; callers also refuse redirects.)
 */
export async function assertPublicUrl(raw: string, what: string, opts: { allowHttp?: boolean } = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${what} must be a URL`);
  }
  if (url.protocol !== "https:" && !(opts.allowHttp && url.protocol === "http:")) throw new Error(`${what} must start with https://`);
  if (url.username || url.password) throw new Error(`${what} must not carry a user name or password`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || /\.(localhost|internal|local|lan|home|corp)$/i.test(host)) throw new Error(`${what} must be a public address`);
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new Error(`${what} (${host}) could not be found`);
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new Error(`${what} must be a public address`);
  return url;
}

/**
 * fetch() for a URL someone else chose, that checks the address it actually connects to. The name is resolved at connect time
 * and the connection refused if any address is private, so a name that answers differently a second time (DNS rebinding)
 * cannot slip through between a check and the fetch. Redirects are never followed; the body is capped at `maxBytes`.
 * `allowPrivate` is for tests against a local stand-in only.
 */
export async function publicFetch(input: string | URL, init: RequestInit & { allowPrivate?: boolean; maxBytes?: number } = {}): Promise<Response> {
  const url = new URL(String(input));
  const mod = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
  if (!mod) throw new Error(`Only http(s) addresses can be fetched, not ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!init.allowPrivate && isIP(host) && isPrivateAddress(host)) throw new Error(`${host} is not a public address`);
  const max = init.maxBytes ?? 1024 * 1024 * 1024;
  const guarded = (name: string, options: LookupOptions, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => {
    dnsLookup(name, { ...options, all: true }, (err, found) => {
      if (err) return cb(err, "");
      const list = found as LookupAddress[];
      if (!list.length) return cb(new Error(`${name} could not be found`), "");
      if (!init.allowPrivate && list.some((a) => isPrivateAddress(a.address))) return cb(new Error(`${name} resolves to a private address`), "");
      if (options.all) cb(null, list);
      else cb(null, list[0].address, list[0].family);
    });
  };
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => (headers[k] = v));
  const body = init.body === undefined || init.body === null ? undefined : typeof init.body === "string" ? init.body : Buffer.from(init.body as Uint8Array);
  return new Promise<Response>((resolve, reject) => {
    const req = mod.request(url, { method: init.method ?? "GET", headers, lookup: guarded as never, signal: init.signal ?? undefined }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > max) req.destroy(new Error(`The answer is larger than ${Math.round(max / 1024 / 1024)} MB`));
        else chunks.push(c);
      });
      res.on("error", reject);
      res.on("end", () => {
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(", ") : String(v));
        const status = res.statusCode ?? 502;
        resolve(new Response([101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: out }));
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
