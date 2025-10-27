// background-scripts.public.js
// Final sanitized public version — safe to publish.
// Free-tier features only. No network calls or private endpoints.

const CT_DEV_DIAG = false;
let __CT_DIAG = { webRequests: [], contentBatches: [], dnrMatches: [] };

function safeLog(...args){ if(CT_DEV_DIAG) console.log(...args); }
function storageGet(keys){ return new Promise(res => chrome.storage.local.get(keys, r=>res(r||{}))); }
function storageSet(obj){ return new Promise(res => chrome.storage.local.set(obj, ()=>res())); }
function storageRemove(keys){ return new Promise(res => chrome.storage.local.remove(keys, ()=>res())); }

// ----------------- small helpers -----------------
function stripDot(domain){
  if(!domain) return domain;
  return domain.startsWith('.') ? domain.slice(1) : domain;
}
async function nowMs(){ return Date.now(); }

// ----------------- runtime state -----------------
let blockedTrackers = {};
let pendingTrackers = {};
let activeBlockedDomains = new Set();
let trackersPerTab = {};
let tabDomainMap = new Map();
let lastCookieCount = {};
let lastCacheEstimate = {};
let trackerBlockingEnabled = true;

// Profiles defaults
const profiles = {
  strict:  { deleteCookies: true,  clearCache: true, deleteLocalStorage: true, deleteSessionStorage: true, deleteIndexedDB: true },
  balanced:{ deleteCookies: true,  clearCache: true, deleteLocalStorage: false, deleteSessionStorage: false, deleteIndexedDB: false },
  relaxed: { deleteCookies: false, clearCache: false, deleteLocalStorage: false, deleteSessionStorage: false, deleteIndexedDB: false },
  paranoid:{ deleteCookies: true,  clearCache: true, deleteLocalStorage: true, deleteSessionStorage: true, deleteIndexedDB: true }
};

// ----------------- cookie categories bundle -----------------
let cookieCategoryMap = { 'session':'necessary', 'sid':'necessary', 'track':'analytics' };
async function loadCookieCategoriesFromBundle(){
  try {
    const url = chrome.runtime.getURL('bundled-cookie-categories.json');
    const resp = await fetch(url).catch(()=>null);
    if(resp && resp.ok){ cookieCategoryMap = await resp.json(); safeLog('Loaded cookie categories bundle'); }
  } catch(e){ safeLog('cookie categories bundle load failed', e); }
}
function getCookieCategory(name){
  const key = (name||'').toLowerCase();
  for(const id of Object.keys(cookieCategoryMap||{})){
    if(key.includes(id.toLowerCase())) return cookieCategoryMap[id];
  }
  return 'uncategorized';
}

// ----------------- trusted site / whitelist helpers -----------------
async function isTrustedDomain(hostBase){
  try {
    const s = await storageGet(['trustedSites']);
    const trustedSites = s.trustedSites || {};
    return !!trustedSites[hostBase];
  } catch(e){ return false; }
}
async function shouldSkipCookieCleanup(host){
  try {
    const s = await storageGet(['cookieWhitelist']);
    const cookieWhitelist = s.cookieWhitelist || [];
    return cookieWhitelist.some(k => String(k||'').startsWith(host+'|') || String(k||'') === host);
  } catch(e){ return false; }
}
async function shouldSkipCacheCleanup(host){
  try {
    const s = await storageGet(['trustedSites']);
    const trustedSites = s.trustedSites || {};
    return !!trustedSites[host];
  } catch(e){ return false; }
}

