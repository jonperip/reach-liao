// Reach Liao NUS shuttle relay (Cloudflare Worker).
//
// NUS's live shuttle feed (uNivUS, the official NUS app) only answers requests that
// carry a guest session cookie, and it doesn't let other websites read it directly.
// This worker opens the same public "continue as guest" session the uNivUS web app
// uses (no NUSNET login, no API key) and passes one stop's shuttle times back to
// Reach Liao.
//
//   GET /?stop=CLB   ->  {"ok":true,"result":{name, caption, TimeStamp, shuttles:[...]}}
//   GET /?ping       ->  {"ok":true}
//
// Answers are cached for 15 seconds so many viewers don't multiply requests to NUS.
//
// Bus tracking alerts (needs a KV namespace bound as KV and a cron trigger "* * * * *"):
//   GET  /push/key       ->  {"ok":true,"key":"<VAPID public key>"}  (keys are made on first use, kept in KV)
//   POST /track          {sub, kind:"bus"|"nus", stop, svc, minutes, stopName, url}  ->  {"ok":true,"id":"..."}
//   POST /track/cancel   {id}
// Every minute the cron checks each tracked bus and sends a Web Push notification when it is
// `minutes` away and again when it is arriving.

const ORIGIN = 'https://inetapps.nus.edu.sg';
const WEB_BASE = `${ORIGIN}/univus/web/`;
const LOGIN_URL = `${WEB_BASE}api/login/loginPublic`;
const ESB_URL = `${ORIGIN}/univus/web/api/esb`;
const SHUTTLE_METHOD = '/univus/api/bus-proxy/shuttle-service';
const XSRF_COOKIE = 'UNIVUS_WEB_XSRF_TOKEN';
const RENEW_AFTER_MS = 23 * 3600 * 1000;
const AUTH_CODES = new Set(['10007', '19000']); // guest session no longer valid
const CACHE_SECONDS = 15;

// Sites allowed to read answers from this relay.
const ALLOWED_ORIGINS = ['https://jonperip.github.io'];

const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
const MAX_TRACKERS = 30;
const TRACK_TTL_MS = 90 * 60 * 1000;

let session = null; // { cookies: {name: value}, at: ms }

function readSetCookies(headers) {
  const list = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get('set-cookie') || '').split(/,(?=\s*[A-Za-z0-9_\-]+=)/);
  const out = {};
  for (const line of list) {
    const pair = line.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

async function login() {
  // The login redirect itself carries the session cookies, so don't follow it.
  const resp = await fetch(LOGIN_URL, {
    redirect: 'manual',
    headers: { Accept: 'text/html', Referer: WEB_BASE },
  });
  const cookies = readSetCookies(resp.headers);
  if (!cookies[XSRF_COOKIE]) throw new Error(`guest login failed: HTTP ${resp.status}`);
  session = { cookies, at: Date.now() };
  return session;
}

async function queryStop(stop) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!session || Date.now() - session.at > RENEW_AFTER_MS || attempt === 1) await login();
    const c = session.cookies;
    const resp = await fetch(ESB_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-XSRF-TOKEN': decodeURIComponent(c[XSRF_COOKIE] || ''),
        Cookie: Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; '),
        Origin: ORIGIN,
        Referer: WEB_BASE,
      },
      body: JSON.stringify({ methodpath: SHUTTLE_METHOD, busstopname: stop }),
    });
    if ((resp.status === 401 || resp.status === 403) && attempt === 0) continue;
    if (!resp.ok) throw new Error(`NUS feed replied HTTP ${resp.status}`);
    let payload = await resp.json();
    if (typeof payload === 'string') payload = JSON.parse(payload); // sometimes double-encoded
    const code = payload && typeof payload === 'object' ? String(payload.code) : null;
    if (AUTH_CODES.has(code) && attempt === 0) continue;
    if (code !== '00000') throw new Error(`NUS feed code ${code}: ${(payload && payload.msg) || ''}`.trim());
    let data = payload.data;
    if (data && typeof data.ShuttleServiceResult === 'object') data = data.ShuttleServiceResult;
    if (!data || !Array.isArray(data.shuttles)) throw new Error('NUS feed sent an unexpected answer');
    return data;
  }
  throw new Error('NUS rejected the guest session');
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const ok = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return ok ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
}

