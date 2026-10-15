'use strict';

// These tests use only the local emulator. Never substitute a live project ID.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const {
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch,
  runTransaction, serverTimestamp, Timestamp, FieldPath, deleteField, setLogLevel,
} = require('firebase/firestore');

const PROJECT_ID = 'demo-naljapja-tests';
const HOST = '127.0.0.1';
const PORT = 8180;
const KEY = 'test_host_secret_abcdefgh12345678';
const OTHER_KEY = 'another_secret_abcdefgh123456789';
const RULES = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
assert.ok(!process.env.FIRESTORE_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST === `${HOST}:${PORT}`,
  'FIRESTORE_EMULATOR_HOST must be 127.0.0.1:8180; refusing another target');
setLogLevel('silent');
let env;
let db;
let fixtureSequence = 0;

test.before(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { host: HOST, port: PORT, rules: RULES } });
  db = env.unauthenticatedContext().firestore();
});
test.after(async () => { await env?.cleanup(); });

function eventData(count = 3) {
  return {
    title: '가벼운 약속', start: '2026-10-16', end: '2026-10-18',
    members: Array.from({ length: count }, (_, i) => ({ id: `m${i + 1}`, name: `친구${i + 1}` })),
    responses: {}, fixed: null, closed: false, deadline: null,
    createdAt: Timestamp.fromMillis(1), updatedAt: Timestamp.fromMillis(1),
  };
}
async function seed({ data = eventData(), key = KEY } = {}) {
  const id = `event_test_${++fixtureSequence}`;
  await env.withSecurityRulesDisabled(async ctx => {
    const admin = ctx.firestore();
    await setDoc(doc(admin, 'events', id), data);
    if (key !== null) await setDoc(doc(admin, 'hostkeys', id), { key });
  });
  return id;
}
function changeEvent(id, patch) {
  return updateDoc(doc(db, 'events', id), { ...patch, updatedAt: serverTimestamp() });
}
function hostChange(id, patch, key = KEY) {
  const batch = writeBatch(db);
  batch.update(doc(db, 'events', id), { ...patch, updatedAt: serverTimestamp() });
  batch.update(doc(db, 'hostkeys', id), new FieldPath(key), serverTimestamp());
  return batch.commit();
}
function response(dates = ['2026-10-17']) {
  return { dates, at: 1792100000000 };
}
async function rawData(collectionName, id) {
  let data;
  await env.withSecurityRulesDisabled(async ctx => { data = (await getDoc(doc(ctx.firestore(), collectionName, id))).data(); });
  return data;
}

