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
      return new Response(null, { status: 204, headers: { ...corsHeaders(request), 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
    }
    if (request.method !== 'GET') return json({ ok: false, error: 'Only GET is supported' }, 405, request);

    const url = new URL(request.url);
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
};
