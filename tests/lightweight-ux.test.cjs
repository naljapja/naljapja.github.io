const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const id = 'fixture12345';
const ownerKey = 'OwnerKey_1234567890-abcd';
const fixture = () => ({
  title: '가벼운 약속', start: '2026-10-16', end: '2026-10-23',
  members: [{ id: 'a', name: '가람' }, { id: 'b', name: '나래' }, { id: 'c', name: '다솜' }],
  responses: {}, fixed: null, closed: false, deadline: null,
});

// All browser and database primitives are isolated in memory. These tests execute
// the real module without loading any SDK or accessing a production document.
function page({ records = [], initial = fixture() } = {}) {
  class Element {
    constructor(tag) {
      Object.assign(this, { tagName: tag, children: [], attributes: {}, events: {}, style: {}, dataset: {}, className: '', ownText: '', value: '', disabled: false });
      this.classList = {
        add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(' ').filter(x => !names.includes(x)).join(' '); },
      };
    }
    append(...nodes) { for (const node of nodes) node.parentNode = this; this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = []; this.ownText = ''; this.append(...nodes); }
    after(...nodes) { const parent = this.parentNode; if (parent) { const at = parent.children.indexOf(this); for (const node of nodes) node.parentNode = parent; parent.children.splice(at + 1, 0, ...nodes); } }
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'disabled') this.disabled = true; if (name === 'open') this.open = true; }
    addEventListener(name, fn) { this.events[name] = fn; }
    removeEventListener(name, fn) { if (this.events[name] === fn) delete this.events[name]; }
    contains(node) { return this === node || this.children.some(x => x.contains(node)); }
    matches(selector) { return selector.split(', ').includes(this.tagName); }
    blur() {}
    get textContent() { return this.ownText + this.children.map(x => x.textContent).join(''); }
    set textContent(value) { this.ownText = String(value); this.children = []; }
  }
  const app = new Element('main'), toast = new Element('div'), local = new Map([['yaksok:hosted', JSON.stringify(records)]]);
  const storage = { fail: false, discard: false }, listeners = new Map(), prompts = [], errors = [];
  const docs = new Map([['events/' + id, clone(initial)], ['hostkeys/' + id, { key: ownerKey }]]);
  const server = { commits: [], transactions: [], subscriptions: [], attempts: 0, batchAttempts: 0, error: null, onRead: null };
  let version = 0, random = 0;
  const apply = (ref, args, replace = false) => {
    let data = replace ? {} : clone(docs.get(ref) || {});
    const entries = args.length === 1 ? Object.entries(args[0]).map(([k, v]) => [k.split('.'), v]) : Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2].parts || String(args[i * 2]).split('.'), args[i * 2 + 1]]);
    for (const [parts, value] of entries) {
      let at = data;
      for (const part of parts.slice(0, -1)) at = at[part] ||= {};
      if (value && value.deleteSentinel) delete at[parts.at(-1)];
      else at[parts.at(-1)] = clone(value);
    }
    docs.set(ref, data);
  };
  const firebase = {
    db: {}, doc: (_, collection, key) => collection + '/' + key,
    FieldPath: class { constructor(...parts) { this.parts = parts; } },
    serverTimestamp: () => 'SERVER_TIMESTAMP', deleteField: () => ({ deleteSentinel: true }),
    onSnapshot(ref, options, next, error) {
      server.subscriptions.push({ ref, options, next, error });
      return () => {};
    },
    writeBatch() {
      const operations = [];
      return {
        set(ref, data) { operations.push({ ref, args: [data] }); },
        async commit() {
          server.batchAttempts++;
          server.beforeCommit?.(operations);
          if (server.error) throw server.error;
          for (const op of operations) apply(op.ref, op.args, true);
          version++; server.commits.push(operations);
        },
      };
    },
    async runTransaction(_, callback) {
      for (let retry = 0; retry < 10; retry++) {
        server.attempts++;
        let readVersion = version;
        const operations = [];
        const result = await callback({
          async get(ref) {
            readVersion = version;
            const data = clone(docs.get(ref));
            await server.onRead?.(ref, retry);
            return { exists: () => data != null, data: () => clone(data) };
          },
          update(ref, ...args) { operations.push({ ref, args }); },
          set(ref, data) { operations.push({ ref, args: [data], replace: true }); },
        });
        if (readVersion !== version) continue;
        if (server.error) throw server.error;
        for (const op of operations) apply(op.ref, op.args, op.replace);
        if (operations.length) { version++; server.transactions.push(operations); }
        return result;
      }
      throw new Error('transaction fixture exhausted retries');
    },
  };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [2026, 9, 16, 10])); } static now() { return new Date(2026, 9, 16, 10).getTime(); } }
  const context = vm.createContext({
    console: { error: e => errors.push(e) }, Date: Clock, Node: Element, URLSearchParams,
    document: {
      activeElement: null, body: new Element('body'),
      getElementById: key => key === 'app' ? app : toast,
      createElement: tag => new Element(tag), createTextNode: text => { const node = new Element('#text'); node.textContent = text; return node; },
      addEventListener(name, fn) { listeners.set('document:' + name, fn); },
    },
    window: {
      scrollTo() {}, scrollY: 0, confirm: message => { prompts.push(message); return context.__confirm; },
      addEventListener(name, fn) { listeners.set(name, fn); },
      removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    },
    location: { search: '', pathname: '/', origin: 'https://example.test' }, history: { replaceState() {} },
    localStorage: {
      getItem: key => local.get(key) ?? null,
      setItem(key, value) { if (storage.fail) throw new Error('Storage denied'); if (!storage.discard) local.set(key, value); },
    },
    crypto: { getRandomValues: array => { for (let i = 0; i < array.length; i++) array[i] = (random++ * 13 + i) % 256; return array; } },
    navigator: {}, matchMedia: () => ({ matches: true }), setInterval() {}, setTimeout: () => 1, clearTimeout() {},
    __confirm: true, __firebase: firebase,
  });
  vm.runInContext(source + '\nFB = __firebase; globalThis.__api = { S, stats, go, render, resetDraft, openPick, patch, addMember, removeMember, closeEvent, fixDate, setDeadline, reopenEvent, toggleReq, deleteEvent, confirmHosted, watch, normalize };', context);
  const api = context.__api;
  const run = code => vm.runInContext(code, context);
  const walk = (root = app) => [root, ...root.children.flatMap(walk)];
  const button = text => { const result = walk().find(x => x.tagName === 'button' && (typeof text === 'string' ? x.textContent === text : text.test(x.textContent))); assert.ok(result, 'button exists: ' + text); return result; };
  const click = node => node.events.click({ currentTarget: node });
  return {
    api, app, toast, context, storage, local, docs, server, listeners, prompts, errors, run, walk, button, click,
    records: () => JSON.parse(local.get('yaksok:hosted')),
    editDraft() {
      api.resetDraft(); Object.assign(api.S.draft, { title: '보존할 약속', start: '2026-10-16', end: '2026-10-23', names: ['가람', '나래'] });
      api.go('create');
    },
    openEvent(view = 'intro') {
      api.S.id = id; api.S.ev = clone(initial); api.S.wasFinal = api.stats(api.S.ev).final; api.go(view);
    },
    day(key) { const result = walk().find(x => x.tagName === 'button' && x.className.split(' ').includes('day') && x.attributes['aria-label']?.startsWith(run(`fmt('${key}')`))); assert.ok(result, 'day exists: ' + key); return result; },
  };
}
const ownerRecord = () => ({ id, key: ownerKey, title: '가벼운 약속', start: '2026-10-16', end: '2026-10-23' });
const userError = message => Object.assign(new Error(message), { code: 'permission-denied' });

