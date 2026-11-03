// Electron entry point: starts the local server, then shows the app in a window.
const { app, BrowserWindow, Menu, dialog, shell, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { startBackend } = require('./backend');

const TITLE = 'خريطة العلاقات';
const appDir = fs.existsSync(path.join(__dirname, 'app')) ? path.join(__dirname, 'app') : path.join(__dirname, '..');
let backend = null;
let win = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(async () => {
    const dataFile = path.join(app.getPath('userData'), 'data', 'relationship-map.json');
    try {
      // IndexedDB is scoped by origin including port: keep it stable across app restarts.
      backend = await startBackend({ appDir, dataFile, strictPort: true });
    } catch (err) {
      dialog.showErrorBox(TITLE, err.code === 'EADDRINUSE' ? 'تعذر تشغيل البرنامج لأن منفذه المحلي 47831 مستخدم. أغلق البرنامج الآخر وحاول مجددًا؛ لم تُغيَّر بياناتك.' : `تعذر تشغيل البرنامج:\n${err.message}`);
      app.quit();
      return;
    }
    buildMenu(dataFile);
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { backend?.stop(); });
}

function createWindow() {
  const icon = path.join(__dirname, 'build', 'icon.png');
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 900, minHeight: 600, show: false,
    title: TITLE, backgroundColor: '#0b0e12', autoHideMenuBar: true,
    ...(fs.existsSync(icon) ? { icon } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const origin = new URL(backend.url).origin;
  // Links to other sites open in the normal browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (new URL(url).origin !== origin) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.once('ready-to-show', () => {
    win.show();
    if (backend.initialPassword) showPassword('أهلًا بك في خريطة العلاقات', backend.initialPassword, 'هذه كلمة المرور الأولية.');
  });
  win.on('closed', () => { win = null; });
  win.loadURL(backend.url);
}

function showPassword(message, password, lead) {
  clipboard.writeText(password);
  dialog.showMessageBox(win, {
    type: 'info', title: TITLE, message,
    detail: `${lead}\n\nاسم المستخدم: ${backend.username}\nكلمة المرور: ${password}\n\nنُسخت كلمة المرور إلى الحافظة. بعد تسجيل الدخول غيّرها من أيقونة الحساب.`,
    buttons: ['حسنًا'],
  });
}

function buildMenu(dataFile) {
  const template = [
    { label: 'ملف', submenu: [
      { label: 'فتح مجلد البيانات', click: () => shell.openPath(path.dirname(dataFile)) },
      { label: 'حفظ نسخة احتياطية…', click: async () => {
        const stamp = new Date().toISOString().slice(0, 10);
        const { filePath, canceled } = await dialog.showSaveDialog(win, { title: 'حفظ نسخة احتياطية', defaultPath: `relationship-map-${stamp}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (!canceled && filePath) { try { fs.copyFileSync(dataFile, filePath); } catch (e) { dialog.showErrorBox(TITLE, `تعذر حفظ النسخة: ${e.message}`); } }
      } },
      { label: 'إعادة تعيين كلمة مرور المدير…', click: async () => {
        const { response } = await dialog.showMessageBox(win, { type: 'warning', title: TITLE, message: 'إعادة تعيين كلمة المرور؟', detail: 'سيتم إنشاء كلمة مرور جديدة وتسجيل الخروج. بياناتك لن تتأثر.', buttons: ['إلغاء', 'إعادة التعيين'], defaultId: 0, cancelId: 0 });
        if (response === 1) { const pw = await backend.resetPassword(); showPassword('تمت إعادة التعيين', pw, 'كلمة المرور الجديدة:'); win?.webContents.reload(); }
      } },
      { type: 'separator' },
      { role: 'quit', label: 'خروج' },
    ] },
    { label: 'تحرير', submenu: [
      { role: 'cut', label: 'قص' }, { role: 'copy', label: 'نسخ' }, { role: 'paste', label: 'لصق' }, { role: 'selectAll', label: 'تحديد الكل' },
    ] },
    { label: 'عرض', submenu: [
      { role: 'reload', label: 'إعادة تحميل' },
      { role: 'resetZoom', label: 'الحجم الفعلي' }, { role: 'zoomIn', label: 'تكبير' }, { role: 'zoomOut', label: 'تصغير' },
      { role: 'togglefullscreen', label: 'ملء الشاشة' },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
