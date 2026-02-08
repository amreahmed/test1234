const fs = require("fs");
const path = require("path");
const vm = require("vm");
const WebSocket = require("ws");
const ProxyAgent = (() => {
  try {
    return require("proxy-agent");
  } catch (_) {
    return null;
  }
})();

const CONFIG_PATH = path.join(__dirname, "bots.json");
const DEFAULT_API_FILES = [
  "SFS2X_API_JS.js",
  "sfs2x-api-1.8.5.js",
  "sfs2x-api.js"
];

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing bots.json at ${CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function _pushProxy(list, v) {
  try {
    if (v == null) return;
    var s = String(v || "").trim();
    if (s.length < 1) return;
    list.push(s);
  } catch (_) {}
}

function _dedupe(list) {
  try {
    var out = [];
    var seen = new Set();
    for (const v of list) {
      const s = String(v || "").trim();
      if (!s) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  } catch (_) {
    return list || [];
  }
}

function resolveProxyList(cfg) {
  var list = [];
  try {
    if (cfg) {
      if (Array.isArray(cfg.proxyList)) {
        for (const p of cfg.proxyList) _pushProxy(list, p);
      } else if (cfg.proxyList != null) {
        String(cfg.proxyList)
          .split(/[\r\n,]+/)
          .forEach((p) => _pushProxy(list, p));
      }
      if (cfg.proxyListFile) {
        try {
          const fp = path.isAbsolute(cfg.proxyListFile)
            ? cfg.proxyListFile
            : path.join(__dirname, cfg.proxyListFile);
          if (fs.existsSync(fp)) {
            const lines = fs.readFileSync(fp, "utf8").split(/\r?\n/);
            for (const ln of lines) _pushProxy(list, ln);
          }
        } catch (_) {}
      }
      const single = cfg.proxyUrl || cfg.proxy;
      _pushProxy(list, single);
    }
  } catch (_) {}
  if (list.length === 0) {
    try {
      const env =
        process.env.HTTPS_PROXY ||
        process.env.HTTP_PROXY ||
        process.env.https_proxy ||
        process.env.http_proxy;
      _pushProxy(list, env);
    } catch (_) {}
  }
  return _dedupe(list);
}

function resolveProxyRotateEvery(cfg) {
  try {
    if (cfg && cfg.proxyRotateEvery != null) {
      const n = parseInt(String(cfg.proxyRotateEvery), 10);
      if (isFinite(n) && n > 0) return n;
    }
  } catch (_) {}
  return 100;
}

function buildProxySelector(proxyList, rotateEvery) {
  if (!proxyList || proxyList.length === 0) return null;
  if (!ProxyAgent) {
    throw new Error(
      "Proxy requested but 'proxy-agent' is not installed. Run: npm install proxy-agent"
    );
  }
  var connIndex = 0;
  var list = proxyList.slice();
  var every = rotateEvery && rotateEvery > 0 ? rotateEvery : 100;
  var agentCache = new Map();
  function getProxyForIndex(idx) {
    if (!list || list.length === 0) return null;
    var i = Math.floor(idx / every) % list.length;
    return list[i];
  }
  function getAgent() {
    var proxyUrl = getProxyForIndex(connIndex);
    connIndex++;
    if (!proxyUrl) return null;
    var a = agentCache.get(proxyUrl);
    if (a == null) {
      a = new ProxyAgent(proxyUrl);
      agentCache.set(proxyUrl, a);
    }
    return a;
  }
  return { getAgent, getProxyForIndex };
}

function wrapWebSocketWithProxy(BaseWebSocket, proxySelector) {
  function ProxyWebSocket(url, protocols) {
    var agent = null;
    try {
      if (proxySelector && typeof proxySelector.getAgent === "function")
        agent = proxySelector.getAgent();
    } catch (_) {
      agent = null;
    }
    if (agent) return new BaseWebSocket(url, protocols, { agent });
    return new BaseWebSocket(url, protocols);
  }
  ProxyWebSocket.prototype = BaseWebSocket.prototype;
  try {
    ProxyWebSocket.CONNECTING = BaseWebSocket.CONNECTING;
    ProxyWebSocket.OPEN = BaseWebSocket.OPEN;
    ProxyWebSocket.CLOSING = BaseWebSocket.CLOSING;
    ProxyWebSocket.CLOSED = BaseWebSocket.CLOSED;
  } catch (_) {}
  return ProxyWebSocket;
}

function resolveApiPath(apiFile) {
  if (apiFile) {
    const p = path.join(__dirname, apiFile);
    if (fs.existsSync(p)) return p;
  }
  for (const f of DEFAULT_API_FILES) {
    const p = path.join(__dirname, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadSfsApi(apiFile, proxySelector) {
  // Ensure globals for the SFS2X API when running under Node.
  try {
    global.WebSocket = wrapWebSocketWithProxy(WebSocket, proxySelector);
  } catch (_) {}
  try {
    if (typeof global.window === "undefined") global.window = global;
  } catch (_) {}
  try {
    if (typeof global.self === "undefined") global.self = global;
  } catch (_) {}
  try {
    if (typeof global.navigator === "undefined")
      global.navigator = { userAgent: "node" };
  } catch (_) {}

  const apiPath = resolveApiPath(apiFile);
  if (!apiPath) {
    throw new Error(
      `Missing SmartFox JS API file. Put SFS2X_API_JS.js (or sfs2x-api-*.js) in ws-bots/.`
    );
  }
  let api = null;
  try {
    api = require(apiPath);
  } catch (_) {
    api = null;
  }
  if (!api) {
    const WS = typeof global.WebSocket !== "undefined" ? global.WebSocket : WebSocket;
    const code = fs.readFileSync(apiPath, "utf8");
    const sandbox = {
      console,
      WebSocket: WS,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      navigator: { userAgent: "node" },
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: "SFS2X_API_JS.js" });
    api = sandbox.SFS2X || sandbox.window.SFS2X || null;
  }
  if (!api) {
    throw new Error("Failed to load SFS2X API (API object not found).");
  }
  if (!api.SFSEvent && api.SFS2X && api.SFS2X.SFSEvent) {
    api = api.SFS2X;
  }
  return api;
}

function resolveSfsCtor(api) {
  if (!api) return null;
  if (typeof api.SmartFox === "function") return api.SmartFox;
  if (typeof api.SFS2X === "function") return api.SFS2X;
  if (api.SFS2X && typeof api.SFS2X.SmartFox === "function")
    return api.SFS2X.SmartFox;
  if (api.SFS2X && typeof api.SFS2X.SFS2X === "function")
    return api.SFS2X.SFS2X;
  if (typeof api === "function") return api;
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const cfg = loadConfig();
  const proxyList = resolveProxyList(cfg);
  const proxyRotateEvery = resolveProxyRotateEvery(cfg);
  const proxySelector = buildProxySelector(proxyList, proxyRotateEvery);
  const api = loadSfsApi(cfg.apiFile, proxySelector);

  const {
    host,
    port,
    zone,
    useSSL,
    botCount,
    namePrefix,
    password,
    randomizeNames,
    nameSuffix,
    staggerMs,
    joinRoom,
    zoneOnly,
    sendInit,
    initTimeoutMs,
    joinDelayMs,
    moveIntervalMs,
    gridWidth,
    gridHeight,
    enableRandomClothes,
    clothShopIds,
    clothRequestDelayMs,
    clothChangeIntervalMs,
  } = cfg;

  const runId = Date.now().toString().slice(-6);

  for (let i = 1; i <= botCount; i++) {
    let username = `${namePrefix}${String(i).padStart(2, "0")}`;
    if (randomizeNames) username = `${username}_${runId}_${i}`;
    if (nameSuffix) username = `${username}${nameSuffix}`;

    const bot = new BotClient(api, {
      host,
      port,
      zone,
      useSSL,
      username,
      password,
      joinRoom,
      zoneOnly,
      sendInit,
      initTimeoutMs,
      joinDelayMs,
      moveIntervalMs,
      gridWidth,
      gridHeight,
      enableRandomClothes,
      clothShopIds,
      clothRequestDelayMs,
      clothChangeIntervalMs,
      _proxyForBot:
        proxySelector && typeof proxySelector.getProxyForIndex === "function"
          ? proxySelector.getProxyForIndex(i - 1)
          : null,
    });
    bot.connect();
    await sleep(staggerMs || 0);
  }
}

class BotClient {
  constructor(api, cfg) {
    this.api = api;
    this.cfg = cfg;
    this.rng = Math.random;
    this.clothProducts = [];
    this.clothProductKeys = new Set();
    this.shopRequestsSent = false;
    this.clothesScheduleStarted = false;
    this.joinStarted = false;
    this.initReceived = false;
    this.initTimer = null;
    this.zoneOnly = !!cfg.zoneOnly;

    const SfsCtor = resolveSfsCtor(api);
    if (!SfsCtor) {
      throw new Error("SmartFox client constructor not found in API.");
    }
    this.sfs = new SfsCtor();

    this.sfs.addEventListener(
      api.SFSEvent.CONNECTION,
      this.onConnection.bind(this)
    );
    this.sfs.addEventListener(api.SFSEvent.LOGIN, this.onLogin.bind(this));
    this.sfs.addEventListener(
      api.SFSEvent.LOGIN_ERROR,
      this.onLoginError.bind(this)
    );
    this.sfs.addEventListener(
      api.SFSEvent.ROOM_JOIN,
      this.onRoomJoin.bind(this)
    );
    this.sfs.addEventListener(
      api.SFSEvent.ROOM_JOIN_ERROR,
      this.onRoomJoinError.bind(this)
    );
    this.sfs.addEventListener(
      api.SFSEvent.CONNECTION_LOST,
      this.onConnectionLost.bind(this)
    );
    this.sfs.addEventListener(
      api.SFSEvent.EXTENSION_RESPONSE,
      this.onExtensionResponse.bind(this)
    );
  }

  connect() {
    this.sfs.connect(this.cfg.host, this.cfg.port, !!this.cfg.useSSL);
  }

  onConnection(evt) {
    if (evt.success) {
      console.log(`Connected: ${this.cfg.username}`);
      const params = new this.api.SFSObject();
      params.putUtfString("username", this.cfg.username);
      params.putUtfString("loginName", this.cfg.username);
      this.sfs.send(
        new this.api.LoginRequest(
          this.cfg.username,
          this.cfg.password,
          params,
          this.cfg.zone
        )
      );
    } else {
      console.log(`Connection failed: ${this.cfg.username}`, evt);
    }
  }

  onLogin(evt) {
    console.log(`Login ok: ${this.cfg.username}`);
    this.initReceived = false;
    this.joinStarted = false;
    if (this.zoneOnly) {
      // Stay in zone only (no init/join)
      return;
    }
    if (this.cfg.sendInit !== false) {
      const initPayload = new this.api.SFSObject();
      initPayload.putUtfString("client", "desktop");
      this.sfs.send(new this.api.ExtensionRequest("init", initPayload));
      const timeoutMs =
        this.cfg.initTimeoutMs != null ? this.cfg.initTimeoutMs : 800;
      this.initTimer = setTimeout(() => this.joinAfterInit(), timeoutMs);
    } else {
      this.joinAfterInit();
    }
  }

  onRoomJoin(evt) {
    console.log(`Joined room: ${this.cfg.username}`);
    if (this.zoneOnly) {
      try {
        this.sfs.send(new this.api.LeaveRoomRequest(evt.room));
      } catch (_) {
        try {
          this.sfs.send(new this.api.LeaveRoomRequest());
        } catch (_) {}
      }
      return;
    }
    this.sfs.send(
      new this.api.ExtensionRequest(
        "roomjoincomplete",
        new this.api.SFSObject()
      )
    );
    this.startMoving();
    this.requestShopListsIfNeeded();
  }

  onLoginError(evt) {
    console.log(`Login error: ${this.cfg.username}`, evt);
  }

  onRoomJoinError(evt) {
    console.log(`Join error: ${this.cfg.username}`, evt);
  }

  onConnectionLost(evt) {
    console.log(`Connection lost: ${this.cfg.username}`, evt);
    if (this.moveTimer) clearInterval(this.moveTimer);
  }

  startMoving() {
    if (this.zoneOnly) return;
    if (this.moveTimer) return;
    this.moveTimer = setInterval(() => {
      try {
        const x = Math.floor(Math.random() * Math.max(1, this.cfg.gridWidth));
        const y = Math.floor(Math.random() * Math.max(1, this.cfg.gridHeight));
        const p = new this.api.SFSObject();
        p.putInt("x", x);
        p.putInt("y", y);
        this.sfs.send(new this.api.ExtensionRequest("walkrequest", p));
      } catch (_) {}
    }, this.cfg.moveIntervalMs);
  }

  requestShopListsIfNeeded() {
    if (this.zoneOnly) return;
    if (!this.cfg.enableRandomClothes) return;
    if (!Array.isArray(this.cfg.clothShopIds) || this.cfg.clothShopIds.length === 0) return;
    if (this.shopRequestsSent) return;
    this.shopRequestsSent = true;
    setTimeout(() => {
      for (const shopId of this.cfg.clothShopIds) {
        const req = new this.api.SFSObject();
        req.putInt("shopID", shopId);
        this.sfs.send(new this.api.ExtensionRequest("shopproductlist", req));
      }
    }, this.cfg.clothRequestDelayMs || 0);
  }

  onExtensionResponse(evt) {
    const cmd = evt.cmd || (evt.params && evt.params.cmd);
    const params = evt.params;
    if (!cmd || !params) return;
    if (cmd === "init") {
      this.initReceived = true;
      if (this.initTimer) clearTimeout(this.initTimer);
      this.joinAfterInit();
      return;
    }
    if (cmd === "shopproductlist" || cmd === "shopproductlistA") {
      try {
        this.collectClothProducts(params);
        this.maybeStartClothesSchedule();
      } catch (_) {}
    }
  }

  collectClothProducts(params) {
    let shopId = 0;
    try {
      shopId = params.getInt("shopID");
    } catch (_) {
      shopId = 0;
    }
    const shopList = params.getSFSObject("shopProductList");
    if (!shopList) return;
    const keys = shopList.getKeys();
    for (const key of keys) {
      const arr = shopList.getSFSArray(key);
      if (!arr) continue;
      for (let i = 0; i < arr.size(); i++) {
        const p = arr.getSFSObject(i);
        if (!p) continue;
        const type = p.getUtfString("type");
        if (!type || String(type).toUpperCase() !== "CLOTH") continue;
        const clip = p.getUtfString("clip");
        const pid = p.getInt("id");
        if (!clip || !pid) continue;
        const colors = this.parseColors(p);
        const keyId = `${shopId}:${pid}`;
        if (this.clothProductKeys.has(keyId)) continue;
        this.clothProductKeys.add(keyId);
        this.clothProducts.push({ shopId, productId: pid, clip, colors });
      }
    }
  }

  parseColors(p) {
    try {
      const cols = p.getSFSArray("colors");
      if (!cols || cols.size() === 0) return [];
      const out = [];
      for (let i = 0; i < cols.size(); i++) {
        const v = cols.getUtfString(i);
        const n = parseInt(String(v), 10);
        if (n > 0) out.push(n);
      }
      return out;
    } catch (_) {
      return [];
    }
  }

  maybeStartClothesSchedule() {
    if (!this.cfg.enableRandomClothes) return;
    if (this.clothesScheduleStarted) return;
    if (this.clothProducts.length === 0) return;
    this.clothesScheduleStarted = true;
    setTimeout(() => this.applyRandomClothesOnce(), 300);
    if (this.cfg.clothChangeIntervalMs && this.cfg.clothChangeIntervalMs > 0) {
      setInterval(() => this.applyRandomClothesOnce(), this.cfg.clothChangeIntervalMs);
    }
  }

  applyRandomClothesOnce() {
    const prod = this.pickRandomClothProduct();
    if (!prod) return;
    const color = this.pickColor(prod);
    this.sendPurchase(prod.shopId, prod.productId, color);
    setTimeout(() => this.sendChangeClothes(prod.clip, color), 300);
  }

  pickRandomClothProduct() {
    if (this.clothProducts.length === 0) return null;
    return this.clothProducts[Math.floor(Math.random() * this.clothProducts.length)];
  }

  pickColor(prod) {
    if (!prod.colors || prod.colors.length === 0) return 0;
    return prod.colors[Math.floor(Math.random() * prod.colors.length)];
  }

  sendPurchase(shopId, productId, color) {
    try {
      const item = new this.api.SFSObject();
      item.putInt("shopProductID", productId);
      item.putInt("quantity", 1);
      if (color > 0) item.putInt("color", color);
      const items = new this.api.SFSArray();
      items.addSFSObject(item);
      const req = new this.api.SFSObject();
      req.putInt("shopID", shopId || 0);
      req.putSFSArray("items", items);
      this.sfs.send(new this.api.ExtensionRequest("purchase", req));
    } catch (_) {}
  }

  sendChangeClothes(clip, color) {
    try {
      const req = new this.api.SFSObject();
      req.putUtfString("clip", clip);
      if (color > 0) req.putInt("color", color);
      this.sfs.send(new this.api.ExtensionRequest("changeclothes", req));
    } catch (_) {}
  }

  joinAfterInit() {
    if (this.joinStarted) return;
    this.joinStarted = true;
    if (this.zoneOnly) return;
    const delayMs =
      this.cfg.joinDelayMs != null ? this.cfg.joinDelayMs : 250;
    if (this.cfg.joinRoom) {
      setTimeout(() => {
        const target = this.resolveJoinRoomName(this.cfg.joinRoom);
        this.sfs.send(new this.api.JoinRoomRequest(target));
      }, delayMs);
    }
  }

  resolveJoinRoomName(baseName) {
    try {
      const base = String(baseName || "").trim();
      if (!base) return baseName;
      if (base.indexOf("@") !== -1) return base;

      const rooms = this.getRoomListSafe();
      if (!rooms || rooms.length === 0) return base;

      const candidates = [];
      const baseAlt = base.startsWith("w1#") ? base.slice(3) : base;
      const withPrefix = base.startsWith("w1#") ? base : `w1#${base}`;
      for (const r of rooms) {
        if (!r) continue;
        const rn = r.name || r.getName?.();
        if (!rn) continue;
        const name = String(rn);
        if (
          name === base ||
          name.startsWith(`${base}@`) ||
          name === withPrefix ||
          name.startsWith(`${withPrefix}@`) ||
          name === baseAlt ||
          name.startsWith(`${baseAlt}@`)
        ) {
          candidates.push(r);
        }
      }
      if (candidates.length === 0) return base;

      let best = candidates[0];
      let bestCount = this.getRoomUserCount(best);
      for (let i = 1; i < candidates.length; i++) {
        const c = candidates[i];
        const cnt = this.getRoomUserCount(c);
        if (cnt > bestCount) {
          best = c;
          bestCount = cnt;
        }
      }
      const bestName = best.name || best.getName?.();
      return bestName ? String(bestName) : base;
    } catch (_) {
      return baseName;
    }
  }

  getRoomListSafe() {
    try {
      if (this.sfs.getRoomList) {
        const list = this.sfs.getRoomList();
        if (Array.isArray(list)) return list;
        if (list && list.length != null) return Array.from(list);
      }
    } catch (_) {}
    try {
      const rm = this.sfs.roomManager || this.sfs.getRoomManager?.();
      if (rm && rm.getRoomList) {
        const list = rm.getRoomList();
        if (Array.isArray(list)) return list;
        if (list && list.length != null) return Array.from(list);
      }
    } catch (_) {}
    return [];
  }

  getRoomUserCount(room) {
    try {
      if (room.userCount != null) return Number(room.userCount) || 0;
    } catch (_) {}
    try {
      if (room.getUserCount) return Number(room.getUserCount()) || 0;
    } catch (_) {}
    return 0;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