// ----------------- community tracker rules loader (bundled) -----------------
async function loadApprovedRules(){
  try {
    const url = chrome.runtime.getURL('bundled-rules.json');
    const resp = await fetch(url).catch(()=>null);
    if(resp && resp.ok){
      const approved = await resp.json();
      const domains = Object.keys(approved || {});
      const addRules = domains.map((domain,i) => ({
        id: 100000 + i,
        priority: 1,
        action: { type: "block" },
        condition: { urlFilter: `||${domain}^`, resourceTypes: ["script","xmlhttprequest","sub_frame","image","stylesheet"] }
      }));
      if(addRules.length){
        try { await chrome.declarativeNetRequest.updateDynamicRules({ addRules }); activeBlockedDomains = new Set(domains); }
        catch(e){ safeLog('updateDynamicRules failed (platform)', e); }
      } else {
        try { await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: Array.from({length:10000},(_,i)=>100000+i), addRules: [] }); } catch(e){}
        activeBlockedDomains = new Set();
      }
      return approved;
    }
  } catch(e){ safeLog('loadApprovedRules err', e); }
  activeBlockedDomains = new Set();
  try { await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: Array.from({length:10000},(_,i)=>100000+i), addRules: [] }); } catch(e){}
  return {};
}

// ----------------- DNR/webRequest bookkeeping -----------------
function ctPushDnr(url, ruleId){ try{ __CT_DIAG.dnrMatches.push({t:Date.now(),url,ruleId}); if(__CT_DIAG.dnrMatches.length>300) __CT_DIAG.dnrMatches.shift(); } catch(e){} }
function schedulePersistBlockedTrackers(){ persistBlockedTrackersNow(); }
function persistBlockedTrackersNow(){
  try {
    const norm = {};
    for(const [d,info] of Object.entries(blockedTrackers||{})){
      norm[d] = { count: Number(info.count||0), firstBlocked: Number(info.firstBlocked||0), lastSeen: Number(info.lastSeen||0), totalTimeSavedMs: Number(info.totalTimeSavedMs||0), category: info.category||null };
    }
    storageSet({ blockedTrackers: norm });
  } catch(e){ safeLog('persistBlockedTrackersNow err', e); }
}

// minimal handler when a DNR/webrequest is considered blocked
function handleDnrMatch(url, ruleId=null, tabId=null, resourceType=null){
  try {
    if(!url) return;
    const hostname = (()=>{ try{ return new URL(url).hostname } catch(e){ return null; } })();
    if(!hostname) return;
    const hostBase = hostname.split('.').slice(-2).join('.');
    blockedTrackers[hostBase] ||= { count:0, firstBlocked:0, lastSeen:0, totalTimeSavedMs:0, category:null };
    const b = blockedTrackers[hostBase];
    if(!b.firstBlocked) b.firstBlocked = Date.now();
    b.count = (b.count||0) + 1;
    b.lastSeen = Date.now();
    b.totalTimeSavedMs = (b.totalTimeSavedMs||0) + 50;
    schedulePersistBlockedTrackers();
    try { updatePrivacyBadge(); } catch(e){}
    try { ctPushDnr(url, ruleId); } catch(e){}
  } catch(e){ safeLog('handleDnrMatch err', e); }
}

function installDnrRecorder(){
  try {
    if(chrome.declarativeNetRequest && chrome.declarativeNetRequest.onRuleMatchedDebug && !self.__ct_dnr_diag_listener_added){
      self.__ct_dnr_diag_listener_added = true;
      chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(info => {
        try {
          const url = info && info.request && info.request.url;
          if(!url) return;
          const host = new URL(url).hostname;
          const hostBase = host.split('.').slice(-2).join('.');
          pendingTrackers[hostBase] ||= { count:0, firstSeen:Date.now(), lastSeen:0, categories: new Set() };
          const p = pendingTrackers[hostBase];
          p.count++; p.lastSeen = Date.now();
          (info && info.categories || ['tracking']).forEach(c => p.categories.add(c));
          persistPending();
          if(activeBlockedDomains && activeBlockedDomains.has(hostBase)){
            blockedTrackers[hostBase] ||= { count:0, firstBlocked:Date.now(), lastSeen:Date.now(), totalTimeSavedMs:0, category:null };
            blockedTrackers[hostBase].count++;
            schedulePersistBlockedTrackers();
          }
          ctPushDnr(url, info.rule && info.rule.id);
          handleDnrMatch(url, info.rule && info.rule.id, info.request && info.request.tabId, null);
        } catch(e){ safeLog('dnr dbg listener err', e); }
      });
      return;
    }
    // fallback webRequest
    if(!self.__ct_dnr_webreq_fallback_installed){
      self.__ct_dnr_webreq_fallback_installed = true;
      chrome.webRequest.onBeforeRequest.addListener(details=>{
        try {
          if(!details || !details.url) return;
          const host = new URL(details.url).hostname;
          const hostBase = host.split('.').slice(-2).join('.');
          if(activeBlockedDomains && activeBlockedDomains.has(hostBase)){
            ctPushDnr(details.url, null);
            handleDnrMatch(details.url, null, details.tabId, details.type || null);
          }
        } catch(e){}
      }, { urls: ["<all_urls>"] }, []);
    }
  } catch(e){ safeLog('installDnrRecorder err', e); }
}
installDnrRecorder();

