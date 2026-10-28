'use strict';

// XTREAM CATALOG — serveur local sans dépendances (Node.js >= 20)
// Les identifiants restent en mémoire, dans ce serveur; jamais dans localStorage.

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const net = require('node:net');
const { Readable } = require('node:stream');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_HOSTS === '1';
const ROOT = __dirname;
const SESSION_MS = 12 * 60 * 60 * 1000;
const MEDIA_MS = 50 * 60 * 1000;
const sessions = new Map();
const resolvedHosts = new Map();
const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

const forbiddenV4 = (v) => {
  const p = v.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
    (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 192 && p[1] === 0 && p[2] === 0) || (p[0] === 198 && [18, 19].includes(p[1])) ||
    (p[0] === 192 && p[1] === 0 && p[2] === 2) ||
    (p[0] === 198 && p[1] === 51 && p[2] === 100) ||
    (p[0] === 203 && p[1] === 0 && p[2] === 113);
};
const forbiddenIP = ip => {
  if (net.isIP(ip) === 4) return forbiddenV4(ip);
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s.startsWith('::ffff:')) return forbiddenV4(s.slice(7));
  // Bloquer IPv6 loopback, link local, unique local, multicast, unspecified et réservés.
  return s === '::' || s === '::1' || s.startsWith('fe80:') || s.startsWith('fc') ||
    s.startsWith('fd') || s.startsWith('ff') || s.startsWith('2001:db8:');
};

async function ensureSafeUpstream(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
    throw new Error('URL HTTP(S) valide requise, sans identifiants intégrés.');
  }
  if (!ALLOW_PRIVATE) {
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
      throw new Error('Les adresses locales sont désactivées par sécurité.');
    }
    const cached = resolvedHosts.get(host);
    if (!cached || Date.now() - cached.at > 60_000) {
      const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
      if (!addrs.length || addrs.some(x => forbiddenIP(x.address))) {
        throw new Error('Cette adresse IP est bloquée pour éviter les accès internes.');
      }
      resolvedHosts.set(host, { at: Date.now() });
    }
  }
  return u;
}

async function upstreamFetch(input, headers = {}) {
  let url = String(input);
  for (let i = 0; i < 6; i++) {
    await ensureSafeUpstream(url);
    const res = await fetch(url, {
      headers: { 'user-agent': 'XtreamCatalog/1.0', ...headers },
      redirect: 'manual', signal: AbortSignal.timeout(25000),
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new Error('Redirection IPTV sans destination.');
      url = new URL(location, url).href;
      await res.body?.cancel();
      continue;
    }
    return { res, url };
  }
  throw new Error('Trop de redirections du fournisseur IPTV.');
}

function reply(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
function error(res, status, message) { reply(res, status, { error: message }); }

async function parseBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16000) throw new Error('Requête trop volumineuse.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Données JSON invalides.'); }
}

