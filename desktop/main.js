// ALTAKA-ALWATANIYAH – التطبيق الموحد (نسخة ويندوز وماك): الأدوات الميدانية + منظومة ERP عبر Cloudflare
const { app, BrowserWindow, session, shell, Menu, systemPreferences, dialog } = require('electron');
const path = require('path');

// نطاقات الشركة التي تُفتح داخل التطبيق (منظومة ERP والبوابة عبر Cloudflare)
const COMPANY = /^https:\/\/([a-z0-9-]+\.)*(altaka-field\.com|altaka-alwatania\.iq)(:\d+)?(\/|$)/i;
let erpWin = null;
function openErp(url) {
  if (erpWin && !erpWin.isDestroyed()) { erpWin.loadURL(url); erpWin.focus(); return; }
  erpWin = new BrowserWindow({
    width: 1366, height: 860, minWidth: 900, minHeight: 600, title: 'منظومة ERP – الطاقة الوطنية',
    icon: path.join(__dirname, 'build', 'icon.png'), autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false }
  });
  erpWin.loadURL(url);
  erpWin.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith('blob:') || COMPANY.test(u)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
    shell.openExternal(u); return { action: 'deny' };
  });
  erpWin.webContents.on('will-navigate', (e, u) => { if (!COMPANY.test(u) && !u.startsWith('blob:')) { e.preventDefault(); shell.openExternal(u); } });
  erpWin.on('closed', () => { erpWin = null; });
}

// استخدام خدمة الموقع في ويندوز (Windows Location) لتحديد الموقع الجغرافي
app.commandLine.appendSwitch('enable-features', 'WinrtGeolocationImplementation');

function createWindow() {
  const win = new BrowserWindow({
    width: 1366, height: 860, minWidth: 380, minHeight: 560,
    title: 'الطاقة الوطنية – منظومة ERP',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#194239',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  // الروابط الخارجية (الخرائط، الهاتف) تُفتح في المتصفح
  win.webContents.setWindowOpenHandler(({ url }) => {
    // فتح تقارير PDF (تطبيقا الكشف والتنفيذ) داخل نافذة التطبيق
    if (url.startsWith('blob:')) return { action: 'allow', overrideBrowserWindowOptions: { width: 900, height: 1000, autoHideMenuBar: true } };
    if (COMPANY.test(url)) { openErp(url); return { action: 'deny' }; }
    shell.openExternal(url); return { action: 'deny' };
  });
  // التطبيق الموحد ينتقل إلى نسخته على خادم الشركة (https://app.altaka-field.com/app/) فتظهر منظومة ERP داخل النافذة نفسها
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://') && !url.startsWith('blob:') && !COMPANY.test(url)) { e.preventDefault(); shell.openExternal(url); } });
  // بلا إنترنت عند التشغيل: تبقى النسخة المضمّنة تعمل للأدوات الميدانية
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => { if (isMain && COMPANY.test(url)) win.loadFile(path.join(__dirname, 'app', 'index.html')); });
}


/* ---------- التحديث التلقائي لبرنامج ويندوز (النسخة المثبّتة) ----------
   الواجهة والخصائص تصل من خادم الحاسبة الأم مباشرة، وهذا يحدّث غلاف البرنامج نفسه عند صدور إصدار جديد. */
const fs = require('fs'), os = require('os'), https = require('https'), { spawn } = require('child_process');
const REPO = 'takaalwataniya-oos/altaka-alwataniyah-field';
function builtAt() { try { return Date.parse(JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8')).built) || 0; } catch (_) { return 0; } }
function get(url, file, n = 0) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'altaka-desktop', Accept: file ? 'application/octet-stream' : 'application/json' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && n < 5) { r.resume(); return get(r.headers.location, file, n + 1).then(res, rej); }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
      if (file) { const w = fs.createWriteStream(file); r.pipe(w); w.on('finish', () => w.close(() => res(file))); w.on('error', rej); }
      else { let d = ''; r.setEncoding('utf8'); r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }
    }).on('error', rej).setTimeout(10 * 60e3, function () { this.destroy(new Error('timeout')); });
  });
}
let pendingSetup = null;
async function checkUpdate(win) {
  const built = builtAt();
  if (!built || !app.isPackaged) return;
  if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_DIR) return; // النسخة المحمولة: تُستبدل يدوياً
  const rel = await get('https://api.github.com/repos/' + REPO + '/releases/latest');
  const want = process.platform === 'win32' ? 'altaka-alwataniyah-field-setup.exe' : process.platform === 'darwin' ? 'altaka-alwataniyah-field-mac-' + (process.arch === 'arm64' ? 'arm64' : 'x64') + '.dmg' : null;
  const a = want && (rel.assets || []).find(x => x.name === want);
  if (!a || Date.parse(a.updated_at) < built + 60 * 60e3) return; // لا يوجد إصدار أحدث
  if (process.platform === 'darwin') {
    const r = await dialog.showMessageBox(win, { type: 'info', buttons: ['تنزيل التحديث', 'لاحقاً'], defaultId: 0, title: 'تحديث جديد', message: 'يتوفر إصدار جديد من برنامج الطاقة الوطنية (' + (rel.name || '') + ').', detail: 'نزّل الملف وافتحه ثم اسحب البرنامج إلى مجلد Applications.' });
    if (r.response === 0) shell.openExternal(a.browser_download_url);
    return;
  }
  const file = path.join(os.tmpdir(), 'altaka-setup-' + Date.parse(a.updated_at) + '.exe');
  if (!fs.existsSync(file) || fs.statSync(file).size !== a.size) await get(a.browser_download_url, file + '.part', 0).then(() => fs.renameSync(file + '.part', file));
  pendingSetup = file;
  const r = await dialog.showMessageBox(win, { type: 'info', buttons: ['تثبيت الآن', 'عند إغلاق البرنامج'], defaultId: 0, cancelId: 1, title: 'تحديث جديد', message: 'تم تنزيل إصدار جديد من برنامج الطاقة الوطنية (' + (rel.name || '') + ').', detail: 'يستغرق التثبيت أقل من دقيقة ويعيد فتح البرنامج تلقائياً.' });
  if (r.response === 0) { runSetup(); app.quit(); }
}
function runSetup() { if (!pendingSetup) return; const f = pendingSetup; pendingSetup = null; try { spawn(f, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref(); } catch (_) {} }
app.on('will-quit', runSetup);

app.whenReady().then(async () => {
  // ماك: طلب إذن الكاميرا والمايكروفون من النظام
  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('camera'); await systemPreferences.askForMediaAccess('microphone'); } catch (_) {}
  }
  const ok = ['media', 'geolocation', 'notifications', 'fullscreen'];
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(ok.includes(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => ok.includes(perm));
  createWindow();
  setTimeout(() => checkUpdate(BrowserWindow.getAllWindows()[0]).catch(() => {}), 15000);
  setInterval(() => { if (!pendingSetup) checkUpdate(BrowserWindow.getAllWindows()[0]).catch(() => {}); }, 6 * 3600e3);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