function persistPending(){
  const copy = {};
  for(const [k,v] of Object.entries(pendingTrackers||{})){
    copy[k] = { count: v.count||0, firstSeen: v.firstSeen||0, lastSeen: v.lastSeen||0, categories: Array.from(v.categories||[]) };
  }
  storageSet({ pendingTrackers: copy });
}

// ----------------- Privacy Badge (A-D) -----------------
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
let badgeDebounceTimer = null;
function updatePrivacyBadge(opts = {}){
  if(badgeDebounceTimer) clearTimeout(badgeDebounceTimer);
  badgeDebounceTimer = setTimeout(async ()=>{
    badgeDebounceTimer = null;
    try {
      const keys = ["siteStats","pendingCookies","totalCookiesDeleted","pendingCache","totalCacheCleared","pendingTrackers","blockedTrackers"];
      const st = (await storageGet(keys)) || {};
      const siteStats = st.siteStats || {};
      const pendingCookies = Number(st.pendingCookies || 0);
      const pendingCache = Number(st.pendingCache || 0);
      const pendingTrackersLocal = st.pendingTrackers || {};
      const blockedTrackersLocal = st.blockedTrackers || {};
      const agg = computeAggregateStats(siteStats, Date.now());
      const score = gradeFromStats(agg);
      const letter = letterFromScore(score);
      const payload = { type: "privacyScoreUpdated", rawScore: Math.round(score), letter, cookies: { pending: pendingCookies }, cache: { pending: pendingCache }, trackers: { pending: Object.keys(pendingTrackersLocal||{}).length, blocked: Object.keys(blockedTrackersLocal||{}).length }, aggregate: agg };
      try {
        const colorMap = { "A+": "#2ecc71","A":"#27ae60","B":"#f1c40f","C":"#e67e22","D":"#e74c3c" };
        await chrome.action.setBadgeText({ text: payload.letter });
        await chrome.action.setBadgeBackgroundColor({ color: colorMap[payload.letter] || "#000000" });
      } catch(e){}
      try { chrome.runtime.sendMessage(payload); } catch(e){}
    } catch(e){ safeLog('updatePrivacyBadge error', e); }
  }, 250);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if(area !== 'local') return;
  const interesting = ["siteStats","pendingCookies","totalCookiesDeleted","pendingCache","totalCacheCleared","pendingTrackers","blockedTrackers"];
  for(const k of Object.keys(changes||{})) if(interesting.includes(k)) { updatePrivacyBadge(); break; }
});

// ----------------- Fingerprinting detection -----------------
async function registerFingerprintingScript(){
  try {
    const id = "ct-fingerprint";
    try { await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(()=>{}); } catch(e){}
    await chrome.scripting.registerContentScripts([{
      id,
      js: ['content-fingerprint.js'],
      matches: ['*://*/*'],
      runAt: 'document_idle',
      allFrames: true
    }]);
    safeLog('Registered fingerprint content script');
  } catch(e){ safeLog('registerFingerprintingScript err', e); }
}

