/* Runs before application bundles so stores cannot hydrate legacy/global data. */
(function () {
  "use strict";
  var proto = Storage.prototype;
  var get = proto.getItem, set = proto.setItem, remove = proto.removeItem;
  var key = proto.key, length = Object.getOwnPropertyDescriptor(proto, "length").get;
  var marker = "opencut-active-account-v1";
  var id = get.call(localStorage, marker);
  if (!id || !/^[a-f0-9-]{36}$/.test(id)) id = "signed-out";
  window.__opencutAccountId = id === "signed-out" ? null : id;
  var prefix = "opencut-account:" + id + ":";
  function keys(store) {
    var result = [];
    for (var i = 0; i < length.call(store); i++) {
      var item = key.call(store, i);
      if (item && item.startsWith(prefix)) result.push(item);
    }
    return result;
  }
  proto.getItem = function (name) { return get.call(this, prefix + name); };
  proto.setItem = function (name, value) { set.call(this, prefix + name, value); };
  proto.removeItem = function (name) { remove.call(this, prefix + name); };
  proto.key = function (index) { var value = keys(this)[index]; return value ? value.slice(prefix.length) : null; };
  proto.clear = function () { var store = this; keys(store).forEach(function (name) { remove.call(store, name); }); };
  Object.defineProperty(proto, "length", { configurable: true, get: function () { return keys(this).length; } });
  window.__opencutActivateAccount = function (next, path) {
    if (next) set.call(localStorage, marker, next); else remove.call(localStorage, marker);
    if (path) location.replace(path); else location.reload();
  };
  window.__opencutLegacyPreferences = function () {
    var result = {};
    for (var i = 0; i < length.call(localStorage); i++) {
      var name = key.call(localStorage, i);
      if (name && name !== marker && !name.startsWith("opencut-account:")) result[name] = get.call(localStorage, name);
    }
    return result;
  };
  window.addEventListener("storage", function (event) { if (event.key === marker) location.reload(); });
  var originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin === location.origin && url.pathname.startsWith("/api/") && window.__opencutAccountId) {
      var headers = new Headers(init && init.headers || (input instanceof Request ? input.headers : undefined));
      headers.set("X-OpenCut-Account", window.__opencutAccountId);
      init = Object.assign({}, init, { headers: headers });
    }
    return originalFetch(input, init);
  };
})();
