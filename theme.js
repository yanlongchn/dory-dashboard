(function (root) {
  'use strict';
  const key = 'dory-color-theme';
  const valid = value => value === 'light' || value === 'dark';
  let choice = null, system = null;
  const listeners = new Set();
  try { const saved = root.localStorage?.getItem(key); if (valid(saved)) choice = saved; } catch (_) {}
  try { system = root.matchMedia?.('(prefers-color-scheme: dark)'); } catch (_) {}
  const systemTheme = () => system?.matches ? 'dark' : 'light';
  function current() { return root.document.documentElement.dataset.theme; }
  function syncButton() {
    const button = root.document.getElementById('themeToggle');
    if (!button) return;
    const dark = current() === 'dark';
    button.textContent = dark ? '☾ 夜间' : '☀ 日间';
    button.setAttribute('aria-pressed', String(dark));
    button.title = dark ? '切换到日间配色' : '切换到夜间配色';
  }
  function apply(value, persist = false) {
    if (!valid(value)) return;
    if (persist) {
      choice = value;
      try { root.localStorage?.setItem(key, value); } catch (_) {}
    }
    root.document.documentElement.dataset.theme = value;
    root.document.querySelector('meta[name="theme-color"]')?.setAttribute('content', value === 'dark' ? '#101d27' : '#f7f6f2');
    syncButton();
    listeners.forEach(listener => listener(value));
  }
  apply(choice || systemTheme()); // Runs in <head> before the first styled paint.
  system?.addEventListener?.('change', () => { if (!choice) apply(systemTheme()); });
  root.addEventListener?.('storage', event => {
    if (event.key !== key && event.key !== null) return;
    choice = valid(event.newValue) ? event.newValue : null;
    apply(choice || systemTheme());
  });
  root.DoryTheme = {current, syncButton, toggle: () => apply(current() === 'dark' ? 'light' : 'dark', true),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }};
})(globalThis);