test('creation refuses server writes when browser storage is blocked and preserves the draft and error', async () => {
  const p = page(); p.editDraft(); p.storage.fail = true;
  await p.click(p.button('약속 만들고 링크 받기'));
  assert.equal(p.server.batchAttempts, 0);
  assert.equal(p.api.S.view, 'create');
  assert.equal(p.api.S.draft.title, '보존할 약속');
  assert.deepEqual(Array.from(p.api.S.draft.names), ['가람', '나래']);
  assert.match(p.app.textContent, /저장 공간|브라우저.*저장|관리.*저장/);
  assert.equal(p.api.S.saving, false);
});

test('creation verifies a storage write by reading it back before committing remotely', async () => {
  const p = page(); p.editDraft(); p.storage.discard = true;
  await p.click(p.button('약속 만들고 링크 받기'));
  assert.equal(p.server.batchAttempts, 0);
  assert.equal(p.api.S.view, 'create');
  assert.match(p.app.textContent, /저장/);
});

test('a definite rejected creation keeps a persistent error and removes only its provisional key', async () => {
  const other = { ...ownerRecord(), id: 'other1234567', extra: { keep: true } };
  const p = page({ records: [other] }); p.editDraft(); p.server.error = userError('denied');
  await p.click(p.button('약속 만들고 링크 받기'));
  assert.equal(p.server.batchAttempts, 1);
  assert.equal(p.api.S.view, 'create');
  assert.equal(p.api.S.saving, false);
  assert.match(p.app.textContent, /만들지 못|저장하지 못|권한/);
  assert.deepEqual(p.records(), [other]);
  assert.equal(p.api.S.draft.title, '보존할 약속');
});

