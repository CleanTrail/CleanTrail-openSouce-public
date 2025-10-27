/**
 * popup.js
 * Plain JavaScript popup controller for CleanTrail (public build).
 *
 * Features:
 * - Protection summary (pending & cleared cookies, cache, trackers)
 * - Privacy score display (requests from background)
 * - Toggle tracker blocking
 * - Manual cleanup (sends manualClear to background)
 * - Top 5 blocked trackers list (from chrome.storage.local.blockedTrackers)
 * - Fingerprinting alerts (from storage key 'fingerprintingAlerts' or runtime messages)
 * - React analytics component is separate (React code appended below)
 *
 * Expected DOM IDs (see popup.html snippet below):
 * - #privacyScore, #protectionSummary, #topTrackersList, #fingerprintAlerts
 * - #toggleBlockingBtn, #manualClearBtn, #openSettingsBtn
 *
 * Keep this file non-React to keep popup lightweight and fast.
 */

(() => {
  'use strict';

  // ---------- Small helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (res) => resolve(res || {}));
      } catch (e) { resolve({}); }
    });
  }
  function storageSet(obj) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set(obj, () => resolve()); } catch (e) { resolve(); }
    });
  }

  function formatTimeSaved(ms) {
    const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  // ---------- UI rendering helpers ----------
  function setText(selector, text) {
    const el = $(selector);
    if (el) el.textContent = text;
  }

  function clearElement(el) {
    while (el && el.firstChild) el.removeChild(el.firstChild);
  }

  // ---------- Protection Summary ----------
  async function renderProtectionSummary() {
    const keys = ['pendingCookies','totalCookiesDeleted','pendingCache','totalCacheCleared','pendingTrackers','blockedTrackers'];
    const st = await storageGet(keys);
    const pendingCookies = Number(st.pendingCookies || 0);
    const totalCookiesDeleted = Number(st.totalCookiesDeleted || 0);
    const pendingCache = Number(st.pendingCache || 0);
    const totalCacheCleared = Number(st.totalCacheCleared || 0);
    const pendingTrackers = st.pendingTrackers || {};
    const blockedTrackers = st.blockedTrackers || {};

    const pendingTrackersCount = Object.keys(pendingTrackers || {}).length;
    const blockedTrackersCount = Object.keys(blockedTrackers || {}).length;

    // summary area
    const summaryRoot = $('#protectionSummary');
    if (!summaryRoot) return;

    // create summary layout (simple)
    clearElement(summaryRoot);

    const rows = [
      { label: 'Pending cookies', value: pendingCookies.toLocaleString() },
      { label: 'Cookies cleared (total)', value: totalCookiesDeleted.toLocaleString() },
      { label: 'Pending cache (MB)', value: pendingCache },
      { label: 'Cache cleared (MB)', value: totalCacheCleared },
      { label: 'Pending trackers', value: pendingTrackersCount.toLocaleString() },
      { label: 'Top blocked trackers', value: blockedTrackersCount.toLocaleString() },
    ];

    rows.forEach(r => {
      const row = document.createElement('div');
      row.className = 'ct-row';
      const lab = document.createElement('div');
      lab.className = 'ct-row-label';
      lab.textContent = r.label;
      const val = document.createElement('div');
      val.className = 'ct-row-value';
      val.textContent = String(r.value);
      row.appendChild(lab);
      row.appendChild(val);
      summaryRoot.appendChild(row);
    });
  }

  // ---------- Privacy score (badge-like) ----------
  async function renderPrivacyScore() {
    try {
      chrome.runtime.sendMessage({ type: 'getPrivacyScore' }, (resp) => {
        if (chrome.runtime.lastError) {
          // background not available? fallback to storage
          storageGet(['siteStats']).then((s) => {
            // compute a cheap score from siteStats if present
            const agg = computeAggregateStats(s.siteStats || {});
            const score = gradeFromStats(agg);
            setText('#privacyScore', `${letterFromScore(score)} (${Math.round(score)})`);
          });
          return;
        }
        if (resp && resp.letter) {
          setText('#privacyScore', `${resp.letter} (${resp.rawScore})`);
        }
      });
    } catch (e) {
      // fall back
      setText('#privacyScore', '—');
    }
  }

  // These helper functions mirror the ones in the background (small copies)
  const DEFAULT_HALF_LIFE_MS = 24*60*60*1000;
  function computeAggregateStats(siteStats = {}, now = Date.now(), halfLifeMs = DEFAULT_HALF_LIFE_MS){
    let cookies=0, cache=0, trackers=0, fingerprints=0;
    for(const s of Object.values(siteStats||{})){
      const lastSeen = Number(s.lastSeen||s.lastSeenTime||0);
      if(!lastSeen) continue;
      const age = Math.max(0, now - lastSeen);
      const weight = Math.exp(-age / halfLifeMs);
      cookies += (s.cookies||0) * weight;
      cache   += (s.cache||0) * weight;
      trackers+= (s.trackers||0) * weight;
      fingerprints += (s.fingerprints||0) * weight;
    }
    return { cookies, cache, trackers, fingerprints };
  }
  function gradeFromStats({ cookies=0, cache=0, trackers=0, fingerprints=0 }){
    let score = 100;
    score -= cookies * 0.05;
    score -= cache * 0.01;
    score -= trackers * 0.02;
    score -= fingerprints * 0.5;
    return Math.max(0, score);
  }
  function letterFromScore(score){
    if(score > 90) return "A+";
    if(score > 80) return "A";
    if(score > 70) return "B";
    if(score > 60) return "C";
    return "D";
  }

  // ---------- Top 5 Blocked Trackers ----------
  async function renderTopTrackers() {
    const root = $('#topTrackersList');
    if (!root) return;
    clearElement(root);
    const st = await storageGet(['blockedTrackers']);
    const blocked = st.blockedTrackers || {};
    const arr = Object.entries(blocked).map(([domain, info]) => ({
      domain,
      count: Number(info.count || 0),
      timeSavedMs: Number(info.totalTimeSavedMs || 0),
      category: info.category || 'tracking'
    }));
    arr.sort((a,b) => b.count - a.count);
    const top = arr.slice(0,5);
    if (top.length === 0) {
      const p = document.createElement('div'); p.className='ct-empty'; p.textContent='No blocked trackers yet.';
      root.appendChild(p); return;
    }
    top.forEach((t, idx) => {
      const item = document.createElement('div'); item.className='ct-tracker';
      item.innerHTML = `
        <div class="ct-tracker-left">
          <div class="ct-tracker-rank">${idx+1}</div>
          <div class="ct-tracker-meta">
            <div class="ct-tracker-name">${escapeHtml(t.domain)}</div>
            <div class="ct-tracker-domain">${escapeHtml(t.domain)}</div>
          </div>
        </div>
        <div class="ct-tracker-right">
          <div class="ct-tracker-count">${t.count.toLocaleString()}</div>
          <div class="ct-tracker-time">${formatTimeSaved(t.timeSavedMs)}</div>
        </div>
      `;
      root.appendChild(item);
    });
  }

  // ---------- Fingerprinting alerts ----------
  async function renderFingerprintingAlerts() {
    const root = $('#fingerprintAlerts');
    if (!root) return;
    clearElement(root);
    const st = await storageGet(['fingerprintingAlerts']);
    const alerts = (st.fingerprintingAlerts || []).slice().reverse(); // newest first
    if (!alerts || alerts.length === 0) {
      const p = document.createElement('div'); p.className='ct-empty'; p.textContent='No fingerprinting alerts';
      root.appendChild(p); return;
    }
    alerts.slice(0,10).forEach(a => {
      const item = document.createElement('div'); item.className='ct-fp-alert';
      const t = new Date(a.t||Date.now()).toLocaleString();
      item.innerHTML = `<div class="ct-fp-line"><strong>${escapeHtml(a.hostname||a.url||'unknown')}</strong></div><div class="ct-fp-sub">${escapeHtml(a.note||'fingerprinting detected')} · ${t}</div>`;
      root.appendChild(item);
    });
  }

  // ---------- Utilities ----------
  function escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ---------- Buttons / Actions ----------
  async function toggleBlocking() {
    // invert current value
    const s = await storageGet(['trackerBlockingEnabled']);
    const enabled = !s.trackerBlockingEnabled;
    // inform background to update rules
    chrome.runtime.sendMessage({ type: 'setTrackerBlocking', enabled }, (resp) => {
      // update UI after a short delay
      setTimeout(() => renderAll(), 300);
    });
  }

  async function doManualClear(btn) {
    try {
      btn.disabled = true;
      btn.classList && btn.classList.add('working');
      chrome.runtime.sendMessage({ type: 'manualClear' }, (resp) => {
        // result will be persisted by background; refresh UI
        setTimeout(() => { renderAll(); btn.disabled = false; btn.classList && btn.classList.remove('working'); }, 800);
      });
    } catch (e) {
      console.warn('manualClear failed', e);
      btn.disabled = false;
    }
  }

  function openSettingsPage() {
    // assume you have an options page registered in manifest
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else window.open(chrome.runtime.getURL('options.html'));
  }

  // ---------- Reactivity: listen for storage changes & runtime messages ----------
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const relevant = ['pendingCookies','totalCookiesDeleted','pendingCache','pendingTrackers','blockedTrackers','fingerprintingAlerts','trackerBlockingEnabled','siteStats'];
    for (const k of Object.keys(changes)) {
      if (relevant.includes(k)) {
        // refresh UI
        renderAll();
        break;
      }
    }
  });

  // runtime messages (for fingerprintingDetected events etc.)
  chrome.runtime.onMessage.addListener((msg, sender) => {
    try {
      if (!msg || !msg.type) return;
      if (msg.type === 'fingerprintingDetected') {
        // push to storage array
        (async ()=>{
          const st = await storageGet(['fingerprintingAlerts']);
          const alerts = st.fingerprintingAlerts || [];
          alerts.push({ t: Date.now(), hostname: msg.hostname || msg.url || '', note: msg.note || 'fingerprinting detected' });
          // keep last 200
          const keep = alerts.slice(-200);
          await storageSet({ fingerprintingAlerts: keep });
          renderFingerprintingAlerts();
        })();
      }
    } catch (e) { console.warn('onMessage popup err', e); }
  });

  // ---------- Main render ----------
  async function renderAll() {
    await renderProtectionSummary();
    await renderTopTrackers();
    await renderFingerprintingAlerts();
    await renderPrivacyScore();
    // toggle button state
    const s = await storageGet(['trackerBlockingEnabled']);
    const toggleBtn = $('#toggleBlockingBtn');
    if (toggleBtn) {
      const enabled = !!s.trackerBlockingEnabled;
      toggleBtn.textContent = enabled ? 'Disable blocking' : 'Enable blocking';
      toggleBtn.dataset.enabled = enabled ? '1' : '0';
    }
  }

  // ---------- Wire up UI ----------
  function setupUI() {
    const toggleBtn = $('#toggleBlockingBtn');
    const manualBtn = $('#manualClearBtn');
    const settingsBtn = $('#openSettingsBtn');

    if (toggleBtn) toggleBtn.addEventListener('click', () => toggleBlocking());
    if (manualBtn) manualBtn.addEventListener('click', (e) => {
      e.currentTarget && doManualClear(e.currentTarget);
    });
    if (settingsBtn) settingsBtn.addEventListener('click', openSettingsPage);
  }

  // --- Pro block handling (simple, non-React) ---
