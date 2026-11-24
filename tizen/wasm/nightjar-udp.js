/* Sets globalThis.NightjarUdp before app.js. UDP leaves the TV through the
   Samsung Emscripten module (wake-on-lan.js), which sends each magic packet to
   255.255.255.255, the last IPv4, and ff02::1. */
(function (global) {
  "use strict";

  var DISCOVER_DATAGRAM = '{"version":2,"type":"discover"}';

  function isIpv4(value) {
    var parts = String(value).split(".");
    if (parts.length !== 4) {
      return false;
    }
    for (var index = 0; index < parts.length; index += 1) {
      var part = parts[index];
      if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.charAt(0) === "0") || Number(part) > 255) {
        return false;
      }
    }
    return true;
  }

  function copyBytes(value) {
    if (value == null || typeof value.length !== "number") {
      return null;
    }
    var copy = new Uint8Array(value.length);
    for (var index = 0; index < value.length; index += 1) {
      var byte = value[index];
      if ((byte & 255) !== byte) {
        return null;
      }
      copy[index] = byte;
    }
    return copy;
  }

  function macFromMagicPacket(value) {
    var packet = copyBytes(value);
    if (!packet || packet.length !== 102) {
      return null;
    }
    var index;
    for (index = 0; index < 6; index += 1) {
      if (packet[index] !== 0xff) {
        return null;
      }
    }
    var mac = packet.subarray(6, 12);
    var zero = true;
    for (index = 0; index < 6; index += 1) {
      if (mac[index] !== 0) {
        zero = false;
      }
    }
    if (zero || (mac[0] & 1) === 1) {
      return null;
    }
    var repeat;
    var offset;
    for (repeat = 2; repeat <= 16; repeat += 1) {
      for (offset = 0; offset < 6; offset += 1) {
        if (packet[repeat * 6 + offset] !== mac[offset]) {
          return null;
        }
      }
    }
    return mac;
  }

  function Bridge() {
    this.modulePromise = null;
    this.nextRequestId = 1;
    this.discoveries = new Map();
  }

  Bridge.prototype.supported = function () {
    return typeof global.tizentvwasm !== "undefined"
      && typeof global.WebAssembly !== "undefined"
      && typeof global.SharedArrayBuffer !== "undefined"
      && typeof global.createWakeOnLanModule === "function";
  };

  Bridge.prototype.finishDiscover = function (requestId, errorCode) {
    var discovery = this.discoveries.get(requestId);
    if (!discovery) {
      return;
    }
    this.discoveries.delete(requestId);
    clearTimeout(discovery.timer);
    if (discovery.found.length === 0 && errorCode) {
      discovery.reject(new Error("PC search failed (error " + String(errorCode) + ")."));
      return;
    }
    discovery.resolve(discovery.found);
  };

  Bridge.prototype.load = function () {
    if (this.modulePromise) {
      return this.modulePromise;
    }
    var bridge = this;
    var factory = global.createWakeOnLanModule;
    this.modulePromise = new Promise(function (resolve, reject) {
      if (typeof factory !== "function") {
        reject(new Error("The wake module did not load."));
        return;
      }
      var runtime = {
        onWakeResult: function () {},
        onDiscoveryReply: function (requestId, address, text) {
          var discovery = bridge.discoveries.get(requestId);
          if (!discovery || typeof address !== "string" || typeof text !== "string") {
            return;
          }
          discovery.found.push({ address: address, payload: new TextEncoder().encode(text) });
        },
        onDiscoveryDone: function (requestId, replies, errorCode) {
          bridge.finishDiscover(requestId, errorCode);
        },
        onRuntimeInitialized: function () {
          resolve({ runtime: runtime });
        },
        onAbort: function (reason) {
          reject(new Error("The wake module stopped: " + String(reason)));
        },
      };
      try {
        factory(runtime);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }).catch(function (error) {
      bridge.modulePromise = null;
      throw error;
    });
    return this.modulePromise;
  };

  Bridge.prototype.broadcast = function (payload, port, timeoutMs) {
    var bytes = copyBytes(payload);
    var text = bytes ? new TextDecoder().decode(bytes) : "";
    if (text !== DISCOVER_DATAGRAM) {
      return Promise.reject(new Error("Discovery sends only the version 2 discover datagram."));
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return Promise.reject(new Error("Discovery port is invalid."));
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
      return Promise.reject(new Error("Discovery timeout is invalid."));
    }
    if (!this.supported()) {
      return Promise.reject(new Error("This TV cannot send UDP. Enter the PC address."));
    }
    var bridge = this;
    return this.load().then(function (loaded) {
      return new Promise(function (resolve, reject) {
        var requestId = bridge.nextRequestId;
        bridge.nextRequestId += 1;
        var timer = setTimeout(function () {
          bridge.finishDiscover(requestId, 0);
        }, timeoutMs + 5000);
        bridge.discoveries.set(requestId, { resolve: resolve, reject: reject, timer: timer, found: [] });
        var status = loaded.runtime.ccall(
          "net_discover",
          "number",
          ["number", "number", "number"],
          [requestId, port, timeoutMs],
        );
        if (status !== 0) {
          bridge.finishDiscover(requestId, status);
        }
      });
    });
  };

  Bridge.prototype.wake = function (packet, address) {
    var mac = macFromMagicPacket(packet);
    if (!mac || !this.supported()) {
      return false;
    }
    var unicast = typeof address === "string" && isIpv4(address) ? address : "";
    var bridge = this;
    this.load().then(function (loaded) {
      var requestId = bridge.nextRequestId;
      bridge.nextRequestId += 1;
      loaded.runtime.ccall(
        "wol_send",
        "number",
        ["number", "array", "string"],
        [requestId, mac, unicast],
      );
    }).catch(function () {});
    return true;
  };

  var bridge = new Bridge();
  global.NightjarUdp = {
    broadcast: function (payload, port, timeoutMs) {
      return bridge.broadcast(payload, port, timeoutMs);
    },
    wake: function (packet, address) {
      return bridge.wake(packet, address);
    },
  };
}(globalThis));
