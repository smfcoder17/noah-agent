// Doublure des surfaces Electron seulement : actions.js et bandeau.js restent les vrais modules.
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

export function fakeElectron() {
  const alive = (object) => {
    if (object.isDestroyed()) throw new TypeError("Object has been destroyed");
  };
  const handlers = new Map(), notices = [];
  let view;
  const windows = [];
  const createWindow = () => {
    const children = new Set();
    const contentView = Object.assign(new EventEmitter(), {
      children,
      addChildView: (v) => { alive(window); if (v.options?.webPreferences) view = v; children.add(v); },
      removeChildView: (v) => { alive(window); return children.delete(v); },
    });
    const window = Object.assign(new EventEmitter(), {
      webContents: Object.assign(new EventEmitter(), { destroyed: false, isDestroyed() { return this.destroyed; } }),
      contentView, size: [1000, 800], destroyed: false,
      getContentSize() { alive(this); return this.size; },
      isMinimized() { alive(this); return false; }, isDestroyed() { return this.destroyed; },
      show() { alive(this); this.shown = true; }, focus() { alive(this); this.focused = true; }, restore() { alive(this); },
      // closed arrive après la destruction native ; les WebContentsView se ferment séparément.
      destroy() { if (this.destroyed) return; this.destroyed = true; this.webContents.destroyed = true; this.emit("closed"); },
    });
    const page = { webContents: window.webContents, setBounds(bounds) { alive(window); alive(this.webContents); this.bounds = bounds; } };
    children.add(page);
    windows.push(window);
    return window;
  };
  const win = createWindow();
  const mock = {
    win, createWindow, handlers, notices, onRequest: () => {}, get view() { return view; },
    event: () => ({ sender: view.webContents, senderFrame: view.webContents.mainFrame }),
    answer: (id, response, event = mock.event()) => handlers.get("noah:accord")(event, id, response),
    ipcMain: { handle: (name, fn) => {
      if (handlers.has(name)) throw new Error(`Handler déjà enregistré : ${name}`);
      handlers.set(name, fn);
    }, removeHandler: (name) => handlers.delete(name) },
    WebContentsView: class {
      constructor(options) {
        this.options = options;
        // Comme Electron : un webContents déjà attaché ne s'adopte pas après coup.
        if (options.webContents) throw new Error("options.webContents is already attached to a window");
        const ses = {
          clearStorageData: async () => { ses.cleared = true; },
          setPermissionRequestHandler: (fn) => { ses.requestPermission = fn; },
          setPermissionCheckHandler: (fn) => { ses.checkPermission = fn; },
          webRequest: { onBeforeRequest: (fn) => { ses.beforeRequest = fn; } },
        };
        this.webContents = Object.assign(new EventEmitter(), {
          session: ses, mainFrame: { url: "" }, isDestroyed: () => Boolean(this.closed),
          setWindowOpenHandler: (fn) => { this.openHandler = fn; },
          loadFile: async (file) => { this.webContents.mainFrame.url = pathToFileURL(file).href; this.file = file; },
          send: (name, state) => { alive(this.webContents); if (name === "noah:bandeau" && state) mock.onRequest(state); },
          focus: () => { alive(this.webContents); this.focused = true; },
          close: () => { alive(this.webContents); this.closed = true; this.webContents.emit("destroyed"); },
        });
      }
      setBounds(bounds) { alive(this.webContents); this.bounds = bounds; }
      setVisible(visible) { alive(this.webContents); this.visible = visible; }
    },
    BrowserWindow: { getAllWindows: () => windows },
    clipboard: { writeText() {} },
    dialog: new Proxy({}, { get: () => () => { throw new Error("Aucun dialog ne doit être appelé"); } }),
    Notification: class extends EventEmitter {
      constructor(options) { super(); this.options = options; notices.push(this); }
      show() {} close() { this.closed = true; }
    },
    session: { defaultSession: { cookies: { get: async () => [{ value: "jeton-natif" }] } } },
    shell: {},
  };
  return mock;
}
