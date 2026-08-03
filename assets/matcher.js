/* 姓名比對 —— 搜尋框與相機辨識共用。
 *
 * 相機 OCR 一定會有錯字，但名冊是「封閉集合」（只有幾百個名字），
 * 所以不需要 OCR 全對：只要把辨識結果切成 2～4 字的視窗，
 * 拿去跟名冊做容錯比對，錯一個字仍然找得到人。
 */
(function (global) {
  'use strict';

  const CJK_RE = /[㐀-䶿一-鿿]/;
  const NON_CJK_RE = /[^㐀-䶿一-鿿]+/g;

  /** 全形轉半形、去掉所有空白，方便比對。 */
  function normalize(s) {
    return (s || '').normalize('NFKC').replace(/[\s　]+/g, '');
  }

  /** 只留下中文字（信封上的「先生」「敬啟」「收」會被視窗切法自然略過）。 */
  function cjkOnly(s) {
    return normalize(s).replace(NON_CJK_RE, '');
  }

  /** 編輯距離，上限 max，超過就提早結束。 */
  function editDistance(a, b, max) {
    const n = a.length, m = b.length;
    if (Math.abs(n - m) > max) return max + 1;
    let prev = new Array(m + 1);
    let cur = new Array(m + 1);
    for (let j = 0; j <= m; j++) prev[j] = j;
    for (let i = 1; i <= n; i++) {
      cur[0] = i;
      let best = cur[0];
      for (let j = 1; j <= m; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;
      const t = prev; prev = cur; cur = t;
    }
    return prev[m];
  }

  /**
   * 一個候選視窗跟一個姓名的相似度，0 表示不像。
   * 姓氏（第一個字）對得上會加分——OCR 錯在名字比錯在姓氏常見。
   */
  function similarity(win, name) {
    if (win === name) return 1;
    const len = Math.max(win.length, name.length);
    const d = editDistance(win, name, 2);
    if (d === 1) {
      if (name.length >= 3) return win[0] === name[0] ? 0.86 : 0.78;
      return 0.55;                       // 兩個字的名字錯一個字，風險較高
    }
    if (d === 2 && len >= 4) return 0.6;
    // 兩個字的視窗剛好是三字姓名的開頭（OCR 只吃到一半）
    if (win.length === 2 && name.length === 3 && name.startsWith(win)) return 0.62;
    return 0;
  }

  class NameMatcher {
    constructor(people) {
      this.people = people;
      // 字元索引：由視窗裡的每個字反查可能的人，避免每次都全表掃描
      this.charIndex = new Map();
      people.forEach((p, i) => {
        for (const ch of new Set(p.name)) {
          let bucket = this.charIndex.get(ch);
          if (!bucket) this.charIndex.set(ch, bucket = []);
          bucket.push(i);
        }
      });
      this.nameChars = new Set(people.flatMap((p) => [...p.name]));
      this.charset = [...this.nameChars].join('');   // 給 OCR 當白名單用
    }

    /**
     * 從一段（可能有錯字的）文字裡找出名冊中的人。
     * @returns {Array<{person, score, matched}>} 依分數排序
     */
    find(text, opts) {
      const { minScore = 0.5, limit = 8 } = opts || {};
      const lines = String(text || '').split(/[\n\r]+/);
      const best = new Map();                       // people 索引 -> {score, matched}

      for (const line of lines) {
        const compact = cjkOnly(line);
        if (compact.length < 2) continue;
        for (let len = 2; len <= 4; len++) {
          for (let i = 0; i + len <= compact.length; i++) {
            const win = compact.slice(i, i + len);
            this._scoreWindow(win, best, minScore);
          }
        }
      }

      return [...best.entries()]
        .map(([i, v]) => ({ person: this.people[i], score: v.score, matched: v.matched }))
        .sort((a, b) => b.score - a.score || a.person.name.localeCompare(b.person.name))
        .slice(0, limit);
    }

    _scoreWindow(win, best, minScore) {
      // 先用字元索引挑出「至少共用一個字」的人，再算編輯距離
      const seen = new Set();
      for (const ch of win) {
        const bucket = this.charIndex.get(ch);
        if (bucket) for (const i of bucket) seen.add(i);
      }
      for (const i of seen) {
        const p = this.people[i];
        const s = similarity(win, p.name);
        if (s < minScore) continue;
        const cur = best.get(i);
        if (!cur || s > cur.score) best.set(i, { score: s, matched: win });
      }
    }

    /**
     * 搜尋框用：先做「包含」比對（姓名／簡碼／分機／手機／單位／組別／職稱），
     * 沒結果時再退回容錯比對，打錯字也找得到。
     */
    search(query, limit = 200) {
      const q = normalize(query);
      if (!q) return [];

      const scored = [];
      for (const p of this.people) {
        let s = 0;
        if (p.name === q) s = 100;
        else if (p.name.startsWith(q)) s = 90;
        else if (p.name.includes(q)) s = 80;
        else if (p.code === q || p.ext === q) s = 75;
        else if (normalize(p.mobile).replace(/-/g, '').includes(q.replace(/-/g, '')) && q.length >= 3) s = 70;
        else if (p.code.includes(q) || p.ext.includes(q)) s = 55;
        else {
          const hay = normalize(p.unit + p.group + p.title);
          if (hay.toLowerCase().includes(q.toLowerCase())) s = 50;
        }
        if (s) scored.push({ person: p, score: s / 100, matched: q });
      }

      if (scored.length) {
        // 姓名命中（分數高）時短名字優先；單位／組別命中則維持名冊原本的排序
        scored.sort((a, b) => b.score - a.score
          || (a.score >= 0.7 ? a.person.name.length - b.person.name.length : 0));
        return scored.slice(0, limit);
      }

      // 沒有任何包含比對命中 → 當成打錯字，用容錯比對救回來
      if (CJK_RE.test(q)) return this.find(q, { minScore: 0.5, limit });
      return [];
    }
  }

  global.Matcher = { NameMatcher, normalize, cjkOnly, editDistance, similarity };
})(window);
