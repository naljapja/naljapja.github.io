const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];

// Run the real page code with an isolated DOM, local clock and Firebase stub.
// No network imports or live Firebase reads/writes are used by these tests.
function page() {
  let now = new Date(2026, 9, 15, 23, 59, 30).getTime();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.attributes = {};
      this.events = {};
      this.style = {};
      this.className = '';
      this.ownText = '';
      this.classList = {
        add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(' ').filter(x => !names.includes(x)).join(' '); },
      };
    }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; this.ownText = ''; }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === 'disabled') this.disabled = true;
    }
    addEventListener(name, fn) { this.events[name] = fn; }
    contains(node) { return this === node || this.children.some(x => x.contains(node)); }
    matches(selector) { return selector.split(', ').includes(this.tagName); }
    get textContent() { return this.ownText + this.children.map(x => x.textContent).join(''); }
    set textContent(text) { this.ownText = String(text); this.children = []; }
  }
  const app = new Element('main'), toast = new Element('div');
  const local = new Map(), intervals = [], writes = [];
  const document = {
    activeElement: null,
    getElementById: id => id === 'app' ? app : id === 'toast' ? toast : new Element('canvas'),
    createElement: tag => new Element(tag),
    createTextNode: text => { const node = new Element('#text'); node.textContent = text; return node; },
    addEventListener() {},
  };
  const firebase = {
    db: {},
    doc: (...parts) => parts,
    FieldPath: class { constructor(...parts) { this.parts = parts; } },
    serverTimestamp: () => 'SERVER_TIMESTAMP',
    updateDoc: async (...args) => { writes.push(args); },
    runTransaction: async (_, callback) => callback({
      get: async () => ({ exists: () => true, data: () => api.S.ev }),
      update: (...args) => { writes.push(args); },
    }),
  };
  const context = vm.createContext({
    console, Date: Clock, Node: Element, document, URLSearchParams,
    window: { scrollTo() {}, scrollY: 0, addEventListener() {}, removeEventListener() {}, confirm: () => true },
    location: { search: '', pathname: '/', origin: 'https://example.test' },
    localStorage: { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value) },
    navigator: {}, matchMedia: () => ({ matches: true }),
    setInterval: fn => { intervals.push(fn); return intervals.length; },
    setTimeout: () => 1, clearTimeout() {},
    __firebase: firebase,
  });
  vm.runInContext(source + '\nFB = __firebase; globalThis.__api = { S, stats, result, openPick };', context);
  const api = context.__api;
  function walk(root = app) { return [root, ...root.children.flatMap(walk)]; }
  function findButton(text) {
    const found = walk().find(x => x.tagName === 'button' && x.textContent === text);
    assert.ok(found, `button exists: ${text}`);
    return found;
  }
  function day(key) {
    const label = vm.runInContext(`fmt('${key}')`, context);
    const found = walk().find(x => x.tagName === 'button' && x.className.split(' ').includes('day') && x.attributes['aria-label'].startsWith(label));
    assert.ok(found, `day exists: ${key}`);
    return found;
  }
  return {
    api, app, toast, context, writes, intervals, findButton, day,
    click: node => node.events.click({ currentTarget: node }),
    nextDay: () => { now = new Date(2026, 9, 16, 0, 0, 30).getTime(); },
    setEvent(overrides = {}) {
      api.S.id = 'testevent1234';
      api.S.ev = {
        title: '테스트 약속', start: '2026-10-15', end: '2026-10-22',
        members: [{ id: 'm1', name: '가람', req: true }, { id: 'm2', name: '나래' }],
        responses: {}, fixed: null, closed: false, deadline: null,
        ...overrides,
      };
      api.S.wasFinal = api.stats(api.S.ev).final;
    },
  };
}

test('a past fixed date still shows everyone who selected it as available', () => {
  const p = page();
  p.nextDay();
  p.setEvent({ fixed: '2026-10-15', responses: { m1: { dates: ['2026-10-15'] }, m2: { dates: ['2026-10-15'] } } });
  assert.equal(p.api.stats(p.api.S.ev).rows.length, 0);
  const text = p.api.result().textContent;
  assert.ok(text.includes('이날 다 같이 볼 수 있어요!'));
  assert.ok(!text.includes('빼고'));
});