test('an ambiguous creation failure retains its management key and prevents a duplicate submission', async () => {
  const p = page(); p.editDraft(); p.server.error = Object.assign(new Error('network interrupted'), { code: 'unavailable' });
  let attempted;
  p.server.beforeCommit = ops => { attempted = ops; };
  await p.click(p.button('약속 만들고 링크 받기'));
  const publicWrite = attempted.find(op => op.ref.startsWith('events/'));
  const privateWrite = attempted.find(op => op.ref.startsWith('hostkeys/'));
  const createdId = publicWrite.ref.split('/')[1];
  const record = p.records().find(x => x.id === createdId);
  assert.equal(record.key, privateWrite.args[0].key);
  assert.equal(record.pending, true);
  assert.ok(!JSON.stringify(publicWrite.args).includes(record.key));
  assert.match(p.app.textContent, /확인|연결|다시/);
  await p.click(p.button(/약속 만들고 링크 받기|확인 중/));
  assert.equal(p.server.batchAttempts, 1, 'uncertain commit is not duplicated');
});

test('successful creation has a readable local management key before the atomic server commit', async () => {
  const p = page(); p.editDraft();
  p.server.beforeCommit = ops => {
    const pub = ops.find(op => op.ref.startsWith('events/'));
    const priv = ops.find(op => op.ref.startsWith('hostkeys/'));
    const record = p.records().find(x => x.id === pub.ref.split('/')[1]);
    assert.equal(record.key, priv.args[0].key);
    assert.ok(!JSON.stringify(pub.args).includes(record.key));
  };
  await p.click(p.button('약속 만들고 링크 받기'));
  assert.equal(p.server.commits.length, 1);
  assert.equal(p.api.S.view, 'created');
  assert.ok(p.records().find(x => x.id === p.api.S.id)?.key);
  assert.ok(!p.records().find(x => x.id === p.api.S.id)?.pending);
});

test('the home explains browser-local ownership and creation explains the two-person minimum', () => {
  const p = page({ records: [ownerRecord()] });
  assert.match(p.app.textContent, /이 브라우저에서 만든 약속/);
  p.editDraft();
  assert.match(p.app.textContent, /내 이름 포함.*2명|나를 포함.*2명/);
  const optional = p.walk().find(x => x.tagName === 'details' && /마감/.test(x.textContent));
  assert.ok(optional, 'optional deadline is collapsible');
  assert.ok(!optional.attributes.open, 'optional deadline starts collapsed');
});

