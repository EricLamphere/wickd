// Injected only into the throwaway frontend build made by shotctl.py; never
// part of the product. Long-polls the controller for JS to run inside the real
// WKWebView (nothing else can automate it on macOS) and offers small helpers.
(() => {
  const CONTROLLER = '__CONTROLLER__';
  // Lets the controller stop handing commands to a page that's navigating away.
  const PAGE = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const nativeFetch = window.fetch.bind(window);
  let inflight = 0;
  let lastActivity = Date.now();

  window.fetch = async (...args) => {
    inflight += 1;
    lastActivity = Date.now();
    try {
      return await nativeFetch(...args);
    } finally {
      inflight -= 1;
      lastActivity = Date.now();
    }
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };

  const ownText = (el) => (el.innerText ?? el.textContent ?? '').trim().replace(/\s+/g, ' ');

  const INTERACTIVE = 'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="option"], label, summary';

  /** The innermost visible element whose text matches, preferring exact matches and controls. */
  function byText(text, { within = document.body, exact = false, nth = 0 } = {}) {
    const wanted = text.toLowerCase();
    const matches = (el, strict) => {
      const value = ownText(el).toLowerCase();
      return strict ? value === wanted : value.includes(wanted);
    };
    const search = (strict) => {
      const all = [...within.querySelectorAll('*')].filter((el) => visible(el) && matches(el, strict));
      return all.filter((el) => ![...el.children].some((child) => visible(child) && matches(child, strict)));
    };
    const exactHits = search(true);
    const hits = exactHits.length || exact ? exactHits : search(false);
    const controls = hits.filter((el) => el.closest(INTERACTIVE));
    const chosen = (controls.length ? controls : hits)[nth];
    return chosen ? chosen.closest(INTERACTIVE) ?? chosen : null;
  }

  function find(target) {
    if (typeof target === 'string') return byText(target);
    const within = target.within ? find(target.within) : document;
    if (!within) return null;
    if (target.text) {
      return byText(target.text, {
        within: within === document ? document.body : within,
        exact: target.exact,
        nth: target.nth ?? 0,
      });
    }
    return [...within.querySelectorAll(target.sel)].filter(visible)[target.nth ?? 0] ?? null;
  }

  async function waitFor(check, timeout = 20000, label = 'condition') {
    const started = Date.now();
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
      await sleep(100);
    }
  }

  const describe = (target) => JSON.stringify(target);

  const wait = (target, timeout) => waitFor(() => find(target), timeout, describe(target));

  const waitGone = (target, timeout) => waitFor(() => !find(target), timeout, `${describe(target)} to go away`);

  function fireMouse(el, { meta = false, button = 0 } = {}) {
    const rect = el.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      view: window,
      button,
      metaKey: meta,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    el.dispatchEvent(new PointerEvent('pointerover', init));
    el.dispatchEvent(new MouseEvent('mouseover', init));
    el.dispatchEvent(new PointerEvent('pointerdown', init));
    el.dispatchEvent(new MouseEvent('mousedown', init));
    el.dispatchEvent(new PointerEvent('pointerup', init));
    el.dispatchEvent(new MouseEvent('mouseup', init));
    el.dispatchEvent(new MouseEvent(button === 2 ? 'contextmenu' : 'click', init));
  }

  async function click(target, options = {}) {
    const el = await wait(target, options.timeout);
    fireMouse(el, options);
    return ownText(el).slice(0, 80);
  }

  async function type(target, text, { enter = false, timeout } = {}) {
    const el = await wait(target, timeout);
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (enter) key('Enter', {}, el);
    return true;
  }

  function key(name, { meta = false, shift = false } = {}, on = document.activeElement ?? window) {
    const init = { key: name, code: name, bubbles: true, cancelable: true, metaKey: meta, shiftKey: shift };
    on.dispatchEvent(new KeyboardEvent('keydown', init));
    on.dispatchEvent(new KeyboardEvent('keyup', init));
    return true;
  }

  /**
   * Requests idle, fonts loaded, no spinner, and on-screen text unchanged for `quiet` ms. The text
   * check catches streams: a fetch resolves at its headers, long before an answer finishes.
   */
  async function settle({ timeout = 30000, quiet = 1200 } = {}) {
    await document.fonts.ready;
    const spinning = () => [...document.querySelectorAll('.animate-spin')].some(visible);
    let text = '';
    let textChanged = Date.now();
    await waitFor(
      () => {
        const now = document.body.innerText;
        if (now !== text) {
          text = now;
          textChanged = Date.now();
        }
        const quietSince = Math.max(lastActivity, textChanged);
        return inflight === 0 && !spinning() && Date.now() - quietSince > quiet;
      },
      timeout,
      'the page to settle',
    );
    return true;
  }

  const api = async (method, path, body) => {
    const res = await nativeFetch(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  /** What's on screen, for working out a shot's steps without an image. */
  const outline = () => ({
    url: location.pathname + location.search,
    buttons: [...document.querySelectorAll('button, [role="tab"], a')]
      .filter(visible)
      .map(ownText)
      .filter(Boolean)
      .slice(0, 120),
  });

  window.__shot = { sleep, byText, find, wait, waitGone, waitFor, click, type, key, settle, api, outline };

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

  async function runCommand({ id, js }) {
    let reply;
    try {
      const value = await new AsyncFunction('shot', js)(window.__shot);
      reply = { id, ok: true, value: value === undefined ? null : value };
    } catch (error) {
      reply = { id, ok: false, error: String(error && error.message ? error.message : error) };
    }
    await nativeFetch(`${CONTROLLER}/result`, { method: 'POST', body: JSON.stringify({ ...reply, page: PAGE }) });
  }

  async function poll() {
    for (;;) {
      try {
        const res = await nativeFetch(`${CONTROLLER}/next?page=${PAGE}`);
        if (res.status === 200) void runCommand(await res.json());
      } catch {
        await sleep(500);
      }
    }
  }

  void poll();
})();
