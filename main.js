const { app, BrowserWindow, globalShortcut, shell, ipcMain, dialog, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const { execFile } = require('child_process')

let mainWindow
let popupWindow
let itemHotkeys = []
let panicMinimized = false
let currentFakeHotkey
let currentFakeWindow = null

const settingsPath = path.join(app.getPath('userData'), 'settings.json')

function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    return {
      hotkey: data.hotkey || 'Z',
      panicHotkey: data.panicHotkey || 'F10',
      fakeHotkey: data.fakeHotkey || 'F9',
      fakeWindow: data.fakeWindow || null
    }
  } catch {
    return { hotkey: 'Z', panicHotkey: 'F10', fakeHotkey: 'F9', fakeWindow: null }
  }
}

function saveSettings() {
  fs.writeFileSync(settingsPath, JSON.stringify({
    hotkey: currentHotkey,
    panicHotkey: currentPanicHotkey,
    fakeHotkey: currentFakeHotkey,
    fakeWindow: currentFakeWindow
  }))
}

const settings = loadSettings()
let currentHotkey = settings.hotkey
let currentPanicHotkey = settings.panicHotkey
currentFakeHotkey = settings.fakeHotkey
currentFakeWindow = settings.fakeWindow

function runPowerShell(command) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', command],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? '' : stdout)
    )
  })
}

function runPanicMode() {
  const shouldRestore = panicMinimized

  if (!shouldRestore && popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.hide()
  }

  if (process.platform === 'win32') {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', shouldRestore ? '(New-Object -ComObject Shell.Application).UndoMinimizeALL()' : '(New-Object -ComObject Shell.Application).MinimizeAll()'],
      { windowsHide: true },
      () => {
        if (!shouldRestore && mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize()
        panicMinimized = !shouldRestore
      }
    )
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    if (shouldRestore) mainWindow.restore()
    else mainWindow.minimize()
    panicMinimized = !shouldRestore
  }
}

