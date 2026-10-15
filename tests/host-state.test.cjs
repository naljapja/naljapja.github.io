const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
function section(start, end) {
  const first = script.indexOf(start), last = script.indexOf(end, first);
  assert(first >= 0 && last > first, 'source section exists: ' + start);
  return script.slice(first, last);
}
const storageCode = section('const store =', '// ===== 상태 =====');
const hostCode = section('function normalize(', '// ===== 계산 =====') + section('const fail =', '// ===== 공유·복사·토스트 =====');
const clone = value => JSON.parse(JSON.stringify(value));
const member = (id, req = false) => ({ id, name: id.toUpperCase(), ...(req ? { req: true } : {}) });
function event(count = 3) {
  const members = Array.from({ length: count }, (_, i) => member(String.fromCharCode(97 + i)));
  return { title: 'Fixture', start: '2026-10-15', end: '2026-12-31', members, responses: Object.fromEntries(members.map(m => [m.id, { dates: ['2026-11-01'] }])), closed: false, fixed: null, deadline: null };
}
function storeContext(initial = []) {
  const stored = new Map([['yaksok:hosted', JSON.stringify(initial)]]);
  const c = vm.createContext({ S: { id: 'event0' }, localStorage: { getItem: k => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, v) } });
  vm.runInContext(storageCode, c);
  return c;
}
function fakeDatabase(initial) {
  let saved = clone(initial), version = 0, attempts = 0, writes = 0, nextId = 0;
  const transactions = [];
  const ownerKey = 'OwnerKey_1234567890-abcd';
  return {
    get saved() { return clone(saved); },
    get writes() { return writes; },
    get attempts() { return attempts; },
    transactions,
    ownerKey,
    client({ key = ownerKey } = {}) {
      const toasts = [], errors = [];
      const c = vm.createContext({
        S: { id: 'fixture12345', ev: clone(initial) },
        fb: async () => {}, evRef: () => 'events/fixture12345', rid: () => 'new' + (++nextId), hostKey: () => key,
        toast: message => toasts.push(message), console: { error: e => errors.push(e) },
        setTimeout, todayKey: () => '2026-10-15',
        FB: {
          db: {}, serverTimestamp: () => 'server-time', deleteField: () => ({ deleteSentinel: true }),
          doc: (_, collection, id) => collection + '/' + id,
          FieldPath: class { constructor(...parts) { this.parts = parts; } },
          async runTransaction(_, callback) {
            for (let retry = 0; retry < 10; retry++) {
              attempts++;
              let readVersion;
              const operations = [];
              const result = await callback({
                async get(ref) {
                  assert.equal(ref, 'events/fixture12345');
                  readVersion = version;
                  const snapshot = clone(saved);
                  return { exists: () => snapshot !== null, data: () => clone(snapshot) };
                },
                update(ref, ...args) { operations.push({ ref, args }); },
              });
              if (version !== readVersion) continue;
              const eventOperation = operations.find(op => op.ref === 'events/fixture12345');
              const proof = operations.find(op => op.ref === 'hostkeys/fixture12345');
              if (eventOperation) {
                assert.ok(proof, 'an owner event write has a private authorization write in the same transaction');
                assert.deepEqual(Array.from(proof.args[0].parts), [ownerKey]);
                assert.equal(proof.args[1], 'server-time');
                const updates = eventOperation.args[0];
                assert.ok(!JSON.stringify(updates).includes(ownerKey), 'the secret never appears in the public event');
                for (const [key, value] of Object.entries(updates)) {
                  if (key.startsWith('responses.') && value.deleteSentinel) delete saved.responses[key.slice(10)];
                  else saved[key] = clone(value);
                }
                version++; writes++;
                transactions.push(operations);
              }
              return result;
            }
            throw new Error('too many retries');
          },
        },
      });
      vm.runInContext(hostCode, c);
      return { c, toasts, errors, run: code => vm.runInContext(code, c) };
    },
  };
}

test('creating more than 30 events retains the first host key and existing records', () => {
  const c = storeContext([{ id: 'event0', key: 'original-key', title: 'Old event' }]);
  for (let i = 1; i <= 40; i++) {
    c.entry = { id: 'event' + i, key: 'key' + i, title: 'Event ' + i };
    vm.runInContext('rememberHosted(entry)', c);
  }
  assert.equal(vm.runInContext('hosted().length', c), 41);
  assert.equal(vm.runInContext('isHost()', c), true);
  assert.equal(vm.runInContext('hostKey()', c), 'original-key');
  c.entry = { id: 'event0', key: 'original-key', title: 'Same event' };
  vm.runInContext('rememberHosted(entry)', c);
  assert.equal(vm.runInContext('hosted().length', c), 41);
});