// ----------------- Helpers missing earlier -----------------
async function recordSiteStat(hostname, key, delta){
  try {
    const keys = await storageGet(['siteStats']);
    const siteStats = keys.siteStats || {};
    siteStats[hostname] = siteStats[hostname] || { cookies:0, cache:0, trackers:0, fingerprints:0, lastSeen:0 };
    siteStats[hostname][key] = (siteStats[hostname][key] || 0) + (Number(delta)||0);
    siteStats[hostname].lastSeen = Date.now();
    await storageSet({ siteStats });
    updatePrivacyBadge();
  } catch(e){ safeLog('recordSiteStat err', e); }
}

async function deleteCookie(cookie, pageUrl, tabId){
  try {
    // Build a URL to pass to chrome.cookies.remove
    const domain = stripDot(cookie.domain || '');
    const scheme = cookie.secure ? 'https' : 'http';
    const path = cookie.path || '/';
    const url = `${scheme}://${domain}${path}`;
    await new Promise(res => chrome.cookies.remove({ url, name: cookie.name }, () => res()));
    // Increment cookieCategoryCounts maybe
    const cat = getCookieCategory(cookie.name);
    const store = await storageGet(['cookieCategoryCounts']);
    const counts = store.cookieCategoryCounts || {};
    counts[cat] = (counts[cat] || 0) + 1;
    await storageSet({ cookieCategoryCounts: counts });
    return true;
  } catch(e){ safeLog('deleteCookie err', e); return false; }
}

// ----------------- Manual cleanup & runtime messages -----------------
async function handleManualClear(sendResponse){
  try {
    const beforeEstimate = (navigator.storage && navigator.storage.estimate) ? (await navigator.storage.estimate()).usage || 0 : 0;
    const allCookies = await chrome.cookies.getAll({});
    const beforeCookies = allCookies.length;
    chrome.browsingData.remove({ originTypes: { unprotectedWeb: true } }, { cache: true, cookies: true }, async ()=>{
      const afterEstimate = (navigator.storage && navigator.storage.estimate) ? (await navigator.storage.estimate()).usage || 0 : 0;
      const clearedMB = Math.round(Math.max(0, beforeEstimate - afterEstimate) / 1024 / 1024 * 100)/100;
      const deletedCookies = beforeCookies;
      const st = await storageGet(["totalCookiesDeleted","totalCacheCleared","deletionHistory"]);
      const totalCookiesDeleted = Number(st.totalCookiesDeleted || 0);
      const totalCacheCleared = Number(st.totalCacheCleared || 0);
      const deletionHistory = st.deletionHistory || [];
      const now = new Date().toISOString();
      const entry = { hostname: "Manual cleanup", time: now, cookiesDeleted: deletedCookies, cacheCleared: true, cacheEstimateMB: clearedMB };
      await storageSet({
        lastCleanup: now,
        pendingCookies: 0,
        pendingCache: 0,
        totalCookiesDeleted: totalCookiesDeleted + deletedCookies,
        totalCacheCleared: totalCacheCleared + clearedMB,
        deletionHistory: [entry, ...deletionHistory].slice(0,20)
      });
      updatePrivacyBadge();
      sendResponse && sendResponse({ status: 'Manual cleanup complete' });
    });
  } catch(e){ safeLog('handleManualClear err', e); sendResponse && sendResponse({ ok:false, error: String(e) }); }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async ()=>{
    try {
      if(!msg || !msg.type) return;
      if(msg.type === 'manualClear'){ await handleManualClear(sendResponse); return true; }
      if(msg.type === 'getPrivacyScore'){
        const st = await storageGet(['siteStats','pendingCookies','totalCookiesDeleted','pendingCache','totalCacheCleared','pendingTrackers','blockedTrackers']);
        const agg = computeAggregateStats(st.siteStats || {}, Date.now());
        const payload = { type: 'privacyScoreUpdated', rawScore: Math.round(gradeFromStats(agg)), letter: letterFromScore(gradeFromStats(agg)), agg };
        sendResponse && sendResponse(payload);
        return;
      }
      if(msg.type === 'getTrackerStats'){ sendResponse && sendResponse({ blockedTrackers, pendingTrackers }); return; }
      if(msg.type === 'setTrackerBlocking'){ trackerBlockingEnabled = !!msg.enabled; await storageSet({ trackerBlockingEnabled }); if(trackerBlockingEnabled) loadApprovedRules().catch(()=>{}); else { try { await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: Array.from({length:10000},(_,i)=>100000+i), addRules: [] }); } catch(e){} activeBlockedDomains.clear(); } sendResponse && sendResponse({ ok:true }); return; }
    } catch(e){ safeLog('runtime msg err', e); sendResponse && sendResponse({ ok:false, error: String(e) }); }
  })();
  return true;
});