function parseInput(raw, fallbackUser, fallbackPass) {
  let value = String(raw || '').trim();
  if (!value) throw new Error('Indique le lien du serveur Xtream.');
  if (!/^https?:\/\//i.test(value)) value = 'http://' + value;
  const u = new URL(value);
  if (u.username || u.password) throw new Error('Saisis le nom d’utilisateur et le mot de passe dans leurs champs.');
  const user = String(fallbackUser || u.searchParams.get('username') || '').trim();
  const pass = String(fallbackPass || u.searchParams.get('password') || '');
  if (!user || !pass) throw new Error('Le nom d’utilisateur et le mot de passe sont nécessaires.');
  // Accepte URL Xtream, player_api.php, et liens M3U get.php.
  const p = u.pathname.replace(/\/(?:player_api|get|xmltv)\.php$/i, '');
  u.pathname = p.replace(/\/$/, '') || '/';
  u.search = '';
  u.hash = '';
  return { base: u.href.replace(/\/$/, ''), username: user, password: pass };
}

async function fetchJSON(session, action = '', params = {}) {
  const url = new URL(session.base + '/player_api.php');
  url.searchParams.set('username', session.username);
  url.searchParams.set('password', session.password);
  if (action) url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const { res } = await upstreamFetch(url.href, { accept: 'application/json' });
  if (!res.ok) throw new Error('Le serveur IPTV a répondu avec le code ' + res.status + '.');
  const length = Number(res.headers.get('content-length') || 0);
  if (length > 40_000_000) throw new Error('Catalogue trop volumineux.');
  const raw = await res.text();
  if (raw.length > 40_000_000) throw new Error('Catalogue trop volumineux.');
  try { return JSON.parse(raw); }
  catch { throw new Error('Le fournisseur n’a pas renvoyé de JSON Xtream valide.'); }
}

function getSession(req) {
  const cookie = req.headers.cookie || '';
  const id = cookie.split(';').map(x => x.trim()).find(x => x.startsWith('xt_session='))?.slice(11);
  const s = id ? sessions.get(id) : null;
  if (!s) return null;
  if (Date.now() - s.last > SESSION_MS) { sessions.delete(id); return null; }
  s.last = Date.now();
  return s;
}
function publicSession(s) {
  return {
    connected: true, host: new URL(s.base).host,
    username: s.username, status: s.status, expires: s.expires,
    libraryKey: s.libraryKey,
  };
}
function normalizeItem(x, kind) {
  const id = kind === 'series' ? x.series_id : x.stream_id;
  return {
    id: String(id ?? ''), name: String(x.name ?? 'Sans titre'),
    categoryId: String(x.category_id ?? ''),
    image: String(kind === 'series' ? (x.cover || x.stream_icon || '') : (x.stream_icon || '')),
    rating: x.rating ?? '', year: String(x.releaseDate || x.year || ''),
    desc: String(x.plot || x.description || ''),
    ext: String(x.container_extension || (kind === 'live' ? 'm3u8' : 'mp4')),
  };
}
const catalogs = {
  live: ['get_live_categories', 'get_live_streams'],
  movies: ['get_vod_categories', 'get_vod_streams'],
  series: ['get_series_categories', 'get_series'],
};
const isID = s => /^[\w-]{1,90}$/.test(s);
const isExt = s => /^(m3u8|ts|mp4|mkv|avi|mov|webm|mpg|mpeg)$/i.test(s);

function mediaURL(session, type, id, ext) {
  const prefix = type === 'live' ? 'live' : type === 'movies' ? 'movie' : 'series';
  const suffix = type === 'live' ? 'm3u8' : ext;
  if (!isID(id) || !isExt(suffix)) throw new Error('ID ou extension vidéo incorrecte.');
  return session.base + '/' + prefix + '/' + encodeURIComponent(session.username) + '/' +
    encodeURIComponent(session.password) + '/' + encodeURIComponent(id) + '.' + suffix;
}

function tokenFor(s, target) {
  const id = crypto.randomBytes(15).toString('hex');
  if (s.media.size > 12000) {
    const now = Date.now();
    for (const [key, entry] of s.media) if (now - entry.at > MEDIA_MS) s.media.delete(key);
    if (s.media.size > 12000) s.media.clear();
  }
  s.media.set(id, { url: target, at: Date.now() });
  return '/api/media?t=' + id;
}
function rewriteManifest(content, baseURL, session) {
  return content.split(/\r?\n/).map(line => {
    if (!line) return line;
    if (line[0] !== '#') {
      try { return tokenFor(session, new URL(line.trim(), baseURL).href); }
      catch { return line; }
    }
    // Clés AES, initialisation fMP4 et média alternatif.
    return line.replace(/URI="([^"]+)"/g, (_m, original) => {
      try { return 'URI="' + tokenFor(session, new URL(original, baseURL).href) + '"'; }
      catch { return 'URI="' + original + '"'; }
    });
  }).join('\n');
}

async function streamResponse(req, res, session, target) {
  const range = req.headers.range;
  const { res: upstream, url: finalURL } = await upstreamFetch(target, range ? { range } : {});
  if (!upstream.ok && upstream.status !== 206) {
    await upstream.body?.cancel();
    throw new Error('Flux indisponible (' + upstream.status + ').');
  }
  const type = upstream.headers.get('content-type') || '';
  const playlist = /\.m3u8(?:$|\?)/i.test(new URL(finalURL).pathname) || /mpegurl|x-mpegurl/i.test(type);
  if (playlist) {
    const raw = await upstream.text();
    if (raw.length > 8_000_000) throw new Error('Playlist trop volumineuse.');
    if (!raw.trimStart().startsWith('#EXTM3U')) throw new Error('Le serveur n’a pas renvoyé de playlist HLS valide.');
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' });
    return res.end(rewriteManifest(raw, finalURL, session));
  }
  const headers = { 'content-type': type || 'application/octet-stream', 'cache-control': 'no-store' };
  for (const name of ['content-length', 'content-range', 'accept-ranges']) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(upstream.status, headers);
  if (upstream.body) {
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
  } else res.end();
}

