(() => {
  'use strict';

  // ============================================================
  // Persistence
  // ============================================================
  const SAVE_KEY = 'serpentMutant_save_v2';

  function defaultSave() {
    return {
      best: 0,
      meta: 0,
      topScores: [], // [{score, room, date}] max 5, sorted desc
      unlocked: { colors: ['teal'], foods: ['classic'], backgrounds: ['default'] },
      equipped: { color: 'teal', food: 'classic', background: 'default' }
    };
  }

  function loadSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // merge with defaults to survive schema changes gracefully
        const d = defaultSave();
        return {
          best: typeof parsed.best === 'number' ? parsed.best : d.best,
          meta: typeof parsed.meta === 'number' ? parsed.meta : d.meta,
          topScores: Array.isArray(parsed.topScores) ? parsed.topScores : d.topScores,
          unlocked: {
            colors: parsed.unlocked?.colors || d.unlocked.colors,
            foods: parsed.unlocked?.foods || d.unlocked.foods,
            backgrounds: parsed.unlocked?.backgrounds || d.unlocked.backgrounds
          },
          equipped: {
            color: parsed.equipped?.color || d.equipped.color,
            food: parsed.equipped?.food || d.equipped.food,
            background: parsed.equipped?.background || d.equipped.background
          }
        };
      }
    } catch (e) {}
    // legacy save migration (v1 had only best/meta)
    try {
      const legacy = localStorage.getItem('serpentMutant_save_v1');
      if (legacy) {
        const p = JSON.parse(legacy);
        const d = defaultSave();
        d.best = p.best || 0;
        d.meta = p.meta || 0;
        return d;
      }
    } catch (e) {}
    return defaultSave();
  }

  function writeSave(save) {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) {}
  }

  let save = loadSave();
// ============================================================
// Musique de fond
// ============================================================
const MUSIC_TRACKS = {
  classic: 'audio/theme-classic.mp3',
  ice: 'audio/theme-ice.mp3',
  volcano: 'audio/theme-volcano.mp3'
};

let currentAudio = null;
let musicEnabled = localStorage.getItem('serpentMutant_muted') !== '1';
let musicVolume = (() => {
  const v = parseFloat(localStorage.getItem('serpentMutant_volume'));
  return isNaN(v) ? 0.4 : v;
})();
let lastPlayedTrack = null; // {trackKey, reversed} - pour reprise après unmute

function setMusicVolume(v) {
  musicVolume = Math.max(0, Math.min(1, v));
  localStorage.setItem('serpentMutant_volume', String(musicVolume));
  if (currentAudio && currentAudio.gainNode) {
    currentAudio.gainNode.gain.value = musicVolume;
  } else if (currentAudio && typeof currentAudio.volume === 'number') {
    currentAudio.volume = musicVolume;
  }
}

function setMusicMuted(muted) {
  musicEnabled = !muted;
  localStorage.setItem('serpentMutant_muted', muted ? '1' : '0');
  if (muted) {
    stopMusic();
  } else if (lastPlayedTrack) {
    playMusic(lastPlayedTrack.trackKey, { reversed: lastPlayedTrack.reversed });
  }
}

function stopMusic() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
}

function playMusic(trackKey, { reversed = false } = {}) {
  lastPlayedTrack = { trackKey, reversed };
  if (!musicEnabled) return;
  stopMusic();

  const src = MUSIC_TRACKS[trackKey];
  if (!src) return;

  if (reversed) {
    playReversedTrack(src);
    return;
  }

  const audio = new Audio(src);
  audio.loop = true;
  audio.volume = musicVolume;
  audio.play().catch(() => {
    // Lecture bloquée par le navigateur tant qu'aucune interaction utilisateur
    // n'a eu lieu sur la page - se reproduira au prochain clic/touche.
  });
  currentAudio = audio;
}