// ----------------- Adaptive profile logic -----------------
async function getActiveProfile(){ const s = await storageGet(['activeProfile']); return s.activeProfile || 'balanced'; }
async function setActiveProfile(profileKey, source='manual'){ if(!profiles[profileKey]) profileKey='balanced'; await storageSet({ activeProfile: profileKey, profileSource: source }); chrome.runtime.sendMessage({ type: 'profileUpdate', profile: profileKey }); }
async function adaptProfileForDomain(host){ try { const { adaptiveProfiles = true } = await storageGet(['adaptiveProfiles']); if(!adaptiveProfiles) return; const base = host; if(base.endsWith('.onion')){ await setActiveProfile('paranoid','auto'); return; } const trusted = await isTrustedDomain(base); if(trusted){ await setActiveProfile('relaxed','auto'); return; } await setActiveProfile('strict','auto'); } catch(e){ safeLog('adaptProfileForDomain', e); } }

// ----------------- Tab listeners: cookie count, cache estimate, auto-delete on update/close -----------------
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    // We only act on completed navigations or explicit changeInfo.url
    const url = changeInfo.url || tab && tab.url;
    if(!url || !/^https?:/.test(String(url))) return;
    const hostname = new URL(url).hostname;
    // persist tab url map
    const tv = await storageGet(['tabUrls']);
    const tabUrls = tv.tabUrls || {};
    tabUrls[tabId] = url;
    await storageSet({ tabUrls });

    // record cookie count delta
    const allCookies = await chrome.cookies.getAll({ domain: hostname });
    const siteCookies = allCookies.filter(c => stripDot(c.domain) === hostname);
    lastCookieCount[hostname] ||= 0;
    const newCookies = siteCookies.length - lastCookieCount[hostname];
    if(newCookies > 0) await recordSiteStat(hostname, "cookies", newCookies);
    lastCookieCount[hostname] = siteCookies.length;
    await storageSet({ pendingCookies: siteCookies.length });

    // estimate storage / cache (approx)
    if(navigator.storage && navigator.storage.estimate){
      try {
        const { usage = 0 } = await navigator.storage.estimate();
        const pendingMB = Math.round((usage / 1024 / 1024) * 100) / 100;
        await storageSet({ pendingCache: pendingMB });
        lastCacheEstimate[hostname] ||= 0;
        const newMB = pendingMB - lastCacheEstimate[hostname];
        if(newMB > 0) await recordSiteStat(hostname, "cache", newMB);
        lastCacheEstimate[hostname] = pendingMB;
      } catch(e){ safeLog('storage estimate err', e); }
    }

    // adaptive profile & fingerprint script registration
    const st = await storageGet(['profileSource','activeProfile']);
    if(st.profileSource !== 'manual') adaptProfileForDomain(hostname).catch(()=>{});
    registerFingerprintingScript().catch(()=>{});
    updatePrivacyBadge();
  } catch(e){ safeLog('tabs.onUpdated err', e); }
});

