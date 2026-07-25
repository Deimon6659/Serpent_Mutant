/**
 * ============================================================
 * SERPENT MUTANT - Game Engine
 * Version: 2.0
 * Architecture: Site statique + Google Sheets backend
 * Améliorations:
 *   - Système de compte avec mot de passe (SHA-256)
 *   - Code modularisé et optimisé
 *   - Meilleure gestion d'erreurs
 *   - Cache et performance optimisés
 * ============================================================
 */

(() => {
  'use strict';

  // ============================================================
  // CONFIGURATION
  // ============================================================
  
  const CONFIG = {
    // URL du Google Apps Script (à remplacer par ta propre URL)
    WEBAPP_URL: 'https://script.google.com/macros/s/AKfycbzNEhkZOHMhBnBE4Ucba8cRTvpy-YBbRlrlgtrku_hksrXsuIm_o-9rt-VfFZEfb3Vy_g/exec',
    
    // Grille de jeu
    GRID_SIZE: 20,
    
    // Timing
    LAVA_CYCLE_MS: 6000,
    LAVA_ARM_DELAY: 2500,
    
    // Stockage local
    SAVE_KEY: 'serpentMutant_v2',
    SESSION_KEY: 'serpentMutant_session',
  };

  // ============================================================
  // AUDIO
  // ============================================================

  const MUSIC_TRACKS = {
    classic: 'audio/theme-classic.mp3',
    ice:     'audio/theme-ice.mp3',
    volcano: 'audio/theme-volcano.mp3',
  };

  const Audio = {
    current:      null,
    enabled:      localStorage.getItem('serpentMutant_muted') !== '1',
    volume:       (() => {
      const v = parseFloat(localStorage.getItem('serpentMutant_volume'));
      return isNaN(v) ? 0.4 : v;
    })(),
    lastTrack:    null,
    _generation:  0,
    _bufferCache: {},
    _audioCtx:    null,

    getCtx() {
      if (!this._audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this._audioCtx = new AC();
      }
      return this._audioCtx;
    },

    play(trackKey, { reversed = false } = {}) {
      this.lastTrack = { trackKey, reversed };
      if (!this.enabled) return;
      this.stop();
      const src = MUSIC_TRACKS[trackKey];
      if (!src) return;
      if (reversed) { this._playReversed(src); return; }
      const audio = new window.Audio(src);
      audio.loop   = true;
      audio.volume = this.volume;
      audio.play().catch(() => {});
      this.current = audio;
    },

    stop() {
      this._generation++;
      if (this.current) {
        this.current.pause();
        this.current = null;
      }
    },

    setVolume(v) {
      this.volume = Math.max(0, Math.min(1, v));
      localStorage.setItem('serpentMutant_volume', String(this.volume));
      if (this.current) {
        if (this.current.gainNode) this.current.gainNode.gain.value = this.volume;
        else if (typeof this.current.volume === 'number') this.current.volume = this.volume;
      }
    },

    setMuted(muted) {
      this.enabled = !muted;
      localStorage.setItem('serpentMutant_muted', muted ? '1' : '0');
      if (muted) {
        this.stop();
      } else if (this.lastTrack) {
        this.play(this.lastTrack.trackKey, { reversed: this.lastTrack.reversed });
      }
    },

    async _playReversed(src) {
      const gen = ++this._generation;
      try {
        const ctx = this.getCtx();
        let buffer = this._bufferCache[src];
        if (!buffer) {
          const res     = await fetch(src);
          if (gen !== this._generation) return;
          const ab      = await res.arrayBuffer();
          if (gen !== this._generation) return;
          const decoded = await ctx.decodeAudioData(ab);
          if (gen !== this._generation) return;
          for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
            decoded.getChannelData(ch).reverse();
          }
          buffer = decoded;
          this._bufferCache[src] = buffer;
        } else if (gen !== this._generation) {
          return;
        }
        const source   = ctx.createBufferSource();
        source.buffer  = buffer;
        source.loop    = true;
        const gain     = ctx.createGain();
        gain.gain.value = this.volume;
        source.connect(gain);
        gain.connect(ctx.destination);
        await ctx.resume();
        if (gen !== this._generation) return;
        source.start(0);
        this.current = {
          pause:    () => { try { source.stop(); } catch (e) {} },
          gainNode: gain,
        };
      } catch (err) {
        console.warn('Lecture inversée impossible :', err);
      }
    },
  };

  // ============================================================
  // DONNÉES DE JEU
  // ============================================================

  const DIFFICULTIES = {
    easy:    { label: 'Facile',    tickMs: 160, scoreMult: 0.8, obstacles: 0 },
    normal:  { label: 'Normal',    tickMs: 120, scoreMult: 1.0, obstacles: 3 },
    hard:    { label: 'Difficile', tickMs: 90,  scoreMult: 1.5, obstacles: 6 },
    extreme: { label: 'Extrême',   tickMs: 65,  scoreMult: 2.5, obstacles: 10 },
  };

  const MUTATIONS = [
    { id: 'speed',    title: '⚡ Vélocité',     desc: 'Vitesse de déplacement +20%' },
    { id: 'magnet',   title: '🧲 Magnétisme',   desc: 'La nourriture est attirée vers toi (rayon 3)' },
    { id: 'ghost',    title: '👻 Spectre',      desc: 'Tu peux traverser ton propre corps' },
    { id: 'double',   title: '✨ Double Score', desc: 'Chaque fruit rapporte le double de points' },
    { id: 'shrink',   title: '🔻 Réduction',    desc: 'Tu perds 2 segments en mangeant (min 3)' },
    { id: 'shield',   title: '🛡️ Bouclier',    desc: 'Gagne 1 charge (max 3) tous les 5 fruits' },
    { id: 'golden',   title: '🥇 Midas',        desc: 'Des fruits dorés (×5 points) apparaissent' },
    { id: 'teleport', title: '🌀 Téléport',     desc: 'Traverser un bord = apparaître au bord opposé' },
    { id: 'slow',     title: '🐌 Ralenti',      desc: 'Vitesse −15% (utile pour contrôler)' },
    { id: 'tiny',     title: '🔬 Miniature',    desc: 'Le serpent est plus fin visuellement' },
  ];

  const SPECIAL_ROOMS = {
    mirror:  { emoji: '🪞', label: 'Salle Miroir',  desc: 'Touches inversées : gauche ↔ droite, haut ↔ bas' },
    ice:     { emoji: '🧊', label: 'Salle Glace',   desc: 'Cases givrées : tu glisses sur 1-2 cases' },
    volcano: { emoji: '🌋', label: 'Salle Volcan',  desc: 'Zones de lave cycliques. Contact = game over' },
  };

  const SHOP = {
    colors: [
      { id: 'teal',    name: 'Turquoise',   price: 0,   head: '#0fbfae', body: '#0a9d90' },
      { id: 'pink',    name: 'Rose',        price: 50,  head: '#ff6b9d', body: '#d94f7f' },
      { id: 'gold',    name: 'Or',          price: 80,  head: '#ffd93d', body: '#d9af1f' },
      { id: 'purple',  name: 'Violet',      price: 120, head: '#a06bff', body: '#7c4fd9' },
      { id: 'green',   name: 'Vert forêt',  price: 150, head: '#6bcb77', body: '#4a9d55' },
      { id: 'blue',    name: 'Bleu roi',    price: 200, head: '#4a90ff', body: '#2f6fd9' },
      { id: 'orange',  name: 'Orange',      price: 250, head: '#ff9d4a', body: '#d97a2f' },
      { id: 'red',     name: 'Rouge',       price: 300, head: '#ff4a5c', body: '#d92f3f' },
      { id: 'rainbow', name: 'Arc-en-ciel', price: 400, head: '#ff6b9d', body: '#a06bff', rainbow: true },
    ],
    foods: [
      { id: 'classic', name: 'Classique', price: 0,   emoji: '🔴', color: '#ff6b9d' },
      { id: 'apple',   name: 'Pomme',     price: 40,  emoji: '🍎', color: '#ff4a4a' },
      { id: 'cherry',  name: 'Cerise',    price: 60,  emoji: '🍒', color: '#d92f4f' },
      { id: 'grape',   name: 'Raisin',    price: 90,  emoji: '🍇', color: '#a06bff' },
      { id: 'orange',  name: 'Orange',    price: 130, emoji: '🍊', color: '#ff9d4a' },
      { id: 'star',    name: 'Étoile',    price: 170, emoji: '⭐', color: '#ffd93d' },
      { id: 'gem',     name: 'Gemme',     price: 220, emoji: '💎', color: '#4ae0ff' },
      { id: 'donut',   name: 'Donut',     price: 280, emoji: '🍩', color: '#e08a4a' },
      { id: 'sushi',   name: 'Sushi',     price: 350, emoji: '🍣', color: '#f5f5f5' },
    ],
    backgrounds: [
      { id: 'default', name: 'Nuit',           price: 0,   bg: '#10101c', grid: 'rgba(255,255,255,0.03)' },
      { id: 'ocean',   name: 'Océan',          price: 60,  bg: '#0a1e2e', grid: 'rgba(80,180,255,0.06)' },
      { id: 'forest',  name: 'Forêt',          price: 110, bg: '#0e1f14', grid: 'rgba(107,203,119,0.07)' },
      { id: 'sunset',  name: 'Coucher soleil', price: 180, bg: '#2e1420', grid: 'rgba(255,107,157,0.06)' },
      { id: 'void',    name: 'Vide stellaire', price: 260, bg: '#050510', grid: 'rgba(160,107,255,0.08)' },
    ],
  };

  // ============================================================
  // UTILITAIRES
  // ============================================================

  // Hash SHA-256 pour le mot de passe (côté client)
  async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password + '_serpent_salt_2024');
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Génère un ID de session unique
  function generateSessionId() {
    return 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  // Stockage local sécurisé
  const Storage = {
    get(key, defaultVal = null) {
      try {
        const data = localStorage.getItem(key);
        return data ? JSON.parse(data) : defaultVal;
      } catch {
        return defaultVal;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        console.warn('Storage error:', e);
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch {}
    }
  };

  // ============================================================
  // ÉTAT GLOBAL
  // ============================================================

  const State = {
    // Session utilisateur
    session: null, // { username, sessionId, ... }
    
    // Données joueur (depuis le serveur)
    player: null, // { username, eclats, bestScore, bestRoom, totalGames, unlocked, equipped, discoveredMutations }
    
    // État du jeu
    game: {
      snake: [],
      dir: { x: 1, y: 0 },
      nextDir: { x: 1, y: 0 },
      food: [],
      obstacles: [],
      particles: [],
      score: 0,
      room: 1,
      alive: false,
      paused: false,
      waitingForInput: true,
      difficulty: 'normal',
      
      // Mutations actives
      activeMutations: [],
      speedMult: 1,
      ghostMode: false,
      shrinkMode: false,
      scoreMultiplier: 1,
      goldenEnabled: false,
      magnetEnabled: false,
      teleportEnabled: false,
      shieldCharges: 0,
      fruitsEaten: 0,
      fruitsForShield: 0,
      
      // Salle spéciale
      specialRoom: null,
      iceCells: [],
      lavaCells: [],
      lavaCycleAt: null,
      
      // Timing
      runStartTime: 0,
      isTicking: false,
      tickAccumulator: 0,
      lastFrameTime: null,
    },
    
    // Canvas
    canvas: null,
    ctx: null,
    cellSize: 28,
    
    // UI
    currentScreen: 'auth',
    currentShopTab: 'colors',
    authMode: 'login',
  };

  // ============================================================
  // CLOUD API (Google Sheets)
  // ============================================================

  const Cloud = {
    async request(action, data = {}) {
      if (!CONFIG.WEBAPP_URL) {
        return { ok: false, error: 'no_cloud' };
      }
      
      try {
        const res = await fetch(CONFIG.WEBAPP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action, ...data }),
        });
        
        const result = await res.json();
        
        if (!res.ok || result.error) {
          return { ok: false, error: result.error || `HTTP ${res.status}` };
        }
        
        return { ok: true, ...result };
      } catch (err) {
        console.warn('Cloud request failed:', err);
        return { ok: false, error: 'network' };
      }
    },
    
    async register(username, passwordHash) {
      return this.request('register', { username, passwordHash });
    },
    
    async login(username, passwordHash) {
      return this.request('login', { username, passwordHash });
    },
    
    async getPlayer(username, sessionId) {
      return this.request('getPlayer', { username, sessionId });
    },
    
    async submitScore(username, sessionId, scoreData) {
      return this.request('submitScore', { username, sessionId, ...scoreData });
    },
    
    async shopAction(username, sessionId, action, category, itemId) {
      return this.request('shopAction', { username, sessionId, action, category, itemId });
    },
    
    async getLeaderboard() {
      return this.request('getLeaderboard', {});
    },
  };

  // ============================================================
  // AUTHENTIFICATION
  // ============================================================

  const Auth = {
    async register(username, password) {
      const hash = await hashPassword(password);
      const result = await Cloud.register(username.toLowerCase(), hash);
      
      if (result.ok) {
        const sessionId = generateSessionId();
        State.session = { username: username.toLowerCase(), sessionId };
        State.player = result.player;
        Storage.set(CONFIG.SESSION_KEY, State.session);
        return { ok: true };
      }
      
      return result;
    },
    
    async login(username, password) {
      const hash = await hashPassword(password);
      const result = await Cloud.login(username.toLowerCase(), hash);
      
      if (result.ok) {
        State.session = { 
          username: username.toLowerCase(), 
          sessionId: result.sessionId 
        };
        State.player = result.player;
        Storage.set(CONFIG.SESSION_KEY, State.session);
        return { ok: true };
      }
      
      return result;
    },
    
    async restoreSession() {
      const saved = Storage.get(CONFIG.SESSION_KEY);
      if (!saved || !saved.username || !saved.sessionId) {
        return false;
      }
      
      const result = await Cloud.getPlayer(saved.username, saved.sessionId);
      if (result.ok && result.player) {
        State.session = saved;
        State.player = result.player;
        return true;
      }
      
      Storage.remove(CONFIG.SESSION_KEY);
      return false;
    },
    
    logout() {
      State.session = null;
      State.player = null;
      Storage.remove(CONFIG.SESSION_KEY);
      UI.showScreen('auth');
    },
    
    isLoggedIn() {
      return State.session !== null && State.player !== null;
    },
  };

  // ============================================================
  // INTERFACE UTILISATEUR
  // ============================================================

  const UI = {
    // Cache des éléments DOM
    elements: {},
    
    init() {
      // Cache les éléments fréquemment utilisés
      const ids = [
        'authOverlay', 'menuOverlay', 'difficultyOverlay', 'gameContainer',
        'pauseOverlay', 'mutationOverlay', 'gameOverOverlay', 'shopOverlay',
        'scoresOverlay', 'mutationsOverlay', 'settingsOverlay',
        'authForm', 'authUsername', 'authPassword', 'authError', 'authStatus', 'authSubmitBtn',
        'menuUsername', 'statBest', 'statEclats', 'statGames', 'cloudStatus',
        'gameCanvas', 'hud', 'hudScore', 'hudRoom', 'hudShield', 'hudShieldCount', 'mutBar',
        'touchControls', 'mutRoomNum', 'specialRoomBanner', 'mutationChoices',
        'overScore', 'overRoom', 'overEclats', 'newRecordMsg',
        'shopEclatsVal', 'shopGrid', 'shopStatus',
        'leaderBest', 'leaderRoom', 'leaderboardList',
        'mutationsCount', 'mutationsList',
        'settingsUsername', 'settingsBest', 'settingsRoom', 'settingsGames', 'settingsMuts',
      ];
      
      ids.forEach(id => {
        this.elements[id] = document.getElementById(id);
      });
      
      State.canvas = this.elements.gameCanvas;
      State.ctx = State.canvas.getContext('2d');
      
      this.bindEvents();
      this.resizeCanvas();
      window.addEventListener('resize', () => this.resizeCanvas());
    },
    
    bindEvents() {
      // Auth tabs
      document.querySelectorAll('[data-auth-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
          State.authMode = btn.dataset.authTab;
          document.querySelectorAll('[data-auth-tab]').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.elements.authSubmitBtn.textContent = State.authMode === 'login' ? 'Se connecter' : 'Créer un compte';
          this.elements.authError.classList.add('hidden');
        });
      });
      
      // Auth form
      this.elements.authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.handleAuth();
      });
      
      // Menu buttons
      document.getElementById('btnPlay').addEventListener('click', () => this.showScreen('difficulty'));
      document.getElementById('btnShop').addEventListener('click', () => this.showScreen('shop'));
      document.getElementById('btnScores').addEventListener('click', () => this.showScreen('scores'));
      document.getElementById('btnMutations').addEventListener('click', () => this.showScreen('mutations'));
      document.getElementById('btnSettings').addEventListener('click', () => this.showScreen('settings'));
      
      // Difficulty buttons
      document.querySelectorAll('[data-diff]').forEach(btn => {
        btn.addEventListener('click', () => {
          State.game.difficulty = btn.dataset.diff;
          Game.start();
        });
      });
      document.getElementById('btnCancelDiff').addEventListener('click', () => this.showScreen('menu'));
      
      // Game buttons
      document.getElementById('btnPause').addEventListener('click', () => Game.togglePause());
      
      // Bouton mute
      const btnMute = document.getElementById('btnMute');
      if (btnMute) {
        btnMute.textContent = Audio.enabled ? '🔊' : '🔇';
        btnMute.addEventListener('click', () => {
          Audio.setMuted(Audio.enabled); // bascule : si enabled, on mute, et vice versa
          btnMute.textContent = Audio.enabled ? '🔊' : '🔇';
        });
      }
      
      document.getElementById('btnResume').addEventListener('click', () => Game.resume());
      document.getElementById('btnQuitRun').addEventListener('click', () => {
        Game.stop();
        this.showScreen('menu');
      });
      
      // Game over buttons
      document.getElementById('btnRetry').addEventListener('click', () => this.showScreen('difficulty'));
      document.getElementById('btnBackMenu').addEventListener('click', () => this.showScreen('menu'));
      
      // Shop
      document.querySelectorAll('[data-shop-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
          State.currentShopTab = btn.dataset.shopTab;
          document.querySelectorAll('[data-shop-tab]').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.renderShop();
        });
      });
      document.getElementById('btnCloseShop').addEventListener('click', () => this.showScreen('menu'));
      
      // Scores
      document.getElementById('btnCloseScores').addEventListener('click', () => this.showScreen('menu'));
      
      // Mutations
      document.getElementById('btnCloseMutations').addEventListener('click', () => this.showScreen('menu'));
      
      // Settings
      document.getElementById('btnCloseSettings').addEventListener('click', () => this.showScreen('menu'));
      document.getElementById('btnLogout').addEventListener('click', () => Auth.logout());
      
      // Touch controls
      document.querySelectorAll('[data-dir]').forEach(btn => {
        btn.addEventListener('click', () => {
          const dirs = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
          Game.handleDirection(dirs[btn.dataset.dir]);
        });
      });
      
      // Keyboard
      window.addEventListener('keydown', (e) => this.handleKeydown(e));
    },
    
    handleKeydown(e) {
      // Auth screen - no game controls
      if (State.currentScreen === 'auth') return;
      
      // Escape for pause
      if (e.key === 'Escape' && State.currentScreen === 'game') {
        e.preventDefault();
        Game.togglePause();
        return;
      }
      
      // Game controls
      if (State.currentScreen === 'game' && State.game.alive && !State.game.paused) {
        const key = e.key.toLowerCase();
        let dir = null;
        
        if (key === 'arrowup' || key === 'w') dir = { x: 0, y: -1 };
        else if (key === 'arrowdown' || key === 's') dir = { x: 0, y: 1 };
        else if (key === 'arrowleft' || key === 'a') dir = { x: -1, y: 0 };
        else if (key === 'arrowright' || key === 'd') dir = { x: 1, y: 0 };
        
        if (dir) {
          e.preventDefault();
          Game.handleDirection(dir);
        }
      }
    },
    
    async handleAuth() {
      const username = this.elements.authUsername.value.trim();
      const password = this.elements.authPassword.value;
      
      // Validation
      if (username.length < 3 || username.length > 20) {
        this.showAuthError('Le pseudo doit faire 3-20 caractères');
        return;
      }
      
      if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
        this.showAuthError('Pseudo: lettres, chiffres, _ et - uniquement');
        return;
      }
      
      if (password.length < 6) {
        this.showAuthError('Mot de passe: minimum 6 caractères');
        return;
      }
      
      this.elements.authSubmitBtn.disabled = true;
      this.elements.authStatus.textContent = '⏳ Connexion en cours...';
      this.elements.authError.classList.add('hidden');
      
      const result = State.authMode === 'login' 
        ? await Auth.login(username, password)
        : await Auth.register(username, password);
      
      this.elements.authSubmitBtn.disabled = false;
      this.elements.authStatus.textContent = '';
      
      if (result.ok) {
        this.showScreen('menu');
      } else {
        const errorMsg = {
          'user_not_found': 'Pseudo ou mot de passe incorrect',
          'wrong_password': 'Pseudo ou mot de passe incorrect',
          'username_taken': 'Ce pseudo est déjà pris',
          'network': 'Impossible de contacter le serveur',
        }[result.error] || result.error || 'Erreur inconnue';
        
        this.showAuthError(errorMsg);
      }
    },
    
    showAuthError(msg) {
      this.elements.authError.textContent = '⚠️ ' + msg;
      this.elements.authError.classList.remove('hidden');
    },
    
    showScreen(name) {
      State.currentScreen = name;
      
      // Hide all overlays
      const overlays = ['authOverlay', 'menuOverlay', 'difficultyOverlay', 'gameContainer',
        'pauseOverlay', 'mutationOverlay', 'gameOverOverlay', 'shopOverlay',
        'scoresOverlay', 'mutationsOverlay', 'settingsOverlay'];
      
      overlays.forEach(id => {
        const el = this.elements[id];
        if (el) el.classList.add('hidden');
      });
      
      // Show target screen
      switch (name) {
        case 'auth':
          this.elements.authOverlay.classList.remove('hidden');
          break;
          
        case 'menu':
          this.updateMenuStats();
          this.elements.menuOverlay.classList.remove('hidden');
          break;
          
        case 'difficulty':
          this.elements.difficultyOverlay.classList.remove('hidden');
          break;
          
        case 'game':
          this.elements.gameContainer.classList.remove('hidden');
          this.updateTouchControls();
          break;
          
        case 'shop':
          this.renderShop();
          this.elements.shopOverlay.classList.remove('hidden');
          break;
          
        case 'scores':
          this.loadLeaderboard();
          this.elements.scoresOverlay.classList.remove('hidden');
          break;
          
        case 'mutations':
          this.renderMutations();
          this.elements.mutationsOverlay.classList.remove('hidden');
          break;
          
        case 'settings':
          this.updateSettings();
          this.elements.settingsOverlay.classList.remove('hidden');
          break;
      }
    },
    
    updateMenuStats() {
      if (!State.player) return;
      
      this.elements.menuUsername.textContent = State.player.username;
      this.elements.statBest.textContent = State.player.bestScore || 0;
      this.elements.statEclats.textContent = State.player.eclats || 0;
      this.elements.statGames.textContent = State.player.totalGames || 0;
    },
    
    updateSettings() {
      if (!State.player) return;
      
      this.elements.settingsUsername.textContent = State.player.username;
      this.elements.settingsBest.textContent = State.player.bestScore || 0;
      this.elements.settingsRoom.textContent = State.player.bestRoom || 0;
      this.elements.settingsGames.textContent = State.player.totalGames || 0;
      this.elements.settingsMuts.textContent = (State.player.discoveredMutations || []).length;
    },
    
    updateHUD() {
      this.elements.hudScore.textContent = State.game.score;
      this.elements.hudRoom.textContent = State.game.room;
      
      if (State.game.shieldCharges > 0) {
        this.elements.hudShield.style.display = 'flex';
        this.elements.hudShieldCount.textContent = State.game.shieldCharges;
      } else {
        this.elements.hudShield.style.display = 'none';
      }
    },
    
    updateMutBar() {
      this.elements.mutBar.innerHTML = State.game.activeMutations
        .map(m => `<span class="mut-chip">${m.title}</span>`)
        .join('');
    },
    
    updateTouchControls() {
      const show = window.innerWidth <= 640;
      this.elements.touchControls.style.display = show ? 'grid' : 'none';
    },
    
    resizeCanvas() {
      const maxW = Math.min(560, window.innerWidth - 40);
      State.canvas.width = maxW;
      State.canvas.height = maxW;
      State.cellSize = maxW / CONFIG.GRID_SIZE;
      this.updateTouchControls();
    },
    
    showMutationChoice(mutations, specialRoom) {
      this.elements.mutRoomNum.textContent = State.game.room;
      
      // Special room banner
      if (specialRoom && SPECIAL_ROOMS[specialRoom]) {
        const info = SPECIAL_ROOMS[specialRoom];
        this.elements.specialRoomBanner.innerHTML = `
          <div class="room-title">${info.emoji} ${info.label}</div>
          <div class="room-desc">${info.desc}</div>
        `;
        this.elements.specialRoomBanner.classList.remove('hidden');
      } else {
        this.elements.specialRoomBanner.classList.add('hidden');
      }
      
      // Mutation choices
      this.elements.mutationChoices.innerHTML = mutations.map(m => `
        <div class="mut-card" data-mut-id="${m.id}">
          <div class="mut-title">${m.title}</div>
          <div class="mut-desc">${m.desc}</div>
        </div>
      `).join('');
      
      // Bind click events
      this.elements.mutationChoices.querySelectorAll('.mut-card').forEach(card => {
        card.addEventListener('click', () => {
          const mutId = card.dataset.mutId;
          Game.applyMutation(mutId);
        });
      });
      
      this.elements.mutationOverlay.classList.remove('hidden');
    },
    
    hideMutationChoice() {
      this.elements.mutationOverlay.classList.add('hidden');
    },
    
    showGameOver(score, room, eclats, isRecord) {
      this.elements.overScore.textContent = score;
      this.elements.overRoom.textContent = room;
      this.elements.overEclats.textContent = '+' + eclats;
      
      if (isRecord) {
        this.elements.newRecordMsg.classList.remove('hidden');
      } else {
        this.elements.newRecordMsg.classList.add('hidden');
      }
      
      this.elements.gameOverOverlay.classList.remove('hidden');
    },
    
    showPause() {
      this.elements.pauseOverlay.classList.remove('hidden');
    },
    
    hidePause() {
      this.elements.pauseOverlay.classList.add('hidden');
    },
    
    renderShop() {
      const catalog = SHOP[State.currentShopTab];
      const player = State.player;
      const unlocked = player?.unlocked?.[State.currentShopTab] || [];
      const equippedKey = State.currentShopTab === 'colors' ? 'color' 
        : State.currentShopTab === 'foods' ? 'food' : 'background';
      const equippedId = player?.equipped?.[equippedKey] || catalog[0].id;
      
      this.elements.shopEclatsVal.textContent = player?.eclats || 0;
      
      this.elements.shopGrid.innerHTML = catalog.map(item => {
        const isUnlocked = unlocked.includes(item.id) || item.price === 0;
        const isEquipped = equippedId === item.id;
        const canAfford = (player?.eclats || 0) >= item.price;
        
        let swatchStyle = '';
        let swatchContent = '';
        
        if (State.currentShopTab === 'colors') {
          swatchStyle = item.rainbow 
            ? 'background: linear-gradient(135deg, #ff6b9d, #ffd93d, #6bcb77, #4a90ff, #a06bff);'
            : `background: ${item.head};`;
        } else if (State.currentShopTab === 'foods') {
          swatchContent = item.emoji;
          swatchStyle = 'background: rgba(255,255,255,0.08);';
        } else {
          swatchStyle = `background: ${item.bg}; border: 1px solid rgba(255,255,255,0.15);`;
        }
        
        const classes = ['shop-item'];
        if (isEquipped) classes.push('equipped');
        if (!isUnlocked && !canAfford) classes.push('locked');
        
        return `
          <div class="${classes.join(' ')}" data-item-id="${item.id}">
            <div class="shop-swatch" style="${swatchStyle}">${swatchContent}</div>
            <div class="shop-name">${item.name}</div>
            ${isEquipped 
              ? '<div class="shop-equipped">✓ Équipé</div>'
              : isUnlocked 
                ? '<div class="shop-price" style="color: #9a9ab5;">Débloqué</div>'
                : `<div class="shop-price">💎 ${item.price}</div>`
            }
          </div>
        `;
      }).join('');
      
      // Bind click events
      this.elements.shopGrid.querySelectorAll('.shop-item').forEach(el => {
        el.addEventListener('click', () => this.handleShopClick(el.dataset.itemId));
      });
    },
    
    async handleShopClick(itemId) {
      const catalog = SHOP[State.currentShopTab];
      const item = catalog.find(i => i.id === itemId);
      if (!item) return;
      
      const player = State.player;
      const unlocked = player?.unlocked?.[State.currentShopTab] || [];
      const isUnlocked = unlocked.includes(item.id) || item.price === 0;
      const equippedKey = State.currentShopTab === 'colors' ? 'color' 
        : State.currentShopTab === 'foods' ? 'food' : 'background';
      const isEquipped = player?.equipped?.[equippedKey] === item.id;
      
      if (isEquipped) return;
      
      const action = isUnlocked ? 'equip' : 'buy';
      
      if (action === 'buy' && (player?.eclats || 0) < item.price) {
        this.elements.shopStatus.textContent = '⚠️ Pas assez d\'éclats';
        return;
      }
      
      this.elements.shopStatus.textContent = '⏳ En cours...';
      
      const result = await Cloud.shopAction(
        State.session.username,
        State.session.sessionId,
        action,
        State.currentShopTab,
        itemId
      );
      
      if (result.ok && result.player) {
        State.player = result.player;
        this.elements.shopStatus.textContent = action === 'buy' 
          ? '✅ Item débloqué et équipé !'
          : '✅ Item équipé !';
        this.renderShop();
      } else {
        this.elements.shopStatus.textContent = '⚠️ ' + (result.error || 'Erreur');
      }
    },
    
    async loadLeaderboard() {
      this.elements.leaderBest.textContent = State.player?.bestScore || 0;
      this.elements.leaderRoom.textContent = State.player?.bestRoom || 0;
      
      this.elements.leaderboardList.innerHTML = '<p style="color: #9a9ab5; padding: 20px;">⏳ Chargement...</p>';
      
      const result = await Cloud.getLeaderboard();
      
      if (result.ok && result.leaderboard) {
        if (result.leaderboard.length === 0) {
          this.elements.leaderboardList.innerHTML = '<p style="color: #9a9ab5; padding: 20px;">Aucun score. Sois le premier !</p>';
          return;
        }
        
        const medals = ['🥇', '🥈', '🥉'];
        
        this.elements.leaderboardList.innerHTML = result.leaderboard.map((entry, i) => {
          const isMe = entry.username === State.player?.username;
          return `
            <div class="score-row ${isMe ? 'highlight' : ''}">
              <span class="score-rank">${medals[i] || '#' + (i + 1)}</span>
              <div class="score-details">
                <div class="score-name">${entry.username}</div>
                <div class="score-meta">Salle ${entry.room} · ${entry.difficulty || 'normal'}</div>
              </div>
              <span class="score-value">${entry.score}</span>
            </div>
          `;
        }).join('');
      } else {
        this.elements.leaderboardList.innerHTML = '<p style="color: #ff6b9d; padding: 20px;">⚠️ Erreur de chargement</p>';
      }
    },
    
    renderMutations() {
      const discovered = State.player?.discoveredMutations || [];
      this.elements.mutationsCount.textContent = `${discovered.length} / ${MUTATIONS.length} découvertes`;
      
      this.elements.mutationsList.innerHTML = MUTATIONS.map(m => {
        const known = discovered.includes(m.id);
        return `
          <div class="mut-card locked">
            ${known ? `
              <div class="mut-title">${m.title}</div>
              <div class="mut-desc">${m.desc}</div>
            ` : `
              <div class="mut-title">❓ ????</div>
              <div class="mut-desc" style="color: #6a6a8a;">Mutation inconnue. Joue pour la découvrir.</div>
            `}
          </div>
        `;
      }).join('');
    },
  };

  // ============================================================
  // MOTEUR DE JEU
  // ============================================================

  const Game = {
    animFrameId: null,
    
    start() {
      const g = State.game;
      const diff = DIFFICULTIES[g.difficulty] || DIFFICULTIES.normal;
      
      // Reset state
      g.snake = [
        { x: 10, y: 10 },
        { x: 9, y: 10 },
        { x: 8, y: 10 },
      ];
      g.dir = { x: 1, y: 0 };
      g.nextDir = { x: 1, y: 0 };
      g.food = [];
      g.obstacles = [];
      g.particles = [];
      g.score = 0;
      g.room = 1;
      g.alive = true;
      g.paused = false;
      g.waitingForInput = true;
      
      g.activeMutations = [];
      g.speedMult = 1;
      g.ghostMode = false;
      g.shrinkMode = false;
      g.scoreMultiplier = 1;
      g.goldenEnabled = false;
      g.magnetEnabled = false;
      g.teleportEnabled = false;
      g.shieldCharges = 0;
      g.fruitsEaten = 0;
      g.fruitsForShield = 0;
      
      g.specialRoom = null;
      g.iceCells = [];
      g.lavaCells = [];
      g.lavaCycleAt = null;
      
      g.runStartTime = Date.now();
      g.isTicking = false;
      g.tickAccumulator = 0;
      g.lastFrameTime = null;
      
      // Generate obstacles
      this.generateObstacles(diff.obstacles);
      
      // Spawn food
      this.spawnFood();
      
      // Lancement de la musique
      Audio.play('classic');
      
      UI.showScreen('game');
      UI.updateHUD();
      UI.updateMutBar();
      
      // Start render loop
      this.startLoop();
    },
    
    stop() {
      const g = State.game;
      g.alive = false;
      g.paused = false;
      g.isTicking = false;
      
      Audio.stop();
      
      if (this.animFrameId) {
        cancelAnimationFrame(this.animFrameId);
        this.animFrameId = null;
      }
    },
    
    togglePause() {
      const g = State.game;
      if (!g.alive) return;
      
      if (g.paused) {
        this.resume();
      } else {
        this.pause();
      }
    },
    
    pause() {
      const g = State.game;
      if (!g.alive || g.paused) return;
      
      g.paused = true;
      g.isTicking = false;
      UI.showPause();
    },
    
    resume() {
      const g = State.game;
      if (!g.paused) return;
      
      g.paused = false;
      g.isTicking = true;
      g.tickAccumulator = 0;
      g.lastFrameTime = null;
      UI.hidePause();
    },
    
    handleDirection(dir) {
      const g = State.game;
      if (!g.alive || g.paused) return;
      
      // Mirror room inversion
      if (g.specialRoom === 'mirror') {
        dir = { x: -dir.x, y: -dir.y };
      }
      
      // Prevent 180° turn
      if (dir.x === -g.dir.x && dir.y === -g.dir.y) return;
      
      g.nextDir = dir;
      
      if (g.waitingForInput) {
        g.waitingForInput = false;
        g.isTicking = true;
        g.tickAccumulator = 0;
        g.lastFrameTime = null;
      }
    },
    
    generateObstacles(count) {
      const g = State.game;
      g.obstacles = [];
      
      for (let i = 0; i < count; i++) {
        let ox, oy, attempts = 0;
        do {
          ox = Math.floor(Math.random() * CONFIG.GRID_SIZE);
          oy = Math.floor(Math.random() * CONFIG.GRID_SIZE);
          attempts++;
        } while (
          attempts < 100 &&
          (g.snake.some(s => s.x === ox && s.y === oy) ||
           g.obstacles.some(o => o.x === ox && o.y === oy) ||
           g.iceCells.some(c => c.x === ox && c.y === oy) ||
           (Math.abs(ox - 10) < 3 && Math.abs(oy - 10) < 3))
        );
        
        if (attempts < 100) {
          g.obstacles.push({ x: ox, y: oy });
        }
      }
    },
    
    spawnFood() {
      const g = State.game;
      let fx, fy, attempts = 0;
      
      do {
        fx = Math.floor(Math.random() * CONFIG.GRID_SIZE);
        fy = Math.floor(Math.random() * CONFIG.GRID_SIZE);
        attempts++;
      } while (
        attempts < 200 &&
        (g.snake.some(s => s.x === fx && s.y === fy) ||
         g.obstacles.some(o => o.x === fx && o.y === fy) ||
         g.food.some(f => f.x === fx && f.y === fy) ||
         g.iceCells.some(c => c.x === fx && c.y === fy))
      );
      
      const kind = g.goldenEnabled && Math.random() < 0.15 ? 'gold' : 'normal';
      g.food.push({ x: fx, y: fy, kind });
    },
    
    rollSpecialRoom() {
      if (Math.random() < 0.4) return null;
      const rooms = ['mirror', 'ice', 'volcano'];
      return rooms[Math.floor(Math.random() * rooms.length)];
    },
    
    setupSpecialRoom(type) {
      const g = State.game;
      const wasSpecial = g.specialRoom;
      g.specialRoom = type;
      g.iceCells = [];
      g.lavaCells = [];
      g.lavaCycleAt = null;
      
      if (type === 'ice') {
        const count = 8 + Math.floor(Math.random() * 8);
        for (let i = 0; i < count; i++) {
          let ix, iy, attempts = 0;
          do {
            ix = Math.floor(Math.random() * CONFIG.GRID_SIZE);
            iy = Math.floor(Math.random() * CONFIG.GRID_SIZE);
            attempts++;
          } while (
            attempts < 100 &&
            (g.snake.some(s => s.x === ix && s.y === iy) ||
             g.obstacles.some(o => o.x === ix && o.y === iy) ||
             g.iceCells.some(c => c.x === ix && c.y === iy))
          );
          if (attempts < 100) {
            g.iceCells.push({ x: ix, y: iy });
          }
        }
        Audio.play('ice');
      } else if (type === 'volcano') {
        g.lavaCycleAt = Date.now() + CONFIG.LAVA_CYCLE_MS;
        this.cycleLava();
        Audio.play('volcano');
      } else if (type === 'mirror') {
        Audio.play('classic', { reversed: true });
      } else if (wasSpecial) {
        // Retour à une salle normale après une salle spéciale
        Audio.play('classic');
      }
    },
    
    cycleLava() {
      const g = State.game;
      g.lavaCells = [];
      const count = 4 + Math.floor(Math.random() * 6);
      const now = Date.now();
      
      for (let i = 0; i < count; i++) {
        let lx, ly, attempts = 0;
        do {
          lx = Math.floor(Math.random() * CONFIG.GRID_SIZE);
          ly = Math.floor(Math.random() * CONFIG.GRID_SIZE);
          attempts++;
        } while (
          attempts < 100 &&
          g.snake.some(s => s.x === lx && s.y === ly)
        );
        
        if (attempts < 100) {
          g.lavaCells.push({ x: lx, y: ly, armedAt: now + CONFIG.LAVA_ARM_DELAY });
        }
      }
    },
    
    tick() {
      const g = State.game;
      if (!g.alive || g.paused || g.waitingForInput) return;
      
      g.dir = { ...g.nextDir };
      const head = g.snake[0];
      let nx = head.x + g.dir.x;
      let ny = head.y + g.dir.y;
      
      // Teleport wrap
      if (g.teleportEnabled) {
        if (nx < 0) nx = CONFIG.GRID_SIZE - 1;
        else if (nx >= CONFIG.GRID_SIZE) nx = 0;
        if (ny < 0) ny = CONFIG.GRID_SIZE - 1;
        else if (ny >= CONFIG.GRID_SIZE) ny = 0;
      }
      
      // Wall collision
      if (!g.teleportEnabled && (nx < 0 || nx >= CONFIG.GRID_SIZE || ny < 0 || ny >= CONFIG.GRID_SIZE)) {
        if (g.shieldCharges > 0) {
          g.shieldCharges--;
          g.nextDir = { x: -g.dir.x, y: -g.dir.y };
          UI.updateHUD();
          return;
        }
        this.endRun();
        return;
      }
      
      // Self collision
      if (!g.ghostMode && g.snake.some(s => s.x === nx && s.y === ny)) {
        if (g.shieldCharges > 0) {
          g.shieldCharges--;
          g.nextDir = { x: -g.dir.x, y: -g.dir.y };
          UI.updateHUD();
          return;
        }
        this.endRun();
        return;
      }
      
      // Obstacle collision
      if (g.obstacles.some(o => o.x === nx && o.y === ny)) {
        if (g.shieldCharges > 0) {
          g.shieldCharges--;
          g.nextDir = { x: -g.dir.x, y: -g.dir.y };
          UI.updateHUD();
          return;
        }
        this.endRun();
        return;
      }
      
      // Lava collision
      if (g.specialRoom === 'volcano') {
        const now = Date.now();
        const hitLava = g.lavaCells.find(c => c.x === nx && c.y === ny && now >= c.armedAt);
        if (hitLava) {
          if (g.shieldCharges > 0) {
            g.shieldCharges--;
            g.nextDir = { x: -g.dir.x, y: -g.dir.y };
            UI.updateHUD();
            return;
          }
          this.endRun();
          return;
        }
      }
      
      // Move snake
      g.snake.unshift({ x: nx, y: ny });
      
      // Ice slide
      if (g.specialRoom === 'ice') {
        const onIce = g.iceCells.some(c => c.x === nx && c.y === ny);
        if (onIce) {
          const slideCount = 1 + Math.floor(Math.random() * 2);
          for (let s = 0; s < slideCount; s++) {
            const sx = g.snake[0].x + g.dir.x;
            const sy = g.snake[0].y + g.dir.y;
            if (sx < 0 || sx >= CONFIG.GRID_SIZE || sy < 0 || sy >= CONFIG.GRID_SIZE) break;
            if (g.obstacles.some(o => o.x === sx && o.y === sy)) break;
            if (!g.ghostMode && g.snake.some(seg => seg.x === sx && seg.y === sy)) break;
            g.snake.unshift({ x: sx, y: sy });
          }
        }
      }
      
      // Magnet
      if (g.magnetEnabled) {
        const headPos = g.snake[0];
        g.food.forEach(f => {
          const dx = headPos.x - f.x;
          const dy = headPos.y - f.y;
          if (Math.abs(dx) + Math.abs(dy) <= 3) {
            const newFx = f.x + Math.sign(dx);
            const newFy = f.y + Math.sign(dy);
            if (newFx >= 0 && newFx < CONFIG.GRID_SIZE &&
                newFy >= 0 && newFy < CONFIG.GRID_SIZE &&
                !g.obstacles.some(o => o.x === newFx && o.y === newFy) &&
                !g.iceCells.some(c => c.x === newFx && c.y === newFy)) {
              f.x = newFx;
              f.y = newFy;
            }
          }
        });
      }
      
      // Eat food
      let ate = false;
      const diff = DIFFICULTIES[g.difficulty] || DIFFICULTIES.normal;
      
      for (let i = g.food.length - 1; i >= 0; i--) {
        const f = g.food[i];
        if (f.x === g.snake[0].x && f.y === g.snake[0].y) {
          const gain = Math.ceil((f.kind === 'gold' ? 5 : 1) * g.scoreMultiplier * diff.scoreMult);
          g.score += gain;
          
          // Particles
          const CELL = State.cellSize;
          const cx = f.x * CELL + CELL / 2;
          const cy = f.y * CELL + CELL / 2;
          const foodTheme = this.getEquippedFood();
          for (let p = 0; p < 6; p++) {
            g.particles.push({
              x: cx,
              y: cy,
              vx: (Math.random() - 0.5) * 4,
              vy: (Math.random() - 0.5) * 4,
              life: 20,
              color: f.kind === 'gold' ? '#ffd93d' : foodTheme.color,
            });
          }
          
          g.food.splice(i, 1);
          ate = true;
          g.fruitsEaten++;
          
          // Shrink mode
          if (g.shrinkMode) {
            const MIN_LEN = 3;
            if (g.snake.length > MIN_LEN + 2) {
              g.snake.pop();
              g.snake.pop();
            } else if (g.snake.length > MIN_LEN) {
              g.snake.pop();
            }
          }
        }
      }
      
      if (!ate) {
        g.snake.pop();
      }
      
      if (ate) {
        this.spawnFood();
        
        // Shield recharge
        if (g.activeMutations.some(m => m.id === 'shield')) {
          g.fruitsForShield++;
          if (g.fruitsForShield % 5 === 0) {
            g.shieldCharges = Math.min(g.shieldCharges + 1, 3);
          }
        }
        
        // Advance room every 12 fruits
        if (g.fruitsEaten % 12 === 0) {
          this.advanceRoom();
          return;
        }
      }
      
      UI.updateHUD();
    },
    
    advanceRoom() {
      const g = State.game;
      g.lavaCycleAt = null;
      g.room++;
      
      const special = this.rollSpecialRoom();
      g.isTicking = false;
      
      // Pick mutations
      const notTaken = MUTATIONS.filter(m => !g.activeMutations.find(a => a.id === m.id));
      let choices;
      if (notTaken.length >= 3) {
        choices = [...notTaken].sort(() => Math.random() - 0.5).slice(0, 3);
      } else {
        const taken = MUTATIONS.filter(m => g.activeMutations.find(a => a.id === m.id));
        choices = [...notTaken.sort(() => Math.random() - 0.5), ...taken.sort(() => Math.random() - 0.5)].slice(0, 3);
      }
      
      // Track discovered mutations
      const discovered = State.player?.discoveredMutations || [];
      choices.forEach(m => {
        if (!discovered.includes(m.id)) {
          discovered.push(m.id);
        }
      });
      if (State.player) {
        State.player.discoveredMutations = discovered;
      }
      
      // Store pending special room
      g._pendingSpecialRoom = special;
      
      UI.showMutationChoice(choices, special);
    },
    
    applyMutation(mutId) {
      const g = State.game;
      const mut = MUTATIONS.find(m => m.id === mutId);
      if (!mut) return;
      
      // Apply effect
      switch (mut.id) {
        case 'speed': g.speedMult *= 0.8; break;
        case 'slow': g.speedMult *= 1.15; break;
        case 'ghost': g.ghostMode = true; break;
        case 'double': g.scoreMultiplier *= 2; break;
        case 'shrink': g.shrinkMode = true; break;
        case 'shield':
          g.shieldCharges = Math.min(g.shieldCharges + 1, 3);
          g.fruitsForShield = 0;
          break;
        case 'golden': g.goldenEnabled = true; break;
        case 'teleport': g.teleportEnabled = true; break;
        case 'magnet': g.magnetEnabled = true; break;
      }
      
      g.activeMutations.push({ id: mut.id, title: mut.title });
      
      // Setup special room
      const special = g._pendingSpecialRoom;
      g._pendingSpecialRoom = null;
      this.setupSpecialRoom(special);
      
      // Generate new obstacles
      const diff = DIFFICULTIES[g.difficulty] || DIFFICULTIES.normal;
      const obstCount = diff.obstacles + Math.floor(g.room / 3);
      this.generateObstacles(obstCount);
      
      // Respawn food
      g.food = [];
      this.spawnFood();
      
      g.waitingForInput = true;
      
      UI.hideMutationChoice();
      UI.updateHUD();
      UI.updateMutBar();
      
      g.isTicking = true;
      g.tickAccumulator = 0;
      g.lastFrameTime = null;
    },
    
    async endRun() {
      const g = State.game;
      g.alive = false;
      g.paused = false;
      g.isTicking = false;
      
      Audio.stop();
      
      const eclats = Math.max(1, Math.floor(g.score / 10) + g.room);
      const isRecord = g.score > (State.player?.bestScore || 0);
      const durationMs = Date.now() - g.runStartTime;
      
      // Submit to cloud
      if (State.session) {
        const result = await Cloud.submitScore(
          State.session.username,
          State.session.sessionId,
          {
            score: g.score,
            room: g.room,
            difficulty: g.difficulty,
            eclatsGained: eclats,
            durationMs,
            discoveredMutations: State.player?.discoveredMutations || [],
          }
        );
        
        if (result.ok && result.player) {
          State.player = result.player;
        }
      }
      
      UI.showGameOver(g.score, g.room, eclats, isRecord);
    },
    
    getEquippedColor() {
      const id = State.player?.equipped?.color || 'teal';
      return SHOP.colors.find(c => c.id === id) || SHOP.colors[0];
    },
    
    getEquippedFood() {
      const id = State.player?.equipped?.food || 'classic';
      return SHOP.foods.find(f => f.id === id) || SHOP.foods[0];
    },
    
    getEquippedBackground() {
      const id = State.player?.equipped?.background || 'default';
      return SHOP.backgrounds.find(b => b.id === id) || SHOP.backgrounds[0];
    },
    
    startLoop() {
      const loop = (timestamp) => {
        this.animFrameId = requestAnimationFrame(loop);
        
        const g = State.game;
        if (!g.alive && State.currentScreen !== 'game') return;
        
        const now = Date.now();
        
        // Ticking
        if (g.isTicking && g.alive && !g.paused && !g.waitingForInput) {
          if (g.lastFrameTime === null) {
            g.lastFrameTime = timestamp;
          }
          
          let dt = timestamp - g.lastFrameTime;
          g.lastFrameTime = timestamp;
          if (dt > 1000) dt = 1000;
          
          const diff = DIFFICULTIES[g.difficulty] || DIFFICULTIES.normal;
          const baseTickMs = diff.tickMs * g.speedMult;
          g.tickAccumulator += dt;
          
          let ticksThisFrame = 0;
          while (g.tickAccumulator >= baseTickMs && ticksThisFrame < 3) {
            this.tick();
            g.tickAccumulator -= baseTickMs;
            ticksThisFrame++;
            if (!g.alive) break;
          }
          
          if (g.tickAccumulator > baseTickMs * 3) {
            g.tickAccumulator = baseTickMs;
          }
          
          // Lava cycle
          if (g.specialRoom === 'volcano' && g.lavaCycleAt !== null && now >= g.lavaCycleAt) {
            this.cycleLava();
            g.lavaCycleAt = now + CONFIG.LAVA_CYCLE_MS;
          }
        }
        
        // Update particles
        for (let i = g.particles.length - 1; i >= 0; i--) {
          const p = g.particles[i];
          p.x += p.vx;
          p.y += p.vy;
          p.life--;
          if (p.life <= 0) g.particles.splice(i, 1);
        }
        
        // Render
        this.render(now);
      };
      
      this.animFrameId = requestAnimationFrame(loop);
    },
    
    render(now) {
      const g = State.game;
      const ctx = State.ctx;
      const canvas = State.canvas;
      const CELL = State.cellSize;
      
      const bgTheme = this.getEquippedBackground();
      const colorTheme = this.getEquippedColor();
      const foodTheme = this.getEquippedFood();
      
      // Clear
      canvas.style.background = bgTheme.bg;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // Grid
      ctx.strokeStyle = bgTheme.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= CONFIG.GRID_SIZE; i++) {
        ctx.moveTo(i * CELL, 0);
        ctx.lineTo(i * CELL, canvas.height);
        ctx.moveTo(0, i * CELL);
        ctx.lineTo(canvas.width, i * CELL);
      }
      ctx.stroke();
      
      // Ice cells
      if (g.specialRoom === 'ice' && g.iceCells.length) {
        ctx.fillStyle = 'rgba(180, 220, 255, 0.15)';
        ctx.beginPath();
        g.iceCells.forEach(c => this.roundRect(ctx, c.x * CELL + 2, c.y * CELL + 2, CELL - 4, CELL - 4, 5));
        ctx.fill();
      }
      
      // Lava cells
      if (g.specialRoom === 'volcano' && g.lavaCells.length) {
        const blink = Math.floor(now / 150) % 2 === 0;
        g.lavaCells.forEach(c => {
          if (now >= c.armedAt) {
            ctx.fillStyle = '#ff4a2f';
          } else if (blink) {
            ctx.fillStyle = 'rgba(255, 150, 60, 0.55)';
          } else {
            ctx.fillStyle = 'rgba(255, 90, 40, 0.3)';
          }
          ctx.beginPath();
          this.roundRect(ctx, c.x * CELL + 2, c.y * CELL + 2, CELL - 4, CELL - 4, 5);
          ctx.fill();
        });
      }
      
      // Obstacles
      if (g.obstacles.length) {
        ctx.fillStyle = '#3a3a5c';
        ctx.beginPath();
        g.obstacles.forEach(o => this.roundRect(ctx, o.x * CELL + 2, o.y * CELL + 2, CELL - 4, CELL - 4, 4));
        ctx.fill();
      }
      
      // Food
      g.food.forEach(f => {
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
      
      // Snake
      if (colorTheme.rainbow) {
        g.snake.forEach((s, i) => {
          const hue = (i * 25 + now / 20) % 360;
          ctx.fillStyle = `hsl(${hue}, 80%, 62%)`;
          const pad = i === 0 ? 1 : 2;
          ctx.beginPath();
          this.roundRect(ctx, s.x * CELL + pad, s.y * CELL + pad, CELL - pad * 2, CELL - pad * 2, i === 0 ? 6 : 4);
          ctx.fill();
        });
      } else {
        // Body
        if (g.snake.length > 1) {
          ctx.fillStyle = colorTheme.body;
          ctx.beginPath();
          for (let i = 1; i < g.snake.length; i++) {
            this.roundRect(ctx, g.snake[i].x * CELL + 2, g.snake[i].y * CELL + 2, CELL - 4, CELL - 4, 4);
          }
          ctx.fill();
        }
        
        // Head
        if (g.snake.length > 0) {
          ctx.fillStyle = colorTheme.head;
          ctx.beginPath();
          this.roundRect(ctx, g.snake[0].x * CELL + 1, g.snake[0].y * CELL + 1, CELL - 2, CELL - 2, 6);
          ctx.fill();
        }
      }
      
      // Shield indicator
      if (g.shieldCharges > 0 && g.snake[0]) {
        ctx.strokeStyle = '#ffd93d';
        ctx.lineWidth = 2;
        const scx = g.snake[0].x * CELL + CELL / 2;
        const scy = g.snake[0].y * CELL + CELL / 2;
        ctx.beginPath();
        ctx.arc(scx, scy, CELL / 1.6, 0, Math.PI * 2);
        ctx.stroke();
      }
      
      // Particles
      if (g.particles.length) {
        g.particles.forEach(p => {
          ctx.globalAlpha = Math.max(0, p.life / 20);
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.globalAlpha = 1;
      }
      
      // "Press to start" overlay
      if (g.alive && g.waitingForInput) {
        ctx.fillStyle = 'rgba(10,10,20,0.55)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#f5f5f5';
        ctx.font = `${Math.floor(CELL * 0.9)}px Segoe UI, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('▶', canvas.width / 2, canvas.height / 2 - 10);
        ctx.font = `${Math.floor(CELL * 0.5)}px Segoe UI, sans-serif`;
        ctx.fillText('Appuie sur une flèche', canvas.width / 2, canvas.height / 2 + 30);
        ctx.textAlign = 'left';
      }
    },
    
    roundRect(ctx, x, y, w, h, r) {
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    },
  };

  // ============================================================
  // INITIALISATION
  // ============================================================

  async function init() {
    UI.init();
    
    // Try to restore session
    const restored = await Auth.restoreSession();
    
    if (restored) {
      UI.showScreen('menu');
    } else {
      UI.showScreen('auth');
    }
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
