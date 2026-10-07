require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');

const app = express();
app.set('trust proxy', 1); // Render terminates HTTPS in front of the app
const PORT = process.env.PORT || 3000;

// ---- Storage -------------------------------------------------------------
// On Render, mount a persistent disk and set DATA_DIR to its mount path (e.g. /var/data)
// so videos.json / views.json survive redeploys. Without it, data resets on each deploy.
const SEED_DIR = path.join(__dirname, 'data');
const DATA_DIR = process.env.DATA_DIR || SEED_DIR;
const DATA = path.join(DATA_DIR, 'videos.json');
const VIEWS = path.join(DATA_DIR, 'views.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
for (const f of ['videos.json', 'views.json']) {
  const target = path.join(DATA_DIR, f);
  if (!fs.existsSync(target)) {
    const seed = path.join(SEED_DIR, f);
    if (fs.existsSync(seed) && seed !== target) fs.copyFileSync(seed, target);
    else fs.writeFileSync(target, f === 'videos.json' ? '[]' : '{}');
  }
}

const LEGACY_IDS = new Set([
  '1L5g-m4LY3KxbB_cITGwc04HdEMLZvtfP', '1Kaqj9y1_RkQSfbEpm9VrSbIeagRYSH4a',
  '18yuCzwnZ5WZMCzQOocZgZ2J5ix9fP-0N', '1QTj2KtxCGra3j6S3hBu22kEZfJX0JGXr',
  '13KKHg2CNIygu8tjd4Cbr0yWZtfRl1zxP', '1mFBGOFjUkopnodQBcule5hJ0uKHW-wCJ',
  '1uMMzFIKTV_Tz2m0YzoyY_zqzsxjriQav'
]);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic replace
}
const read = () => readJson(DATA, []);
const readViews = () => readJson(VIEWS, {});
function videoList() {
  const views = readViews();
  return read().map(v => ({
    ...v,
    views: views[v.id] ?? v.views ?? 0,
    thumbnail: v.thumbnail || `https://drive.google.com/thumbnail?id=${v.id}&sz=w640`
  }));
}

// ---- Google auth ---------------------------------------------------------
function baseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}
function redirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || `${baseUrl(req)}/oauth2/callback`;
}
function oauth(req) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri(req)
  );
}
function drive(req) {
  const o = oauth(req);
  o.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth: o });
}
function configProblem() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)
    return 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the Render environment.';
  if (!process.env.GOOGLE_REFRESH_TOKEN)
    return 'Google Drive is not authorized. Open /oauth2/start once, then save the refresh token as GOOGLE_REFRESH_TOKEN in the Render environment and redeploy.';
  return null;
}
function describeGoogleError(e) {
  const detail = e?.response?.data?.error;
  const code = e?.response?.status || e?.code;
  if (detail === 'invalid_grant' || /invalid_grant/.test(e?.message || ''))
    return 'Google refresh token is expired or revoked. Re-run /oauth2/start and update GOOGLE_REFRESH_TOKEN. (If your OAuth consent screen is in "Testing" mode, tokens expire after 7 days: publish it to Production.)';
  if (detail === 'invalid_client' || /invalid_client/.test(e?.message || ''))
    return 'Google client ID/secret are wrong. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.';
  if (code === 403 || code === 401)
    return 'Google Drive denied access. Check the Drive API is enabled for the project and re-authorize via /oauth2/start.';
  if (code === 404)
    return 'Google Drive folder or file was not found. Check GOOGLE_DRIVE_FOLDER_ID.';
  return 'Google Drive request failed. Check the server logs.';
}

// ---- Optional upload password -------------------------------------------
// Set UPLOAD_PASSWORD to stop strangers from uploading into your Drive.
function checkUploadAuth(req, res, next) {
  const pw = process.env.UPLOAD_PASSWORD;
  if (!pw) return next();
  const given = String(req.get('x-upload-password') || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(pw).digest();
  if (crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'Wrong upload password.' });
}

const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }), // disk, not RAM (Render has little memory)
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/api/status', (req, res) => {
  res.json({
    oauthConfigured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    driveAuthorized: !!process.env.GOOGLE_REFRESH_TOKEN,
    uploadPasswordRequired: !!process.env.UPLOAD_PASSWORD,
    redirectUri: redirectUri(req),
    persistentDataDir: DATA_DIR !== SEED_DIR
  });
});