// auto-delete on tab update (separate listener to respect profile and whitelists)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    const url = changeInfo.url || tab && tab.url;
    if(!url || !/^https?:/.test(String(url)) || !tab || !tab.active) return;
    const hostname = new URL(url).hostname;
    const skipCookies = await shouldSkipCookieCleanup(hostname);
    const skipCache = await shouldSkipCacheCleanup(hostname);
    const pc = await storageGet(['pauseCleanup','autoCookieDeletionEnabled','cookieWhitelist','cookieCategoryCounts']);
    const { pauseCleanup = false, autoCookieDeletionEnabled = false } = pc;
    if(pauseCleanup) return;
    if(skipCookies && skipCache) return;

    // cookies for page
    const allCookies = await chrome.cookies.getAll({ domain: hostname });
    const siteCookies = allCookies.filter(c => stripDot(c.domain) === hostname);
    await storageSet({ pendingCookies: siteCookies.length });

    const profileKey = await getActiveProfile();
    let profile = profiles[profileKey] || {};
    if(profileKey === "custom_pro"){
      const r = await storageGet(['customProConfig']);
      profile = {...profile, ...(r.customProConfig||{})};
    }

    if(autoCookieDeletionEnabled && !skipCookies){
      const s = await storageGet(['cookieWhitelist','cookieCategoryCounts']);
      const cookieWhitelist = s.cookieWhitelist || [];
      const toDelete = siteCookies.filter(c=>{
        const key = `${stripDot(c.domain)}|${c.name}`;
        const category = getCookieCategory(c.name);
        return !cookieWhitelist.includes(key) && category !== 'necessary';
      });
      const deletedResults = await Promise.all(toDelete.map(c => deleteCookie(c, url, tabId)));
      const deletedCount = deletedResults.filter(Boolean).length;
      const store = await storageGet(['totalCookiesDeleted','deletionHistory','cookieCategoryCounts']);
      const totalCookiesDeleted = Number(store.totalCookiesDeleted || 0);
      const deletionHistory = store.deletionHistory || [];
      await storageSet({ pendingCookies: 0, totalCookiesDeleted: totalCookiesDeleted + deletedCount, deletionHistory: [{ hostname, time: new Date().toISOString(), cookiesDeleted: deletedCount, cacheCleared: !!profile.clearCache }, ...deletionHistory].slice(0,20) });
      await recordSiteStat(hostname, 'cookies', deletedCount * -1);
    }
    await updatePrivacyBadge();
  } catch(e){ safeLog('auto-delete on update err', e); }
});

