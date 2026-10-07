/**
 * studio-origin-fix.js
 * Injected synchronously before config.js & main.js via Nginx sub_filter.
 * Overwrites penpotPublicURI (which the container entrypoint bakes as a
 * hardcoded IP:port) with the actual browser origin at load time.
 * This makes the ClojureScript RPC layer reach the correct host regardless
 * of whether the service is accessed locally, via tunnel, or via a custom domain.
 */
(function () {
  'use strict';

  var origin = window.location.origin;

  // Override before config.js assignment takes effect.
  // config.js runs AFTER this script (injected earlier in <head>).
  Object.defineProperty(window, 'penpotPublicURI', {
    configurable: true,
    enumerable: true,
    get: function () { return origin; },
    set: function (v) {
      // Swallow the hardcoded value baked in by the entrypoint script;
      // keep the runtime value as the live window.location.origin.
      // Uncomment to debug: console.debug('[studio-origin-fix] blocked set:', v, '→ keeping:', origin);
    }
  });
})();
