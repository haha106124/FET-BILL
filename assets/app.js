/* 介面邏輯：分頁切換、姓名查詢、相機辨識、單位總覽。 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const RECENT_KEY = 'sortingmail.recent';
  const THEME_KEY = 'sortingmail.theme';

  let directory = null;
  let matcher = null;

  /* ── 小工具 ─────────────────────────────────────────────── */

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  /* ── 結果卡片 ───────────────────────────────────────────── */

  function personCard(person, score) {
    const p = person;
    // 名冊只留姓名＋工地兩種資訊，卡片也只顯示這兩種——不顯示職稱、電話、
    // 分機、地址等個資（即使名冊來源檔案裡還有，data.js 也已經先過濾掉）。
    const confidenceOnly = score != null && score < 1
      ? `<span class="badge badge-fuzzy">比對 ${Math.round(score * 100)}%</span>` : '';
    return `
      <article class="card">
        <div class="card-head">
          <h3 class="name">${escapeHtml(p.name)}</h3>
          <div class="badges">${confidenceOnly}</div>
        </div>
        <div class="address-block">
          <div class="address-unit">${escapeHtml(p.unit)}</div>
        </div>
      </article>`;
  }

  function renderResults(container, matches, emptyHtml) {
    if (!matches.length) {
      container.innerHTML = emptyHtml || '';
      return;
    }
    container.innerHTML =
      `<p class="result-count">找到 ${matches.length} 筆</p>` +
      matches.map((m) => personCard(m.person, m.score)).join('');
  }

  /* ── 姓名查詢 ───────────────────────────────────────────── */

  function getRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (_) { return []; }
  }

  function pushRecent(name) {
    const list = getRecent().filter((n) => n !== name);
    list.unshift(name);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8))); } catch (_) { /* 私密瀏覽 */ }
    renderRecent();
  }

  function renderRecent() {
    const list = getRecent();
    $('#recentChips').hidden = list.length === 0;
    $('#recentRow').innerHTML = list
      .map((n) => `<button class="chip" data-q="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('');
  }

  let searchTimer;
  function onSearchInput() {
    const q = $('#q').value.trim();
    $('#clearBtn').hidden = !q;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(q), 120);
  }

  function runSearch(q) {
    const box = $('#searchResults');
    if (!q) { box.innerHTML = ''; return; }
    const matches = matcher.search(q);
    renderResults(box, matches,
      `<div class="empty"><p>找不到「${escapeHtml(q)}」</p>
       <p class="empty-sub">試試只打名字的其中兩個字，或改用簡碼／分機查。</p></div>`);
    if (matches.length && matches[0].score >= 0.8) pushRecent(matches[0].person.name);
  }

  /* ── 單位總覽 ───────────────────────────────────────────── */

  function renderUnits() {
    $('#unitList').innerHTML = directory.units.map((u) => `
      <details class="unit">
        <summary>
          <span class="unit-name">${escapeHtml(u.name)}</span>
          <span class="unit-count">${u.people.length} 人</span>
        </summary>
        <div class="unit-body">
          <div class="people-grid">
            ${u.people.map((p) => `<button class="person-chip" data-q="${escapeHtml(p.name)}">
                <span class="pc-name">${escapeHtml(p.name)}</span>
              </button>`).join('')}
          </div>
        </div>
      </details>`).join('');
  }

  /* ── 相機辨識 ───────────────────────────────────────────── */

  // 用「最近幾張影格」的小視窗投票，而不是整段掃描期間無限累積：
  // 換下一封信之後，舊信封的分數只要幾張影格就會被擠出視窗，
  // 新信封不用等很久就能被辨識出來，也不會被舊資料拖累。
  const VOTE_WINDOW = 2;
  // 同一人多久內不重複跳出大字結果（使用者手還沒把信移開時避免一直彈）。
  const CONFIRM_COOLDOWN_MS = 5000;
  // 大字結果顯示多久後自動收回、換回「正在掃描」（換下一封信前這裡一定會清空）。
  const HIT_DISPLAY_MS = 1500;
  // 大量連續掃描以速度優先；只有備援模式才拉高到較大的尺寸。
  const FAST_TARGET_WIDTH = 920;
  const PRECISE_TARGET_WIDTH = 1800;
  const QUALITY_INTERVAL_MS = 110;
  const MOTION_RESET_THRESHOLD = 19;
  const MIN_BRIGHTNESS = 54;
  const MAX_BRIGHTNESS = 238;
  const MIN_SHARPNESS = 7;

  const cam = {
    stream: null,
    track: null,
    facing: 'environment',
    scanning: false,
    busy: false,
    recentFrames: [],     // 最近幾張影格的比對結果（陣列的陣列）
    confirmed: new Map(), // key -> 上次跳出大字結果的時間
    acceptedCount: 0,
    liveTimer: null,
    timer: null,
    qualityTimer: null,
    scanId: 0,
    preciseAttemptId: -1,
    quality: { previous: null, stableFrames: 0, ready: false, brightness: 0, sharpness: 0 },
    torchOn: false,
  };

  function setOcrStatus(text, progress) {
    $('#ocrStatus').hidden = false;
    $('#ocrStatusText').textContent = text;
    $('#progressBar').style.width = `${Math.round((progress || 0) * 100)}%`;
  }

  /** 待機／掃描中：畫面上方一個小提示，不擋住掃描框。 */
  function showLiveScanning(message = '正在掃描：把整個地址欄放進框內') {
    const live = $('#liveMatch');
    live.classList.remove('is-hit');
    live.classList.add('is-scanning');
    live.innerHTML = `<span class="dot" aria-hidden="true"></span>${escapeHtml(message)}`;
    live.hidden = false;
  }

  /** 辨識成功：相機畫面上直接跳出大字姓名＋工地，不用捲動、不用按任何按鈕。 */
  function showLiveHit(person) {
    const live = $('#liveMatch');
    live.classList.remove('is-scanning');
    live.classList.add('is-hit');
    live.innerHTML =
      `<strong>${escapeHtml(person.name)}</strong><span>${escapeHtml(person.unit)}</span>`;
    live.hidden = false;
    clearTimeout(cam.liveTimer);
    cam.liveTimer = setTimeout(() => { if (cam.scanning) showLiveScanning(); }, HIT_DISPLAY_MS);
    setOcrStatus(`已掃描 ${cam.acceptedCount} 筆 · 繼續自動掃描中`, 1);
  }

  function beginNextEnvelope(message = '等待下一封，請停穩…') {
    cam.scanId += 1;
    cam.preciseAttemptId = -1;
    cam.recentFrames = [];
    cam.confirmed.clear();
    cam.quality.stableFrames = 0;
    clearTimeout(cam.liveTimer);
    $('#cameraResults').innerHTML = '';
    showLiveScanning(message);
    setOcrStatus(message, 0);
  }

  /**
   * 每 150ms 只看掃描框內的極小預覽圖。它不做 OCR，而是用來判斷：
   * 1. 是否已換下一封信（舊 OCR 結果必須失效）；2. 是否夠穩、夠亮、夠清楚。
   */
  function sampleFrameQuality() {
    const video = $('#video');
    if (!cam.scanning || !video.videoWidth) return;
    const rect = frameRect(video, 0.06);
    const w = 72, h = 48;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const luma = new Uint8Array(w * h);
    let sum = 0, edge = 0, motion = 0;
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const value = Math.round((px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000);
      luma[j] = value;
      sum += value;
      if (cam.quality.previous) motion += Math.abs(value - cam.quality.previous[j]);
      if (j % w) edge += Math.abs(value - luma[j - 1]);
      if (j >= w) edge += Math.abs(value - luma[j - w]);
    }
    const brightness = sum / luma.length;
    const sharpness = edge / (luma.length * 2);
    motion /= luma.length;
    const hadPreviousFrame = Boolean(cam.quality.previous);
    const changed = hadPreviousFrame && motion >= MOTION_RESET_THRESHOLD;
    cam.quality.previous = luma;
    cam.quality.brightness = brightness;
    cam.quality.sharpness = sharpness;

    if (changed) {
      // 新信封已經進框：所有舊 OCR 回應和舊投票都不能再顯示。
      beginNextEnvelope('偵測到下一封，等待畫面穩定…');
    }

    const usableLight = brightness >= MIN_BRIGHTNESS && brightness <= MAX_BRIGHTNESS;
    const usableFocus = sharpness >= MIN_SHARPNESS;
    // 只需要一個短暫穩定檢查：避免「穩定中」拖太久，但仍不讀剛移入框內的信封。
    const stable = hadPreviousFrame && !changed && motion < MOTION_RESET_THRESHOLD * 0.55;
    cam.quality.stableFrames = stable ? cam.quality.stableFrames + 1 : 0;
    cam.quality.ready = usableLight && usableFocus && cam.quality.stableFrames >= 1;

    if (cam.busy || $('#liveMatch').classList.contains('is-hit')) return;
    if (brightness < MIN_BRIGHTNESS) showLiveScanning('光線不足，可開啟補光');
    else if (brightness > MAX_BRIGHTNESS) showLiveScanning('反光太強，請稍微調整角度');
    else if (!usableFocus) showLiveScanning('請靠近並停穩，等待對焦…');
    else if (!cam.quality.ready) showLiveScanning('畫面穩定中…');
    else showLiveScanning('已對焦，正在自動辨識…');
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('這個瀏覽器不支援相機，請改用「相簿／單張拍照」');
      return;
    }
    if (!window.isSecureContext) {
      toast('相機需要 HTTPS 或 localhost 才能啟動');
      return;
    }
    try {
      cam.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: cam.facing },
          // 解析度盡量拉高：信封上的姓名字塊通常只占畫面一小塊，
          // 來源解析度越高，裁切出來的那一小塊才有足夠的像素可用。
          width: { ideal: 2560 },
          height: { ideal: 1440 },
        },
        audio: false,
      });
    } catch (err) {
      toast(err && err.name === 'NotAllowedError' ? '相機權限被拒絕' : '無法開啟相機');
      console.error(err);
      return;
    }

    const video = $('#video');
    video.srcObject = cam.stream;
    await video.play().catch(() => {});
    cam.track = cam.stream.getVideoTracks()[0];

    $('#cameraIdle').hidden = true;
    $('#cameraBar').hidden = false;
    $('#ocrDebug').hidden = false;
    $('#cameraStage').classList.add('is-live');

    const caps = cam.track.getCapabilities ? cam.track.getCapabilities() : {};
    $('#torchBtn').hidden = !('torch' in caps);
    navigator.mediaDevices.enumerateDevices().then((ds) => {
      $('#flipBtn').hidden = ds.filter((d) => d.kind === 'videoinput').length < 2;
    }).catch(() => {});

    // 近距離對著信封上的字，手機預設對焦／曝光策略常常對不準；
    // 支援的裝置（多半是 Android Chrome）就請它持續自動對焦與自動曝光。
    // iOS Safari 不開放這個 API，會直接被 catch 掉，不影響其他功能。
    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      cam.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
    if (caps.exposureMode && caps.exposureMode.includes('continuous')) {
      cam.track.applyConstraints({ advanced: [{ exposureMode: 'continuous' }] }).catch(() => {});
    }

    cam.recentFrames = [];
    cam.confirmed.clear();
    cam.acceptedCount = 0;
    cam.scanId += 1;
    cam.preciseAttemptId = -1;
    cam.quality = { previous: null, stableFrames: 0, ready: false, brightness: 0, sharpness: 0 };
    clearTimeout(cam.liveTimer);
    showLiveScanning();
    cam.scanning = true;
    setOcrStatus('載入辨識引擎…', 0);

    try {
      await OCR.init((m) => setOcrStatus(`${m.status}（${m.source}）`, m.progress));
      setOcrStatus('掃描中：請把姓名放進框內', 1);
      cam.qualityTimer = setInterval(sampleFrameQuality, QUALITY_INTERVAL_MS);
      scanLoop();
    } catch (err) {
      setOcrStatus(err.message, 0);
      toast('辨識引擎載入失敗，仍可用「立即辨識」以外的方式查詢');
      console.error(err);
    }
  }

  function stopCamera() {
    cam.scanning = false;
    clearTimeout(cam.timer);
    clearTimeout(cam.liveTimer);
    clearInterval(cam.qualityTimer);
    cam.qualityTimer = null;
    cam.scanId += 1; // 讓停止前仍在運算的 OCR 結果全部失效
    if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
    cam.stream = null;
    cam.track = null;
    $('#video').srcObject = null;
    $('#cameraIdle').hidden = false;
    $('#cameraBar').hidden = true;
    $('#ocrStatus').hidden = true;
    $('#cameraStage').classList.remove('is-live');
    $('#liveMatch').hidden = true;
  }

  /**
   * 取出掃描框對應到影片畫面上的區域。
   * 實際裁切會比框線再往外多留一些，使用者不必對得很準。
   */
  // 手持手機快速連續掃 200~300 封信，框很難每次都對得剛剛好，
  // 留白拉大一點比較不會因為手震、信封位置偏一點就整個裁不到姓名。
  const FRAME_PAD = 0.10;

  function frameRect(video, pad = FRAME_PAD) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const stage = $('#cameraStage').getBoundingClientRect();
    const frame = $('#scanFrame').getBoundingClientRect();

    // video 用 object-fit: cover，換算實際被裁切後的比例
    const scale = Math.max(stage.width / vw, stage.height / vh);
    const offX = (vw * scale - stage.width) / 2;
    const offY = (vh * scale - stage.height) / 2;

    let sx = (frame.left - stage.left + offX) / scale;
    let sy = (frame.top - stage.top + offY) / scale;
    let sw = frame.width / scale;
    let sh = frame.height / scale;

    const padX = sw * pad;
    const padY = sh * pad;
    sx -= padX; sy -= padY;
    sw += padX * 2; sh += padY * 2;

    // 夾回影像範圍內
    sx = Math.max(0, Math.min(sx, vw - 1));
    sy = Math.max(0, Math.min(sy, vh - 1));
    sw = Math.min(sw, vw - sx);
    sh = Math.min(sh, vh - sy);

    return {
      sx: Math.round(sx), sy: Math.round(sy),
      sw: Math.round(sw), sh: Math.round(sh),
    };
  }

  async function scanOnce(manual) {
    const video = $('#video');
    if (cam.busy || !video.videoWidth) return;
    if (!manual && !cam.quality.ready) return;
    cam.busy = true;
    const capturedScanId = cam.scanId;
    try {
      // 快速路徑：裁切較緊、解析度較低。清楚的信封大多在這一步就完成。
      let canvas = OCR.preprocess(video, frameRect(video, manual ? 0.16 : 0.08),
        manual ? PRECISE_TARGET_WIDTH : FAST_TARGET_WIDTH);
      let { text } = await OCR.recognize(canvas, 'block');
      if (!cam.scanning || capturedScanId !== cam.scanId) return;
      let matches = matcher.find(text, { minScore: manual ? 0.55 : 0.60, limit: 6 });

      // OCR 連中文字都沒讀到時，通常是信封正在移動或尚未對焦；直接等下一影格
      // 比連跑兩次慢速模式更快。真的讀到中文但沒比對到時才進精準備援。
      const sawChinese = /[㐀-䶿一-鿿]/.test(text);
      if (!matches.length && (manual || (sawChinese && cam.preciseAttemptId !== capturedScanId))) {
        cam.preciseAttemptId = capturedScanId;
        canvas = OCR.preprocess(video, frameRect(video, 0.26), PRECISE_TARGET_WIDTH);
        const retry = await OCR.recognize(canvas, 'block');
        if (!cam.scanning || capturedScanId !== cam.scanId) return;
        text = retry.text;
        matches = matcher.find(text, { minScore: 0.55, limit: 6 });
      }

      // 最慢的版面模式留給使用者按「立即辨識」時才使用；自動掃描不會為一封
      // 讀不到的信卡住太久，下一個清楚影格能馬上接手。
      if (!matches.length && manual) {
        const retry = await OCR.recognize(canvas, 'column');
        if (!cam.scanning || capturedScanId !== cam.scanId) return;
        if (retry.text.trim()) {
          text = retry.text;
          matches = matcher.find(text, { minScore: 0.55, limit: 6 });
        }
      }

      $('#ocrText').textContent = text.trim() || '（沒有讀到文字）';
      handleOcrText(matches, manual);
    } catch (err) {
      console.error(err);
      setOcrStatus(`辨識失敗：${err.message}`, 0);
    } finally {
      cam.busy = false;
    }
  }

  function scanLoop() {
    if (!cam.scanning) return;
    cam.timer = setTimeout(async () => {
      await scanOnce(false);
      scanLoop();
    }, cam.quality.ready ? 90 : 180);
  }

  /**
   * 累計「最近幾張」影格的辨識結果再決定，避免單張誤判造成畫面跳動；
   * 視窗只保留最近幾張，換下一封信之後舊信封的分數很快就會被擠出去，
   * 不需要按任何按鈕、不需要停止相機，新信封出現就能盡快被辨識出來。
   */
  function handleOcrText(matches, manual) {
    if (!matches.length) {
      if (manual) toast('框內沒有辨識到名冊中的姓名');
      return;
    }

    if (!manual) {
      cam.recentFrames.push(matches);
      if (cam.recentFrames.length > VOTE_WINDOW) cam.recentFrames.shift();
    }
    const frames = manual ? [matches] : cam.recentFrames;

    const tally = new Map();
    for (const frameMatches of frames) {
      for (const m of frameMatches) {
        const key = m.person.name + '|' + m.person.unitId;
        const v = tally.get(key) || { hits: 0, best: 0, match: m };
        v.hits += 1;
        v.best = Math.max(v.best, m.score);
        v.match = m;
        tally.set(key, v);
      }
    }

    const ranked = [...tally.values()]
      .sort((a, b) => (b.best * 1.5 + b.hits) - (a.best * 1.5 + a.hits));
    const top = ranked[0];
    // 幾乎完全吻合就直接採用；分數略低則要求連續兩張影格都認得同一個人再採用。
    const confident = manual || top.best >= 0.98 || (top.best >= 0.85 && top.hits >= 2);

    // 同名同姓（例如調動中的人）要一起列出，不能只挑一個
    if (manual) renderResults($('#cameraResults'), ranked.slice(0, 6).map((v) => v.match), '');

    if (!confident) return;

    // 同一封信不要一直重複跳出：同一個人短時間內只提示一次
    const key = top.match.person.name + '|' + top.match.person.unitId;
    const now = Date.now();
    const lastSeen = cam.confirmed.get(key) || 0;
    if (now - lastSeen < CONFIRM_COOLDOWN_MS) return;

    cam.confirmed.set(key, now);
    for (const [oldKey, time] of cam.confirmed) {
      if (now - time > CONFIRM_COOLDOWN_MS * 4) cam.confirmed.delete(oldKey);
    }
    cam.acceptedCount += 1;
    cam.recentFrames = [];   // 這封信已經確認，投票視窗歸零，準備讀下一封

    showLiveHit(top.match.person);
    pushRecent(top.match.person.name);
    if (navigator.vibrate) navigator.vibrate([40, 35, 40]);
  }

  /** 使用者按「立即辨識」：立刻拍一張高解析度的來辨識，相機持續運作不受影響。 */
  async function manualShot() {
    setOcrStatus('辨識中…', 0.4);
    await scanOnce(true);
    setOcrStatus('掃描中：請把姓名放進框內', 1);
  }

  /** 從相簿選圖或單張拍照（不支援 getUserMedia 時的備援）。 */
  function handlePhotoFile(file) {
    if (!file) return;
    const img = new Image();
    img.onload = async () => {
      $('#ocrStatus').hidden = false;
      $('#ocrDebug').hidden = false;
      try {
        await OCR.init((m) => setOcrStatus(`${m.status}（${m.source}）`, m.progress));
        setOcrStatus('辨識中…', 0.5);
        const canvas = OCR.preprocess(img, { sx: 0, sy: 0, sw: img.width, sh: img.height }, 1900);
        // 整張照片通常含多行（地址、姓名等），用「整段文字」模式。
        const { text } = await OCR.recognize(canvas, 'block');
        $('#ocrText').textContent = text.trim() || '（沒有讀到文字）';
        const matches = matcher.find(text, { minScore: 0.55, limit: 8 });
        renderResults($('#cameraResults'), matches,
          '<div class="empty"><p>照片裡沒有辨識到名冊中的姓名</p>' +
          '<p class="empty-sub">試著拍近一點、讓姓名佔滿畫面，或改用姓名查詢。</p></div>');
        setOcrStatus(matches.length ? `辨識完成，找到 ${matches.length} 筆` : '辨識完成，沒有比對到姓名', 1);
        if (matches.length) pushRecent(matches[0].person.name);
      } catch (err) {
        setOcrStatus(`辨識失敗：${err.message}`, 0);
        console.error(err);
      } finally {
        URL.revokeObjectURL(img.src);
      }
    };
    img.onerror = () => toast('無法讀取這張圖片');
    img.src = URL.createObjectURL(file);
  }

  /* ── 分頁 ───────────────────────────────────────────────── */

  function showTab(id) {
    for (const t of document.querySelectorAll('.tab')) {
      const on = t.id === `tab-${id}`;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    }
    for (const p of document.querySelectorAll('.panel')) {
      p.classList.toggle('is-active', p.id === `panel-${id}`);
    }
    if (id !== 'camera' && cam.stream) stopCamera();
    if (id === 'search') $('#q').focus();
  }

  /* ── 啟動 ───────────────────────────────────────────────── */

  function bindEvents() {
    $('#q').addEventListener('input', onSearchInput);
    $('#clearBtn').addEventListener('click', () => {
      $('#q').value = '';
      onSearchInput();
      $('#q').focus();
    });

    document.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', () => showTab(t.id.replace('tab-', '')));
    });

    $('#startCamBtn').addEventListener('click', startCamera);
    $('#stopCamBtn').addEventListener('click', stopCamera);
    $('#shotBtn').addEventListener('click', manualShot);
    $('#nextEnvelopeBtn').addEventListener('click', () => beginNextEnvelope());
    $('#photoInput').addEventListener('change', (e) => handlePhotoFile(e.target.files[0]));

    $('#torchBtn').addEventListener('click', async () => {
      if (!cam.track) return;
      const on = !cam.torchOn;
      try {
        await cam.track.applyConstraints({ advanced: [{ torch: on }] });
        cam.torchOn = on;
        $('#torchBtn').classList.toggle('is-on', on);
      } catch (_) { toast('這台裝置不支援補光'); }
    });

    $('#flipBtn').addEventListener('click', async () => {
      cam.facing = cam.facing === 'environment' ? 'user' : 'environment';
      stopCamera();
      await startCamera();
    });

    $('#themeBtn').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* ignore */ }
    });

    document.addEventListener('click', (e) => {
      const qBtn = e.target.closest('[data-q]');
      if (qBtn) {
        showTab('search');
        $('#q').value = qBtn.dataset.q;
        onSearchInput();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && cam.stream) stopCamera();
    });
  }

  /* ── 登入 ───────────────────────────────────────────────── */

  let envelope = null;

  function showLock(message) {
    $('#lockscreen').hidden = false;
    $('#lockError').hidden = !message;
    $('#lockError').textContent = message || '';
    setTimeout(() => $('#account').focus(), 50);
  }

  function startSession(dir) {
    directory = dir;
    matcher = new Matcher.NameMatcher(directory.people);
    window.SortingMail = { directory, matcher };   // 方便在主控台除錯／測試
    $('#sourceLine').textContent =
      `${directory.people.length} 人 · ${directory.units.length} 個單位 · 來源：${directory.source}`;
    renderUnits();
    renderRecent();
    $('#lockscreen').hidden = true;
    $('#q').focus();
  }

  async function onLogin(e) {
    e.preventDefault();
    const btn = $('#loginBtn');
    const account = $('#account').value.trim();
    const password = $('#password').value;
    if (!account || !password) return;

    btn.disabled = true;
    btn.textContent = '解密中…';
    $('#lockError').hidden = true;
    // 讓瀏覽器有機會重畫按鈕文字：PBKDF2 是同步的重運算，會卡住畫面
    await new Promise((r) => setTimeout(r, 30));

    try {
      const dir = await Directory.unlock(
        envelope, account, password, $('#rememberMe').checked);
      $('#password').value = '';
      startSession(dir);
    } catch (err) {
      $('#lockError').hidden = false;
      $('#lockError').textContent = err.code === 'BAD_CREDENTIALS'
        ? '帳號或密碼不正確' : `解密失敗：${err.message}`;
      $('#password').select();
    } finally {
      btn.disabled = false;
      btn.textContent = '登入';
    }
  }

  function lockAndReload() {
    Directory.forgetKey();
    if (cam.stream) stopCamera();
    location.reload();
  }

  /* ── 啟動 ───────────────────────────────────────────────── */

  async function main() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved) document.documentElement.dataset.theme = saved;
    } catch (_) { /* ignore */ }

    bindEvents();
    $('#loginForm').addEventListener('submit', onLogin);
    $('#lockBtn').addEventListener('click', lockAndReload);

    try {
      envelope = await Directory.fetchEnvelope();
    } catch (err) {
      $('#sourceLine').textContent = '電話表尚未設定';
      showLock(err.code === 'DIRECTORY_NOT_CONFIGURED'
        ? '程式已就緒，尚未載入你的加密電話表。請先完成電腦端電話表設定。'
        : `${err.message}。請確認是透過網頁伺服器開啟（不能用 file://）。`);
      $('#loginBtn').disabled = true;
      return;
    }

    // 之前勾過「記住這台裝置」就直接進去，否則要求登入
    const resumed = await Directory.unlockWithStoredKey(envelope);
    if (resumed) startSession(resumed);
    else showLock('');

    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 非必要功能 */ });
    }
  }

  main();
})();
