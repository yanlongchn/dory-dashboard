import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('../theme.js', import.meta.url), 'utf8');
function page({saved, dark = false, blocked = false} = {}) {
  const attributes = {}, events = {}, values = new Map(saved === undefined ? [] : [['dory-color-theme', saved]]);
  const system = {matches: dark, addEventListener(_, fn) {this.change = fn;}};
  const button = {setAttribute(name, value) {attributes[name] = value;}};
  const meta = {setAttribute(_, value) {this.color = value;}};
  const document = {documentElement: {dataset: {}}, getElementById() {return button;}, querySelector() {return meta;}};
  const localStorage = {getItem(key) {if (blocked) throw Error('storage denied'); return values.get(key);},
    setItem(key, value) {if (blocked) throw Error('storage denied'); values.set(key, value);}};
  const context = vm.createContext({document, localStorage, matchMedia: () => system, addEventListener(name, fn) {events[name] = fn;}});
  vm.runInContext(source, context);
  return {theme: context.DoryTheme, system, values, button, attributes, meta, events};
}
test('first paint follows system; stored manual choice survives reload and overrides later system changes', () => {
  const fresh = page({dark: true});assert.equal(fresh.theme.current(), 'dark');assert.equal(fresh.meta.color, '#101d27');
  fresh.system.matches = false;fresh.system.change();assert.equal(fresh.theme.current(), 'light');
  fresh.theme.toggle();assert.equal(fresh.values.get('dory-color-theme'), 'dark');
  fresh.system.change();assert.equal(fresh.theme.current(), 'dark');
  assert.equal(page({saved: fresh.values.get('dory-color-theme'), dark: false}).theme.current(), 'dark');
  assert.equal(page({saved: 'light', dark: true}).theme.current(), 'light');
});
test('switching with denied storage still works and exposes the correct button and browser colors', () => {
  const p = page({blocked: true});p.theme.toggle();assert.equal(p.theme.current(), 'dark');
  assert.equal(p.attributes['aria-pressed'], 'true');assert.equal(p.button.textContent, '☾ 夜间');
  p.theme.toggle();assert.equal(p.attributes['aria-pressed'], 'false');assert.equal(p.meta.color, '#f7f6f2');
});
test('other tabs sync valid preferences; clearing or invalid storage falls back to system', () => {
  const p = page({saved: 'light', dark: true});p.events.storage({key: 'unrelated', newValue: 'dark'});assert.equal(p.theme.current(), 'light');
  p.events.storage({key: 'dory-color-theme', newValue: 'dark'});assert.equal(p.theme.current(), 'dark');
  p.events.storage({key: null, newValue: null});assert.equal(p.theme.current(), 'dark');
  assert.equal(page({saved: 'invalid', dark: false}).theme.current(), 'light');
});
test('theme changes notify chart rendering without requiring a data fetch', () => {
  const p = page();let draws = 0;const unsubscribe = p.theme.subscribe(() => draws++);
  p.theme.toggle();assert.equal(draws, 1);unsubscribe();p.theme.toggle();assert.equal(draws, 1);
});
