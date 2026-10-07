require('dotenv').config();
const express=require('express');const multer=require('multer');const fs=require('fs');const path=require('path');const {google}=require('googleapis');
const app=express();const PORT=process.env.PORT||3000;const DATA=path.join(__dirname,'data','videos.json');const VIEWS=path.join(__dirname,'data','views.json');
const LEGACY_IDS=new Set(['1L5g-m4LY3KxbB_cITGwc04HdEMLZvtfP','1Kaqj9y1_RkQSfbEpm9VrSbIeagRYSH4a','18yuCzwnZ5WZMCzQOocZgZ2J5ix9fP-0N','1QTj2KtxCGra3j6S3hBu22kEZfJX0JGXr','13KKHg2CNIygu8tjd4Cbr0yWZtfRl1zxP','1mFBGOFjUkopnodQBcule5hJ0uKHW-wCJ','1uMMzFIKTV_Tz2m0YzoyY_zqzsxjriQav']);
fs.mkdirSync(path.dirname(DATA),{recursive:true});
if(!fs.existsSync(DATA))fs.writeFileSync(DATA,'[]');
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:2*1024*1024*1024}});
function read(){return JSON.parse(fs.readFileSync(DATA,'utf8'))}function write(x){fs.writeFileSync(DATA,JSON.stringify(x,null,2))}
function readViews(){return fs.existsSync(VIEWS)?JSON.parse(fs.readFileSync(VIEWS,'utf8')):{}}
function videoList(){const views=readViews();return read().map(v=>({...v,views:views[v.id]??v.views??0,thumbnail:v.thumbnail||`https://drive.google.com/thumbnail?id=${v.id}&sz=w640`}))}
function oauth(){return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID,process.env.GOOGLE_CLIENT_SECRET,process.env.GOOGLE_REDIRECT_URI)}
function drive(){const o=oauth();o.setCredentials({refresh_token:process.env.GOOGLE_REFRESH_TOKEN});return google.drive({version:'v3',auth:o})}
app.use(express.static(path.join(__dirname,'public')));
app.get('/api/videos',(req,res)=>res.json(videoList()));
app.get('/api/views',(req,res)=>{const views=readViews();for(const v of read())views[v.id]??=v.views||0;res.json(views)});
app.post('/api/videos/:id/view',(req,res)=>{if(!/^[\w-]{10,}$/.test(req.params.id))return res.status(400).json({error:'Invalid video ID'});const all=read();const v=all.find(x=>x.id===req.params.id);const views=readViews();views[req.params.id]=(views[req.params.id]??v?.views??0)+1;fs.writeFileSync(VIEWS,JSON.stringify(views,null,2));res.json({views:views[req.params.id]})});
app.get('/api/videos/:id/stream',async(req,res)=>{
 const id=req.params.id,range=req.headers.range;
 if(!/^[\w-]{10,}$/.test(id)||(!LEGACY_IDS.has(id)&&!read().some(v=>v.id===id)))return res.status(404).json({error:'Video not found'});
 if(range&&!/^bytes=\d*-\d*$/.test(range))return res.status(416).json({error:'Invalid video range'});
 if(!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET)return res.status(503).json({error:'Google OAuth is not configured. Fill in the Google client ID and secret in .env, then restart StreamHub.'});
 if(!process.env.GOOGLE_REFRESH_TOKEN)return res.status(503).json({error:'Google Drive is not authorized. Visit /oauth2/start, save the returned refresh token in .env, then restart StreamHub.'});
 try{
  const d=drive();
  const file=await d.files.get({fileId:id,fields:'mimeType,size'});
  const options={responseType:'stream'};
  if(range)options.headers={Range:range};
  const media=await d.files.get({fileId:id,alt:'media'},options);
  const contentRange=media.headers?.['content-range'];
  const contentLength=media.headers?.['content-length'];
  res.status(contentRange?206:(media.status||200));
  res.set('Content-Type',file.data.mimeType||'application/octet-stream');
  res.set('Content-Disposition','inline');
  res.set('Accept-Ranges','bytes');
  res.set('Cache-Control','private, no-store');
  if(contentRange)res.set('Content-Range',contentRange);
  if(contentLength)res.set('Content-Length',contentLength);
  else if(!contentRange&&file.data.size)res.set('Content-Length',file.data.size);
  media.data.on('error',e=>{
   console.error('Video stream failed',e);
   if(!res.headersSent)res.status(502).json({error:'Video stream failed. Check Google Drive access and try again.'});
   else res.destroy(e);
  });
  res.on('close',()=>{if(!res.writableEnded)media.data.destroy()});
  media.data.pipe(res);
 }catch(e){
  console.error('Could not stream video from Google Drive',e);
  if(!res.headersSent){
   const status=e.response?.status||e.code;
   const message=status===401||status===403
    ?'Google Drive denied access. Reauthorize the server with the Drive read permission.'
    :status===404?'Video was not found in the authorized Google Drive account.':'Could not stream video. Check server configuration and Google Drive access.';
   res.status(status===401||status===403||status===404?status:502).json({error:message});
  }
 }
});
app.get('/oauth2/start',(req,res)=>{const o=oauth();res.redirect(o.generateAuthUrl({access_type:'offline',scope:['https://www.googleapis.com/auth/drive.file','https://www.googleapis.com/auth/drive.readonly'],prompt:'consent'}))});
app.get('/oauth2/callback',async(req,res)=>{try{const o=oauth();const {tokens}=await o.getToken(req.query.code);res.type('text').send('Copy this refresh token into GOOGLE_REFRESH_TOKEN in .env:\n\n'+tokens.refresh_token)}catch(e){res.status(500).send(e.message)}});
app.post('/api/upload',upload.single('video'),async(req,res)=>{try{if(!req.file)return res.status(400).json({error:'Video is required'});const d=drive();const folder=process.env.GOOGLE_DRIVE_FOLDER_ID||undefined;const file=await d.files.create({requestBody:{name:req.file.originalname,parents:folder?[folder]:undefined},media:{mimeType:req.file.mimetype,body:require('stream').Readable.from(req.file.buffer)},fields:'id,name,webViewLink'});await d.permissions.create({fileId:file.data.id,requestBody:{type:'anyone',role:'reader'}});const item={id:file.data.id,title:req.body.title||req.file.originalname,description:req.body.description||'',url:`https://drive.google.com/file/d/${file.data.id}/preview`,thumbnail:`https://drive.google.com/thumbnail?id=${file.data.id}&sz=w640`,views:0,createdAt:new Date().toISOString()};const all=read();all.unshift(item);write(all);res.json(item)}catch(e){console.error(e);res.status(500).json({error:'Google Drive upload failed. Check server configuration.'})}});
app.listen(PORT,()=>console.log(`StreamHub running on http://localhost:${PORT}`));