test('a changed selection has an explicit save action and declining back navigation preserves it', () => {
  const p = page(); p.openEvent(); p.api.openPick('a');
  p.click(p.day('2026-10-17'));
  assert.ok(p.button('선택 저장하기 (1일)'));
  assert.match(p.app.textContent, /저장하지|미저장|아직.*저장|저장 전/);
  const unload = p.listeners.get('beforeunload');
  assert.equal(typeof unload, 'function');
  const e = { prevented: false, preventDefault() { this.prevented = true; } };
  unload(e); assert.equal(e.prevented, true);
  p.context.__confirm = false;
  p.click(p.button('‹ 뒤로'));
  assert.equal(p.api.S.view, 'pick');
  assert.deepEqual([...p.api.S.sel], ['2026-10-17']);
  assert.equal(p.prompts.length, 1);
});

test('a selection returned to its saved state does not trigger an unsaved-navigation warning', () => {
  const p = page({ initial: { ...fixture(), responses: { a: { dates: ['2026-10-17'] } } } });
  p.openEvent(); p.api.openPick('a');
  p.click(p.day('2026-10-17')); p.click(p.day('2026-10-17'));
  p.context.__confirm = false;
  p.click(p.button('‹ 뒤로'));
  assert.equal(p.api.S.view, 'who');
  assert.equal(p.prompts.length, 0);
});

test('saving a response clears the dirty state and allows navigation without warning', async () => {
  const p = page(); p.openEvent(); p.api.openPick('a');
  p.click(p.day('2026-10-17'));
  await p.click(p.button('선택 저장하기 (1일)'));
  assert.equal(p.api.S.view, 'done');
  assert.equal(p.prompts.length, 0);
  assert.deepEqual(p.docs.get('events/' + id).responses.a.dates, ['2026-10-17']);
  assert.ok(!p.listeners.has('beforeunload'));
});

test('a stale picker cannot write a response after that member is removed on the server', async () => {
  const p = page(); p.openEvent(); p.api.openPick('a');
  p.click(p.day('2026-10-17'));
  const current = p.docs.get('events/' + id); current.members = current.members.filter(m => m.id !== 'a');
  await p.click(p.button('선택 저장하기 (1일)'));
  assert.equal(p.server.transactions.length, 0);
  assert.equal(p.docs.get('events/' + id).responses.a, undefined);
  assert.match(p.toast.textContent, /명단|참여자|사람/);
});

test('a keyless host cannot change owner settings while an ordinary participant can still respond', async () => {
  const p = page({ records: [{ ...ownerRecord(), key: undefined }] }); p.openEvent();
  await p.api.closeEvent();
  await p.api.fixDate('2026-10-17');
  await p.api.setDeadline('2026-10-20');
  p.context.input = { value: '새이름' }; await p.run('addMember(input)');
  assert.equal(p.server.transactions.length, 0);
  assert.equal(p.docs.get('events/' + id).closed, false);
  assert.equal(p.context.input.value, '새이름');
  p.api.openPick('a'); p.click(p.day('2026-10-17'));
  await p.click(p.button('선택 저장하기 (1일)'));
  assert.equal(p.server.transactions.length, 1);
  assert.ok(p.server.transactions[0].every(op => op.ref.startsWith('events/')));
});

test('owner changes stamp a private document atomically without publishing the management secret', async () => {
  const p = page({ records: [ownerRecord()] }); p.openEvent();
  await p.api.patch({ closed: true });
  const tx = p.server.transactions[0];
  assert.equal(tx.length, 2);
  const proof = tx.find(op => op.ref === 'hostkeys/' + id);
  assert.deepEqual(Array.from(proof.args[0].parts), [ownerKey]);
  assert.equal(proof.args[1], 'SERVER_TIMESTAMP');
  assert.equal(p.docs.get('events/' + id).closed, true);
  assert.ok(!JSON.stringify(p.docs.get('events/' + id)).includes(ownerKey));
});

