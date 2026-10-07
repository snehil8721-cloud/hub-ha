# StreamHub – Render deployment

1. Upload this folder to a GitHub repo (or use the included `render.yaml` as a Blueprint). Build: `npm install`, Start: `npm start`.
2. In Render → Environment, set: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and (after step 4) `GOOGLE_REFRESH_TOKEN`. Optional: `GOOGLE_DRIVE_FOLDER_ID`, `UPLOAD_PASSWORD`, `DATA_DIR=/var/data` (with a persistent disk).
3. Google Cloud Console → OAuth client → Authorized redirect URI: `https://hub-ha.onrender.com/oauth2/callback`. Make sure the Google Drive API is enabled, and set the consent screen to **In production** (in "Testing" the refresh token dies after 7 days).
4. Visit `https://hub-ha.onrender.com/oauth2/start`, approve, copy the refresh token into `GOOGLE_REFRESH_TOKEN`, redeploy.
5. Check `https://hub-ha.onrender.com/api/status` – both `oauthConfigured` and `driveAuthorized` should be `true`.

Uploads are streamed from temp disk to Drive (not held in RAM). Never commit secrets.