async function handle(req, res) {
  const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const name = u.pathname;
  if (req.method === 'GET' && staticFiles[name]) {
    const [filename, mime] = staticFiles[name];
    const data = await fs.readFile(path.join(ROOT, filename));
    res.writeHead(200, {
      'content-type': mime, 'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https: http: data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    return res.end(data);
  }
  if (!name.startsWith('/api/')) return error(res, 404, 'Page introuvable.');

  // Protection contre les requêtes cross-site modifiant la session.
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return error(res, 403, 'Origine non autorisée.');
  }
  if (req.method === 'POST' && name === '/api/connect') {
    const body = await parseBody(req);
    const parsed = parseInput(body.server, body.username, body.password);
    await ensureSafeUpstream(parsed.base);
    const account = await fetchJSON(parsed);
    if (Number(account?.user_info?.auth) !== 1) return error(res, 401, 'Identifiants refusés par ce serveur Xtream.');
    const id = crypto.randomBytes(32).toString('hex');
    const session = {
      ...parsed, last: Date.now(), cache: {}, media: new Map(),
      status: String(account.user_info?.status || 'Connecté'),
      expires: String(account.user_info?.exp_date || ''),
      libraryKey: crypto.createHash('sha256').update(parsed.base + ':' + parsed.username).digest('hex').slice(0, 14),
    };
    sessions.set(id, session);
    res.setHeader('set-cookie', 'xt_session=' + id + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200');
    return reply(res, 200, publicSession(session));
  }
  const session = getSession(req);
  if (req.method === 'GET' && name === '/api/session') {
    return reply(res, 200, session ? publicSession(session) : { connected: false });
  }
  if (req.method === 'POST' && name === '/api/logout') {
    const id = (req.headers.cookie || '').match(/(?:^|;\s*)xt_session=([^;]+)/)?.[1];
    if (id) sessions.delete(id);
    res.setHeader('set-cookie', 'xt_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return reply(res, 200, { connected: false });
  }
  if (!session) return error(res, 401, 'Connecte-toi à ton serveur Xtream.');
  if (req.method === 'GET' && name === '/api/catalog') {
    const section = u.searchParams.get('section');
    if (!catalogs[section]) return error(res, 400, 'Section inconnue.');
    const cached = session.cache[section];
    if (cached && Date.now() - cached.at < 8 * 60 * 1000) return reply(res, 200, cached.data);
    const [catAction, itemsAction] = catalogs[section];
    const [cats, data] = await Promise.all([
      fetchJSON(session, catAction).catch(() => []), fetchJSON(session, itemsAction),
    ]);
    if (!Array.isArray(data)) throw new Error('Le serveur a renvoyé un catalogue invalide.');
    const items = data.map(x => normalizeItem(x, section)).filter(x => isID(x.id));
    const categories = Array.isArray(cats) ? cats.map(x => ({
      id: String(x.category_id ?? ''), name: String(x.category_name || 'Autre'),
    })) : [];
    const result = { section, items, categories };
    session.cache[section] = { at: Date.now(), data: result };
    return reply(res, 200, result);
  }
  if (req.method === 'GET' && name === '/api/details') {
    const type = u.searchParams.get('type');
    const id = u.searchParams.get('id') || '';
    if (!isID(id)) return error(res, 400, 'Identifiant incorrect.');
    if (type === 'series') {
      const details = await fetchJSON(session, 'get_series_info', { series_id: id });
      const eps = details.episodes || {};
      const seasons = Object.entries(eps).map(([season, episodes]) => ({
        season: String(season), episodes: (Array.isArray(episodes) ? episodes : []).map(e => ({
          id: String(e.id ?? ''), title: String(e.title || e.info?.name || 'Épisode'),
          episodeNum: String(e.episode_num || ''), ext: String(e.container_extension || 'mp4'),
          duration: String(e.info?.duration || ''), plot: String(e.info?.plot || ''),
        })).filter(e => isID(e.id)),
      })).sort((a, b) => Number(a.season) - Number(b.season));
      return reply(res, 200, { info: details.info || {}, seasons });
    }
    if (type === 'movies') {
      const details = await fetchJSON(session, 'get_vod_info', { vod_id: id });
      return reply(res, 200, { info: details.info || {}, movie: details.movie_data || {} });
    }
    return error(res, 400, 'Type inconnu.');
  }
  if (req.method === 'GET' && name === '/api/stream') {
    const type = u.searchParams.get('type') || '';
    const id = u.searchParams.get('id') || '';
    const ext = u.searchParams.get('ext') || 'mp4';
    if (!['live', 'movies', 'series'].includes(type) || !isID(id) || !isExt(ext)) {
      return error(res, 400, 'Informations de lecture incorrectes.');
    }
    return streamResponse(req, res, session, mediaURL(session, type, id, ext));
  }
  if (req.method === 'GET' && name === '/api/media') {
    const token = u.searchParams.get('t');
    const entry = session.media.get(token);
    if (!entry || Date.now() - entry.at > MEDIA_MS) return error(res, 404, 'Segment vidéo expiré.');
    return streamResponse(req, res, session, entry.url);
  }
  return error(res, 404, 'Route inconnue.');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    const msg = err.name === 'TimeoutError' ? 'Le serveur Xtream ne répond pas (délai dépassé).' : (err.message || 'Erreur inattendue.');
    console.error('[Xtream]', msg.replace(/https?:\/\/\S+/g, '[URL masquée]'));
    if (!res.headersSent) error(res, 502, msg);
    else res.destroy();
  });
});
server.listen(PORT, HOST, () => console.log(`\nXtream Catalog prêt : http://${HOST}:${PORT}\n`));
setInterval(() => {
  for (const [id, s] of sessions) if (Date.now() - s.last > SESSION_MS) sessions.delete(id);
}, 10 * 60 * 1000).unref();