test('response saves reject missing and deleted server documents without recreating them', async () => {
  for (const gone of [null, { deleted: true }]) {
    const p = page(); p.openEvent(); p.api.openPick('a'); p.click(p.day('2026-10-17'));
    if (gone) p.docs.set('events/' + id, gone); else p.docs.delete('events/' + id);
    await p.click(p.button('선택 저장하기 (1일)'));
    assert.equal(p.server.transactions.length, 0);
    assert.deepEqual(p.docs.get('events/' + id) ?? null, gone);
    assert.match(p.toast.textContent, /약속|삭제|새로고침/);
  }
});

test('a response save racing a member removal cannot restore that member or leave an orphan response', async () => {
  for (const saveFirst of [true, false]) {
    const initial = fixture(); initial.responses.b = { dates: ['2026-10-18'] };
    const p = page({ records: [ownerRecord()], initial }); p.openEvent(); p.api.openPick('a'); p.click(p.day('2026-10-17'));
    p.context.removeButton = { dataset: { armed: '1' } };
    const save = () => p.click(p.button('선택 저장하기 (1일)'));
    const remove = () => p.run('removeMember(S.ev.members[0], removeButton)');
    await Promise.all(saveFirst ? [save(), remove()] : [remove(), save()]);
    const current = p.docs.get('events/' + id);
    assert.equal(current.members.some(m => m.id === 'a'), false);
    assert.equal(current.responses.a, undefined);
    assert.deepEqual(current.responses.b, { dates: ['2026-10-18'] });
    assert.ok(p.server.attempts > p.server.transactions.length, 'the fixture exercises a competing write and retry');
  }
});