const PRO_FEATURES = [
  "Session hijacking & malicious script detection",
  "Dark Pattern Detection",
  "Scheduled cleanup automation",
  "Persistent cookie alerts",
  "Phishing protection",
  "Ultimate Stealth Mode (advanced fingerprint spoofing)",
  "Encrypted cloud sync across devices"
];

// set your real store / website link here
const UPGRADE_URL = "https://chromewebstore.google.com/detail/cleantrail/jndmenkfpnihhjlnobgpifocfkleoeon";

function renderProBlock() {
  const list = document.getElementById('proFeatureList');
  if(!list) return;
  list.innerHTML = '';
  PRO_FEATURES.forEach(f => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="ct-lock">🔒</span><span>${escapeHtml(f)}</span>`;
    list.appendChild(li);
  });
}

function wireProButtons() {
  const btn = document.getElementById('upgradeBtn');
  if(!btn) return;
  btn.addEventListener('click', () => {
    // open store / website in a new tab
    try {
      chrome.tabs.create({ url: UPGRADE_URL });
    } catch (e) {
      // fallback
      window.open(UPGRADE_URL, '_blank');
    }
  });
}

// call on DOMContentLoaded (or within your setupUI)
document.addEventListener('DOMContentLoaded', () => {
  renderProBlock();
  wireProButtons();
});


  // ---------- Init ----------
  document.addEventListener('DOMContentLoaded', () => {
    setupUI();
    renderAll().catch((e)=>console.warn(e));
  });

})();
