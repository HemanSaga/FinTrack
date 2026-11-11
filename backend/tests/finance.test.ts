import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { connectDatabase } from '../src/config/database.js';
import { User, Bucket, Transaction } from '../src/models/index.js';
import {
  budgetMetrics,
  monthRange,
  currentMonth,
  currentDate,
  daysInMonth,
} from '../src/utils/core.js';

// Every run owns a fresh database. Never use or drop the application's database.
const databaseName = `fintrack_test_${randomUUID().replaceAll('-', '')}`;
const testOrigin = 'http://localhost:5173';
const owner = request.agent(app);
const outsider = request.agent(app);
let food = '',
  travel = '',
  ownerId = '',
  outsiderId = '',
  firstTx = '',
  secondTx = '';
let outsiderCookie: string[] = [];
const expense = (amount: number, bucketId = food, date = '2025-11-03') => ({
  description: 'Lunch at college',
  amount,
  bucketId,
  date,
});
const requestWithOrigin = () => request(app);

before(async () => {
  await connectDatabase(`mongodb://127.0.0.1:27017/${databaseName}`);
  const one = await owner.post('/api/v1/auth/register').set('Origin', testOrigin).send({
    name: 'Test Owner',
    email: 'owner@example.test',
    password: 'Owner-password-123',
    timezone: 'Asia/Kolkata',
  });
  assert.equal(one.status, 201);
  ownerId = one.body.data.user.id;
  const two = await outsider.post('/api/v1/auth/register').send({
    name: 'Test Outsider',
    email: 'outsider@example.test',
    password: 'Outsider-password-123',
    timezone: 'America/New_York',
  });
  assert.equal(two.status, 201);
  outsiderId = two.body.data.user.id;
  outsiderCookie = two.headers['set-cookie'] as unknown as string[];
  const buckets = await owner.get('/api/v1/buckets?month=2025-11');
  food = buckets.body.data.find((b: { name: string }) => b.name === 'Food').id;
  travel = buckets.body.data.find((b: { name: string }) => b.name === 'Travel').id;
});
after(async () => {
  if (mongoose.connection.name === databaseName && databaseName.startsWith('fintrack_test_'))
    await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test('registration creates eleven private default buckets without sample transactions', async () => {
  assert.equal(await Bucket.countDocuments({ userId: ownerId }), 11);
  assert.equal(await Transaction.countDocuments({ userId: ownerId }), 0);
  const me = await owner.get('/api/v1/auth/me').expect(200);
  assert.equal(me.body.data.user.name, 'Test Owner');
  assert.equal('passwordHash' in me.body.data.user, false);
  assert.equal('sessionVersion' in me.body.data.user, false);
  const user = await User.findById(ownerId).select('+passwordHash');
  assert.ok(user?.passwordHash.startsWith('$2'));
  assert.notEqual(user?.passwordHash, 'Owner-password-123');
});
test('unauthenticated and wrong-password requests are rejected', async () => {
  await request(app).get('/api/v1/buckets').expect(401);
  await request(app)
    .post('/api/v1/auth/login')
    .send({ email: 'owner@example.test', password: 'wrong' })
    .expect(401);
  await request(app)
    .post('/api/v1/auth/register')
    .send({ name: 'Duplicate', email: 'owner@example.test', password: 'something-12345' })
    .expect(409);
});
test('sessions use HttpOnly SameSite cookies', () => {
  assert.match(outsiderCookie[0], /HttpOnly/);
  assert.match(outsiderCookie[0], /SameSite=Lax/);
});
test('5000 budget minus 1000 expense leaves 4000', async () => {
  await owner
    .put(`/api/v1/budgets/${food}`)
    .send({ monthKey: '2025-11', amount: 500000 })
    .expect(200);
  const created = await owner.post('/api/v1/transactions').send(expense(100000)).expect(201);
  firstTx = created.body.data.id;
  const b = await owner.get(`/api/v1/buckets/${food}?month=2025-11`).expect(200);
  assert.equal(b.body.data.spent, 100000);
  assert.equal(b.body.data.remaining, 400000);
});
test('adding another 500 immediately raises spent to 1500', async () => {
  const created = await owner.post('/api/v1/transactions').send(expense(50000)).expect(201);
  secondTx = created.body.data.id;
  const b = await owner.get(`/api/v1/buckets/${food}?month=2025-11`).expect(200);
  assert.equal(b.body.data.spent, 150000);
});
test('editing 500 to 700 recalculates spent to 1700', async () => {
  await owner.patch(`/api/v1/transactions/${secondTx}`).send({ amount: 70000 }).expect(200);
  const b = await owner.get(`/api/v1/buckets/${food}?month=2025-11`).expect(200);
  assert.equal(b.body.data.spent, 170000);
});
test('moving an expense recalculates both original and new bucket', async () => {
  await owner.patch(`/api/v1/transactions/${secondTx}`).send({ bucketId: travel }).expect(200);
  const a = await owner.get(`/api/v1/buckets/${food}?month=2025-11`);
  const b = await owner.get(`/api/v1/buckets/${travel}?month=2025-11`);
  assert.equal(a.body.data.spent, 100000);
  assert.equal(b.body.data.spent, 70000);
  await owner.patch(`/api/v1/transactions/${secondTx}`).send({ bucketId: food }).expect(200);
});
test('deleting an expense reduces spent back to 1000', async () => {
  await owner.delete(`/api/v1/transactions/${secondTx}`).expect(200);
  const b = await owner.get(`/api/v1/buckets/${food}?month=2025-11`);
  assert.equal(b.body.data.spent, 100000);
});
test('December budget changes preserve November history', async () => {
  await owner
    .put(`/api/v1/budgets/${food}`)
    .send({ monthKey: '2025-12', amount: 600000 })
    .expect(200);
  const november = await owner.get(`/api/v1/budgets/${food}?month=2025-11`);
  const december = await owner.get(`/api/v1/budgets/${food}?month=2025-12`);
  assert.equal(november.body.data.amount, 500000);
  assert.equal(december.body.data.amount, 600000);
});
test('status boundaries and zero budgets are handled safely', () => {
  assert.equal(budgetMetrics(500000, 399999).status, 'normal');
  assert.equal(budgetMetrics(500000, 400000).status, 'warning');
  assert.equal(budgetMetrics(500000, 500000).status, 'reached');
  assert.equal(budgetMetrics(500000, 500001).status, 'overspending');
  assert.equal(budgetMetrics(0, 500).status, 'unbudgeted');
  assert.equal(Number.isFinite(budgetMetrics(0, 500).utilization), true);
});
test('API reflects 80%, exactly 100%, and over-budget statuses', async () => {
  for (const [budget, status] of [
    [125000, 'warning'],
    [100000, 'reached'],
    [90000, 'overspending'],
  ] as const) {
    await owner.put(`/api/v1/budgets/${food}`).send({ monthKey: '2025-11', amount: budget });
    const b = await owner.get(`/api/v1/buckets/${food}?month=2025-11`);
    assert.equal(b.body.data.status, status);
  }
  await owner.put(`/api/v1/budgets/${food}`).send({ monthKey: '2025-11', amount: 500000 });
});
test('another user cannot read, mutate, budget, archive or spend in owned buckets', async () => {
  await outsider.get(`/api/v1/buckets/${food}`).expect(404);
  await outsider.patch(`/api/v1/buckets/${food}`).send({ name: 'Hijacked' }).expect(404);
  await outsider.delete(`/api/v1/buckets/${food}`).expect(404);
  await outsider.get(`/api/v1/budgets/${food}?month=2025-11`).expect(404);
  await outsider
    .put(`/api/v1/budgets/${food}`)
    .send({ monthKey: '2025-11', amount: 1 })
    .expect(404);
  await outsider.post('/api/v1/transactions').send(expense(100)).expect(404);
  await outsider.get(`/api/v1/transactions?bucketId=${food}`).expect(404);
});
test('another user cannot read, edit or delete owned transactions', async () => {
  await outsider.get(`/api/v1/transactions/${firstTx}`).expect(404);
  await outsider.patch(`/api/v1/transactions/${firstTx}`).send({ amount: 10 }).expect(404);
  await outsider.delete(`/api/v1/transactions/${firstTx}`).expect(404);
  const summary = await outsider.get('/api/v1/dashboard/summary?month=2025-11').expect(200);
  assert.equal(summary.body.data.spent, 0);
});
test('input rejects user-supplied ownership, invalid IDs, fractional paise and invalid dates', async () => {
  await owner
    .post('/api/v1/transactions')
    .send({ ...expense(100), userId: outsiderId })
    .expect(400);
  await owner.post('/api/v1/transactions').send(expense(0.5)).expect(400);
  await owner.post('/api/v1/transactions').send(expense(0)).expect(400);
  await owner.post('/api/v1/transactions').send(expense(-100)).expect(400);
  await owner
    .post('/api/v1/transactions')
    .send(expense(100, food, '2025-02-30'))
    .expect(400);
  await owner
    .post('/api/v1/transactions')
    .send(expense(100, food, '2099-12-01'))
    .expect(400);
  await owner.get('/api/v1/buckets/not-an-id').expect(400);
  await owner.get('/api/v1/transactions?month=2025-13').expect(400);
  await owner.get('/api/v1/transactions?from=2025-12-01&to=2025-11-01').expect(400);
});
test('duplicate active bucket names are case-insensitively rejected', async () => {
  await owner
    .post('/api/v1/buckets')
    .send({ name: 'food', icon: 'utensils', color: '#557744', monthKey: '2025-11', budget: 100 })
    .expect(409);
  await owner.patch(`/api/v1/buckets/${travel}`).send({ name: 'FOOD' }).expect(409);
});
test('a custom bucket stores its own monthly budget', async () => {
  const created = await owner
    .post('/api/v1/buckets')
    .send({
      name: 'Adventures',
      icon: 'plane',
      color: '#557744',
      monthKey: '2025-11',
      budget: 250000,
    })
    .expect(201);
  const b = await owner.get(`/api/v1/buckets/${created.body.data.id}?month=2025-11`).expect(200);
  assert.equal(b.body.data.budget, 250000);
  assert.equal(b.body.data.isDefault, false);
});
test('idempotent retries and concurrent submissions create only one expense', async () => {
  const requestId = randomUUID();
  const body = { ...expense(12345, travel), requestId };
  const [a, b] = await Promise.all([
    owner.post('/api/v1/transactions').send(body),
    owner.post('/api/v1/transactions').send(body),
  ]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.body.data.id, b.body.data.id);
  assert.equal(await Transaction.countDocuments({ userId: ownerId, requestId }), 1);
});
test('archive preserves history, rejects new expenses, and allows corrections or restoration', async () => {
  await owner.delete(`/api/v1/buckets/${food}`).expect(200);
  await owner.post('/api/v1/transactions').send(expense(100)).expect(400);
  const old = await owner.get(`/api/v1/transactions/${firstTx}`).expect(200);
  assert.equal(old.body.data.bucket.isArchived, true);
  await owner
    .patch(`/api/v1/transactions/${firstTx}`)
    .send({ notes: 'Corrected historical note' })
    .expect(200);
  const b = await owner.get(`/api/v1/buckets/${food}?month=2025-11`).expect(200);
  assert.equal(b.body.data.spent, 100000);
  assert.equal(b.body.data.budget, 500000);
  await owner.patch(`/api/v1/buckets/${food}`).send({ isArchived: false }).expect(200);
});
test('search, pagination, sort, and date ranges return actual matching records', async () => {
  const list = await owner
    .get('/api/v1/transactions?month=2025-11&search=college&sort=amount-desc&limit=1')
    .expect(200);
  assert.equal(list.body.data.items.length, 1);
  assert.equal(list.body.data.items[0].amount, 100000);
  assert.equal(list.body.data.total, 2);
  assert.equal(list.body.data.totalAmount, 112345);
  const byNotes = await owner.get('/api/v1/transactions?search=historical+note').expect(200);
  assert.equal(byNotes.body.data.total, 1);
  assert.equal(byNotes.body.data.items[0].id, firstTx);
  const excluded = await owner
    .get('/api/v1/transactions?month=2025-11&from=2025-11-10&to=2025-11-20')
    .expect(200);
  assert.equal(excluded.body.data.total, 0);
  const literal = await owner.get('/api/v1/transactions?search=%2E%2A').expect(200);
  assert.equal(literal.body.data.total, 0);
});
test('health endpoint reports readiness, uptime, and timestamp', async () => {
  const res = await request(app).get('/api/health').expect(200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.status, 'ready');
  assert.equal(typeof res.body.data.uptime, 'number');
  assert.ok(res.body.data.timestamp);
});
test('moving an expense date changes the corresponding month totals', async () => {
  await owner.patch(`/api/v1/transactions/${firstTx}`).send({ date: '2025-12-03' }).expect(200);
  const nov = await owner.get(`/api/v1/buckets/${food}?month=2025-11`);
  const dec = await owner.get(`/api/v1/buckets/${food}?month=2025-12`);
  assert.equal(nov.body.data.spent, 0);
  assert.equal(dec.body.data.spent, 100000);
  await owner.patch(`/api/v1/transactions/${firstTx}`).send({ date: '2025-11-03' });
});
test('timezone month boundaries include the correct UTC instants, including DST', async () => {
  const range = monthRange('2025-11', 'America/New_York');
  assert.equal(range.start.toISOString(), '2025-11-01T04:00:00.000Z');
  assert.equal(range.end.toISOString(), '2025-12-01T05:00:00.000Z');
  const outsiderFood = await Bucket.findOne({ userId: outsiderId, name: 'Food' });
  await Transaction.create({
    userId: outsiderId,
    bucketId: outsiderFood!._id,
    description: 'Late night November expense',
    amount: 4321,
    transactionDate: new Date('2025-12-01T02:00:00Z'),
  });
  const november = await outsider.get('/api/v1/dashboard/overview?month=2025-11').expect(200);
  assert.equal(november.body.data.spent, 4321);
  assert.equal(
    november.body.data.daily.find((d: { day: string }) => d.day === '2025-11-30').spent,
    4321,
  );
  assert.equal(november.body.data.recent[0].dateKey, '2025-11-30');
});
test('monthly and annual reports reconcile with transactions and historical budgets', async () => {
  const report = await owner.get('/api/v1/reports/monthly?month=2025-11').expect(200);
  assert.equal(report.body.data.spent, 112345);
  assert.equal(report.body.data.transactionCount, 2);
  const annual = await owner.get('/api/v1/reports/annual?year=2025').expect(200);
  assert.equal(annual.body.data.months.length, 12);
  assert.equal(annual.body.data.spent, 112345);
  for (const path of ['summary', 'bucket-breakdown', 'monthly-trends', 'recent-transactions'])
    await owner.get(`/api/v1/dashboard/${path}?month=2025-11`).expect(200);
});
test('untrusted origins and cross-site write requests are rejected', async () => {
  await owner
    .post('/api/v1/transactions')
    .set('Origin', 'https://attacker.example')
    .send(expense(100))
    .expect(403);
  await owner
    .patch('/api/v1/auth/profile')
    .set('Sec-Fetch-Site', 'cross-site')
    .send({ name: 'Malicious' })
    .expect(403);
});
test('profile validation and password changes preserve the current session and revoke others', async () => {
  await owner
    .patch('/api/v1/auth/profile')
    .send({ name: 'New Name', currency: 'USD', timezone: 'UTC' })
    .expect(200);
  await owner.patch('/api/v1/auth/profile').send({ timezone: 'Not/AZone' }).expect(400);
  await owner.patch('/api/v1/auth/profile').send({ userId: outsiderId }).expect(400);
  const previous = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: 'owner@example.test', password: 'Owner-password-123' })
    .expect(200);
  const cookie = previous.headers['set-cookie'] as unknown as string[];
  await owner
    .patch('/api/v1/auth/change-password')
    .send({ currentPassword: 'wrong', newPassword: 'New-password-56789' })
    .expect(400);
  await owner
    .patch('/api/v1/auth/change-password')
    .send({ currentPassword: 'Owner-password-123', newPassword: 'New-password-56789' })
    .expect(200);
  await owner.get('/api/v1/auth/me').expect(200);
  await request(app).get('/api/v1/auth/me').set('Cookie', cookie).expect(401);
  await request(app)
    .post('/api/v1/auth/login')
    .send({ email: 'owner@example.test', password: 'Owner-password-123' })
    .expect(401);
  await request(app)
    .post('/api/v1/auth/login')
    .send({ email: 'owner@example.test', password: 'New-password-56789' })
    .expect(200);
});
test('logout revokes the session even if an old cookie is replayed', async () => {
  await outsider.post('/api/v1/auth/logout').expect(200);
  await request(app).get('/api/v1/auth/me').set('Cookie', outsiderCookie).expect(401);
});

