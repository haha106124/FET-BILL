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
  // 實際帳單版面：郵遞區號＋地址＋公司名稱＋姓名是連在一起的 2-3 行文字，
  // 姓名常常直接黏在地址或公司名稱那一行的尾端、沒有獨立成行。所以主要辨識
  // 用「整段文字」把這 2-3 行一次讀出來，再交給模糊比對從整段文字裡找姓名；
  // 沒讀到才重試「單欄變動字級」模式（郵遞區號常比地址行的字級/字體不同）。
  const PSM_BLOCK = '6';
  const PSM_COLUMN = '4';

  let worker = null;
  let initPromise = null;
  let appliedPsm = null;

  /* ── 影像前處理 ───────────────────────────────────────────────
   * 手機拍出來的照片光線不均，直接丟進 OCR 命中率很差，需要前處理。
   *
   * 這裡刻意「不」做非黑即白的二值化。Tesseract 4/5 的 LSTM 辨識引擎是拿
   * 灰階／有邊緣灰階漸層的影像訓練的，实測把影像先二值化反而常常降低準確率
   * （硬二值化會把筆劃邊緣的灰階細節整個抹掉，繁體中文筆劃多、細節密，傷害
   * 更明顯）。所以改用「區域對比正規化」：用積分影像算出每個像素附近的區域
   * 平均亮度當作背景基準，再把每個像素相對背景的差異放大——效果是陰影、反
   * 光造成的亮度不均會被拉平，但字本身的灰階漸層與筆劃邊緣都保留下來，讓
   * OCR 引擎自己去判斷，而不是我們先幫它（可能幫倒忙地）決定黑白。
   */
  function preprocess(source, rect, targetWidth = 1000) {
    const { sx, sy, sw, sh } = rect;
    // 裁切框越小，越需要放大才有足夠的筆劃解析度；上限拉高到 4 倍，
    // 讓「掃描框對到的小範圍名字」也能有夠高的有效解析度。
    const scale = Math.min(4, Math.max(1, targetWidth / sw));
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
    const gray = new Float64Array(w * h);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      gray[j] = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
    }

    // 積分影像，用來快速算任意矩形範圍內的平均亮度（區域背景估計）
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += gray[y * w + x];
        integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum;
      }
    }

    const radius = Math.max(10, Math.round(w / 16));
    const GAIN = 1.7;       // 對比放大倍率
    // 遠傳帳單開窗裡的地址欄底下印著淺灰色的防偽底紋，光是拉對比會連底紋
    // 一起放大、干擾辨識。KNEE 之後的值代表「原本就偏淺灰」，用更陡的曲線
    // 把它們推向純白；KNEE 之前是「真的比較深」的筆畫，維持原本的灰階漸層。
    const KNEE = 150;
    const KNEE_GAIN = 2.4;
    let darkSum = 0;
    const out = new Float64Array(w * h);
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
        const localMean = sum / count;
        let v = 128 + (gray[y * w + x] - localMean) * GAIN;
        if (v > KNEE) v = KNEE + (v - KNEE) * KNEE_GAIN;
        v = Math.max(0, Math.min(255, v));
        out[y * w + x] = v;
        darkSum += v;
      }
    }

    // 深色底、淺色字的話整體反轉，Tesseract 偏好白底黑字
    const invert = (darkSum / (w * h)) < 118;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = out[y * w + x];
        if (invert) v = 255 - v;
        const o = (y * w + x) * 4;
        px[o] = px[o + 1] = px[o + 2] = v;
        px[o + 3] = 255;
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
          await w.setParameters({ tessedit_pageseg_mode: PSM_BLOCK });
          appliedPsm = PSM_BLOCK;
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
   * @param {'block'|'column'} [mode='block'] 'block' = 整段文字（帳單地址欄的
   *   郵遞區號＋地址＋公司＋姓名本來就是連在一起的 2-3 行，這是主要模式）；
   *   'column' = 單欄變動字級（郵遞區號常比地址行字級不同時的備援重試）
   *
   * 註：曾經用 tessedit_char_whitelist 把辨識結果限制在名冊字集內，但
   * Tesseract 的 LSTM 引擎（本專案用的 OEM_LSTM_ONLY）不支援字元白名單
   * ——這是官方已確認的已知限制，設定了也不會生效——所以拿掉這個參數，
   * 改把力氣放在真的有效的地方：影像前處理、解析度、PSM、模糊比對。
   */
  async function recognize(canvas, mode) {
    const w = await init();
    const psm = mode === 'column' ? PSM_COLUMN : PSM_BLOCK;
    if (psm !== appliedPsm) {
      await w.setParameters({ tessedit_pageseg_mode: psm });
      appliedPsm = psm;
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
    appliedPsm = null;
  }

  global.OCR = { init, recognize, preprocess, terminate, get source() { return worker && worker.__source; } };
})(window);
