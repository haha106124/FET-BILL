/* 載入名冊。
 *
 * 網站放在公開的 GitHub Pages 上，所以名冊是加密的（見 tools/encrypt_data.py）：
 * 要用正確的帳號＋密碼推出金鑰才解得開。解密完再把單位地址接到每個人身上。
 */
(function (global) {
  'use strict';

  const ENC_URL = 'data/directory.enc.json';
  const KEY_STORE = 'fet-bill.key';          // 勾「記住這台裝置」時存解出來的金鑰

  const b64ToBytes = (s) =>
    Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const bytesToB64 = (bytes) =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)));

  async function fetchEnvelope() {
    const res = await fetch(ENC_URL, { cache: 'no-cache' });
    if (res.status === 404) {
      const err = new Error('尚未設定加密電話表');
      err.code = 'DIRECTORY_NOT_CONFIGURED';
      throw err;
    }
    if (!res.ok) throw new Error(`無法載入電話表（HTTP ${res.status}）`);
    return res.json();
  }

  /** 由帳號＋密碼推出 AES 金鑰，參數要跟 tools/encrypt_data.py 一致。 */
  async function deriveKey(envelope, account, password) {
    const material = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(`${account}:${password}`),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: b64ToBytes(envelope.salt),
        iterations: envelope.iterations,
        hash: 'SHA-256',
      },
      material,
      { name: 'AES-GCM', length: 256 },
      true,                                   // 可匯出，才能存起來記住這台裝置
      ['decrypt']
    );
  }

  async function decrypt(envelope, key) {
    let plain;
    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64ToBytes(envelope.iv) },
        key,
        b64ToBytes(envelope.data)
      );
    } catch (_) {
      // GCM 驗證失敗＝帳密不對（或檔案被改過）
      const err = new Error('帳號或密碼不正確');
      err.code = 'BAD_CREDENTIALS';
      throw err;
    }
    return JSON.parse(new TextDecoder().decode(plain));
  }

  /** 把單位的地址／電話接到每個人身上，並統計各單位人數。 */
  function build(raw) {
    const units = new Map(raw.units.map((u) => [u.id, u]));
    const people = raw.people.map((p) => {
      const u = units.get(p.unitId) || {};
      return {
        ...p,
        address: u.address || '',
        unitTel: u.tel || '',
        unitFax: u.fax || '',
        unitNote: u.note || '',
      };
    });
    for (const u of raw.units) {
      u.people = people.filter((p) => p.unitId === u.id);
    }
    return { source: raw.source, units: raw.units, people };
  }

  /* ── 記住這台裝置 ─────────────────────────────────────────
   * 存的是解出來的金鑰，不是帳號密碼；按「鎖定」就會清掉。
   */
  async function rememberKey(key) {
    try {
      const raw = await crypto.subtle.exportKey('raw', key);
      localStorage.setItem(KEY_STORE, bytesToB64(raw));
    } catch (_) { /* 私密瀏覽模式會失敗，忽略即可 */ }
  }

  async function storedKey() {
    let saved;
    try { saved = localStorage.getItem(KEY_STORE); } catch (_) { return null; }
    if (!saved) return null;
    try {
      return await crypto.subtle.importKey(
        'raw', b64ToBytes(saved), { name: 'AES-GCM' }, true, ['decrypt']);
    } catch (_) {
      forgetKey();
      return null;
    }
  }

  function forgetKey() {
    try { localStorage.removeItem(KEY_STORE); } catch (_) { /* ignore */ }
  }

  async function unlock(envelope, account, password, remember) {
    const key = await deriveKey(envelope, account, password);
    const raw = await decrypt(envelope, key);      // 帳密錯的話這裡就會擋下來
    if (remember) await rememberKey(key);
    else forgetKey();
    return build(raw);
  }

  /** 之前勾過「記住這台裝置」的話，直接用存起來的金鑰解開。 */
  async function unlockWithStoredKey(envelope) {
    const key = await storedKey();
    if (!key) return null;
    try {
      return build(await decrypt(envelope, key));
    } catch (_) {
      forgetKey();                                 // 金鑰過期或名冊換密碼了
      return null;
    }
  }

  global.Directory = { fetchEnvelope, unlock, unlockWithStoredKey, forgetKey };
})(window);