test('monthly plans update multiple owned buckets and preserve other months', async () => {
  await owner
    .put('/api/v1/budgets')
    .send({
      monthKey: '2024-08',
      items: [
        { bucketId: food, amount: 120000 },
        { bucketId: travel, amount: 30000 },
      ],
    })
    .expect(200);
  await owner
    .put('/api/v1/budgets')
    .send({
      monthKey: '2024-09',
      items: [
        { bucketId: food, amount: 160000 },
        { bucketId: travel, amount: 50000 },
      ],
    })
    .expect(200);
  const august = await owner.get('/api/v1/dashboard/summary?month=2024-08').expect(200);
  const september = await owner.get('/api/v1/dashboard/summary?month=2024-09').expect(200);
  assert.equal(august.body.data.budget, 150000);
  assert.equal(september.body.data.budget, 210000);
});
test('a plan containing a foreign bucket is rejected before any values change', async () => {
  const foreign = await Bucket.findOne({ userId: outsiderId });
  await owner
    .put('/api/v1/budgets')
    .send({
      monthKey: '2024-08',
      items: [
        { bucketId: food, amount: 999 },
        { bucketId: String(foreign!._id), amount: 10 },
      ],
    })
    .expect(404);
  const unchanged = await owner.get(`/api/v1/budgets/${food}?month=2024-08`);
  assert.equal(unchanged.body.data.amount, 120000);
});
test('plan validation rejects duplicates, fractions, invalid months and forged ownership', async () => {
  const item = { bucketId: food, amount: 100 };
  for (const body of [
    { monthKey: '2024-08', items: [item, item] },
    { monthKey: '2024-08', items: [{ ...item, amount: 0.5 }] },
    { monthKey: '2024-13', items: [item] },
    { monthKey: '2024-08', items: [item], userId: outsiderId },
    { monthKey: '2024-08', items: [] },
  ])
    await owner.put('/api/v1/budgets').send(body).expect(400);
});
test('archived buckets cannot enter a new bulk spending plan', async () => {
  const created = await owner
    .post('/api/v1/buckets')
    .send({
      name: 'Archived planner test',
      icon: 'other',
      color: '#557744',
      monthKey: '2024-08',
      budget: 0,
    })
    .expect(201);
  await owner.delete(`/api/v1/buckets/${created.body.data.id}`).expect(200);
  await owner
    .put('/api/v1/budgets')
    .send({
      monthKey: '2024-08',
      items: [
        { bucketId: food, amount: 999 },
        { bucketId: created.body.data.id, amount: 10 },
      ],
    })
    .expect(404);
  const unchanged = await owner.get(`/api/v1/budgets/${food}?month=2024-08`);
  assert.equal(unchanged.body.data.amount, 120000);
});
test('a deliberate zero budget is saved, and plan retries remain idempotent', async () => {
  const body = {
    monthKey: '2024-09',
    items: [
      { bucketId: food, amount: 0 },
      { bucketId: travel, amount: 50000 },
    ],
  };
  await owner.put('/api/v1/budgets').send(body).expect(200);
  await owner.put('/api/v1/budgets').send(body).expect(200);
  const plans = await owner.get('/api/v1/budgets?month=2024-09');
  assert.equal(plans.body.data.length, 2);
  assert.equal(
    plans.body.data.find((plan: { bucketId: string }) => plan.bucketId === food).amount,
    0,
  );
});
test('spending pace uses the selected calendar and does not project closed months', async () => {
  const historic = await owner.get('/api/v1/dashboard/overview?month=2025-11').expect(200);
  assert.equal(historic.body.data.pace.period, 'past');
  assert.equal(historic.body.data.pace.elapsedDays, 30);
  assert.equal(historic.body.data.pace.remainingDays, 0);
  assert.equal(historic.body.data.pace.projectedSpent, null);
  assert.equal(historic.body.data.pace.averageDailySpent, Math.round(112345 / 30));
  const month = currentMonth('UTC');
  await owner
    .post('/api/v1/transactions')
    .send(expense(10000, food, currentDate('UTC')))
    .expect(201);
  const current = await owner.get(`/api/v1/dashboard/overview?month=${month}`).expect(200);
  const elapsed = Number(currentDate('UTC').slice(-2));
  assert.equal(current.body.data.pace.elapsedDays, elapsed);
  assert.equal(
    current.body.data.pace.projectedSpent,
    Math.round((10000 / elapsed) * daysInMonth(month)),
  );
  assert.equal(current.body.data.pace.spendingDays, 1);
});
test('reusing a saved expense request ID with different data returns a conflict', async () => {
  const body = { ...expense(1234), requestId: randomUUID() };
  await owner.post('/api/v1/transactions').send(body).expect(201);
  const conflict = await owner
    .post('/api/v1/transactions')
    .send({ ...body, amount: 5678 })
    .expect(409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(await Transaction.countDocuments({ userId: ownerId, requestId: body.requestId }), 1);
});
