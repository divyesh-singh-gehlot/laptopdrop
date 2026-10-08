# LaptopDrop

[![npm](https://img.shields.io/npm/v/laptopdrop)](https://www.npmjs.com/package/laptopdrop)

An AirDrop-style app for your local network. Send files and text from your laptop to your phone (or to another laptop) over Wi-Fi. No internet, no accounts, no cloud, and no app to install on the phone.

```bash
npx laptopdrop@latest
```

> **Status:** early prototype. The UI is basic and only the core functionality works. Contributions and feedback are welcome.

## Features

- Send **any file type** (images, documents, PDFs, videos, archives, and more) and text
- Send from a laptop to a phone or to another laptop
- Phone connects by scanning a QR code and just opens a web page (no install)
- Laptop-to-laptop discovery using mDNS
- Receiver must tap **Accept** before anything is saved or shown
- Transfers expire after 60 seconds if not accepted
- Files stay on your local network and never touch the cloud
- Image thumbnails and previews; other files show their name and size
- Light and dark mode

## How it differs from real AirDrop

Real AirDrop uses Bluetooth and peer-to-peer Wi-Fi, so devices can share just by being close together. LaptopDrop cannot do that. Both devices must be on the **same Wi-Fi network**, and a phone connects by scanning a QR code instead of by proximity.

## Current limitations

- Phones are **receive-only** for now (they cannot send)
- Executable and script files are blocked for safety (see [Security notes](#security-notes))
- Large files (such as videos) depend on your network speed and the size limit in `server.js`
- Plain HTTP only (no encryption yet)
- Basic UI

## Tech stack

- Node.js + Express
- ws (WebSockets) for real-time events
- bonjour-service (mDNS) for laptop discovery
- multer for file uploads
- qrcode for the connection QR code
- Plain HTML, CSS and JavaScript frontend

## Requirements

- Node.js 20 or newer
- Laptop and phone on the **same Wi-Fi network**

## Install and run

### Option 1: npx (no install)

```bash
npx laptopdrop@latest
```

### Option 2: install globally

```bash
npm install -g laptopdrop
laptopdrop
```

### Option 3: from source

```bash
git clone <your-repo-url>
cd laptopdrop
npm install
npm start
```

The terminal prints two addresses and a QR code:

```
Open on this laptop: http://localhost:3000
Open on your phone:  http://192.168.x.x:3000
```

### Updating

- `npx laptopdrop@latest` always fetches the newest version.
- If installed globally: `npm update -g laptopdrop`

## Usage

### Laptop to phone

1. Run LaptopDrop on the laptop. The page opens at `http://localhost:3000`.
2. On your phone, scan the QR code (from the terminal or the page), or type the "Open on your phone" URL into the phone's browser.
3. The phone appears under **Nearby devices** on the laptop page.
4. Select the phone, add files or type text, then click **Send**.
5. On the phone, tap **Accept**, then **Download** the files or **Copy** the text.

### Laptop to laptop

1. Run LaptopDrop on both laptops (same Wi-Fi).
2. Each laptop shows the other under **Nearby devices**.
3. Select it, add files or text, and click **Send**.
4. The receiving laptop clicks **Accept**. Files are saved to `~/Downloads/LaptopDrop`.

## Network setup

Both devices need to be on the same local network. The network does **not** need internet access.

| Setup | Works? | Notes |
|---|---|---|
| Home or office Wi-Fi router | Yes | Most reliable option |
| Laptop's Mobile Hotspot, phone joins it | Yes (tested) | Windows: Settings > Network & Internet > Mobile hotspot. The laptop address is usually `192.168.137.1` |
| Second phone's hotspot, laptop and main phone both join | Usually | Both devices are ordinary clients |
| Laptop joins the phone's hotspot, phone opens the page | Yes (tested) | Turn on the phone's hotspot, connect the laptop to it, then open the laptop's URL on the phone. On some phones the browser may show "No internet connection"; if so, use one of the other setups |

## Troubleshooting

**Phone says "No internet connection" or the page won't load**
- Confirm both devices are on the same network (not one on mobile data).
- If your phone is the hotspot host and the page still won't open, try one of the other setups in the table above.
- On Android, if it warns that the Wi-Fi has no internet, choose to **stay connected**, or turn mobile data off temporarily.

**Phone can't reach the laptop's address**
- Allow Node.js through the firewall on **private networks** when Windows or macOS prompts. If you missed the prompt, allow it manually in firewall settings.
- Check the IP in the terminal matches your network range (e.g. `192.168.x.x`). If it shows a virtual adapter's address (VirtualBox, Docker, WSL, VPN), the QR code points to the wrong place.
- Use the exact port shown in the terminal. It moves to 3001 and up if 3000 is busy.
- Test by opening `http://<laptop-ip>:<port>` in the phone's browser.

**Device doesn't appear in Nearby devices**
- Some college, office and public Wi-Fi networks block device-to-device traffic ("client isolation"). Use a home router, a laptop hotspot, or a phone hotspot with both devices as clients.
- Make sure the phone's page is still open and connected.

**A file was skipped or rejected**
- Executable and script types (for example `.exe`, `.bat`, `.ps1`) are blocked. See [Security notes](#security-notes).
- Check the file is under the size limit set in `server.js`.

**Large file transfer fails or stalls**
- Keep both devices on a strong Wi-Fi connection and keep the phone page open until the download finishes.
- Make sure the sending and receiving laptops have enough free disk space, since files are staged in a temporary folder.

**Phone browser warns the site is "not secure"**
- Expected: LaptopDrop uses plain HTTP. This is fine on a network you trust, but avoid using it on public Wi-Fi.

**Copy button doesn't work on the phone**
- Clipboard access can be restricted over plain HTTP. Long-press the text and copy manually.

## Security notes

- Nothing is saved or shown until the receiver accepts.
- Pending transfers expire after 60 seconds and temporary files are deleted.
- File names are sanitized to prevent path traversal.
- These file types are blocked by default: `.exe`, `.msi`, `.bat`, `.cmd`, `.com`, `.scr`, `.ps1`, `.vbs`, `.vbe`, `.wsf`, `.hta`, `.jar`, `.lnk`, `.reg`, `.dll`. The list is `BLOCKED_EXT` in `server.js`.
- Only image files are ever displayed inline on the phone. Everything else is served as a download.
- Received text is escaped before display.
- Only the laptop running the server can send; phones can only receive.
- Traffic is **not encrypted yet**, so use it only on networks you trust.
- Only accept files from devices and people you recognize.

## Configuration

Settings are in the `CONFIG` object at the top of `server.js`:

| Setting | Default | Description |
|---|---|---|
| `START_PORT` | `3000` | Starting port (tries the next ones if busy) |
| `MAX_FILE_SIZE` | `100 MB` | Maximum size per file. Increase it to send large videos |
| `MAX_FILES` | `20` | Maximum files per transfer |
| `PENDING_TIMEOUT_MS` | `60000` | How long a request waits for Accept |
| `ACCEPTED_KEEP_MS` | `10 min` | How long files stay available for the phone to download after Accept |
| `BLOCKED_EXT` | see above | File extensions that are rejected |
| `OPEN_BROWSER` | `true` | Open the page automatically on start |

## Project structure

```
laptopdrop/
├── package.json
├── bin/
│   └── laptopdrop.js  # CLI entry point (npx laptopdrop)
├── server.js          # Express, mDNS, WebSocket, transfer logic
├── public/
│   ├── index.html     # Laptop (host) UI
│   ├── app.js
│   ├── receive.html   # Phone (receive-only) UI
│   ├── receive.js
│   └── style.css
├── LICENSE
└── README.md
```

## Roadmap

- [x] Publish as an npm package
- [x] Support for documents and other file types
- [ ] Let phones send files to laptops
- [ ] Better UI design
- [ ] HTTPS with a self-signed certificate
- [ ] Electron desktop app with a tray icon
- [ ] Transfer history and progress improvements

## Contributing

Issues and pull requests are welcome. If you have ideas or run into problems, please open an issue.

## License

MIT
