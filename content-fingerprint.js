// content-fingerprint.js
(function() {
  const suspiciousApis = [
    "CanvasRenderingContext2D.prototype.toDataURL",
    "navigator.hardwareConcurrency",
    "navigator.deviceMemory",
    "AudioContext",
    "OfflineAudioContext",
    "WebGLRenderingContext.prototype.getParameter"
  ];

  function report(api) {
    chrome.runtime.sendMessage({ type: "fingerprintingDetected", api, url: location.href });
  }

  suspiciousApis.forEach(apiPath => {
    try {
      const parts = apiPath.split(".");
      let obj = window;
      for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
      const fn = obj[parts[parts.length - 1]];
      if (typeof fn === "function") {
        obj[parts[parts.length - 1]] = new Proxy(fn, {
          apply(target, thisArg, args) {
            report(apiPath);
            return Reflect.apply(target, thisArg, args);
          }
        });
      }
    } catch(e) { /* ignore */ }
  });
})();
