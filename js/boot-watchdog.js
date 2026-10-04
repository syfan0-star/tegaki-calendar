// Boot watchdog — a classic (non-module) script that runs before js/main.js.
//
// If the app never starts (a module failed to load or link: mixed versions right after a deploy, a
// server error, a file missing from the offline cache), main.js never runs, so its own error screen
// never appears and the splash would stay forever — and a Home Screen app has no reload button.
// After a script error, or BOOT_TIMEOUT_MS without a start, this adds buttons to the splash:
//   「再読み込み」                    location.reload()
//   「アプリを更新して再読み込み」    (online only) removes this app's cached files ('tegaki-v*') and its
//                                      service worker, then reloads from the network
// It NEVER touches IndexedDB or localStorage (the handwriting and the settings live there).
// main.js sets window.__tegakiBooted = true once it runs (splash hidden / welcome / its own error screen).
// CSP (script-src 'self') forbids inline scripts, hence this separate file.

(function () {
  'use strict';

  var BOOT_TIMEOUT_MS = 12000;
  var CACHE_PREFIX = 'tegaki-v';
  var shown = false;

  function booted() {
    return window.__tegakiBooted === true;
  }

  function appBase() {
    try {
      return new URL('./', document.baseURI || location.href).href;
    } catch (e) {
      return location.origin + '/';
    }
  }

  function button(label, primary, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = primary ? 'btn btn-primary boot-splash-button' : 'btn boot-splash-button';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      Promise.resolve(promise).catch(function () { return undefined; }),
      new Promise(function (resolve) { setTimeout(resolve, ms); }),
    ]);
  }

  /** Deletes only this app's caches and service worker (other sites on the same origin are left alone). */
  function resetAppShell() {
    var jobs = [];
    try {
      if (window.caches && typeof caches.keys === 'function') {
        jobs.push(caches.keys().then(function (names) {
          return Promise.all(names.filter(function (n) { return n.indexOf(CACHE_PREFIX) === 0; })
            .map(function (n) { return caches.delete(n); }));
        }));
      }
    } catch (e) { /* ignore */ }
    try {
      var sw = navigator.serviceWorker;
      if (sw && typeof sw.getRegistrations === 'function') {
        var base = appBase();
        jobs.push(sw.getRegistrations().then(function (regs) {
          return Promise.all(regs.filter(function (r) { return r.scope === base; })
            .map(function (r) { return r.unregister(); }));
        }));
      }
    } catch (e) { /* ignore */ }
    return withTimeout(Promise.all(jobs), 5000);
  }

  function show() {
    if (shown || booted()) return;
    var splash = document.getElementById('boot-splash');
    if (!splash) return;
    shown = true;
    var box = document.createElement('div');
    box.className = 'boot-splash-actions';
    var note = document.createElement('div');
    note.className = 'boot-splash-detail';
    note.textContent = '起動できませんでした。下のボタンを押してください（手書きは消えません）。';
    box.appendChild(note);
    box.appendChild(button('再読み込み', true, function () { location.reload(); }));
    if (navigator.onLine !== false) {
      box.appendChild(button('アプリを更新して再読み込み', false, function (e) {
        e.target.disabled = true;
        resetAppShell().then(function () { location.reload(); });
      }));
    }
    splash.appendChild(box);
  }

  function onError(e) {
    if (booted()) return;
    var t = e && e.target;
    // A <script> that failed to load (module graph fetch error), or an uncaught error such as a module
    // link error ("Importing binding name … is not found"). Images and other resources are ignored.
    if (t && t.nodeType === 1 && t.tagName !== 'SCRIPT') return;
    setTimeout(show, 0);
  }

  window.addEventListener('error', onError, true); // capture: element load errors do not bubble
  setTimeout(show, BOOT_TIMEOUT_MS);
})();
