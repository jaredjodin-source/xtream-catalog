'use strict';

const $ = id => document.getElementById(id);
const sectionNames = { live: 'TV en direct', movies: 'Films', series: 'Séries', favorites: 'Mes favoris' };
const sectionDesc = {
  live: 'Toutes les chaînes de votre abonnement.',
  movies: 'Retrouvez tous vos films à la demande.',
  series: 'Parcourez les séries et leurs saisons.',
  favorites: 'Les contenus que vous avez enregistrés.',
};
const state = { connected: false, section: 'live', cache: {}, category: 'all', query: '', shown: 72, favs: new Set(), libraryKey: '', playerHls: null, currentDetails: null };
let toastTimer;

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeImage = v => {
  try { const u = new URL(String(v)); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; }
  catch { return ''; }
};
const clean = s => String(s || '').trim().toLocaleLowerCase('fr');

async function request(url, options) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  let data;
  try { data = await res.json(); } catch { throw Error('Réponse incorrecte du serveur.'); }
  if (!res.ok) throw Error(data.error || 'Erreur de connexion.');
  return data;
}
function toast(message) {
  clearTimeout(toastTimer);
  const el = $('toast'); el.textContent = message; el.classList.add('show');
  toastTimer = setTimeout(() => el.classList.remove('show'), 3300);
}
function showDashboard(session) {
  state.connected = true;
  state.libraryKey = session.libraryKey || 'default';
  try { state.favs = new Set(JSON.parse(localStorage.getItem('fluxio-favs-' + state.libraryKey) || '[]')); }
  catch { state.favs = new Set(); }
  $('serverLabel').textContent = session.host || 'Xtream';
  $('loginScreen').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  navigate('live');
}
function showLogin() {
  state.connected = false;
  state.cache = {};
  closePlayer();
  closeDetails();
  $('dashboard').classList.add('hidden');
  $('loginScreen').classList.remove('hidden');
}
function readXtreamLink() {
  const raw = $('server').value.trim();
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : 'http://' + raw);
    if (u.searchParams.has('username') && !$('username').value) $('username').value = u.searchParams.get('username') || '';
    if (u.searchParams.has('password') && !$('password').value) $('password').value = u.searchParams.get('password') || '';
  } catch { /* Entrée libre */ }
}
async function connect(event) {
  event.preventDefault();
  $('loginError').textContent = '';
  const btn = $('connectBtn'); btn.disabled = true;
  btn.firstChild.textContent = 'Connexion en cours… ';
  try {
    const data = await request('/api/connect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server: $('server').value, username: $('username').value, password: $('password').value }),
    });
    $('password').value = '';
    showDashboard(data);
    toast('Connexion réussie !');
  } catch (err) { $('loginError').textContent = err.message; }
  finally { btn.disabled = false; btn.firstChild.textContent = 'Se connecter '; }
}
async function logout() {
  try { await request('/api/logout', { method: 'POST' }); }
  catch (err) { toast(err.message); }
  showLogin();
}
function favKey(section, id) { return section + ':' + id; }
function saveFavorites() {
  localStorage.setItem('fluxio-favs-' + state.libraryKey, JSON.stringify([...state.favs]));
}
function toggleFavorite(item, section) {
  const key = favKey(section, item.id);
  if (state.favs.has(key)) state.favs.delete(key); else state.favs.add(key);
  saveFavorites(); renderItems();
}

