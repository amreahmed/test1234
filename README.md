# WebSocket Headless Bots (Node)

This bot runner connects to **sfs.cloxbot.app:8080** using the **SmartFox JS API** (WebSocket),
logs in multiple users and (optionally) joins a room to move them around.

## Requirements
- Node.js 16+
- SmartFoxServer **JavaScript API** file (`SFS2X_API_JS.js`)
- `ws` package

## Setup
1. Put the SmartFox JS API file in `ws-bots/` (e.g. `SFS2X_API_JS.js` or `sfs2x-api-1.8.5.js`).
2. Install deps:
   ```powershell
   cd ws-bots
   npm install
   ```
3. Edit `bots.json` to match your server/zone (and optional `apiFile` name).

## Run
```powershell
cd ws-bots
node bot.js
```

## Notes
- These are **real users** (count as online).
- Uses WebSocket (same as the real client).
- If you want random clothes, set `enableRandomClothes=true` and adjust `clothShopIds`.
- If you want bots to stay online without joining any room, set `zoneOnly: true` and `sendInit: false`.
- Proxy support: set `proxyUrl` or `proxyList` in `bots.json` (e.g. `http://user:pass@host:port`) or use `HTTP_PROXY` / `HTTPS_PROXY`.
- To rotate proxies, set `proxyList` and `proxyRotateEvery` (e.g. rotate every 100 bots).