// on tab remove => run cleanup per profile (delete cookies/cache/localstorage etc)
chrome.tabs.onRemoved.addListener(async tabId => {
  try {
    const s = await storageGet(['pauseCleanup','tabUrls']);
    const { pauseCleanup = false, tabUrls = {} } = s;
    if(pauseCleanup) return;
    const url = tabUrls[tabId]; delete tabUrls[tabId]; await storageSet({ tabUrls });
    if(!url) return;
    let hostname;
    try { hostname = new URL(url).hostname; } catch { return; }
    const skipCookies = await shouldSkipCookieCleanup(hostname);
    const skipCache = await shouldSkipCacheCleanup(hostname);
    if(skipCookies && skipCache) return;

    const allCookies = await chrome.cookies.getAll({ domain: hostname });
    const siteCookies = allCookies.filter(c => stripDot(c.domain) === hostname);

    const profileKey = await getActiveProfile();
    let profile = profiles[profileKey] || {};
    if(profileKey === "custom_pro"){
      const r = await storageGet(['customProConfig']);
      profile = {...profile, ...(r.customProConfig||{})};
    }

    const now = new Date().toISOString();

    // storage cleanup via content script if requested
    if(profile.deleteLocalStorage || profile.deleteSessionStorage || profile.deleteIndexedDB){
      try {
        await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["content-cleanup.js"], args: [{ deleteLocalStorage: !!profile.deleteLocalStorage, deleteSessionStorage: !!profile.deleteSessionStorage, deleteIndexedDB: !!profile.deleteIndexedDB }] });
      } catch(e){ safeLog('scripting executeScript cleanup failed', e); }
    }

    if(profile.deleteCookies && !skipCookies){
      const s2 = await storageGet(['cookieWhitelist']);
      const cookieWhitelist = s2.cookieWhitelist || [];
      const toDelete = siteCookies.filter(c => {
        const key = `${stripDot(c.domain)}|${c.name}`;
        const cat = getCookieCategory(c.name);
        return !cookieWhitelist.includes(key) && cat !== 'necessary';
      });
      const results = await Promise.all(toDelete.map(c => deleteCookie(c, url, null)));
      const deletedCount = results.filter(Boolean).length;
      const st = await storageGet(['totalCookiesDeleted','deletionHistory','dailyCookieClears']);
      const totalCookiesDeleted = Number(st.totalCookiesDeleted || 0);
      const deletionHistory = st.deletionHistory || [];
      await storageSet({ pendingCookies: 0, totalCookiesDeleted: totalCookiesDeleted + deletedCount, deletionHistory: [{ hostname, time: now, cookiesDeleted: deletedCount, cacheCleared: false }, ...deletionHistory].slice(0,20) });
      // daily cookie clears tally
      const dayKey = now.slice(0,10);
      const dailyCookieClears = st.dailyCookieClears || {};
      dailyCookieClears[dayKey] = (dailyCookieClears[dayKey]||0) + deletedCount;
      await storageSet({ dailyCookieClears });
    }

    if(profile.clearCache && !skipCache){
      const st = await storageGet(['pendingCache','totalCacheCleared','deletionHistory','dailyCacheClears']);
      const pendingCache = Number(st.pendingCache || 0);
      chrome.browsingData.remove({ origins: [`https://${hostname}`, `http://${hostname}`] }, { cache: true }, async ()=>{
        const now2 = new Date().toISOString();
        const totalCacheCleared = Number(st.totalCacheCleared || 0);
        const deletionHistory = st.deletionHistory || [];
        const clearedMB = pendingCache;
        await storageSet({ pendingCache: 0, totalCacheCleared: totalCacheCleared + clearedMB, deletionHistory: [{ hostname, time: now2, cacheCleared: true, cacheEstimateMB: clearedMB }, ...deletionHistory].slice(0,20) });
        const dayKey2 = now2.slice(0,10);
        const dailyCacheClears = st.dailyCacheClears || {};
        dailyCacheClears[dayKey2] = (dailyCacheClears[dayKey2] || 0) + clearedMB;
        await storageSet({ dailyCacheClears });
      });
    }
    await updatePrivacyBadge();
  } catch(e){ safeLog('tabs.onRemoved err', e); }
});

// ----------------- local-only pending tracker reporting -----------------
async function reportPendingTracker(domain, categories){
  try {
    pendingTrackers[domain] ||= { count:0, firstSeen: Date.now(), lastSeen:0, categories: new Set() };
    const p = pendingTrackers[domain];
    p.count = (p.count||0) + 1;
    p.lastSeen = Date.now();
    (Array.isArray(categories) ? categories : []).forEach(c => p.categories.add(c));
    persistPending();
  } catch(e){ safeLog('reportPendingTracker err', e); }
}

// ----------------- Initialization -----------------
(async function initPublicBackground(){
  try {
    // load cookie & rules bundles
    await loadCookieCategoriesFromBundle();
    await loadApprovedRules();
    await registerFingerprintingScript();
    updatePrivacyBadge();
    const st = await storageGet(['blockedTrackers','pendingTrackers','trackerBlockingEnabled']);
    blockedTrackers = st.blockedTrackers || blockedTrackers;
    pendingTrackers = st.pendingTrackers || pendingTrackers;
    if(typeof st.trackerBlockingEnabled === 'boolean') trackerBlockingEnabled = st.trackerBlockingEnabled;
    safeLog('[public bg] initialized');
  } catch(e){ safeLog('initPublicBackground err', e); }
})();
