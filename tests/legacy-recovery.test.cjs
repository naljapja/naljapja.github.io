const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const eventId = 'ot4cdm8zd2mk';
const firstKey = 'RecoveryKey_1234567890-abcd';
const secondKey = 'CorrectKey_1234567890-efgh';
const clone = value => JSON.parse(JSON.stringify(value));
const original = () => [
  { id: 'other1234567', title: 'Other event', start: '2026-10-15', end: '2026-12-31', key: 'other-existing-key', extra: { keep: true } },
  { id: eventId, title: 'Old event', start: '2026-10-15', end: '2026-12-31', extra: ['keep', 42] },
];

// Execute the real page with in-memory browser primitives. Every server entry
// point is a trap, so these checks cannot contact or modify a live event.
function page(records = original()) {
  class Element {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.attributes = {}; this.events = {};
      this.style = {}; this.className = ''; this.ownText = ''; this.value = '';
      this.classList = { add() {}, remove() {} };
    }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; this.ownText = ''; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(name, fn) { this.events[name] = fn; }
    blur() {}
    contains(node) { return this === node || this.children.some(x => x.contains(node)); }
    matches(selector) { return selector.split(', ').includes(this.tagName); }
    get textContent() { return this.ownText + this.children.map(x => x.textContent).join(''); }
    set textContent(value) { this.ownText = String(value); this.children = []; }
  }
  const app = new Element('main'), toast = new Element('div');
  const local = new Map([['yaksok:hosted', JSON.stringify(records)]]);
  const calls = [], storage = { fail: false, writes: 0 };
  const serverTrap = name => (...args) => { calls.push({ name, args }); throw new Error('Unexpected server access: ' + name); };
  const context = vm.createContext({
    console, Node: Element, URLSearchParams,
    document: {
      activeElement: null,
      getElementById: id => id === 'app' ? app : toast,
      createElement: tag => new Element(tag),
      createTextNode: text => { const node = new Element('#text'); node.textContent = text; return node; },
      addEventListener() {},
    },
    localStorage: {
      getItem: key => local.get(key) ?? null,
      setItem(key, value) {
        storage.writes++;
        if (storage.fail) throw new Error('Storage quota exceeded');
        local.set(key, value);
      },
    },
    window: { scrollTo() {}, scrollY: 0 },
    location: { search: '', pathname: '/', origin: 'https://example.test' },
    navigator: {}, matchMedia: () => ({ matches: true }),
    setInterval() {}, setTimeout() { return 1; }, clearTimeout() {},
    __fb: serverTrap('fb'),
    __firebase: Object.fromEntries(['setDoc', 'getDoc', 'updateDoc', 'deleteDoc', 'runTransaction', 'onSnapshot', 'writeBatch'].map(name => [name, serverTrap(name)])),
  });
  vm.runInContext(source + '\nFB = __firebase; fb = __fb; globalThis.__api = { S, restoreHostKey, isHost, hostKey, hostPanel, hostKeyRecovery, created, stats };', context);
  const api = context.__api;
  api.S.id = eventId;
  api.S.ev = {
    title: 'Old event', start: '2026-10-15', end: '2026-12-31',
    members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], responses: {},
    fixed: null, closed: false, deadline: null,
  };
  return { api, app, toast, context, calls, local, storage,
    records: () => JSON.parse(local.get('yaksok:hosted')),
    run: code => vm.runInContext(code, context),
  };
}
function walk(root) { return [root, ...root.children.flatMap(walk)]; }
function userError(error) { return !!(error && typeof error.userMessage === 'string' && error.userMessage.length); }

test('restoring an old host record stores a trimmed key and preserves all metadata and other events', () => {
  const p = page(), before = p.records();
  assert.equal(p.api.isHost(), true);
  assert.equal(p.api.hostKey(), null);
  assert.equal(p.api.restoreHostKey(eventId, ' \n' + firstKey + '\t '), true);
  assert.equal(p.api.isHost(), true);
  assert.equal(p.api.hostKey(), firstKey);
  const expected = clone(before); expected[1].key = firstKey;
  assert.deepEqual(p.records(), expected);
  assert.deepEqual(p.calls, []);
});

test('a recovery cannot target another event or create a host record for a visitor', () => {
  for (const { records, id } of [
    { records: original(), id: 'other1234567' },
    { records: [], id: eventId },
    { records: original().slice(0, 1), id: eventId },
  ]) {
    const p = page(records), before = p.local.get('yaksok:hosted');
    assert.throws(() => p.api.restoreHostKey(id, firstKey), userError);
    assert.equal(p.local.get('yaksok:hosted'), before);
    assert.equal(p.storage.writes, 0);
    assert.deepEqual(p.calls, []);
  }
});

