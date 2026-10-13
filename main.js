const { app, BrowserWindow } = require('electron');
const path = require('path');

// Para que varios computadores compartan los datos, pon aquí la dirección del servidor publicado
// (por ejemplo 'https://flowprint.tuempresa.cl') o usa la variable de entorno FLOWPRINT_URL.
// Si queda vacío, la app levanta el servidor local como antes.
const SERVIDOR_REMOTO = process.env.FLOWPRINT_URL || '';

if (!SERVIDOR_REMOTO) require('./server');

function createWindow() {
  const win = new BrowserWindow({
    width: 1366,
    height: 850,
    minWidth: 1024,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    autoHideMenuBar: true
  });

  win.loadURL(SERVIDOR_REMOTO || 'http://localhost:5050');
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});