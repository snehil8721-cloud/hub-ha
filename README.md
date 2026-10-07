# StreamHub

YouTube-style frontend that preserves the existing Google Drive video links and adds uploads to your Google Drive.

## Setup
1. Install Node.js.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and fill in your Google OAuth client ID and secret. Add `http://localhost:3001/oauth2/callback` as an authorized redirect URI in the Google OAuth client settings.
4. Start with `npm start` (the example config uses port 3001).
5. Open `http://localhost:3001/oauth2/start` to authorize the Google account that owns the Drive storage; this grants access to stream the existing videos as well as upload new ones. Copy the new refresh token returned into `.env`. If you already authorized uploads, authorize again to grant the additional read-only permission.
6. Restart the server and open `http://localhost:3001` (do not open `public/index.html` directly as a local file).

Videos get automatic Google Drive thumbnails and persistent view counts (stored in `data/views.json`). Selecting a video opens a centered, responsive 16:9 player popup. Video playback streams through the server with byte-range support; if streaming an existing Drive video fails, StreamHub falls back to its original Google Drive preview link.

For production, put the backend behind HTTPS and keep `.env` private. Do not put Google client secrets or refresh tokens in browser JavaScript.