function json(body, status, request, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(request), ...extra },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...corsHeaders(request), 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
    }
    const url = new URL(request.url);
    if (url.pathname.startsWith('/push') || url.pathname.startsWith('/track')) {
      try { return await handlePush(request, env, ctx, url); }
      catch (err) { return json({ ok: false, error: String(err && err.message || err) }, 500, request); }
    }
    if (request.method !== 'GET') return json({ ok: false, error: 'Only GET is supported' }, 405, request);
    if (url.searchParams.has('ping')) return json({ ok: true }, 200, request);

    const stop = (url.searchParams.get('stop') || '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9\-]{1,23}$/.test(stop)) return json({ ok: false, error: 'Add ?stop=<NUS stop name>, e.g. ?stop=CLB' }, 400, request);

    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}/__cache/${stop}`);
    const hit = await cache.match(cacheKey);
    if (hit) return json(await hit.json(), 200, request, { 'X-Relay-Cache': 'hit' });

    try {
      const result = await queryStop(stop);
      const body = { ok: true, result };
      ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(body), { headers: { 'Cache-Control': `max-age=${CACHE_SECONDS}` } })));
      return json(body, 200, request, { 'Cache-Control': `max-age=${CACHE_SECONDS}` });
    } catch (err) {
      session = null;
      return json({ ok: false, error: String(err && err.message || err) }, 502, request);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTrackers(env));
  },
};

// ---------------------------------------------------------------- bus tracking + Web Push

async function handlePush(request, env, ctx, url) {
  if (!env.KV) return json({ ok: false, error: 'storage', message: 'Bind a KV namespace as KV to turn on alerts' }, 501, request);
  if (url.pathname === '/push/key' && request.method === 'GET') return json({ ok: true, key: (await getVapid(env)).pub }, 200, request);
  if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405, request);
  const body = await request.json().catch(() => ({}));
  const list = JSON.parse((await env.KV.get('trackers')) || '[]');

  if (url.pathname === '/track/cancel') {
    const keep = list.filter(t => t.id !== body.id);
    if (keep.length !== list.length) await env.KV.put('trackers', JSON.stringify(keep));
    return json({ ok: true }, 200, request);
  }
  if (url.pathname !== '/track') return json({ ok: false, error: 'Unknown path' }, 404, request);

  const sub = body.sub || {};
  let host = '';
  try { host = new URL(sub.endpoint).hostname; } catch {}
  if (!/^https:/.test(sub.endpoint || '') || !PUSH_HOSTS.test(host) || !sub.keys?.p256dh || !sub.keys?.auth) return json({ ok: false, error: 'Not a valid push subscription' }, 400, request);
  const kind = body.kind === 'nus' ? 'nus' : 'bus';
  const stop = String(body.stop || '').toUpperCase(), svc = String(body.svc || '').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9\-]{1,23}$/.test(stop) || !/^[A-Z0-9]{1,6}$/.test(svc)) return json({ ok: false, error: 'Bad stop or bus' }, 400, request);
  const t = {
    id: crypto.randomUUID(), sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
    kind, stop, svc, minutes: Math.min(30, Math.max(1, Math.round(+body.minutes || 3))),
    stopName: String(body.stopName || stop).slice(0, 80), url: String(body.url || './').slice(0, 200), stage: 0, created: Date.now(),
  };
  const keep = list.filter(x => x.sub.endpoint !== t.sub.endpoint).slice(-(MAX_TRACKERS - 1));
  keep.push(t);
  await env.KV.put('trackers', JSON.stringify(keep));
  const label = busLabel(t);
  ctx.waitUntil(sendPush(env, t.sub, { title: `Tracking ${label}`, body: `You'll get an alert when it's ${t.minutes <= 1 ? 'arriving' : t.minutes + ' min'} from ${t.stopName}.`, tag: 'track', url: t.url }).catch(() => {}));
  return json({ ok: true, id: t.id }, 200, request);
}

const busLabel = t => t.kind === 'nus' ? `NUS shuttle ${t.svc}` : `bus ${t.svc}`;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

async function etaFor(t, cache) {
  const key = t.kind + ':' + t.stop;
  if (!(key in cache)) {
    cache[key] = (async () => {
      if (t.kind === 'nus') return { nus: await queryStop(t.stop) };
      const r = await fetch('https://arrivelah2.busrouter.sg/?id=' + encodeURIComponent(t.stop));
      if (!r.ok) throw new Error('arrivals HTTP ' + r.status);
      return { bus: await r.json() };
    })();
  }
  const d = await cache[key];
  if (d.nus) {
    const s = (d.nus.shuttles || []).find(x => String(x.name || '').toUpperCase().split(/[\s\-_(]/)[0] === t.svc);
    if (!s) return null;
    const v = [s.arrivalTime, (s._etas || [])[0]?.eta].find(x => x != null && x !== '' && x !== '-' && !isNaN(+x));
    return v == null ? null : Math.max(0, Math.round(+v));
  }
  const s = (d.bus.services || []).find(x => String(x.no).toUpperCase() === t.svc);
  if (!s || !s.next || !s.next.time) return null;
  return Math.max(0, Math.floor((Date.parse(s.next.time) - Date.now()) / 60000));
}

async function runTrackers(env) {
  if (!env.KV) return;
  const raw = (await env.KV.get('trackers')) || '[]';
  const list = JSON.parse(raw);
  if (!list.length) return;
  const cache = {}, keep = [];
  let changed = false;
  for (const t of list) {
    if (Date.now() - t.created > TRACK_TTL_MS) { changed = true; continue; }
    let eta;
    try { eta = await etaFor(t, cache); } catch { keep.push(t); continue; }
    if (eta == null) { keep.push(t); continue; }
    let msg = null;
    if (t.stage >= 1 && t.last != null && eta > t.last + 3) { changed = true; continue; } // that bus has gone; a later one is showing
    if (t.stage === 0 && eta <= t.minutes) {
      msg = { title: eta <= 1 ? `${cap(busLabel(t))} is arriving` : `${cap(busLabel(t))} is ${eta} min away`, body: `At ${t.stopName}.` };
      t.stage = eta <= 1 || t.minutes <= 1 ? 2 : 1; t.last = eta;
    } else if (t.stage === 1 && eta <= 1) {
      msg = { title: `${cap(busLabel(t))} is arriving`, body: `At ${t.stopName}.` };
      t.stage = 2;
    }
    if (msg) {
      changed = true;
      const status = await sendPush(env, t.sub, { ...msg, tag: 'track', url: t.url }).catch(() => 0);
      if (status === 404 || status === 410) continue; // subscription gone
    }
    if (t.stage >= 2) { changed = true; continue; } // done
    keep.push(t);
  }
  if (changed) await env.KV.put('trackers', JSON.stringify(keep));
}

// Web Push (RFC 8291 aes128gcm payload encryption, RFC 8292 VAPID)
const enc = new TextEncoder();
const b64u = {
  enc: buf => { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec: str => { const s = str.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(s + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0)); },
};
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };

async function getVapid(env) {
  const saved = await env.KV.get('vapid');
  if (saved) return JSON.parse(saved);
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const v = { pub: b64u.enc(await crypto.subtle.exportKey('raw', kp.publicKey)), jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
  await env.KV.put('vapid', JSON.stringify(v));
  return v;
}

async function vapidHeader(endpoint, v) {
  const head = b64u.enc(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.enc(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://jonperip.github.io/reach-liao/' })));
  const key = await crypto.subtle.importKey('jwk', { ...v.jwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + claims));
  return `vapid t=${head}.${claims}.${b64u.enc(sig)}, k=${v.pub}`;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

async function encryptPayload(sub, text) {
  const uaPublic = b64u.dec(sub.keys.p256dh), authSecret = b64u.dec(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(enc.encode(text), new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0); new DataView(header.buffer).setUint32(16, 4096); header[20] = asPublic.length; header.set(asPublic, 21);
  return concat(header, cipher);
}

async function sendPush(env, sub, data) {
  const v = await getVapid(env);
  const resp = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: await vapidHeader(sub.endpoint, v), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '600', Urgency: 'high' },
    body: await encryptPayload(sub, JSON.stringify(data)),
  });
  return resp.status;
}
