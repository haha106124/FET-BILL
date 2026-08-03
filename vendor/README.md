# vendor/ — 內建的離線 OCR 引擎

這些檔案是從 npm 取得後直接放進 repo，讓「拍照辨識」不必依賴外部 CDN
（公司網路常會擋 CDN），第一次載入後也能離線使用。

| 目錄 | 來源套件 | 版本 | 授權 |
| --- | --- | --- | --- |
| `tesseract/` | [`tesseract.js`](https://www.npmjs.com/package/tesseract.js) (`dist/`) | 5.1.1 | Apache-2.0 |
| `tesseract-core/` | [`tesseract.js-core`](https://www.npmjs.com/package/tesseract.js-core) （LSTM 版，含 SIMD / 非 SIMD） | 5.1.1 | Apache-2.0 |
| `tessdata/` | [`@tesseract.js-data/chi_tra`](https://www.npmjs.com/package/@tesseract.js-data/chi_tra) （`4.0.0_best_int`，繁體中文模型） | 1.0.0 | Apache-2.0 |

## 更新方式

```bash
npm pack tesseract.js@5 tesseract.js-core@5 @tesseract.js-data/chi_tra
# 解開後對應複製：
#   package/dist/{tesseract.min.js,worker.min.js}      -> vendor/tesseract/
#   package/tesseract-core-{simd-,}lstm.wasm.js        -> vendor/tesseract-core/
#   package/4.0.0_best_int/chi_tra.traineddata.gz      -> vendor/tessdata/
```

若把 `vendor/` 整個刪掉，網站會自動改用 jsDelivr CDN（見 `assets/ocr.js` 的 `OCR_SOURCES`）。