test('all date editing shortcuts are inert while a response save is in progress', async () => {
  const p = page(); p.openEvent(); p.api.openPick('a'); p.click(p.day('2026-10-17'));
  const all = p.button('전체 선택'), clear = p.button('전체 해제'), weekday = p.button('월'), day = p.day('2026-10-18');
  let release, read;
  const waiting = new Promise(resolve => { read = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  p.server.onRead = async () => { read(); await delayed; };
  const saving = p.click(p.button('선택 저장하기 (1일)'));
  await waiting;
  p.click(day); p.click(all); p.click(clear); p.click(weekday);
  assert.deepEqual([...p.api.S.sel], ['2026-10-17']);
  release(); await saving;
  assert.deepEqual(p.docs.get('events/' + id).responses.a.dates, ['2026-10-17']);
});

test('authorized deletion atomically replaces personal event data with the existing deletion marker protocol', async () => {
  const initial = fixture(); initial.responses.a = { dates: ['2026-10-17'] };
  const p = page({ records: [ownerRecord()], initial }); p.openEvent();
  await p.api.deleteEvent({ dataset: { armed: '1' } });
  assert.equal(p.server.transactions.length, 1);
  assert.deepEqual(p.docs.get('events/' + id), { deleted: true, delKey: ownerKey, deletedAt: 'SERVER_TIMESTAMP' });
  assert.equal(p.records().some(x => x.id === id), false);
  assert.equal(p.api.S.view, 'home');
});

test('rejected deletion retains the event and local owner key and opens recovery guidance', async () => {
  const initial = fixture(), p = page({ records: [ownerRecord()], initial }); p.openEvent();
  p.server.error = userError('wrong key');
  await p.api.deleteEvent({ dataset: { armed: '1' } });
  assert.deepEqual(p.docs.get('events/' + id), initial);
  assert.equal(p.records()[0].key, ownerKey);
  assert.equal(p.api.S.deleting, false);
  assert.equal(p.api.S.hostOpen, true);
  assert.match(p.toast.textContent, /권한|복구/);
});

test('an owner operation cannot follow a delayed initialization into a different event', async () => {
  for (const kind of ['patch', 'delete']) {
    const p = page({ records: [ownerRecord()] }); p.openEvent();
    let ready;
    p.context.__ready = new Promise(resolve => { ready = resolve; });
    p.run('fb = async () => { await __ready; return FB; };');
    const pending = kind === 'patch' ? p.api.patch({ closed: true }).catch(error => error) : p.api.deleteEvent({ dataset: { armed: '1' } });
    p.api.S.id = 'other1234567'; ready(); await pending;
    assert.equal(p.server.transactions.length, 0);
    assert.deepEqual(p.docs.get('events/' + id), fixture());
    assert.equal(p.records()[0].key, ownerKey);
  }
});

test('a server-confirmed host record loses only its pending marker and keeps its key, metadata and position', () => {
  const first = { ...ownerRecord(), id: 'first1234567', pending: true };
  const middle = { ...ownerRecord(), pending: true, extra: { preserve: [1, 2] } };
  const last = { ...ownerRecord(), id: 'last12345678', key: 'another-owner-key' };
  const p = page({ records: [first, middle, last] });
  assert.equal(p.api.confirmHosted(id, { hasPendingWrites: false, fromCache: false }), true);
  const expected = clone(middle); delete expected.pending;
  assert.deepEqual(p.records(), [first, expected, last]);
  assert.equal(p.api.confirmHosted(id, { hasPendingWrites: false, fromCache: false }), false, 'confirmation is idempotent');
});

test('cached, uncommitted and absent snapshot metadata cannot clear a provisional management key', () => {
  for (const metadata of [undefined, null, {}, { fromCache: true, hasPendingWrites: false }, { fromCache: false, hasPendingWrites: true }, { hasPendingWrites: false }]) {
    const record = { ...ownerRecord(), pending: true }, p = page({ records: [record] });
    assert.equal(p.api.confirmHosted(id, metadata), false);
    assert.deepEqual(p.records(), [record]);
  }
});

test('a failed local confirmation write preserves the pending management key for a later retry', () => {
  const record = { ...ownerRecord(), pending: true }, p = page({ records: [record] });
  p.storage.fail = true;
  assert.equal(p.api.confirmHosted(id, { fromCache: false, hasPendingWrites: false }), false);
  assert.deepEqual(p.records(), [record]);
  p.storage.fail = false;
  assert.equal(p.api.confirmHosted(id, { fromCache: false, hasPendingWrites: false }), true);
  assert.equal(p.records()[0].key, ownerKey);
  assert.ok(!p.records()[0].pending);
});

test('the live listener requests metadata events so an identical cached document can become confirmed', async () => {
  const record = { ...ownerRecord(), pending: true }, p = page({ records: [record] }); p.openEvent();
  await p.api.watch();
  const subscription = p.server.subscriptions[0];
  assert.equal(subscription.ref, 'events/' + id);
  assert.deepEqual(clone(subscription.options), { includeMetadataChanges: true });
  const emit = metadata => subscription.next({ exists: () => true, data: () => fixture(), metadata });
  emit({ fromCache: true, hasPendingWrites: false });
  assert.equal(p.records()[0].pending, true);
  emit({ fromCache: false, hasPendingWrites: false });
  assert.equal(p.records()[0].key, ownerKey);
  assert.ok(!p.records()[0].pending);
});

test('a server-confirmed missing document does not label a provisional creation successful', async () => {
  const record = { ...ownerRecord(), pending: true }, p = page({ records: [record] }); p.openEvent();
  await p.api.watch();
  p.server.subscriptions[0].next({ exists: () => false, metadata: { fromCache: false, hasPendingWrites: false } });
  assert.deepEqual(p.records(), [record]);
  assert.equal(p.api.S.view, 'notfound');
});

test('a stale listener cannot confirm a former event after navigation to another event', async () => {
  const record = { ...ownerRecord(), pending: true }, p = page({ records: [record] }); p.openEvent();
  await p.api.watch();
  p.api.S.id = 'other1234567';
  p.server.subscriptions[0].next({ exists: () => true, data: () => fixture(), metadata: { fromCache: false, hasPendingWrites: false } });
  assert.deepEqual(p.records(), [record]);
});

test('nested and non-string dates cannot crash a live result render or replace valid selections', async () => {
  const raw = fixture();
  raw.responses = {
    a: { dates: [['2026-10-17'], ['2026-10-18', '2026-10-19'], { toString: '2026-10-20' }, null, true, 20261021, '2026-10-17'] },
    b: { dates: ['2026-10-17'] }, c: { dates: [] },
  };
  const p = page(); p.openEvent(); await p.api.watch();
  assert.doesNotThrow(() => p.server.subscriptions[0].next({ exists: () => true, data: () => raw, metadata: { fromCache: false, hasPendingWrites: false } }));
  assert.deepEqual(Array.from(p.api.S.ev.responses.a.dates), ['2026-10-17']);
  assert.equal(p.api.S.view, 'result');
  const st = p.api.stats(p.api.S.ev);
  assert.equal(st.rows.length, 1); assert.equal(st.rows[0].k, '2026-10-17'); assert.equal(st.rows[0].c, 2);
  assert.match(p.app.textContent, /3명 모두 참여|날짜 순위/);
});

test('normalization drops nonexistent, out-of-range and duplicate dates while retaining the valid response', () => {
  const raw = fixture();
  raw.responses = { a: { dates: ['2026-10-17', '2026-10-17', '2026-10-15', '2026-10-24', '2026-10-32', '2026-13-01', '2026-1-17', '2026-10-17x', '2026-10-18'], at: 123 } };
  const p = page(), ev = p.api.normalize(raw);
  assert.deepEqual(Array.from(ev.responses.a.dates), ['2026-10-17', '2026-10-18']);
  assert.equal(ev.responses.a.at, 123);
  const st = p.api.stats(ev);
  assert.equal(st.rows.length, 2);
  assert.equal(st.rows[0].c, 1, 'duplicate dates do not inflate attendance');
});

test('calendar validation distinguishes leap days and month lengths without coercing values', () => {
  const p = page();
  for (const [start, end, dates, expected] of [
    ['2026-02-01', '2026-04-30', ['2026-02-28', '2026-02-29', '2026-04-30', '2026-04-31'], ['2026-02-28', '2026-04-30']],
    ['2028-02-01', '2028-03-01', ['2028-02-29', '2028-02-30', '2028-03-00'], ['2028-02-29']],
    ['2100-02-01', '2100-03-01', ['2100-02-28', '2100-02-29'], ['2100-02-28']],
    ['2000-02-01', '2000-03-01', ['2000-02-29'], ['2000-02-29']],
  ]) {
    const ev = p.api.normalize({ ...fixture(), start, end, responses: { a: { dates } } });
    assert.deepEqual(Array.from(ev.responses.a.dates), expected);
  }
});

test('malformed response containers and invalid members do not appear as completed or affect ranking', () => {
  const p = page();
  for (const invalid of [null, false, '2026-10-17', ['2026-10-17'], {}, { dates: '2026-10-17' }, { dates: { 0: '2026-10-17' } }]) {
    const ev = p.api.normalize({ ...fixture(), members: [...fixture().members, { id: ['bad'], name: 'Bad ID' }, { id: 'bad', name: { nested: true } }, null], responses: { a: invalid, b: { dates: [] }, foreign: { dates: ['2026-10-17'] } } });
    assert.equal(ev.members.length, 3);
    assert.equal(ev.responses.a, undefined);
    assert.equal(ev.responses.foreign, undefined);
    const st = p.api.stats(ev);
    assert.equal(st.n, 1); assert.equal(st.rows.length, 0);
    p.api.S.ev = ev;
    assert.doesNotThrow(() => p.api.go('intro'));
  }
  assert.deepEqual(clone(p.api.normalize({ ...fixture(), responses: [] }).responses), {});
});

test('valid empty selections remain completed responses and render an all-done result safely', () => {
  const raw = fixture(); raw.responses = { a: { dates: [] }, b: { dates: [] }, c: { dates: [] } };
  const p = page(), ev = p.api.normalize(raw), st = p.api.stats(ev);
  assert.equal(st.n, 3); assert.equal(st.allDone, true); assert.equal(st.rows.length, 0);
  p.api.S.ev = ev; p.api.S.id = id;
  assert.doesNotThrow(() => p.api.go('result'));
  assert.match(p.app.textContent, /3명 모두 참여/);
});