test('new event and private key are created together; either document alone is refused', async () => {
  const id = `event_create_${++fixtureSequence}`;
  const event = { ...eventData(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  await assertFails(setDoc(doc(db, 'events', id), event));
  await assertFails(setDoc(doc(db, 'hostkeys', id), { key: KEY }));
  const batch = writeBatch(db);
  batch.set(doc(db, 'events', id), event);
  batch.set(doc(db, 'hostkeys', id), { key: KEY });
  await assertSucceeds(batch.commit());
  assert.equal((await getDoc(doc(db, 'events', id))).data().title, event.title);
});

test('event IDs may be read individually, while event lists and private key reads/lists are denied', async () => {
  const id = await seed();
  await assertSucceeds(getDoc(doc(db, 'events', id)));
  await assertFails(getDocs(collection(db, 'events')));
  await assertFails(getDoc(doc(db, 'hostkeys', id)));
  await assertFails(getDocs(collection(db, 'hostkeys')));
});

test('anonymous participants can update responses, but cannot write orphan response IDs', async () => {
  const id = await seed();
  await assertSucceeds(changeEvent(id, { 'responses.m1': response() }));
  await assertFails(changeEvent(id, { 'responses.removed_member': response() }));
  await assert.rejects(async () => changeEvent(id, { responses: { '': response() } }));
});

test('malformed response payloads and more than 92 selected dates are refused', async () => {
  const id = await seed();
  await assertFails(changeEvent(id, { 'responses.m1': { dates: { broken: true }, at: 1 } }));
  await assertFails(changeEvent(id, { 'responses.m1': { dates: Array(93).fill('2026-10-17'), at: 1 } }));
  await assertFails(changeEvent(id, { 'responses.m1': { dates: [], at: 'broken' } }));
  await assertSucceeds(changeEvent(id, { 'responses.m1': { dates: [] } }));
});

test('response dates reject nested lists, maps, numbers and malformed date strings', async () => {
  const id = await seed();
  // Nested arrays cannot be serialized by Firestore in the first place.
  await assert.rejects(async () => changeEvent(id, { 'responses.m1': response([['2026-10-17']]) }));
  for (const dates of [[{ date: '2026-10-17' }], [20261017], ['2026-10-17', null], ['not-a-date'], ['2026-10-17,2026-10-18']]) {
    await assertFails(changeEvent(id, { 'responses.m1': response(dates) }));
  }
  await assertSucceeds(changeEvent(id, { 'responses.m1': response(['2026-10-16', '2026-10-18']) }));
});

test('a participant cannot change members, required flags, deadline, fixed date, closed state or title', async () => {
  const id = await seed();
  const data = eventData();
  for (const patch of [
    { members: data.members.slice(0, 2) },
    { members: data.members.map((m, i) => i === 0 ? { ...m, req: true } : m) },
    { deadline: '2026-10-17' }, { fixed: '2026-10-17' }, { closed: true }, { title: '무단 변경' },
  ]) await assertFails(changeEvent(id, patch));
});

test('a host can atomically change administrative fields and stamp the secret field path', async () => {
  const id = await seed();
  await assertSucceeds(hostChange(id, { title: '주최자가 수정', closed: true, deadline: '2026-10-17', fixed: '2026-10-17' }));
  const data = (await getDoc(doc(db, 'events', id))).data();
  assert.equal(data.title, '주최자가 수정');
  assert.equal(data.closed, true);
  const privateData = await rawData('hostkeys', id);
  assert.equal(privateData.key, KEY);
  assert.ok(privateData[KEY] instanceof Timestamp);
});

test('a host removing a member must also remove that response in the same atomic change', async () => {
  const data = eventData();
  data.responses.m3 = response();
  const id = await seed({ data });
  await assertFails(hostChange(id, { members: data.members.slice(0, 2) }));
  await assertSucceeds(hostChange(id, { members: data.members.slice(0, 2), 'responses.m3': deleteField() }));
  await assertFails(changeEvent(id, { 'responses.m3': response() }));
});

test('unknown fields and a forged authorizedAt field cannot grant host access', async () => {
  const id = await seed();
  await assertFails(changeEvent(id, { authorizedAt: serverTimestamp(), closed: true }));
  await assertFails(hostChange(id, { unexpected: true }));
  const batch = writeBatch(db);
  batch.update(doc(db, 'events', id), { closed: true, updatedAt: serverTimestamp() });
  batch.update(doc(db, 'hostkeys', id), { authorizedAt: serverTimestamp() });
  await assertFails(batch.commit());
});

test('private key omission, replacement, extra fields and direct deletion are refused', async () => {
  const id = await seed();
  await assertFails(setDoc(doc(db, 'hostkeys', id), { [KEY]: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, 'hostkeys', id), { key: OTHER_KEY }));
  await assertFails(updateDoc(doc(db, 'hostkeys', id), new FieldPath(KEY), serverTimestamp(), 'extra', true));
  await assertFails(deleteDoc(doc(db, 'hostkeys', id)));
  await assertFails(deleteDoc(doc(db, 'events', id)));
});

test('a proof committed before the event change cannot be reused in a later commit', async () => {
  const id = await seed();
  await assertSucceeds(updateDoc(doc(db, 'hostkeys', id), new FieldPath(KEY), serverTimestamp()));
  await assertFails(changeEvent(id, { closed: true }));
});

test('a different event key or a stamp on a different event cannot authorize the target', async () => {
  const id = await seed();
  const otherId = await seed({ key: OTHER_KEY });
  await assertFails(hostChange(id, { closed: true }, OTHER_KEY));
  const batch = writeBatch(db);
  batch.update(doc(db, 'events', id), { closed: true, updatedAt: serverTimestamp() });
  batch.update(doc(db, 'hostkeys', otherId), new FieldPath(OTHER_KEY), serverTimestamp());
  await assertFails(batch.commit());
});

test('legacy events without a key remain readable/respondable; clients cannot seize a key or edit admin fields', async () => {
  const data = eventData();
  delete data.deadline;
  const id = await seed({ data, key: null });
  await assertSucceeds(getDoc(doc(db, 'events', id)));
  await assertSucceeds(changeEvent(id, { 'responses.m1': response() }));
  await assertFails(changeEvent(id, { closed: true }));
  await assertFails(setDoc(doc(db, 'hostkeys', id), { key: KEY }));
});

test('deletion requires the matching key and produces only the existing three-field tombstone', async () => {
  const id = await seed();
  await assertFails(setDoc(doc(db, 'events', id), { deleted: true, delKey: OTHER_KEY, deletedAt: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(db, 'events', id), { deleted: true, delKey: KEY, deletedAt: serverTimestamp() }));
  const deleted = (await getDoc(doc(db, 'events', id))).data();
  assert.deepEqual(Object.keys(deleted).sort(), ['delKey', 'deleted', 'deletedAt']);
  assert.equal(deleted.deleted, true);
});

test('a deleted event cannot be restored, responded to, rewritten or used for another host proof', async () => {
  const id = await seed();
  await setDoc(doc(db, 'events', id), { deleted: true, delKey: KEY, deletedAt: serverTimestamp() });
  await assertFails(setDoc(doc(db, 'events', id), { ...eventData(), updatedAt: serverTimestamp() }));
  await assertFails(changeEvent(id, { 'responses.m1': response() }));
  await assertFails(hostChange(id, { title: '복원' }));
  await assertFails(updateDoc(doc(db, 'hostkeys', id), new FieldPath(KEY), serverTimestamp()));
  await assertFails(setDoc(doc(db, 'events', id), { deleted: true, delKey: KEY, deletedAt: serverTimestamp() }));
});

test('thirty participants with complete 92-date responses fit the real rules expression budget', async () => {
  const data = eventData(30);
  data.responses = Object.fromEntries(data.members.map(m => [m.id, response(Array(92).fill('2026-10-17'))]));
  const id = await seed({ data });
  await assertSucceeds(changeEvent(id, { 'responses.m30': response(Array(92).fill('2026-10-18')) }));
  await assertSucceeds(hostChange(id, { closed: true }));
});

test('concurrent response and transactional host changes preserve the accepted response and roster', async () => {
  const id = await seed();
  const ref = doc(db, 'events', id);
  await Promise.all([
    assertSucceeds(changeEvent(id, { 'responses.m1': response() })),
    assertSucceeds(runTransaction(db, async tx => {
      const current = (await tx.get(ref)).data();
      tx.update(ref, { members: [...current.members, { id: 'm4', name: '새 친구' }], updatedAt: serverTimestamp() });
      tx.update(doc(db, 'hostkeys', id), new FieldPath(KEY), serverTimestamp());
    })),
  ]);
  const data = (await getDoc(ref)).data();
  assert.equal(data.members.length, 4);
  assert.deepEqual(data.responses.m1.dates, ['2026-10-17']);
});

test('createdAt is immutable, even with a correct host proof', async () => {
  const id = await seed();
  await assertFails(hostChange(id, { createdAt: serverTimestamp() }));
});