app.get('/api/videos', (req, res) => res.json(videoList()));
app.get('/api/views', (req, res) => {
  const views = readViews();
  for (const v of read()) views[v.id] ??= v.views || 0;
  res.json(views);
});
app.post('/api/videos/:id/view', (req, res) => {
  if (!/^[\w-]{10,}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid video ID' });
  const v = read().find(x => x.id === req.params.id);
  const views = readViews();
  views[req.params.id] = (views[req.params.id] ?? v?.views ?? 0) + 1;
  writeJson(VIEWS, views);
  res.json({ views: views[req.params.id] });
});

app.get('/api/videos/:id/stream', async (req, res) => {
  const id = req.params.id, range = req.headers.range;
  if (!/^[\w-]{10,}$/.test(id) || (!LEGACY_IDS.has(id) && !read().some(v => v.id === id)))
    return res.status(404).json({ error: 'Video not found' });
  if (range && !/^bytes=\d*-\d*$/.test(range)) return res.status(416).json({ error: 'Invalid video range' });
  const problem = configProblem();
  if (problem) return res.status(503).json({ error: problem });
  try {
    const d = drive(req);
    const file = await d.files.get({ fileId: id, fields: 'mimeType,size' });
    const options = { responseType: 'stream' };
    if (range) options.headers = { Range: range };
    const media = await d.files.get({ fileId: id, alt: 'media' }, options);
    const contentRange = media.headers?.['content-range'];
    const contentLength = media.headers?.['content-length'];
    res.status(contentRange ? 206 : (media.status || 200));
    res.set('Content-Type', file.data.mimeType || 'application/octet-stream');
    res.set('Content-Disposition', 'inline');
    res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'private, no-store');
    if (contentRange) res.set('Content-Range', contentRange);
    if (contentLength) res.set('Content-Length', contentLength);
    else if (!contentRange && file.data.size) res.set('Content-Length', file.data.size);
    media.data.on('error', e => {
      console.error('Video stream failed', e.message);
      if (!res.headersSent) res.status(502).json({ error: 'Video stream failed. Try again.' });
      else res.destroy(e);
    });
    res.on('close', () => { if (!res.writableEnded) media.data.destroy(); });
    media.data.pipe(res);
  } catch (e) {
    console.error('Could not stream video from Google Drive', e.message);
    if (!res.headersSent) {
      const status = e.response?.status || e.code;
      res.status([401, 403, 404].includes(status) ? status : 502).json({ error: describeGoogleError(e) });
    }
  }
});

app.get('/oauth2/start', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)
    return res.status(503).type('text').send('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.');
  res.redirect(oauth(req).generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive.readonly'],
    prompt: 'consent'
  }));
});
app.get('/oauth2/callback', async (req, res) => {
  try {
    if (!req.query.code) return res.status(400).type('text').send('Missing ?code. Start at /oauth2/start.');
    const { tokens } = await oauth(req).getToken(req.query.code);
    if (!tokens.refresh_token)
      return res.type('text').send('Google did not return a refresh token. Remove StreamHub at https://myaccount.google.com/permissions and run /oauth2/start again.');
    res.type('text').send('Copy this refresh token into GOOGLE_REFRESH_TOKEN in the Render environment, then redeploy:\n\n' + tokens.refresh_token);
  } catch (e) {
    console.error('OAuth callback failed', e.message);
    res.status(500).type('text').send(describeGoogleError(e) + '\n\nRedirect URI used: ' + redirectUri(req));
  }
});

app.post('/api/upload', checkUploadAuth, upload.single('video'), async (req, res) => {
  const tmpPath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'Video is required' });
    const problem = configProblem();
    if (problem) return res.status(503).json({ error: problem });
    const d = drive(req);
    const folder = process.env.GOOGLE_DRIVE_FOLDER_ID || undefined;
    const file = await d.files.create({
      requestBody: { name: req.file.originalname, parents: folder ? [folder] : undefined },
      media: { mimeType: req.file.mimetype, body: fs.createReadStream(tmpPath) },
      fields: 'id,name,webViewLink'
    });
    await d.permissions.create({ fileId: file.data.id, requestBody: { type: 'anyone', role: 'reader' } });
    const item = {
      id: file.data.id,
      title: req.body.title || req.file.originalname,
      description: req.body.description || '',
      url: `https://drive.google.com/file/d/${file.data.id}/preview`,
      thumbnail: `https://drive.google.com/thumbnail?id=${file.data.id}&sz=w640`,
      views: 0,
      createdAt: new Date().toISOString()
    };
    const all = read(); all.unshift(item); writeJson(DATA, all);
    res.json(item);
  } catch (e) {
    console.error('Upload failed', e.message);
    res.status(500).json({ error: describeGoogleError(e) });
  } finally {
    if (tmpPath) fs.unlink(tmpPath, () => {});
  }
});

// Multer / generic error handler (e.g. file too large)
app.use((err, req, res, next) => {
  console.error(err.message);
  if (res.headersSent) return next(err);
  res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 500).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 2 GB.' : 'Server error.' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`StreamHub running on port ${PORT}`));