// Lecture à l'envers via Web Audio API (pour le niveau Miroir)
let reversedBufferCache = {};
async function playReversedTrack(src) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioContextClass();

    let buffer = reversedBufferCache[src];
    if (!buffer) {
      const response = await fetch(src);
      const arrayBuffer = await response.arrayBuffer();
      const decoded = await audioCtx.decodeAudioData(arrayBuffer);
      // Inverse chaque canal audio
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        decoded.getChannelData(ch).reverse();
      }
      buffer = decoded;
      reversedBufferCache[src] = buffer;
    }

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = musicVolume;
    source.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    source.start(0);

    currentAudio = { pause: () => source.stop(), currentTime: 0, gainNode };
  } catch (err) {
    console.warn('Lecture inversée impossible :', err);
  }
}
  // ============================================================
  // Cloud backend (Google Sheets + Apps Script) - optional
  // ============================================================
  // Colle ici l'URL de ta Web App Apps Script (voir le tuto fourni).
  // Tant que cette URL n'est pas renseignée, tout fonctionne normalement
  // en local (localStorage) et les appels cloud sont simplement ignorés.
  const WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbzNEhkZOHMhBnBE4Ucba8cRTvpy-YBbRlrlgtrku_hksrXsuIm_o-9rt-VfFZEfb3Vy_g/exec'; // ex: 'https://script.google.com/macros/s/AKfycb.../exec'

  function getOrCreatePlayerId() {
    let id = localStorage.getItem('serpentMutant_playerId');
    if (!id) {
      id = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('serpentMutant_playerId', id);
    }
    return id;
  }
  const PLAYER_ID = getOrCreatePlayerId();

  function cloudEnabled() {
    return typeof WEBAPP_URL === 'string' && WEBAPP_URL.trim().length > 0;
  }

  let lastCloudErrorTimestamp = 0;
  const CLOUD_ERROR_DISPLAY_MS = 8000;

  function setCloudStatus(text, isError) {
    const el = document.getElementById('cloudStatus');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#ff6b9d' : '#9a9ab5';
    if (isError) lastCloudErrorTimestamp = Date.now();
  }

  function updateCloudStatusIdle() {
    // Don't overwrite a recent error message right away - give the player
    // time to actually read it when they land back on the menu.
    if (Date.now() - lastCloudErrorTimestamp < CLOUD_ERROR_DISPLAY_MS) return;
    if (!cloudEnabled()) {
      setCloudStatus('☁️ Mode local uniquement (aucune URL cloud configurée)');
    } else {
      setCloudStatus('☁️ Connecté au classement en ligne');
    }
  }

  async function submitScoreToCloud(scoreVal, roomVal, eclatsGagnes, difficulty) {
    if (!cloudEnabled()) return;
    try {
      const res = await fetch(WEBAPP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // évite le preflight CORS qui bloque Apps Script
        body: JSON.stringify({
          action: 'submitScore',
          playerId: PLAYER_ID,
          pseudo: (localStorage.getItem('serpentMutant_pseudo') || 'Anonyme'),
          score: scoreVal,
          room: roomVal,
          difficulty: difficulty,
          eclats: eclatsGagnes
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || (data && data.error)) {
        if (data && data.error === 'pseudo_taken') {
          setCloudStatus('⚠️ Pseudo déjà pris — choisis-en un autre', true);
        } else if (data && data.error === 'rate_limited') {
          setCloudStatus('⚠️ Trop de requêtes, réessaie dans quelques secondes', true);
        } else {
          setCloudStatus('⚠️ Score non envoyé (' + (data && data.error ? data.error : ('HTTP ' + res.status)) + ')', true);
        }
      } else {
        setCloudStatus('✅ Score envoyé au classement en ligne');
        if (data && data.pseudo) lockPseudo(data.pseudo);
      }
    } catch (err) {
      console.warn('Envoi du score au cloud a échoué (le score local reste sauvegardé) :', err);
      setCloudStatus('⚠️ Envoi au cloud impossible (voir console)', true);
    }
  }

  async function saveEclatsToCloud(totalEclats) {
    if (!cloudEnabled()) return;
    try {
      const res = await fetch(WEBAPP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'saveEclats',
          playerId: PLAYER_ID,
          totalEclats: totalEclats
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || (data && data.error)) {
        setCloudStatus('⚠️ Éclats non synchronisés (' + (data && data.error ? data.error : ('HTTP ' + res.status)) + ')', true);
      }
    } catch (err) {
      console.warn('Sauvegarde des Éclats au cloud a échoué (la sauvegarde locale reste valide) :', err);
      setCloudStatus('⚠️ Synchro Éclats impossible (voir console)', true);
    }
  }

  const PSEUDO_REGEX = /^[a-zA-Z0-9_-]{3,18}$/;

  function isPseudoLocked() {
    return localStorage.getItem('serpentMutant_pseudoLocked') === '1';
  }
  function lockPseudo(pseudo) {
    localStorage.setItem('serpentMutant_pseudo', pseudo);
    localStorage.setItem('serpentMutant_pseudoLocked', '1');
  }

  async function checkPseudoAvailable(pseudo) {
    if (!cloudEnabled()) return { available: true };
    if (!PSEUDO_REGEX.test(pseudo)) return { available: false, error: 'invalid_format' };
    try {
      const res = await fetch(WEBAPP_URL + '?action=checkPseudo&pseudo=' + encodeURIComponent(pseudo));
      return await res.json();
    } catch (err) {
      return { available: true }; // pas bloquant si offline, le serveur validera au submit
    }
  }

  async function fetchGlobalTopScores() {
    if (!cloudEnabled()) return [];
    try {
      const res = await fetch(WEBAPP_URL + '?action=getTopScores');
      const data = await res.json();
      if (data && data.error) {
        setCloudStatus('⚠️ Classement global : ' + data.error, true);
        return [];
      }
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.warn('Impossible de récupérer le classement global :', err);
      setCloudStatus('⚠️ Classement global inaccessible (voir console)', true);
      return [];
    }
  }


  function addTopScore(score, room) {
    save.topScores.push({ score, room, date: Date.now() });
    save.topScores.sort((a, b) => b.score - a.score);
    save.topScores = save.topScores.slice(0, 5);
  }

  // ============================================================
  // Shop catalog
  // ============================================================
  const SHOP_COLORS = [
    { id: 'teal',    name: 'Turquoise',  price: 0,   head: '#0fbfae', body: '#0a9d90' },
    { id: 'pink',    name: 'Rose',       price: 50,  head: '#ff6b9d', body: '#d94f7f' },
    { id: 'gold',    name: 'Or',         price: 80,  head: '#ffd93d', body: '#d9af1f' },
    { id: 'purple',  name: 'Violet',     price: 120, head: '#a06bff', body: '#7c4fd9' },
    { id: 'green',   name: 'Vert forêt', price: 150, head: '#6bcb77', body: '#4a9d55' },
    { id: 'blue',    name: 'Bleu roi',   price: 200, head: '#4a90ff', body: '#2f6fd9' },
    { id: 'orange',  name: 'Orange',     price: 250, head: '#ff9d4a', body: '#d97a2f' },
    { id: 'red',     name: 'Rouge',      price: 300, head: '#ff4a5c', body: '#d92f3f' },
    { id: 'rainbow', name: 'Arc-en-ciel', price: 400, head: '#ff6b9d', body: '#a06bff', rainbow: true }
  ];

  const SHOP_FOODS = [
    { id: 'classic', name: 'Classique', price: 0,   emoji: '🔴', color: '#ff6b9d' },
    { id: 'apple',   name: 'Pomme',     price: 40,  emoji: '🍎', color: '#ff4a4a' },
    { id: 'cherry',  name: 'Cerise',    price: 60,  emoji: '🍒', color: '#d92f4f' },
    { id: 'grape',   name: 'Raisin',    price: 90,  emoji: '🍇', color: '#a06bff' },
    { id: 'orange',  name: 'Orange',    price: 130, emoji: '🍊', color: '#ff9d4a' },
    { id: 'star',    name: 'Étoile',    price: 170, emoji: '⭐', color: '#ffd93d' },
    { id: 'gem',     name: 'Gemme',     price: 220, emoji: '💎', color: '#4ae0ff' },
    { id: 'donut',   name: 'Donut',     price: 280, emoji: '🍩', color: '#e08a4a' },
    { id: 'sushi',   name: 'Sushi',     price: 350, emoji: '🍣', color: '#f5f5f5' }
  ];

  const SHOP_BACKGROUNDS = [
    { id: 'default', name: 'Nuit', price: 0,   bg: '#10101c', grid: 'rgba(255,255,255,0.03)' },
    { id: 'ocean',    name: 'Océan', price: 60,  bg: '#0a1e2e', grid: 'rgba(80,180,255,0.06)' },
    { id: 'forest',   name: 'Forêt', price: 110, bg: '#0e1f14', grid: 'rgba(107,203,119,0.07)' },
    { id: 'sunset',   name: 'Coucher de soleil', price: 180, bg: '#2e1420', grid: 'rgba(255,107,157,0.06)' },
    { id: 'void',     name: 'Vide stellaire', price: 260, bg: '#050510', grid: 'rgba(160,107,255,0.08)' }
  ];

  function shopCatalog(tab) {
    if (tab === 'colors') return SHOP_COLORS;
    if (tab === 'foods') return SHOP_FOODS;
    return SHOP_BACKGROUNDS;
  }
  function unlockedKey(tab) {
    return tab === 'colors' ? 'colors' : tab === 'foods' ? 'foods' : 'backgrounds';
  }
  function equippedKey(tab) {
    return tab === 'colors' ? 'color' : tab === 'foods' ? 'food' : 'background';
  }

  function getEquippedColor() {
    return SHOP_COLORS.find(c => c.id === save.equipped.color) || SHOP_COLORS[0];
  }
  function getEquippedFood() {
    return SHOP_FOODS.find(f => f.id === save.equipped.food) || SHOP_FOODS[0];
  }
  function getEquippedBackground() {
    return SHOP_BACKGROUNDS.find(b => b.id === save.equipped.background) || SHOP_BACKGROUNDS[0];
  }

  // ============================================================
  // Canvas setup
  // ============================================================
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const GRID = 20;
  let CELL = canvas.width / GRID;

  function resizeCanvas() {
    const maxW = Math.min(560, window.innerWidth - 40);
    canvas.width = maxW;
    canvas.height = maxW;
    CELL = canvas.width / GRID;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // ============================================================
  // DOM refs
  // ============================================================
  const scoreVal = document.getElementById('scoreVal');
  const roomVal = document.getElementById('roomVal');
  const bestVal = document.getElementById('bestVal');
  const metaVal = document.getElementById('metaVal');
  const mutBar = document.getElementById('mutBar');
  const hud = document.getElementById('hud');
  const gameWrap = document.getElementById('gameWrap');
  const btnMenuFromGame = document.getElementById('btnMenuFromGame');
  const btnMuteGameEl = document.getElementById('btnMuteGame');
  const touchControls = document.getElementById('touchControls');

  const menuOverlay = document.getElementById('menuOverlay');
  const difficultyOverlay = document.getElementById('difficultyOverlay');
  const shopOverlay = document.getElementById('shopOverlay');
  const scoresOverlay = document.getElementById('scoresOverlay');
  const overlayMut = document.getElementById('mutOverlay');
  const overlayOver = document.getElementById('overOverlay');

  function refreshTopHud() {
    bestVal.textContent = save.best;
    metaVal.textContent = save.meta;
    document.getElementById('statBest').textContent = save.best;
    document.getElementById('statMeta').textContent = save.meta;
    document.getElementById('shopMetaVal').textContent = save.meta;
  }
  refreshTopHud();

  // ============================================================
  // Screen management
  // ============================================================
  function showScreen(name) {
    menuOverlay.classList.add('hidden');
    shopOverlay.classList.add('hidden');
    scoresOverlay.classList.add('hidden');
    difficultyOverlay.classList.add('hidden');
    overlayMut.classList.add('hidden');
    overlayOver.classList.add('hidden');
    hud.classList.add('hidden');
    gameWrap.classList.add('hidden');
    btnMenuFromGame.classList.add('hidden');
    btnMuteGameEl.classList.add('hidden');
    touchControls.style.display = 'none';

    if (name === 'menu') {
      refreshTopHud();
      const pseudoInput = document.getElementById('pseudoInput');
      if (pseudoInput) pseudoInput.value = localStorage.getItem('serpentMutant_pseudo') || '';
      updateCloudStatusIdle();
      menuOverlay.classList.remove('hidden');
    } else if (name === 'difficulty') {
      renderDifficultyScreen();
      difficultyOverlay.classList.remove('hidden');
    } else if (name === 'shop') {
      refreshTopHud();
      renderShop();
      shopOverlay.classList.remove('hidden');
    } else if (name === 'scores') {
      renderScores();
      scoresOverlay.classList.remove('hidden');
    } else if (name === 'game') {
      hud.classList.remove('hidden');
      gameWrap.classList.remove('hidden');
      btnMenuFromGame.classList.remove('hidden');
      btnMuteGameEl.classList.remove('hidden');
      if (window.innerWidth <= 640) touchControls.style.display = 'grid';
    }
  }

  // ============================================================
  // Shop rendering
  // ============================================================
  let currentShopTab = 'colors';

  document.querySelectorAll('.shopTab').forEach(tabEl => {
    tabEl.addEventListener('click', () => {
      currentShopTab = tabEl.dataset.tab;
      document.querySelectorAll('.shopTab').forEach(t => t.classList.remove('active'));
      tabEl.classList.add('active');
      renderShop();
    });
  });

  function renderShop() {
    const grid = document.getElementById('shopGrid');
    grid.innerHTML = '';
    const catalog = shopCatalog(currentShopTab);
    const uKey = unlockedKey(currentShopTab);
    const eKey = equippedKey(currentShopTab);

    catalog.forEach(item => {
      const isUnlocked = save.unlocked[uKey].includes(item.id) || item.price === 0;
      const isEquipped = save.equipped[eKey] === item.id;
      const canAfford = save.meta >= item.price;

      const cell = document.createElement('div');
      cell.className = 'shopItem' + (isEquipped ? ' equipped' : '') + (!isUnlocked && !canAfford ? ' locked' : '');

      let swatchContent = '';
      let swatchStyle = '';
      if (currentShopTab === 'colors') {
        swatchStyle = item.rainbow
          ? `background: linear-gradient(135deg, #ff6b9d, #ffd93d, #6bcb77, #4a90ff, #a06bff);`
          : `background: ${item.head};`;
      } else if (currentShopTab === 'foods') {
        swatchContent = item.emoji;
        swatchStyle = `background: rgba(255,255,255,0.08);`;
      } else {
        swatchStyle = `background: ${item.bg}; border: 1px solid rgba(255,255,255,0.15);`;
      }

      cell.innerHTML = `
        <div class="swatch" style="${swatchStyle}">${swatchContent}</div>
        <div class="iName">${item.name}</div>
        ${isEquipped
          ? '<div class="iEquipped">✓ Équipé</div>'
          : isUnlocked
            ? '<div class="iPrice">Débloqué</div>'
            : `<div class="iPrice">${canAfford ? '' : '🔒 '}${item.price} 🧬</div>`
        }
      `;

      cell.addEventListener('click', () => {
        if (isUnlocked) {
          save.equipped[eKey] = item.id;
          writeSave(save);
          renderShop();
        } else if (canAfford) {
          save.meta -= item.price;
          save.unlocked[uKey].push(item.id);
          save.equipped[eKey] = item.id;
          writeSave(save);
          saveEclatsToCloud(save.meta);
          refreshTopHud();
          renderShop();
        }
      });

      grid.appendChild(cell);
    });
  }

  // ============================================================
  // Difficulty select rendering
  // ============================================================
  function renderDifficultyScreen() {
    document.querySelectorAll('.diffBtn').forEach(btn => {
      const isSelected = btn.dataset.diff === selectedDifficulty;
      btn.style.outline = isSelected ? '2px solid var(--accent)' : 'none';
      btn.style.background = isSelected ? 'rgba(15,191,174,0.15)' : '';
    });
  }

  // ============================================================
  // Scores rendering
  // ============================================================
  function renderScores() {
    const list = document.getElementById('scoresList');
    list.innerHTML = '';
    const scores = (save.topScores || [])
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    if (scores.length === 0) {
      list.innerHTML = '<div class="emptyScores">Aucun score enregistré pour l’instant. Lance un run !</div>';
      return;
    }
    scores.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'scoreRow';
      const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i] || (i + 1);
      row.innerHTML = `
        <div class="rank">${medal}</div>
        <div class="details">
          <div class="sc">${s.score} pts</div>
          <div class="rm">Salle ${s.room}</div>
        </div>
      `;
      list.appendChild(row);
    });

    renderGlobalScores();
  }

  async function renderGlobalScores() {
    const section = document.getElementById('globalScoresSection');
    const list = document.getElementById('globalScoresList');
    if (!cloudEnabled()) {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');
    list.innerHTML = '<div class="emptyScores">Chargement…</div>';
    const globalScores = await fetchGlobalTopScores();
    if (!globalScores || globalScores.length === 0) {
      list.innerHTML = '<div class="emptyScores">Aucun score global pour l’instant.</div>';
      return;
    }
    list.innerHTML = '';
    globalScores.slice(0, 10).forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'scoreRow';

      const rank = document.createElement('div');
      rank.className = 'rank';
      rank.textContent = String(i + 1);

      const details = document.createElement('div');
      details.className = 'details';
      const sc = document.createElement('div');
      sc.className = 'sc';
      sc.textContent = `${s.pseudo || 'Anonyme'} — ${s.score} pts`;
      const rm = document.createElement('div');
      rm.className = 'rm';
      rm.textContent = `Salle ${s.room} · ${s.difficulty || 'normal'}`;
      details.appendChild(sc);
      details.appendChild(rm);

      row.appendChild(rank);
      row.appendChild(details);
      list.appendChild(row);
    });
  }

  const DIFFICULTIES = {
    easy:   { label: '🟢 Facile',    speedMult: 1, scoreMult: 1, tickMs: 150 },
    normal: { label: '🟡 Normal',    speedMult: 2, scoreMult: 2, tickMs: 100 },
    hard:   { label: '🔴 Difficile', speedMult: 3, scoreMult: 3, tickMs: 70 }
  };
  let selectedDifficulty = 'normal';

  // ============================================================
  // Game state
  // ============================================================
  let snake = [], dir = {x:1,y:0}, nextDir = {x:1,y:0}, food = [], obstacles = [], score = 0, room = 1, alive = false, tickTimer;
  let waitingForFirstInput = true;
  let activeMutations = [];
  let shieldCharges = 0;
  let particles = [];
  let doubleFoodActive = false;

  const MUTATION_POOL = [
    { id: 'speed', title: '⚡ Accélération', desc: 'Le serpent se déplace 15% plus vite en permanence.',
      apply: () => { baseTickMs = Math.max(60, baseTickMs * 0.85); } },
    { id: 'shield', title: '🛡️ Bouclier', desc: 'Survis à 1 collision fatale (rechargeable en mangeant 5 fruits).',
      apply: () => { shieldCharges += 1; } },
    { id: 'phase', title: '👻 Traversée', desc: 'Traverse les bords de l\'arène (téléportation) au lieu de mourir.',
      apply: () => { wallsWrap = true; } },
    { id: 'doublefood', title: '🍎🍎 Double Fruit', desc: 'Deux fruits apparaissent en permanence sur le plateau.',
      apply: () => { doubleFoodActive = true; } },
    { id: 'shrink', title: '✂️ Régime', desc: 'Le serpent perd 2 segments à chaque fruit mangé — plus facile à manœuvrer.',
      apply: () => { shrinkMode = true; } },
    { id: 'magnet', title: '🧲 Aimant', desc: 'Les fruits proches sont légèrement attirés vers la tête du serpent.',
      apply: () => { magnetActive = true; } },
    { id: 'scorex2', title: '💰 Cupidité', desc: 'Chaque fruit rapporte le double de points.',
      apply: () => { scoreMultiplier *= 2; } },
    { id: 'slowobstacles', title: '🧊 Gel', desc: 'Les nouveaux obstacles apparaissent moins fréquemment.',
      apply: () => { obstacleDensity = Math.max(0.02, obstacleDensity * 0.6); } }
  ];

  let baseTickMs = 150;
  let difficultyScoreMult = 1;
  let wallsWrap = false;
  let shrinkMode = false;
  let magnetActive = false;
  let scoreMultiplier = 1;
  let obstacleDensity = 0.05;
  let fruitsEatenThisRun = 0;

  // ============================================================
  // Special rooms (miroir / glace / volcan)
  // ============================================================
  const SPECIAL_ROOM_START = 3; // ne peuvent apparaître qu'à partir de cette salle
  const SPECIAL_ROOM_CHANCE = 0.25; // 1 chance sur 4
  const SPECIAL_ROOM_TYPES = ['mirror', 'ice', 'volcano'];

  let currentSpecialRoom = null; // null | 'mirror' | 'ice' | 'volcano'
  let iceCells = [];             // [{x,y}] cases givrées (niveau glace)
  let slideQueue = 0;            // nombre de cases de glissade restantes à appliquer
  let lavaCells = [];            // [{x,y}] cases actuellement en lave (niveau volcan)
  let lavaCyclePositions = [];   // pool de positions candidates pour la lave
  let lavaCycleTimer = null;
  const LAVA_CYCLE_MS = 2500;    // à quel rythme les zones de lave changent de place
  const LAVA_WARNING_MS = 900;   // temps d'avertissement visuel avant que ça devienne mortel

  function rollSpecialRoom() {
    if (room < SPECIAL_ROOM_START) return null;
    if (Math.random() >= SPECIAL_ROOM_CHANCE) return null;
    return SPECIAL_ROOM_TYPES[Math.floor(Math.random() * SPECIAL_ROOM_TYPES.length)];
  }

  function clearSpecialRoomEffects() {
    if (lavaCycleTimer) { clearInterval(lavaCycleTimer); lavaCycleTimer = null; }
    iceCells = [];
    lavaCells = [];
    lavaCyclePositions = [];
    slideQueue = 0;
  }

  function setupSpecialRoom(type) {
  clearSpecialRoomEffects();
  currentSpecialRoom = type;
  if (type === 'ice') {
    generateIceCells();
    playMusic('ice');
  } else if (type === 'volcano') {
    generateLavaCyclePositions();
    cycleLavaZones();
    lavaCycleTimer = setInterval(cycleLavaZones, LAVA_CYCLE_MS);
    playMusic('volcano');
  } else if (type === 'mirror') {
    playMusic('classic', { reversed: true });
  } else {
    playMusic('classic'); // retour à une salle normale après une salle spéciale
  }
}

  function generateIceCells() {
    iceCells = [];
    const count = Math.floor(GRID * GRID * 0.06);
    let tries = 0;
    const headX = snake && snake[0] ? snake[0].x : 10;
    const headY = snake && snake[0] ? snake[0].y : 10;
    while (iceCells.length < count && tries < 400) {
      tries++;
      const x = Math.floor(Math.random() * GRID);
      const y = Math.floor(Math.random() * GRID);
      if (Math.abs(x - headX) < 4 && Math.abs(y - headY) < 4) continue;
      if (!cellFree(x, y)) continue;
      if (iceCells.some(c => c.x === x && c.y === y)) continue;
      iceCells.push({ x, y });
    }
  }

  function generateLavaCyclePositions() {
    // Un pool plus large que ce qui est actif à un instant T, pour piocher dedans à chaque cycle
    lavaCyclePositions = [];
    const poolSize = Math.floor(GRID * GRID * 0.18);
    let tries = 0;
    while (lavaCyclePositions.length < poolSize && tries < 900) {
      tries++;
      const x = Math.floor(Math.random() * GRID);
      const y = Math.floor(Math.random() * GRID);
      if (lavaCyclePositions.some(c => c.x === x && c.y === y)) continue;
      lavaCyclePositions.push({ x, y });
    }
  }

  function cycleLavaZones() {
    if (!alive || currentSpecialRoom !== 'volcano') return;
    const headX = snake && snake[0] ? snake[0].x : 10;
    const headY = snake && snake[0] ? snake[0].y : 10;
    const activeCount = Math.floor(GRID * GRID * 0.05);
    const candidates = lavaCyclePositions.filter(c =>
      !(Math.abs(c.x - headX) < 3 && Math.abs(c.y - headY) < 3)
    );
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    const nextActive = shuffled.slice(0, activeCount);

    // Phase d'avertissement : la case clignote avant de devenir vraiment mortelle,
    // pour laisser une chance de réagir plutôt qu'une mort instantanée imprévisible.
    lavaCells = nextActive.map(c => ({ x: c.x, y: c.y, armedAt: Date.now() + LAVA_WARNING_MS }));
  }

  function isLavaActive(x, y) {
    const cell = lavaCells.find(c => c.x === x && c.y === y);
    if (!cell) return false;
    return Date.now() >= cell.armedAt;
  }

  function isLavaWarning(x, y) {
    const cell = lavaCells.find(c => c.x === x && c.y === y);
    if (!cell) return false;
    return Date.now() < cell.armedAt;
  }

  function isIceCell(x, y) {
    return iceCells.some(c => c.x === x && c.y === y);
  }

  function resetRunState() {    
    snake = [
      { x: 10, y: 10 },
      { x: 9, y: 10 },
      { x: 8, y: 10 }
    ];
    dir = { x: 1, y: 0 };
    nextDir = { x: 1, y: 0 };
    obstacles = [];
    score = 0;
    room = 1;
    alive = true;
    activeMutations = [];
    shieldCharges = 0;
    const diff = DIFFICULTIES[selectedDifficulty] || DIFFICULTIES.normal;
    baseTickMs = diff.tickMs;
    difficultyScoreMult = diff.scoreMult;
    wallsWrap = false;
    shrinkMode = false;
    magnetActive = false;
    scoreMultiplier = 1;
    obstacleDensity = 0.05;
    fruitsEatenThisRun = 0;
    doubleFoodActive = false;
    particles = [];
    food = [];
    waitingForFirstInput = true;
    currentSpecialRoom = null;
    playMusic('classic');
    clearSpecialRoomEffects();
    generateObstaclesForRoom();
    spawnFood();
    updateHud();
    mutBar.innerHTML = '';
  }

  function cellFree(x, y) {
    if (x < 0 || y < 0 || x >= GRID || y >= GRID) return false;
    for (const s of snake) if (s.x === x && s.y === y) return false;
    for (const o of obstacles) if (o.x === x && o.y === y) return false;
    for (const f of food) if (f.x === x && f.y === y) return false;
    return true;
  }

  function generateObstaclesForRoom() {
    obstacles = [];
    const roomFactor = room === 1 ? 0.5 : Math.min(1 + room * 0.15, 2.2);
    const count = Math.floor(GRID * GRID * obstacleDensity * roomFactor);
    let tries = 0;
    const headX = snake && snake[0] ? snake[0].x : 10;
    const headY = snake && snake[0] ? snake[0].y : 10;
    while (obstacles.length < count && tries < 800) {
      tries++;
      const x = Math.floor(Math.random() * GRID);
      const y = Math.floor(Math.random() * GRID);
      if (Math.abs(x - headX) < 5 && Math.abs(y - headY) < 5) continue;
      let tooCloseToBody = false;
      for (const s of snake) {
        if (Math.abs(x - s.x) <= 1 && Math.abs(y - s.y) <= 1) { tooCloseToBody = true; break; }
      }
      if (tooCloseToBody) continue;
      if (dir) {
        if (dir.x !== 0 && y === headY && Math.sign(x - headX) === Math.sign(dir.x)) continue;
        if (dir.y !== 0 && x === headX && Math.sign(y - headY) === Math.sign(dir.y)) continue;
      }
      if (cellFree(x, y)) obstacles.push({ x, y });
    }
  }

  function spawnFood() {
    const wanted = doubleFoodActive ? 2 : 1;
    const headX = snake && snake[0] ? snake[0].x : 10;
    const headY = snake && snake[0] ? snake[0].y : 10;
    while (food.length < wanted) {
      let tries = 0, x, y;
      let placed = false;
      while (tries < 150) {
        const radius = 6 + Math.floor(tries / 20);
        x = Math.max(0, Math.min(GRID - 1, headX + Math.floor(Math.random() * (radius * 2 + 1)) - radius));
        y = Math.max(0, Math.min(GRID - 1, headY + Math.floor(Math.random() * (radius * 2 + 1)) - radius));
        tries++;
        if (cellFree(x, y)) { placed = true; break; }
      }
      if (!placed) {
        tries = 0;
        do {
          x = Math.floor(Math.random() * GRID);
          y = Math.floor(Math.random() * GRID);
          tries++;
        } while (!cellFree(x, y) && tries < 300);
      }
      food.push({ x, y, kind: Math.random() < 0.15 ? 'gold' : 'normal' });
    }
  }

  function updateHud() {
    scoreVal.textContent = score;
    roomVal.textContent = room;
    bestVal.textContent = Math.max(save.best, score);
    const diffLabel = document.getElementById('diffVal');
    if (diffLabel) diffLabel.textContent = (DIFFICULTIES[selectedDifficulty] || DIFFICULTIES.normal).label;

    const specialBlock = document.getElementById('specialRoomHudBlock');
    const specialVal = document.getElementById('specialRoomVal');
    if (specialBlock && specialVal) {
      if (currentSpecialRoom && SPECIAL_ROOM_INFO[currentSpecialRoom]) {
        specialVal.textContent = SPECIAL_ROOM_INFO[currentSpecialRoom].emoji + ' ' + SPECIAL_ROOM_INFO[currentSpecialRoom].label;
        specialBlock.classList.remove('hidden');
      } else {
        specialBlock.classList.add('hidden');
      }
    }
  }

  function addParticles(x, y, color) {
    for (let i = 0; i < 8; i++) {
      particles.push({
        x: x * CELL + CELL / 2,
        y: y * CELL + CELL / 2,
        vx: (Math.random() - 0.5) * 3,
        vy: (Math.random() - 0.5) * 3,
        life: 20,
        color
      });
    }
  }

  // ============================================================
  // Input
  // ============================================================
  const DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
  };

  const MIRROR_MAP = { up: 'down', down: 'up', left: 'right', right: 'left' };

  function setDir(d) {
    if (!alive) return;
    const effectiveKey = currentSpecialRoom === 'mirror' ? MIRROR_MAP[d] : d;
    const nd = DIRS[effectiveKey];
    if (!nd) return;
    if (nd.x === -dir.x && nd.y === -dir.y && snake.length > 1) return;
    nextDir = nd;
    waitingForFirstInput = false;
  }

  window.addEventListener('keydown', (e) => {
    const map = {
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
      w: 'up', s: 'down', a: 'left', d: 'right',
      W: 'up', S: 'down', A: 'left', D: 'right'
    };
    if (map[e.key] && alive) {
      e.preventDefault();
      setDir(map[e.key]);
    }
  });

  document.querySelectorAll('#touchControls .dpad').forEach(btn => {
    btn.addEventListener('click', () => setDir(btn.dataset.dir));
  });

  let touchStart = null;
  canvas.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  canvas.addEventListener('touchend', (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    if (Math.abs(dx) > Math.abs(dy)) {
      setDir(dx > 0 ? 'right' : 'left');
    } else {
      setDir(dy > 0 ? 'down' : 'up');
    }
    touchStart = null;
  }, { passive: true });

  // ============================================================
  // Game loop
  // ============================================================
  function step() {
    if (!alive || waitingForFirstInput) return;

    // Sur la glace, la direction du joueur est ignorée le temps de la glissade :
    // on continue dans la même direction jusqu'à épuisement de la glissade.
    if (slideQueue > 0) {
      slideQueue--;
    } else {
      dir = nextDir;
    }

    let head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

    if (wallsWrap) {
      if (head.x < 0) head.x = GRID - 1;
      if (head.x >= GRID) head.x = 0;
      if (head.y < 0) head.y = GRID - 1;
      if (head.y >= GRID) head.y = 0;
    }

    let dead = false;
    if (!wallsWrap && (head.x < 0 || head.y < 0 || head.x >= GRID || head.y >= GRID)) dead = true;
    if (!dead) {
      for (const o of obstacles) if (o.x === head.x && o.y === head.y) dead = true;
    }
    if (!dead) {
      for (let i = 0; i < snake.length - 1; i++) {
        if (snake[i].x === head.x && snake[i].y === head.y) dead = true;
      }
    }
    if (!dead && currentSpecialRoom === 'volcano' && isLavaActive(head.x, head.y)) dead = true;

    if (dead) {
      if (shieldCharges > 0) {
        shieldCharges--;
        addParticles(head.x, head.y, '#ffd93d');
        slideQueue = 0;
        return;
      }
      endRun();
      return;
    }

    snake.unshift(head);

    // Case givrée : programme 1-2 cases de glissade supplémentaires dans la même direction
    if (currentSpecialRoom === 'ice' && isIceCell(head.x, head.y) && slideQueue === 0) {
      slideQueue = 1 + Math.floor(Math.random() * 2); // 1 ou 2 cases
    }

    if (magnetActive) {
      for (const f of food) {
        const d = Math.abs(f.x - head.x) + Math.abs(f.y - head.y);
        if (d <= 4 && d > 0 && Math.random() < 0.3) {
          if (f.x < head.x) f.x++; else if (f.x > head.x) f.x--;
          if (f.y < head.y) f.y++; else if (f.y > head.y) f.y--;
        }
      }
    }

    let ate = false;
    for (let i = food.length - 1; i >= 0; i--) {
      if (food[i].x === head.x && food[i].y === head.y) {
        const gain = (food[i].kind === 'gold' ? 5 : 1) * scoreMultiplier * difficultyScoreMult;
        score += gain;
        addParticles(head.x, head.y, food[i].kind === 'gold' ? '#ffd93d' : getEquippedFood().color);
        food.splice(i, 1);
        ate = true;
        fruitsEatenThisRun++;
        if (shrinkMode) {
          if (snake.length > 4) { snake.pop(); snake.pop(); }
          else snake.pop();
        }
      }
    }

    if (!ate) {
      snake.pop();
    }

    if (ate) {
      spawnFood();
      if (activeMutations.some(m => m.id === 'shield') && fruitsEatenThisRun % 5 === 0) {
        shieldCharges = Math.min(shieldCharges + 1, 3);
      }
      if (fruitsEatenThisRun % 12 === 0) {
        advanceRoom();
        return;
      }
    }

    updateHud();
  }

  function advanceRoom() {
    room++;
    currentSpecialRoom = rollSpecialRoom();
    updateHud();
    showMutationChoice();
  }

  function pickRandomMutations(n) {
    const notTaken = MUTATION_POOL.filter(m => !activeMutations.find(a => a.id === m.id));
    const pool = notTaken.length >= n ? notTaken : MUTATION_POOL;
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
  }

  const SPECIAL_ROOM_INFO = {
    mirror:  { emoji: '🪞', label: 'Salle Miroir',  desc: 'Les touches sont inversées : gauche ↔ droite, haut ↔ bas.' },
    ice:     { emoji: '🧊', label: 'Salle Glace',   desc: 'Certaines cases sont givrées : tu glisses dessus sur 1-2 cases de plus.' },
    volcano: { emoji: '🌋', label: 'Salle Volcan',  desc: 'Des zones de lave apparaissent et se déplacent. Rester dessus après l\'avertissement = game over.' }
  };

  function showMutationChoice() {
    clearInterval(tickTimer);
    const choices = pickRandomMutations(3);
    const container = document.getElementById('mutChoices');
    container.innerHTML = '';

    const specialBanner = document.getElementById('specialRoomBanner');
    if (currentSpecialRoom && SPECIAL_ROOM_INFO[currentSpecialRoom]) {
      const info = SPECIAL_ROOM_INFO[currentSpecialRoom];
      specialBanner.innerHTML = `<div class="specialRoomTitle">${info.emoji} ${info.label}</div><div class="specialRoomDesc">${info.desc}</div>`;
      specialBanner.classList.remove('hidden');
    } else {
      specialBanner.classList.add('hidden');
    }

    choices.forEach(mut => {
      const card = document.createElement('div');
      card.className = 'mutCard';
      card.innerHTML = `<div class="mTitle">${mut.title}</div><div class="mDesc">${mut.desc}</div>`;
      card.addEventListener('click', () => {
        mut.apply();
        activeMutations.push(mut);
        renderMutBar();
        overlayMut.classList.add('hidden');
        generateObstaclesForRoom();
        setupSpecialRoom(currentSpecialRoom);
        food = [];
        spawnFood();
        waitingForFirstInput = true;
        updateHud();
        startTicking();
      });
      container.appendChild(card);
    });
    overlayMut.classList.remove('hidden');
  }

  function renderMutBar() {
    mutBar.innerHTML = '';
    activeMutations.forEach(m => {
      const chip = document.createElement('div');
      chip.className = 'mutChip';
      chip.textContent = m.title;
      mutBar.appendChild(chip);
    });
  }

  function endRun() {
    stopMusic();
    alive = false;
    clearInterval(tickTimer);
    clearSpecialRoomEffects();
    const metaGain = Math.max(1, Math.floor(score / 10) + room);
    save.meta += metaGain;
    const isRecord = score > save.best;
    if (isRecord) save.best = score;
    addTopScore(score, room);
    writeSave(save);
    submitScoreToCloud(score, room, metaGain, selectedDifficulty);
    saveEclatsToCloud(save.meta);

    document.getElementById('overScore').textContent = score;
    document.getElementById('overRoom').textContent = room;
    document.getElementById('overMeta').textContent = '+' + metaGain;
    document.getElementById('overDiffLabel').textContent = (DIFFICULTIES[selectedDifficulty] || DIFFICULTIES.normal).label;
    document.getElementById('newRecordMsg').classList.toggle('hidden', !isRecord);
    refreshTopHud();

    overlayMut.classList.add('hidden');
    overlayOver.classList.remove('hidden');
  }

  // ============================================================
  // Rendering
  // ============================================================
  function draw() {
    const bgTheme = getEquippedBackground();
    const colorTheme = getEquippedColor();
    const foodTheme = getEquippedFood();

    canvas.style.background = bgTheme.bg;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = bgTheme.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= GRID; i++) {
      ctx.beginPath();
      ctx.moveTo(i * CELL, 0);
      ctx.lineTo(i * CELL, canvas.height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * CELL);
      ctx.lineTo(canvas.width, i * CELL);
      ctx.stroke();
    }

    // Cases spéciales (glace / lave) rendues avant les obstacles et la nourriture
    if (currentSpecialRoom === 'ice') {
      iceCells.forEach(c => {
        ctx.fillStyle = 'rgba(140, 210, 255, 0.35)';
        ctx.strokeStyle = 'rgba(200, 235, 255, 0.6)';
        ctx.lineWidth = 1;
        roundRect(c.x * CELL + 2, c.y * CELL + 2, CELL - 4, CELL - 4, 5);
        ctx.strokeRect(c.x * CELL + 2, c.y * CELL + 2, CELL - 4, CELL - 4);
      });
    }
    if (currentSpecialRoom === 'volcano') {
      const now = Date.now();
      lavaCells.forEach(c => {
        const active = now >= c.armedAt;
        if (active) {
          ctx.fillStyle = '#ff4a2f';
        } else {
          // clignote pendant la phase d'avertissement
          const blink = Math.floor(now / 150) % 2 === 0;
          ctx.fillStyle = blink ? 'rgba(255, 150, 60, 0.55)' : 'rgba(255, 90, 40, 0.3)';
        }
        roundRect(c.x * CELL + 2, c.y * CELL + 2, CELL - 4, CELL - 4, 5);
      });
    }

    ctx.fillStyle = '#3a3a5c';
    obstacles.forEach(o => {
      roundRect(o.x * CELL + 2, o.y * CELL + 2, CELL - 4, CELL - 4, 4);
    });

    food.forEach(f => {
      const cx = f.x * CELL + CELL / 2;
      const cy = f.y * CELL + CELL / 2;
      if (f.kind === 'gold') {
        ctx.fillStyle = '#ffd93d';
        ctx.beginPath();
        ctx.arc(cx, cy, CELL / 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff8d6';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (foodTheme.emoji) {
        ctx.font = `${Math.floor(CELL * 0.85)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(foodTheme.emoji, cx, cy + 1);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
      } else {
        ctx.fillStyle = foodTheme.color;
        ctx.beginPath();
        ctx.arc(cx, cy, CELL / 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    snake.forEach((s, i) => {
      if (colorTheme.rainbow) {
        const hue = (i * 25 + Date.now() / 20) % 360;
        ctx.fillStyle = `hsl(${hue}, 80%, 62%)`;
      } else {
        ctx.fillStyle = i === 0 ? colorTheme.head : colorTheme.body;
      }
      const pad = i === 0 ? 1 : 2;
      roundRect(s.x * CELL + pad, s.y * CELL + pad, CELL - pad * 2, CELL - pad * 2, i === 0 ? 6 : 4);
    });

    if (shieldCharges > 0 && snake[0]) {
      ctx.strokeStyle = '#ffd93d';
      ctx.lineWidth = 2;
      const cx = snake[0].x * CELL + CELL / 2;
      const cy = snake[0].y * CELL + CELL / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, CELL / 1.6, 0, Math.PI * 2);
      ctx.stroke();
    }

    particles.forEach(p => {
      ctx.globalAlpha = Math.max(0, p.life / 20);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    });

    if (alive && waitingForFirstInput) {
      ctx.fillStyle = 'rgba(10,10,20,0.55)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#f5f5f5';
      ctx.font = `${Math.floor(CELL * 0.9)}px Segoe UI, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('▶', canvas.width / 2, canvas.height / 2 - 10);
      ctx.font = `${Math.floor(CELL * 0.5)}px Segoe UI, sans-serif`;
      ctx.fillText('Appuie sur une flèche pour commencer', canvas.width / 2, canvas.height / 2 + 30);
      ctx.textAlign = 'left';
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  }

  function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life--;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }

  function renderLoop() {
    updateParticles();
    if (!menuOverlay.classList.contains('hidden')) {
      // idle on menu - nothing to draw on canvas (hidden anyway)
    } else {
      draw();
    }
    requestAnimationFrame(renderLoop);
  }

  function startTicking() {
    clearInterval(tickTimer);
    tickTimer = setInterval(step, baseTickMs);
  }

  function stopTicking() {
    clearInterval(tickTimer);
  }

  // ============================================================
  // Navigation wiring
  // ============================================================
  const volumeSlider = document.getElementById('volumeSlider');
  if (volumeSlider) {
    volumeSlider.value = Math.round(musicVolume * 100);
    volumeSlider.addEventListener('input', (e) => {
      setMusicVolume(parseInt(e.target.value, 10) / 100);
    });
  }

  function refreshMuteBtn() {
    if (btnMuteGameEl) btnMuteGameEl.textContent = musicEnabled ? '🔊' : '🔇';
  }
  refreshMuteBtn();
  if (btnMuteGameEl) {
    btnMuteGameEl.addEventListener('click', () => {
      setMusicMuted(musicEnabled);
      refreshMuteBtn();
    });
  }

  const pseudoInputEl = document.getElementById('pseudoInput');
  const pseudoStatusEl = document.getElementById('pseudoStatus');

  if (isPseudoLocked()) {
    pseudoInputEl.disabled = true;
    if (pseudoStatusEl) pseudoStatusEl.textContent = '🔒 Pseudo verrouillé définitivement';
  }

  let pseudoCheckTimer = null;
  pseudoInputEl.addEventListener('input', (e) => {
    if (isPseudoLocked()) return;
    const val = e.target.value.trim();
    if (val) localStorage.setItem('serpentMutant_pseudo', val);
    else localStorage.removeItem('serpentMutant_pseudo');

    if (!pseudoStatusEl) return;
    clearTimeout(pseudoCheckTimer);
    if (!val) { pseudoStatusEl.textContent = ''; return; }
    if (!PSEUDO_REGEX.test(val)) {
      pseudoStatusEl.textContent = '❌ 3-18 caractères, lettres/chiffres/_/- uniquement';
      return;
    }
    pseudoStatusEl.textContent = '⏳ Vérification…';
    pseudoCheckTimer = setTimeout(async () => {
      const result = await checkPseudoAvailable(val);
      pseudoStatusEl.textContent = result.available ? '✅ Disponible' : '❌ Déjà pris';
    }, 500);
  });

  document.getElementById('btnStart').addEventListener('click', () => {
    showScreen('difficulty');
  });

  document.getElementById('btnOpenShop').addEventListener('click', () => showScreen('shop'));
  document.getElementById('btnCloseShop').addEventListener('click', () => showScreen('menu'));
  document.getElementById('btnOpenScores').addEventListener('click', () => showScreen('scores'));
  document.getElementById('btnCloseScores').addEventListener('click', () => showScreen('menu'));
  document.getElementById('btnCancelDifficulty').addEventListener('click', () => showScreen('menu'));

  document.querySelectorAll('.diffBtn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedDifficulty = btn.dataset.diff;
      resetRunState();
      showScreen('game');
      startTicking();
    });
  });

  document.getElementById('btnRetry').addEventListener('click', () => {
    showScreen('difficulty');
  });

  document.getElementById('btnBackToMenu').addEventListener('click', () => {
    stopTicking();
    showScreen('menu');
  });

  btnMenuFromGame.addEventListener('click', () => {
    // pause/abandon current run and return to menu without counting it as a loss twice
    stopTicking();
    alive = false;
    showScreen('menu');
  });

  showScreen('menu');
  renderLoop();
})();