test('concurrent required-member edits survive a transaction retry', async () => {
  const db = fakeDatabase(event()), a = db.client(), b = db.client();
  await Promise.all([a.run('toggleReq(S.ev.members[0])'), b.run('toggleReq(S.ev.members[1])')]);
  assert.equal(db.saved.members[0].req, true);
  assert.equal(db.saved.members[1].req, true);
  assert(db.attempts > db.writes, 'fixture exercised a retry');
});

test('two tabs enabling the same required member do not cancel each other', async () => {
  const db = fakeDatabase(event()), a = db.client(), b = db.client();
  await Promise.all([a.run('toggleReq(S.ev.members[0])'), b.run('toggleReq(S.ev.members[0])')]);
  assert.equal(db.saved.members[0].req, true);
});

test('concurrent add and removal preserve the new member and delete only the removed response', async () => {
  const db = fakeDatabase(event()), a = db.client(), b = db.client();
  a.c.input = { value: 'D' };
  b.c.button = { dataset: { armed: '1' } };
  await Promise.all([b.run('removeMember(S.ev.members[1], button)'), a.run('addMember(input)')]);
  assert.deepEqual(db.saved.members.map(m => m.name).sort(), ['A', 'C', 'D']);
  assert.deepEqual(db.saved.responses, { a: { dates: ['2026-11-01'] }, c: { dates: ['2026-11-01'] } });
  assert.equal(db.saved.title, 'Fixture');
  assert.equal(a.c.input.value, '');
});

test('concurrent removals cannot leave fewer than two members', async () => {
  const db = fakeDatabase(event()), a = db.client(), b = db.client();
  a.c.button = b.c.button = { dataset: { armed: '1' } };
  await Promise.all([a.run('removeMember(S.ev.members[0], button)'), b.run('removeMember(S.ev.members[1], button)')]);
  assert.equal(db.saved.members.length, 2);
  assert.equal(Object.keys(db.saved.responses).length, 2);
  assert.equal(db.writes, 1);
  assert([...a.toasts, ...b.toasts].includes('참여자는 2명 이상이어야 해요'));
});

test('duplicate names are checked against the latest server data', async () => {
  const db = fakeDatabase(event()), a = db.client(), b = db.client();
  a.c.input = { value: 'New' }; b.c.input = { value: 'New' };
  await Promise.all([a.run('addMember(input)'), b.run('addMember(input)')]);
  assert.equal(db.saved.members.filter(m => m.name === 'New').length, 1);
  assert.equal(db.writes, 1);
  assert([...a.toasts, ...b.toasts].includes('이미 있는 이름이에요'));
});

test('concurrent additions enforce the 30-member limit on current data', async () => {
  const db = fakeDatabase(event(29)), a = db.client(), b = db.client();
  a.c.input = { value: 'New A' }; b.c.input = { value: 'New B' };
  await Promise.all([a.run('addMember(input)'), b.run('addMember(input)')]);
  assert.equal(db.saved.members.length, 30);
  assert.equal(db.writes, 1);
  assert([...a.toasts, ...b.toasts].includes('참여자는 30명까지예요'));
});

test('stale required-member edits cannot resurrect a removed member', async () => {
  const db = fakeDatabase(event()), a = db.client(), b = db.client();
  a.c.button = { dataset: { armed: '1' } };
  await a.run('removeMember(S.ev.members[0], button)');
  await b.run('toggleReq(S.ev.members[0])');
  assert.equal(db.saved.members.some(m => m.id === 'a'), false);
  assert.equal(db.writes, 1);
  assert(b.toasts.includes('이미 명단에서 빠진 사람이에요.'));
});

test('missing or deleted events cannot be recreated by stale member edits', async () => {
  for (const initial of [null, { ...event(), deleted: true }]) {
    const db = fakeDatabase(initial), a = db.client();
    a.c.input = { value: 'New' };
    await a.run('addMember(input)');
    assert.equal(db.writes, 0);
    assert.equal(a.c.input.value, 'New');
    assert(a.toasts.includes('약속을 찾을 수 없어요. 새로고침해 주세요.'));
  }
});

test('a denied or offline transaction leaves the input and event unchanged', async () => {
  const initial = event(), db = fakeDatabase(initial), a = db.client();
  a.c.input = { value: 'New' };
  a.c.FB.runTransaction = async () => { throw new Error('offline'); };
  await a.run('addMember(input)');
  assert.deepEqual(db.saved, initial);
  assert.equal(a.c.input.value, 'New');
  assert(a.toasts.includes('처리하지 못했어요. 다시 시도해 주세요.'));
});