async function loadCatalog(section) {
  if (state.cache[section]) return state.cache[section];
  const data = await request('/api/catalog?section=' + encodeURIComponent(section));
  state.cache[section] = data;
  return data;
}
async function navigate(section) {
  if (!sectionNames[section]) return;
  state.section = section; state.category = 'all'; state.query = ''; state.shown = 72;
  $('sidebar').classList.remove('open');
  $('search').value = '';
  $('breadcrumb').textContent = sectionNames[section];
  $('sectionTitle').textContent = sectionNames[section];
  $('sectionSubtitle').textContent = sectionDesc[section];
  document.querySelectorAll('.nav-link').forEach(x => x.classList.toggle('active', x.dataset.section === section));
  $('libraryStatus').textContent = 'Chargement du catalogue…';
  $('contentGrid').innerHTML = '';
  $('countPill').textContent = '— éléments';
  $('loadMore').classList.add('hidden');
  const token = Symbol();
  state.navToken = token;
  try {
    if (section === 'favorites') {
      await Promise.all(['live', 'movies', 'series'].map(s => loadCatalog(s).catch(() => null)));
    } else await loadCatalog(section);
    if (state.navToken !== token) return;
    updateCategories(); renderItems();
  } catch (err) {
    if (state.navToken !== token) return;
    $('libraryStatus').textContent = 'Impossible de charger le catalogue : ' + err.message;
    $('contentGrid').innerHTML = '<div class="empty"><strong>Catalogue inaccessible</strong><p>Vérifiez les informations Xtream et la disponibilité de votre fournisseur.</p></div>';
  }
}
function updateCategories() {
  let categories = [];
  if (state.section !== 'favorites') categories = state.cache[state.section]?.categories || [];
  const select = $('categorySelect');
  select.replaceChildren(new Option('Toutes les catégories', 'all'));
  const seen = new Set();
  categories.forEach(c => {
    if (seen.has(c.id)) return;
    seen.add(c.id); select.add(new Option(c.name, c.id));
  });
  select.disabled = state.section === 'favorites';
  select.value = 'all';
}
function listForSection() {
  if (state.section !== 'favorites') {
    return (state.cache[state.section]?.items || []).map(item => ({ item, section: state.section }));
  }
  const result = [];
  for (const section of ['live', 'movies', 'series']) {
    for (const item of state.cache[section]?.items || []) {
      if (state.favs.has(favKey(section, item.id))) result.push({ item, section });
    }
  }
  return result;
}
function renderItems() {
  const q = clean(state.query);
  const all = listForSection();
  const filtered = all.filter(({ item }) =>
    (state.category === 'all' || item.categoryId === state.category) &&
    (!q || clean(item.name).includes(q) || clean(item.desc).includes(q))
  );
  $('libraryStatus').textContent = '';
  $('countPill').textContent = filtered.length.toLocaleString('fr-BE') + ' éléments';
  $('loadMore').classList.toggle('hidden', state.shown >= filtered.length);
  if (!filtered.length) {
    $('contentGrid').innerHTML = '<div class="empty"><strong>Aucun contenu trouvé</strong><p>Essayez une autre recherche ou une autre catégorie.</p></div>';
    return;
  }
  const visible = filtered.slice(0, state.shown);
  $('contentGrid').innerHTML = visible.map(({ item, section }, i) => {
    const image = safeImage(item.image);
    const favorite = state.favs.has(favKey(section, item.id));
    const label = section === 'live' ? 'DIRECT' : section === 'movies' ? 'FILM' : 'SÉRIE';
    const rating = parseFloat(String(item.rating || ''));
    return `<article class="content-card" role="button" tabindex="0" data-idx="${i}" aria-label="Ouvrir ${esc(item.name)}">
      <div class="poster ${section === 'live' ? 'live' : ''} ${image ? '' : 'no-image'}">
        ${image ? `<img src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''}
        <span class="card-chip">${label}</span>
        <button class="fav-btn ${favorite ? 'liked' : ''}" data-fav-idx="${i}" title="${favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}" aria-label="Favoris">${favorite ? '♥' : '♡'}</button>
      </div>
      <h3 title="${esc(item.name)}">${esc(item.name)}</h3>
      <div class="card-meta"><span>${section === 'live' ? 'Chaîne TV' : section === 'movies' ? 'Film' : 'Série'}</span>${Number.isFinite(rating) && rating > 0 ? `<span class="rating">★ ${rating.toFixed(1)}</span>` : ''}</div>
    </article>`;
  }).join('');
  const grid = $('contentGrid');
  grid.querySelectorAll('img').forEach(img => img.addEventListener('error', () => { img.parentElement.classList.add('no-image'); img.remove(); }, { once: true }));
  grid.onclick = event => {
    const fav = event.target.closest('[data-fav-idx]');
    if (fav) {
      event.stopPropagation();
      const entry = visible[Number(fav.dataset.favIdx)];
      if (entry) toggleFavorite(entry.item, entry.section);
      return;
    }
    const card = event.target.closest('[data-idx]');
    if (card) { const entry = visible[Number(card.dataset.idx)]; if (entry) openItem(entry.item, entry.section); }
  };
  grid.onkeydown = event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.content-card')) {
      event.preventDefault();
      const entry = visible[Number(event.target.dataset.idx)];
      if (entry) openItem(entry.item, entry.section);
    }
  };
}

function openItem(item, section) {
  if (section === 'live') return openPlayer({ id: item.id, name: item.name, section, ext: 'm3u8' });
  return openDetails(item, section);
}
function closeDetails() { $('detailModal').classList.add('hidden'); $('modalContent').innerHTML = ''; }
function makeArt(item) {
  const url = safeImage(item.image);
  return `<div class="detail-art">${url ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer" />` : '▶'}</div>`;
}
function descMarkup(item, info) {
  const description = info.plot || info.description || item.desc || 'Aucun résumé disponible.';
  const tag = item.section === 'series' ? 'SÉRIE TV' : 'FILM À LA DEMANDE';
  const rating = info.rating || item.rating;
  return `<div class="detail-hero">${makeArt(item)}<div class="detail-main">
    <div class="detail-tag">${tag}</div><h2 id="modalTitle">${esc(item.name)}</h2>
    <div class="detail-data">${item.year ? esc(item.year) + ' &nbsp;·&nbsp; ' : ''}${rating ? '★ ' + esc(rating) : ''}</div>
    <p>${esc(description)}</p></div></div>`;
}
async function openDetails(item, section) {
  $('detailModal').classList.remove('hidden');
  $('modalContent').innerHTML = '<div class="detail-loading">Chargement des informations…</div>';
  state.currentDetails = { item, section };
  try {
    const data = await request('/api/details?type=' + section + '&id=' + encodeURIComponent(item.id));
    if (state.currentDetails?.item !== item) return;
    const info = data.info || {};
    let html = descMarkup({ ...item, section }, info);
    if (section === 'movies') {
      html += `<div class="detail-content"><button id="playMovie" class="primary-btn">▶ &nbsp; Regarder le film</button></div>`;
    } else {
      const seasons = data.seasons || [];
      html += `<div class="detail-content"><h3 class="details-title">Épisodes</h3>${seasons.length ?
        `<select id="seasonSelect" class="season-select" aria-label="Saison">${seasons.map((s, i) => `<option value="${i}">Saison ${esc(s.season)}</option>`).join('')}</select><div id="episodes"></div>` : '<p class="player-note">Aucun épisode disponible dans le catalogue.</p>'}</div>`;
    }
    $('modalContent').innerHTML = html;
    if (section === 'movies') {
      $('playMovie').onclick = () => {
        closeDetails(); openPlayer({ id: item.id, name: item.name, section, ext: item.ext });
      };
    } else if (data.seasons?.length) {
      const renderEpisodes = () => {
        const season = data.seasons[Number($('seasonSelect').value)];
        $('episodes').innerHTML = season.episodes.map((ep, i) => `<button class="episode" data-episode="${i}">
          <span class="episode-num">${esc(ep.episodeNum || (i + 1))}</span><span class="episode-text"><strong>${esc(ep.title)}</strong><small>${esc(ep.duration || 'Épisode')}</small></span><span class="episode-play">▶</span></button>`).join('') || '<p class="player-note">Aucun épisode dans cette saison.</p>';
        $('episodes').onclick = e => {
          const btn = e.target.closest('[data-episode]');
          if (!btn) return;
          const ep = season.episodes[Number(btn.dataset.episode)];
          closeDetails(); openPlayer({ id: ep.id, name: item.name + ' — ' + ep.title, section: 'series', ext: ep.ext });
        };
      };
      $('seasonSelect').onchange = renderEpisodes;
      renderEpisodes();
    }
  } catch (err) {
    $('modalContent').innerHTML = `<div class="detail-content" ><h2 id="modalTitle">${esc(item.name)}</h2><p class="error-note">${esc(err.message)}</p><p>Impossible de récupérer les détails de ce contenu.</p></div>`;
  }
}
function closePlayer() {
  $('playerModal').classList.add('hidden');
  const player = $('videoPlayer');
  if (state.playerHls) { state.playerHls.destroy(); state.playerHls = null; }
  player.pause(); player.removeAttribute('src'); player.load();
}
function openPlayer({ id, name, section, ext }) {
  const player = $('videoPlayer');
  closePlayer();
  $('playerTitle').textContent = name;
  const note = $('playerNote');
  note.textContent = 'Si une vidéo ne s’ouvre pas, son format n’est peut-être pas compatible avec le navigateur.';
  note.classList.remove('error-note');
  $('playerModal').classList.remove('hidden');
  const endpoint = '/api/stream?type=' + encodeURIComponent(section) + '&id=' + encodeURIComponent(id) + '&ext=' + encodeURIComponent(ext || 'mp4');
  const isHLS = section === 'live' || String(ext).toLowerCase() === 'm3u8';
  if (isHLS && player.canPlayType('application/vnd.apple.mpegurl')) {
    player.src = endpoint;
  } else if (isHLS && window.Hls?.isSupported()) {
    const hls = new window.Hls({ enableWorker: true });
    state.playerHls = hls;
    hls.loadSource(endpoint);
    hls.attachMedia(player);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => player.play().catch(() => {}));
    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        note.textContent = 'Lecture impossible : le flux HLS ne répond pas ou le serveur bloque ce format.';
        note.classList.add('error-note');
      }
    });
  } else if (isHLS) {
    note.textContent = 'Ce navigateur ne prend pas en charge HLS. Vérifiez votre accès à Internet pour charger le lecteur HLS.';
    note.classList.add('error-note');
  } else { player.src = endpoint; player.play().catch(() => {}); }
  player.onerror = () => {
    note.textContent = 'Impossible de lire la vidéo. Le navigateur ne prend peut-être pas en charge ce format (ex. MKV/AVI), ou le fournisseur refuse la lecture.';
    note.classList.add('error-note');
  };
}