test('a past fixed date reports only unavailable responders and preserves required-member status', () => {
  const p = page();
  p.nextDay();
  p.setEvent({ fixed: '2026-10-15', responses: { m1: { dates: ['2026-10-15'] }, m2: { dates: [] } } });
  const text = p.api.result().textContent;
  assert.ok(text.includes('나래 빼고 · 필참 인원은 모두 돼요'));
  assert.ok(!text.includes('가람, 나래 빼고'));
});

test('the minute timer refreshes a picker at midnight even when final stays false', () => {
  const p = page();
  p.setEvent();
  p.api.openPick('m1');
  assert.ok(!p.day('2026-10-15').disabled);
  p.nextDay();
  p.intervals[0]();
  assert.equal(p.api.S.wasFinal, false);
  assert.equal(p.day('2026-10-15').disabled, true);
  assert.ok(p.day('2026-10-16').className.split(' ').includes('today'));
});

test('a stale day button cannot select yesterday before the timer runs', () => {
  const p = page();
  p.setEvent();
  p.api.openPick('m1');
  const oldButton = p.day('2026-10-15');
  p.nextDay();
  p.click(oldButton);
  assert.equal(p.api.S.sel.size, 0);
  assert.ok(p.toast.textContent.includes('지난 날짜'));
  assert.equal(p.day('2026-10-15').disabled, true);
});

test('a stale select-all button selects only dates that are still current', () => {
  const p = page();
  p.setEvent();
  p.api.openPick('m1');
  const oldButton = p.findButton('전체 선택');
  p.nextDay();
  p.click(oldButton);
  assert.ok(!p.api.S.sel.has('2026-10-15'));
  assert.equal(p.api.S.sel.size, 7);
});

test('a stale weekday shortcut skips the newly past date', () => {
  const p = page();
  p.setEvent();
  p.api.openPick('m1');
  const weekday = p.findButton('목');
  p.nextDay();
  p.click(weekday);
  assert.deepEqual([...p.api.S.sel], ['2026-10-22']);
});

test('save removes newly expired unsaved dates, tells the user, and requires confirmation again', async () => {
  const p = page();
  p.setEvent();
  p.api.openPick('m1');
  p.click(p.day('2026-10-15'));
  p.click(p.day('2026-10-16'));
  const save = p.findButton('선택 저장하기 (2일)');
  p.nextDay();
  await p.click(save);
  assert.equal(p.writes.length, 0);
  assert.deepEqual([...p.api.S.sel], ['2026-10-16']);
  assert.ok(p.toast.textContent.includes('다시 저장'));
  await p.click(p.findButton('선택 저장하기 (1일)'));
  assert.equal(p.writes.length, 1);
  assert.deepEqual(Array.from(p.writes[0][2].dates), ['2026-10-16']);
});

test('saved historical dates survive an ordinary response edit', async () => {
  const p = page();
  p.nextDay();
  p.setEvent({ responses: { m1: { dates: ['2026-10-15'] } } });
  p.api.openPick('m1');
  p.click(p.day('2026-10-16'));
  await p.click(p.findButton('선택 저장하기 (2일)'));
  assert.equal(p.writes.length, 1);
  assert.deepEqual(Array.from(p.writes[0][2].dates), ['2026-10-15', '2026-10-16']);
});

test('save rechecks the date after Firebase initialization crosses midnight', async () => {
  const p = page();
  p.setEvent();
  p.api.openPick('m1');
  p.click(p.day('2026-10-15'));
  let ready;
  p.context.__ready = new Promise(resolve => { ready = resolve; });
  vm.runInContext('fb = async () => { await __ready; return FB; };', p.context);
  const saving = p.click(p.findButton('선택 저장하기 (1일)'));
  p.nextDay();
  ready();
  await saving;
  assert.equal(p.writes.length, 0);
  assert.equal(p.api.S.saving, false);
  assert.equal(p.api.S.sel.size, 0);
  assert.equal(p.api.S.confirmEmpty, false);
  assert.ok(p.toast.textContent.includes('다시 저장'));
});
