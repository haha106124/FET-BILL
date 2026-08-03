/* 相機文字辨識（Tesseract.js，繁體中文模型）。
 *
 * 引擎檔案預設走 repo 內的 vendor/（不依賴 CDN、也能離線用）；
 * 若 vendor/ 被刪掉或載入失敗，會自動改用 jsDelivr。
 */
(function (global) {
  'use strict';

  const OCR_SOURCES = [
    {
      name: '本機',
      workerPath: 'vendor/tesseract/worker.min.js',
      corePath: 'vendor/tesseract-core/',
      langPath: 'vendor/tessdata',
    },
    {
      name: 'CDN',
      workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
      corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1',
      langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_tra/4.0.0_best_int',
    },
  ];

  const LANG = 'chi_tra';
  const OEM_LSTM_ONLY = 1;
  const PSM_SINGLE_BLOCK = '6';

  let worker = null;
  let initPromise = null;
  let appliedWhitelist = null;

  /* ── 影像前處理 ───────────────────────────────────────────────
   * 手機拍出來的照片光線不均，直接丟進 OCR 命中率很差。
   * 這裡做：灰階 → Bradley 自適應二值化（用積分影像算區域平均），
   * 比全域門檻更能對付陰影與反光。
   */
  function preprocess(source, rect, targetWidth = 1000) {
    const { sx, sy, sw, sh } = rect;
    const scale = Math.min(3, Math.max(1, targetWidth / sw));
    const w = Math.round(sw * scale);
    const h = Math.round(sh * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);

    const img = ctx.getImageData(0, 0, w, h);
    const px = img.data;

    // 灰階
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      gray[j] = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
    }

    // 積分影像
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += gray[y * w + x];
        integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum;
      }
    }

    const radius = Math.max(8, Math.round(w / 24));
    const t = 0.15;
    let dark = 0;
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(h - 1, y + radius);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - radius);
        const x1 = Math.min(w - 1, x + radius);
        const count = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum = integral[(y1 + 1) * (w + 1) + (x1 + 1)]
                  - integral[y0 * (w + 1) + (x1 + 1)]
                  - integral[(y1 + 1) * (w + 1) + x0]
                  + integral[y0 * (w + 1) + x0];
        const value = gray[y * w + x] * count < sum * (1 - t) ? 0 : 255;
        if (value === 0) dark++;
        const o = (y * w + x) * 4;
        px[o] = px[o + 1] = px[o + 2] = value;
        px[o + 3] = 255;
      }
    }

    // 深色底、淺色字的話反轉，Tesseract 偏好白底黑字
    if (dark > w * h * 0.55) {
      for (let i = 0; i < px.length; i += 4) {
        px[i] = px[i + 1] = px[i + 2] = 255 - px[i];
      }
    }

    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /* ── 引擎 ─────────────────────────────────────────────────── */

  async function createWithSource(src, onProgress) {
    return Tesseract.createWorker(LANG, OEM_LSTM_ONLY, {
      workerPath: src.workerPath,
      corePath: src.corePath,
      langPath: src.langPath,
      workerBlobURL: false,
      logger: (m) => {
        if (!onProgress) return;
        const pct = typeof m.progress === 'number' ? m.progress : 0;
        onProgress({ status: m.status, progress: pct, source: src.name });
      },
    });
  }

  async function init(onProgress) {
    if (worker) return worker;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      if (typeof Tesseract === 'undefined') {
        throw new Error('找不到 OCR 引擎（vendor/tesseract/tesseract.min.js 未載入）');
      }
      let lastErr;
      for (const src of OCR_SOURCES) {
        try {
          onProgress && onProgress({ status: `載入辨識引擎（${src.name}）`, progress: 0, source: src.name });
          const w = await createWithSource(src, onProgress);
          await w.setParameters({ tessedit_pageseg_mode: PSM_SINGLE_BLOCK });
          worker = w;
          worker.__source = src.name;
          return worker;
        } catch (err) {
          lastErr = err;
          console.warn(`[OCR] ${src.name} 載入失敗，改試下一個來源`, err);
        }
      }
      initPromise = null;
      throw new Error(`辨識引擎載入失敗：${lastErr && lastErr.message ? lastErr.message : lastErr}`);
    })();

    return initPromise;
  }

  /**
   * 辨識一張畫布。
   * @param {HTMLCanvasElement} canvas 已前處理的影像
   * @param {string|null} whitelist 只允許出現的字元（名冊字集），null 表示不限制
   */
  async function recognize(canvas, whitelist) {
    const w = await init();
    const wl = whitelist || '';
    if (wl !== appliedWhitelist) {
      await w.setParameters({ tessedit_char_whitelist: wl });
      appliedWhitelist = wl;
    }
    const { data } = await w.recognize(canvas);
    return { text: data.text || '', confidence: data.confidence || 0 };
  }

  async function terminate() {
    if (worker) {
      try { await worker.terminate(); } catch (_) { /* 忽略 */ }
    }
    worker = null;
    initPromise = null;
    appliedWhitelist = null;
  }

  global.OCR = { init, recognize, preprocess, terminate, get source() { return worker && worker.__source; } };
})(window);