async function listOpenWindows() {
  if (process.platform !== 'win32') return []
  const script = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinList {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$windows = New-Object System.Collections.Generic.List[object]
[WinList]::EnumWindows({
  param($hWnd, $lParam)
  if ([WinList]::IsWindowVisible($hWnd)) {
    $titleBuilder = New-Object System.Text.StringBuilder 512
    [void][WinList]::GetWindowText($hWnd, $titleBuilder, $titleBuilder.Capacity)
    $title = $titleBuilder.ToString()
    if ($title.Trim().Length -gt 0) {
      [uint32]$pid = 0
      [void][WinList]::GetWindowThreadProcessId($hWnd, [ref]$pid)
      $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -ne "School Linked") {
        $windows.Add([pscustomobject]@{
          handle = $hWnd.ToInt64()
          title = $title
          pid = [int]$pid
          processName = $proc.ProcessName
        })
      }
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
$windows | Sort-Object processName,title | ConvertTo-Json -Compress
`
  try {
    const output = await runPowerShell(script)
    if (!output.trim()) return []
    const parsed = JSON.parse(output)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

function activateFakeWindow() {
  if (!currentFakeWindow || process.platform !== 'win32') return
  const target = {
    handle: Number(currentFakeWindow.handle || 0),
    title: String(currentFakeWindow.title || ''),
    pid: Number(currentFakeWindow.pid || 0),
    processName: String(currentFakeWindow.processName || '')
  }
  const script = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinFocus {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$targetHandle = [IntPtr]${target.handle}
$targetPid = ${target.pid}
$targetTitle = @'
${target.title}
'@
$targetProcess = @'
${target.processName}
'@
function Focus-Window([IntPtr]$hwnd) {
  if ($hwnd -eq [IntPtr]::Zero) { return $false }
  [void][WinFocus]::ShowWindowAsync($hwnd, 9)
  Start-Sleep -Milliseconds 80
  return [WinFocus]::SetForegroundWindow($hwnd)
}
if ([WinFocus]::IsWindow($targetHandle)) {
  if (Focus-Window $targetHandle) { exit }
}
$found = [IntPtr]::Zero
[WinFocus]::EnumWindows({
  param($hWnd, $lParam)
  if ([WinFocus]::IsWindowVisible($hWnd)) {
    [uint32]$pid = 0
    [void][WinFocus]::GetWindowThreadProcessId($hWnd, [ref]$pid)
    $titleBuilder = New-Object System.Text.StringBuilder 512
    [void][WinFocus]::GetWindowText($hWnd, $titleBuilder, $titleBuilder.Capacity)
    $title = $titleBuilder.ToString()
    $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
    if (($targetPid -gt 0 -and $pid -eq $targetPid) -or ($proc -and $proc.ProcessName -eq $targetProcess -and $title -eq $targetTitle)) {
      $script:found = $hWnd
      return $false
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
[void](Focus-Window $found)
`
  runPowerShell(script)
}

function fixUrl(url) {
  if (!url) return ''
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  return 'https://' + url
}

function openHotkeyItem(item) {
  if (!item) return

  if (item.type === 'note') {
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('reset-popup')
      popupWindow.webContents.send('open-note-hotkey', item.tabIdx, item.linkIdx)
      popupWindow.show()
      popupWindow.focus()
    }
    return
  }

  if (item.type === 'app' || item.type === 'file') {
    shell.openPath(item.url)
    return
  }

  shell.openExternal(fixUrl(item.url))
}

function registerHotkey() {
  globalShortcut.unregisterAll()
  try {
    globalShortcut.register(currentHotkey, () => {
      if (popupWindow.isVisible()) {
        popupWindow.hide()
      } else {
        popupWindow.webContents.send('reset-popup')
        popupWindow.show()
        popupWindow.focus()
      }
    })
  } catch(e) {
    console.log('Invalid hotkey:', currentHotkey)
  }

  try {
    if (currentPanicHotkey !== currentHotkey) {
      globalShortcut.register(currentPanicHotkey, runPanicMode)
    }
  } catch(e) {
    console.log('Invalid panic hotkey:', currentPanicHotkey)
  }

  try {
    if (currentFakeHotkey !== currentHotkey && currentFakeHotkey !== currentPanicHotkey) {
      globalShortcut.register(currentFakeHotkey, activateFakeWindow)
    }
  } catch(e) {
    console.log('Invalid fake hotkey:', currentFakeHotkey)
  }

  itemHotkeys.forEach((entry) => {
    if (!entry.hotkey || entry.hotkey === currentHotkey || entry.hotkey === currentPanicHotkey || entry.hotkey === currentFakeHotkey) return

    try {
      globalShortcut.register(entry.hotkey, () => openHotkeyItem(entry))
    } catch(e) {
      console.log('Invalid item hotkey:', entry.hotkey)
    }
  })
}

function resizePopup(height) {
  if (!popupWindow || popupWindow.isDestroyed()) return
  const display = screen.getDisplayMatching(popupWindow.getBounds())
  const maxHeight = Math.max(420, display.workArea.height - 40)
  const nextHeight = Math.min(Math.max(420, Math.ceil(height)), maxHeight)
  popupWindow.setSize(390, nextHeight)
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 750,
    minWidth: 420,
    minHeight: 500,
    resizable: true,
    icon: path.join(__dirname, 'school_linked.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })
  mainWindow.loadFile('index.html')

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('hotkey-update', currentHotkey, currentPanicHotkey, currentFakeHotkey, currentFakeWindow)
  })

  ipcMain.removeAllListeners('set-hotkey')
  ipcMain.removeAllListeners('set-panic-hotkey')
  ipcMain.removeAllListeners('set-fake-hotkey')
  ipcMain.removeHandler('get-open-windows')
  ipcMain.removeAllListeners('pick-exe')
  ipcMain.removeAllListeners('pick-exe-edit')
  ipcMain.removeAllListeners('pick-file')
  ipcMain.removeAllListeners('pick-file-edit')
  ipcMain.removeAllListeners('open-path')
  ipcMain.removeAllListeners('panic-now')
  ipcMain.removeAllListeners('fake-now')
  ipcMain.removeAllListeners('set-fake-window')
  ipcMain.removeAllListeners('resize-popup')
  ipcMain.removeAllListeners('register-item-hotkeys')

  ipcMain.on('set-hotkey', (event, key) => {
    currentHotkey = key
    saveSettings()
    registerHotkey()
    mainWindow.webContents.send('hotkey-update', currentHotkey, currentPanicHotkey, currentFakeHotkey, currentFakeWindow)
  })

  ipcMain.on('set-panic-hotkey', (event, key) => {
    currentPanicHotkey = key
    saveSettings()
    registerHotkey()
    mainWindow.webContents.send('hotkey-update', currentHotkey, currentPanicHotkey, currentFakeHotkey, currentFakeWindow)
  })

  ipcMain.on('set-fake-hotkey', (event, key) => {
    currentFakeHotkey = key
    saveSettings()
    registerHotkey()
    mainWindow.webContents.send('hotkey-update', currentHotkey, currentPanicHotkey, currentFakeHotkey, currentFakeWindow)
  })

  ipcMain.handle('get-open-windows', async () => {
    return listOpenWindows()
  })

  ipcMain.on('pick-exe', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select a Program',
      filters: [{ name: 'Programs', extensions: ['exe'] }],
      properties: ['openFile']
    })
    if (!result.canceled && result.filePaths.length > 0) {
      event.reply('exe-picked', result.filePaths[0])
    }
  })

  ipcMain.on('pick-exe-edit', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select a Program',
      filters: [{ name: 'Programs', extensions: ['exe'] }],
      properties: ['openFile']
    })
    if (!result.canceled && result.filePaths.length > 0) {
      event.reply('exe-picked-edit', result.filePaths[0])
    }
  })

  ipcMain.on('pick-file', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select a File',
      filters: [
        { name: 'Documents', extensions: ['pdf', 'txt', 'doc', 'docx'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Text', extensions: ['txt'] },
        { name: 'Word', extensions: ['doc', 'docx'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (!result.canceled && result.filePaths.length > 0) {
      event.reply('file-picked', result.filePaths[0])
    }
  })

  ipcMain.on('pick-file-edit', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select a File',
      filters: [
        { name: 'Documents', extensions: ['pdf', 'txt', 'doc', 'docx'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Text', extensions: ['txt'] },
        { name: 'Word', extensions: ['doc', 'docx'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (!result.canceled && result.filePaths.length > 0) {
      event.reply('file-picked-edit', result.filePaths[0])
    }
  })

  ipcMain.on('open-path', (event, filePath) => {
    shell.openPath(filePath)
  })

  ipcMain.on('panic-now', () => {
    runPanicMode()
  })

  ipcMain.on('fake-now', () => {
    activateFakeWindow()
  })

  ipcMain.on('set-fake-window', (event, win) => {
    currentFakeWindow = win || null
    saveSettings()
    mainWindow.webContents.send('hotkey-update', currentHotkey, currentPanicHotkey, currentFakeHotkey, currentFakeWindow)
  })

  ipcMain.on('resize-popup', (event, height) => {
    resizePopup(height)
  })

  ipcMain.on('register-item-hotkeys', (event, hotkeys) => {
    itemHotkeys = Array.isArray(hotkeys) ? hotkeys : []
    registerHotkey()
  })

  mainWindow.on('close', () => {
    globalShortcut.unregisterAll()
    app.quit()
  })
}

function createPopup() {
  popupWindow = new BrowserWindow({
    width: 390,
    height: 520,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    transparent: true,
    icon: path.join(__dirname, 'school_linked.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })
  popupWindow.loadFile('index.html', { query: { popup: 'true' } })

  popupWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  popupWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  popupWindow.webContents.on('did-finish-load', () => {
    popupWindow.webContents.insertCSS('html, body, #popupView, .popup-container { overflow: hidden !important; }')
    resizePopup(520)
  })

  popupWindow.on('blur', () => {
    popupWindow.hide()
  })
}

app.whenReady().then(() => {
  createMainWindow()
  createPopup()
  registerHotkey()
})

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll()
  if (process.platform !== 'darwin') app.quit()
})