test('recovery rejects malformed keys and enforces both length boundaries without changing storage', () => {
  const invalid = ['', ' '.repeat(30), 'a'.repeat(19), 'a'.repeat(129),
    'a'.repeat(20) + '/', 'a'.repeat(20) + '=', 'a'.repeat(20) + '\nb',
    '가'.repeat(24), null, undefined, 12345, { key: firstKey }];
  for (const key of invalid) {
    const p = page(), before = p.local.get('yaksok:hosted');
    assert.throws(() => p.api.restoreHostKey(eventId, key), userError, 'rejects ' + String(key));
    assert.equal(p.local.get('yaksok:hosted'), before);
    assert.equal(p.storage.writes, 0);
  }
  for (const key of ['A_-'.repeat(6) + '12', 'A'.repeat(128)]) {
    const p = page();
    assert.equal(p.api.restoreHostKey(eventId, key), true);
    assert.equal(p.api.hostKey(), key);
  }
});

test('storage denial reports a user error and leaves the existing host records intact', () => {
  const p = page(), before = p.local.get('yaksok:hosted');
  p.storage.fail = true;
  assert.throws(() => p.api.restoreHostKey(eventId, firstKey), userError);
  assert.equal(p.local.get('yaksok:hosted'), before);
  assert.equal(p.api.hostKey(), null);
  assert.deepEqual(p.calls, []);
});

test('a mistyped but well-formed key can be replaced without losing records or accessing Firebase', () => {
  const p = page(), before = p.records();
  p.api.restoreHostKey(eventId, firstKey);
  p.api.restoreHostKey(eventId, secondKey);
  const expected = clone(before); expected[1].key = secondKey;
  assert.equal(p.api.hostKey(), secondKey);
  assert.deepEqual(p.records(), expected);
  assert.deepEqual(p.calls, []);
});

test('a keyless host sees recovery guidance and a masked key input instead of a silent missing delete control', () => {
  const p = page(), panel = p.api.hostPanel(p.api.stats(p.api.S.ev));
  const nodes = walk(panel);
  assert.equal(nodes.some(x => x.tagName === 'button' && x.textContent === '약속 삭제'), false);
  assert.ok(nodes.some(x => x.tagName === 'form'), 'recovery form is visible');
  assert.match(panel.textContent, /복구/);
  assert.match(panel.textContent, /관리자|관리 키|관리 열쇠|삭제 열쇠/);
  const input = nodes.find(x => x.tagName === 'input' && x.attributes.type === 'password');
  assert.ok(input, 'the recovery key is masked');
  assert.equal(input.attributes.autocomplete, 'off');
  assert.equal(input.attributes.maxlength, '128');
  assert.deepEqual(p.calls, []);
});

test('storage failure keeps the entered recovery key in the form so the host can retry', () => {
  const p = page(), panel = p.api.hostPanel(p.api.stats(p.api.S.ev));
  const form = walk(panel).find(x => x.tagName === 'form');
  const input = walk(form).find(x => x.tagName === 'input' && x.attributes.type === 'password');
  input.value = firstKey; p.storage.fail = true;
  form.events.submit({ preventDefault() {}, currentTarget: form });
  assert.equal(input.value, firstKey);
  assert.equal(p.api.hostKey(), null);
  assert.equal(p.api.S.view, 'home', 'a failed recovery did not navigate away');
  assert.ok(panel.textContent.match(/저장|다시|실패/) || p.toast.textContent.match(/저장|다시|실패/), 'the host is told to retry');
  assert.deepEqual(p.calls, []);
});

test('submitting a recovery form reveals deletion locally and does not send the key to Firebase', () => {
  const p = page();
  p.api.S.view = 'intro'; p.api.S.hostOpen = true;
  p.run('render(false)');
  const form = walk(p.app).find(x => x.tagName === 'form');
  const input = walk(form).find(x => x.tagName === 'input' && x.attributes.type === 'password');
  input.value = firstKey;
  form.events.submit({ preventDefault() {}, currentTarget: form });
  assert.equal(input.value, '', 'the old input no longer retains a submitted secret');
  assert.equal(p.api.hostKey(), firstKey);
  assert.ok(walk(p.app).some(x => x.tagName === 'button' && x.textContent === '약속 삭제'));
  assert.deepEqual(p.calls, []);
});

test('a keyed host has a delete control and a collapsed recovery entry for correcting its key', () => {
  const records = original(); records[1].key = firstKey;
  const p = page(records), panel = p.api.hostPanel(p.api.stats(p.api.S.ev));
  assert.ok(walk(panel).some(x => x.tagName === 'button' && x.textContent === '약속 삭제'));
  const recovery = walk(panel).find(x => x.tagName === 'details' && x !== panel && walk(x).some(y => y.tagName === 'form'));
  assert.ok(recovery, 'key replacement remains reachable');
  assert.equal(recovery.attributes.open, undefined, 'replacement starts collapsed');
  assert.deepEqual(p.calls, []);
});

test('the creation-complete screen provides an immediate route to the expanded host menu', () => {
  const p = page(), screen = p.api.created();
  const button = walk(screen).find(x => x.tagName === 'button' && x.textContent === '주최자 메뉴 열기');
  assert.ok(button, 'host menu can be opened without revisiting the link');
  button.events.click({ currentTarget: button });
  assert.equal(p.api.S.view, 'intro');
  assert.equal(p.api.S.hostOpen, true);
  assert.ok(walk(p.app).some(x => x.tagName === 'details' && x.attributes.open === ''));
  assert.deepEqual(p.calls, []);
});