$('loginForm').addEventListener('submit', connect);
$('server').addEventListener('change', readXtreamLink);
$('server').addEventListener('paste', () => setTimeout(readXtreamLink, 0));
$('togglePassword').addEventListener('click', () => {
  const input = $('password'); input.type = input.type === 'password' ? 'text' : 'password';
});
$('logoutBtn').addEventListener('click', logout);
document.querySelectorAll('[data-section]').forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.section)));
$('exploreBtn').addEventListener('click', () => $('search').focus());
$('search').addEventListener('input', e => { state.query = e.target.value; state.shown = 72; renderItems(); });
$('categorySelect').addEventListener('change', e => { state.category = e.target.value; state.shown = 72; renderItems(); });
$('refreshBtn').addEventListener('click', () => { delete state.cache[state.section]; navigate(state.section); });
$('loadMore').addEventListener('click', () => { state.shown += 72; renderItems(); });
$('menuBtn').addEventListener('click', () => $('sidebar').classList.toggle('open'));
$('closeModal').addEventListener('click', closeDetails);
$('closePlayer').addEventListener('click', closePlayer);
$('detailModal').addEventListener('click', e => { if (e.target === $('detailModal')) closeDetails(); });
$('playerModal').addEventListener('click', e => { if (e.target === $('playerModal')) closePlayer(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDetails(); closePlayer(); $('sidebar').classList.remove('open'); } });
request('/api/session').then(data => { if (data.connected) showDashboard(data); }).catch(() => {});
