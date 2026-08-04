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

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已複製');
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('已複製'); } catch (e) { toast('複製失敗'); }
      ta.remove();
    }
  }

  /* ── 結果卡片 ───────────────────────────────────────────── */

  function personCard(person, score) {
    const p = person;
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

    // Legacy detail-card code below is intentionally unreachable. It is kept
    // temporarily to avoid changing unrelated OCR behavior in this release.
    const confidence = score != null && score < 1
      ? `<span class="badge badge-fuzzy">相似 ${Math.round(score * 100)}%</span>` : '';
    const note = p.note ? `<span class="badge badge-note">${escapeHtml(p.note)}</span>` : '';
    const title = p.title ? `<span class="badge">${escapeHtml(p.title)}</span>` : '';
    const group = p.group ? `<span class="badge badge-soft">${escapeHtml(p.group)}</span>` : '';

    const rows = [];
    if (p.mobile) {
      rows.push(`<div class="row"><span class="k">行動電話</span>
        <a class="v link" href="tel:${escapeHtml(p.mobile.replace(/-/g, ''))}">${escapeHtml(p.mobile)}</a></div>`);
    }
    if (p.ext) {
      const tel = p.unitTel ? p.unitTel.split(/[、,]/)[0].replace(/[()]/g, '') : '';
      const href = tel ? `tel:${escapeHtml(tel.replace(/-/g, ''))},${escapeHtml(p.ext)}` : null;
      rows.push(`<div class="row"><span class="k">分機</span>${href
        ? `<a class="v link" href="${href}">${escapeHtml(p.ext)}</a>`
        : `<span class="v">${escapeHtml(p.ext)}</span>`}</div>`);
    }
    if (p.code) rows.push(`<div class="row"><span class="k">簡碼</span><span class="v">${escapeHtml(p.code)}</span></div>`);
    if (p.unitTel) rows.push(`<div class="row"><span class="k">單位電話</span><span class="v">${escapeHtml(p.unitTel)}</span></div>`);
    if (p.unitFax) rows.push(`<div class="row"><span class="k">傳真</span><span class="v">${escapeHtml(p.unitFax)}</span></div>`);

    const mailLabel = `${p.unit}　${p.name}${p.title ? ' ' + p.title : ''}\n${p.address}`;

    return `
      <article class="card">
        <div class="card-head">
          <h3 class="name">${escapeHtml(p.name)}</h3>
          <div class="badges">${title}${group}${note}${confidence}</div>
        </div>

        <div class="address-block">
          <div class="address-label">收件單位 · 地址</div>
          <div class="address-unit">${escapeHtml(p.unit)}</div>
          <div class="address-text">${escapeHtml(p.address || '（名冊未載明地址）')}</div>
          <div class="address-actions">
            <button class="btn btn-sm" data-copy="${escapeHtml(p.address)}">複製地址</button>
            <button class="btn btn-sm" data-copy="${escapeHtml(mailLabel)}">複製整組</button>
            ${p.address ? `<a class="btn btn-sm" target="_blank" rel="noopener"
                 href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address)}">地圖</a>` : ''}
          </div>
        </div>

        <div class="rows">${rows.join('')}</div>
        ${p.unitNote ? `<p class="unit-note">${escapeHtml(p.unitNote)}</p>` : ''}
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
          <span class="unit-addr">${escapeHtml(u.address)}</span>
        </summary>
        <div class="unit-body">
          <div class="unit-meta">
            ${u.tel ? `<div><span class="k">電話</span><span class="v">${escapeHtml(u.tel)}</span></div>` : ''}
            ${u.fax ? `<div><span class="k">傳真</span><span class="v">${escapeHtml(u.fax)}</span></div>` : ''}
            ${u.note ? `<div><span class="k">備註</span><span class="v">${escapeHtml(u.note)}</span></div>` : ''}
            <button class="btn btn-sm" data-copy="${escapeHtml(u.address)}">複製地址</button>
          </div>
          <div class="people-grid">
            ${u.people.map((p) => `<button class="person-chip" data-q="${escapeHtml(p.name)}">
                <span class="pc-name">${escapeHtml(p.name)}</span>
                <span class="pc-sub">${escapeHtml(p.group || p.title || '')}</span>
              </button>`).join('')}
          </div>
        </div>
      </details>`).join('');
  }

  /* ── 相機辨識 ───────────────────────────────────────────── */

  const cam = {
    stream: null,
    track: null,
    facing: 'environment',
    scanning: false,
    busy: false,
    votes: new Map(),
    confirmed: new Map(),
    acceptedCount: 0,
    liveTimer: null,
    locked: false,
    timer: null,
  };

  function setOcrStatus(text, progress) {
    $('#ocrStatus').hidden = false;
    $('#ocrStatusText').textContent = text;
    $('#progressBar').style.width = `${Math.round((progress || 0) * 100)}%`;
  }

  function showLiveScanning() {
    const live = $('#liveMatch');
    live.innerHTML = '<strong>正在掃描</strong><span>請把收件人姓名放入框內</span>';
    live.hidden = false;
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
          width: { ideal: 1920 },
          height: { ideal: 1080 },
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

    cam.locked = false;
    cam.votes.clear();
    cam.confirmed.clear();
    cam.acceptedCount = 0;
    clearTimeout(cam.liveTimer);
    showLiveScanning();
    cam.scanning = true;
    setOcrStatus('載入辨識引擎…', 0);

    try {
      await OCR.init((m) => setOcrStatus(`${m.status}（${m.source}）`, m.progress));
      setOcrStatus('掃描中：請把姓名放進框內', 1);
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
  // Live scanning favours name recognition over a tiny, fast crop. Envelopes
  // vary a lot, so include a generous area around the visible frame.
  const FRAME_PAD = 0.18;

  function frameRect(video) {
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

    const padX = sw * FRAME_PAD;
    const padY = sh * FRAME_PAD;
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
    cam.busy = true;
    try {
      const canvas = OCR.preprocess(video, frameRect(video), manual ? 1600 : 1450);
      const whitelist = $('#whitelistToggle').checked ? matcher.charset : null;
      const { text } = await OCR.recognize(canvas, whitelist);
      $('#ocrText').textContent = text.trim() || '（沒有讀到文字）';
      handleOcrText(text, manual);
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
      if (!cam.locked) await scanOnce(false);
      scanLoop();
    }, 350);
  }

  /**
   * 累計連續幾張影格的辨識結果再決定，避免單張誤判造成畫面跳動。
   */
  function handleOcrText(text, manual) {
    const matches = matcher.find(text, { minScore: 0.55, limit: 6 });
    if (!matches.length) {
      if (manual) toast('框內沒有辨識到名冊中的姓名');
      return;
    }

    for (const m of matches) {
      const key = m.person.name + '|' + m.person.unitId;
      const v = cam.votes.get(key) || { hits: 0, best: 0, match: m };
      v.hits += 1;
      v.best = Math.max(v.best, m.score);
      v.match = m;
      cam.votes.set(key, v);
    }

    // 用累計票數排序而不是單張結果，畫面才不會每掃一次就跳一次
    const ranked = [...cam.votes.values()]
      .sort((a, b) => (b.best * 1.5 + b.hits) - (a.best * 1.5 + a.hits));
    const top = ranked[0];
    const confident = manual || top.best >= 0.985 || (top.best >= 0.88 && top.hits >= 2);

    // 同名同姓（例如調動中的人）要一起列出，不能只挑一個
    if (manual) renderResults($('#cameraResults'), ranked.slice(0, 6).map((v) => v.match), '');
    else $('#cameraResults').innerHTML = '';

    if (confident && !cam.locked) {
      const key = top.match.person.name + '|' + top.match.person.unitId;
      const now = Date.now();
      const lastSeen = cam.confirmed.get(key) || 0;
      if (now - lastSeen < 8000) return;

      cam.confirmed.set(key, now);
      for (const [oldKey, time] of cam.confirmed) {
        if (now - time > 30000) cam.confirmed.delete(oldKey);
      }
      cam.acceptedCount += 1;
      cam.votes.clear();
      const live = $('#liveMatch');
      live.innerHTML = `<strong>${escapeHtml(top.match.person.name)}</strong><span>${escapeHtml(top.match.person.unit)} · 已掃描 ${cam.acceptedCount} 筆</span>`;
      live.hidden = false;
      clearTimeout(cam.liveTimer);
      cam.liveTimer = setTimeout(() => {
        if (cam.scanning) showLiveScanning();
      }, 2200);
      setOcrStatus(`已找到 ${top.match.person.name}，繼續自動掃描中`, 1);
      pushRecent(top.match.person.name);
      if (navigator.vibrate) navigator.vibrate([40, 35, 40]);
      return;

      cam.locked = true;
      cam.scanning = false;
      clearTimeout(cam.timer);
      setOcrStatus(`已鎖定：${top.match.person.name}（點「立即辨識」可重新掃描）`, 1);
      pushRecent(top.match.person.name);
      if (navigator.vibrate) navigator.vibrate(60);
      $('#cameraResults').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  /** 使用者按「立即辨識」：解除鎖定並立刻拍一張高解析度的來辨識。 */
  async function manualShot() {
    cam.votes.clear();
    cam.locked = false;
    setOcrStatus('辨識中…', 0.4);
    await scanOnce(true);
    if (!cam.locked) {
      setOcrStatus('掃描中：請把姓名放進框內', 1);
      cam.scanning = true;
      scanLoop();
    }
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
        const canvas = OCR.preprocess(img, { sx: 0, sy: 0, sw: img.width, sh: img.height }, 1600);
        const whitelist = $('#whitelistToggle').checked ? matcher.charset : null;
        const { text } = await OCR.recognize(canvas, whitelist);
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

    // 複製按鈕與「點名字轉去查詢」共用一個事件代理
    document.addEventListener('click', (e) => {
      const copyBtn = e.target.closest('[data-copy]');
      if (copyBtn) { copyText(copyBtn.dataset.copy); return; }
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
