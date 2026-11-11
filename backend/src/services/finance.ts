import { Types } from 'mongoose';
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import {
  Bucket,
  BucketBudget,
  Transaction,
  type UserDocument,
  type TransactionDocument,
} from '../models/index.js';
import {
  ApiError,
  budgetMetrics,
  monthRange,
  currentMonth,
  currentDate,
  localDate,
  shiftMonth,
  daysInMonth,
} from '../utils/core.js';
import type {
  CreateBucket,
  UpdateBucket,
  CreateTransaction,
  UpdateTransaction,
  TransactionQuery,
} from '../validators/index.js';

export async function ownBucket(userId: Types.ObjectId, id: string) {
  const bucket = await Bucket.findOne({ _id: id, userId });
  if (!bucket) throw new ApiError(404, 'That bucket couldn’t be found.', 'NOT_FOUND');
  return bucket;
}
export async function bucketViews(user: UserDocument, month: string) {
  const range = monthRange(month, user.timezone);
  const [buckets, budgets, amounts] = await Promise.all([
    Bucket.find({ userId: user._id }).sort({ sortOrder: 1, createdAt: 1 }).lean(),
    BucketBudget.find({ userId: user._id, monthKey: month }).lean(),
    Transaction.aggregate<{ _id: Types.ObjectId; spent: number }>([
      { $match: { userId: user._id, transactionDate: { $gte: range.start, $lt: range.end } } },
      { $group: { _id: '$bucketId', spent: { $sum: '$amount' } } },
    ]),
  ]);
  const bm = new Map(budgets.map((b) => [String(b.bucketId), b.amount]));
  const sm = new Map(amounts.map((b) => [String(b._id), b.spent]));
  return buckets.map((b) => ({
    id: String(b._id),
    name: b.name,
    icon: b.icon,
    color: b.color,
    isDefault: b.isDefault,
    isArchived: b.isArchived,
    sortOrder: b.sortOrder,
    ...budgetMetrics(bm.get(String(b._id)) || 0, sm.get(String(b._id)) || 0),
  }));
}
export async function setBudget(
  user: UserDocument,
  bucketId: string,
  monthKey: string,
  amount: number,
) {
  await ownBucket(user._id, bucketId);
  const budget = await BucketBudget.findOneAndUpdate(
    { userId: user._id, bucketId, monthKey },
    { $set: { amount } },
    { upsert: true, returnDocument: 'after', runValidators: true },
  );
  return { id: String(budget!._id), bucketId, monthKey, amount: budget!.amount };
}
export async function createBucket(user: UserDocument, input: CreateBucket) {
  const last = await Bucket.findOne({ userId: user._id }).sort({ sortOrder: -1 }).lean();
  const bucket = await Bucket.create({
    userId: user._id,
    name: input.name,
    nameKey: input.name.toLowerCase(),
    icon: input.icon,
    color: input.color,
    sortOrder: (last?.sortOrder || 0) + 1,
  });
  try {
    await setBudget(user, String(bucket._id), input.monthKey, input.budget);
  } catch (e) {
    await Bucket.deleteOne({ _id: bucket._id, userId: user._id });
    throw e;
  }
  return { id: String(bucket._id) };
}
export async function saveBudgetPlan(
  user: UserDocument,
  monthKey: string,
  items: { bucketId: string; amount: number }[],
) {
  // Validate the entire selection before writing anything, including archived buckets.
  const owned = await Bucket.countDocuments({
    _id: { $in: items.map((item) => new Types.ObjectId(item.bucketId)) },
    userId: user._id,
    isArchived: false,
  });
  if (owned !== items.length)
    throw new ApiError(
      404,
      'One of these buckets is unavailable. Refresh your plan and try again.',
    );
  await BucketBudget.bulkWrite(
    items.map(({ bucketId, amount }) => ({
      updateOne: {
        filter: { userId: user._id, bucketId: new Types.ObjectId(bucketId), monthKey },
        update: { $set: { amount } },
        upsert: true,
      },
    })),
  );
  return { monthKey, updated: items.length };
}
export async function updateBucket(user: UserDocument, id: string, input: UpdateBucket) {
  const bucket = await ownBucket(user._id, id);
  if (input.name !== undefined) {
    bucket.name = input.name;
    bucket.nameKey = input.name.toLowerCase();
  }
  if (input.icon !== undefined) bucket.icon = input.icon;
  if (input.color !== undefined) bucket.color = input.color;
  if (input.isArchived !== undefined) bucket.isArchived = input.isArchived;
  await bucket.save();
  if (input.budget !== undefined && input.monthKey)
    await setBudget(user, id, input.monthKey, input.budget);
  return { id: String(bucket._id) };
}
export async function archiveBucket(user: UserDocument, id: string) {
  const bucket = await ownBucket(user._id, id);
  bucket.isArchived = true;
  await bucket.save();
  return { id, isArchived: true };
}
export async function transactionDTO(transaction: TransactionDocument, timezone: string) {
  const bucket = await Bucket.findOne({
    _id: transaction.bucketId,
    userId: transaction.userId,
  }).lean();
  if (!bucket) throw new ApiError(404, 'The transaction bucket was not found.');
  return {
    id: String(transaction._id),
    description: transaction.description,
    amount: transaction.amount,
    transactionDate: transaction.transactionDate.toISOString(),
    dateKey: formatInTimeZone(transaction.transactionDate, timezone, 'yyyy-MM-dd'),
    notes: transaction.notes,
    createdAt: transaction.createdAt.toISOString(),
    bucket: {
      id: String(bucket._id),
      name: bucket.name,
      icon: bucket.icon,
      color: bucket.color,
      isArchived: bucket.isArchived,
    },
  };
}
export async function ownTransaction(user: UserDocument, id: string) {
  const transaction = await Transaction.findOne({ _id: id, userId: user._id });
  if (!transaction) throw new ApiError(404, 'That expense couldn’t be found.', 'NOT_FOUND');
  return transaction;
}
export async function createTransaction(user: UserDocument, input: CreateTransaction) {
  const existingResult = (existing: TransactionDocument) => {
    if (
      existing.amount !== input.amount ||
      String(existing.bucketId) !== input.bucketId.toLowerCase() ||
      existing.description !== input.description ||
      (existing.notes || '') !== (input.notes || '') ||
      formatInTimeZone(existing.transactionDate, user.timezone, 'yyyy-MM-dd') !== input.date
    )
      throw new ApiError(
        409,
        'This submission was already saved with different details. Refresh the history before adding it again.',
        'IDEMPOTENCY_CONFLICT',
      );
    return transactionDTO(existing, user.timezone);
  };
  if (input.requestId) {
    const existing = await Transaction.findOne({ userId: user._id, requestId: input.requestId });
    if (existing) return existingResult(existing);
  }
  const bucket = await ownBucket(user._id, input.bucketId);
  if (bucket.isArchived) throw new ApiError(400, 'Restore this bucket before adding new expenses.');
  if (input.date > currentDate(user.timezone))
    throw new ApiError(400, 'An expense date cannot be in the future.');
  try {
    const tx = await Transaction.create({
      userId: user._id,
      bucketId: bucket._id,
      description: input.description,
      amount: input.amount,
      transactionDate: localDate(input.date, user.timezone),
      notes: input.notes,
      requestId: input.requestId,
    });
    return await transactionDTO(tx, user.timezone);
  } catch (e) {
    if (input.requestId && typeof e === 'object' && e && 'code' in e && e.code === 11000) {
      const existing = await Transaction.findOne({ userId: user._id, requestId: input.requestId });
      if (existing) return existingResult(existing);
    }
    throw e;
  }
}
export async function updateTransaction(user: UserDocument, id: string, input: UpdateTransaction) {
  const tx = await ownTransaction(user, id);
  if (input.bucketId) {
    const bucket = await ownBucket(user._id, input.bucketId);
    if (bucket.isArchived && String(tx.bucketId) !== input.bucketId)
      throw new ApiError(400, 'Restore this bucket before moving expenses into it.');
    tx.bucketId = bucket._id;
  }
  if (input.date) {
    if (input.date > currentDate(user.timezone))
      throw new ApiError(400, 'An expense date cannot be in the future.');
    tx.transactionDate = localDate(input.date, user.timezone);
  }
  if (input.amount !== undefined) tx.amount = input.amount;
  if (input.description !== undefined) tx.description = input.description;
  if (input.notes !== undefined) tx.notes = input.notes;
  await tx.save();
  return transactionDTO(tx, user.timezone);
}
export async function listTransactions(user: UserDocument, query: TransactionQuery) {
  const filter: Record<string, unknown> = { userId: user._id };
  if (query.bucketId) {
    await ownBucket(user._id, query.bucketId);
    filter.bucketId = new Types.ObjectId(query.bucketId);
  }
  let lower: Date | undefined, upper: Date | undefined;
  if (query.month) {
    const range = monthRange(query.month, user.timezone);
    lower = range.start;
    upper = range.end;
  }
  if (query.from) {
    const start = fromZonedTime(`${query.from}T00:00:00`, user.timezone);
    if (!lower || start > lower) lower = start;
  }
  if (query.to) {
    const next = new Date(`${query.to}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const end = fromZonedTime(`${next.toISOString().slice(0, 10)}T00:00:00`, user.timezone);
    if (!upper || end < upper) upper = end;
  }
  if (lower || upper)
    filter.transactionDate = {
      ...(lower ? { $gte: lower } : {}),
      ...(upper ? { $lt: upper } : {}),
    };
  if (query.search) {
    const pattern = {
      $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      $options: 'i',
    };
    filter.$or = [{ description: pattern }, { notes: pattern }];
  }
  const sort: Record<string, 1 | -1> = query.sort.startsWith('amount')
    ? { amount: query.sort.endsWith('asc') ? 1 : -1, _id: -1 }
    : { transactionDate: query.sort.endsWith('asc') ? 1 : -1, _id: -1 };
  const [total, totalAmountResult, docs] = await Promise.all([
    Transaction.countDocuments(filter),
    Transaction.aggregate<{ totalSpent: number }>([
      { $match: filter },
      { $group: { _id: null, totalSpent: { $sum: '$amount' } } },
    ]),
    Transaction.find(filter)
      .sort(sort)
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
  ]);
  const totalAmount = totalAmountResult[0]?.totalSpent || 0;
  const bucketIds = [...new Set(docs.map((t) => String(t.bucketId)))];
  const buckets = await Bucket.find({ userId: user._id, _id: { $in: bucketIds } }).lean();
  const bm = new Map(buckets.map((b) => [String(b._id), b]));
  const items = docs.map((t) => {
    const b = bm.get(String(t.bucketId));
    return {
      id: String(t._id),
      description: t.description,
      amount: t.amount,
      transactionDate: t.transactionDate.toISOString(),
      dateKey: formatInTimeZone(t.transactionDate, user.timezone, 'yyyy-MM-dd'),
      notes: t.notes,
      createdAt: t.createdAt.toISOString(),
      bucket: {
        id: String(t.bucketId),
        name: b?.name || 'Archived bucket',
        icon: b?.icon || 'other',
        color: b?.color || '#9b9b87',
        isArchived: b?.isArchived ?? true,
      },
    };
  });
  return {
    items,
    total,
    totalAmount,
    page: query.page,
    pages: Math.max(1, Math.ceil(total / query.limit)),
  };
}
export async function monthlyTrends(
  user: UserDocument,
  endMonth = currentMonth(user.timezone),
  count = 6,
) {
  const startMonth = shiftMonth(endMonth, 1 - count);
  const range = {
    start: monthRange(startMonth, user.timezone).start,
    end: monthRange(endMonth, user.timezone).end,
  };
  const [spent, budgets] = await Promise.all([
    Transaction.aggregate<{ _id: string; amount: number }>([
      { $match: { userId: user._id, transactionDate: { $gte: range.start, $lt: range.end } } },
      {
        $group: {
          _id: {
            $dateToString: { date: '$transactionDate', format: '%Y-%m', timezone: user.timezone },
          },
          amount: { $sum: '$amount' },
        },
      },
    ]),
    BucketBudget.aggregate<{ _id: string; amount: number }>([
      { $match: { userId: user._id, monthKey: { $gte: startMonth, $lte: endMonth } } },
      { $group: { _id: '$monthKey', amount: { $sum: '$amount' } } },
    ]),
  ]);
  const sm = new Map(spent.map((s) => [s._id, s.amount]));
  const bm = new Map(budgets.map((b) => [b._id, b.amount]));
  return Array.from({ length: count }, (_, i) => {
    const month = shiftMonth(startMonth, i);
    return { month, spent: sm.get(month) || 0, budget: bm.get(month) || 0 };
  });
}
export async function overview(user: UserDocument, month: string) {
  const range = monthRange(month, user.timezone);
  const [buckets, trend, dailyRaw, recent] = await Promise.all([
    bucketViews(user, month),
    monthlyTrends(user, month),
    Transaction.aggregate<{ _id: string; spent: number; count: number }>([
      { $match: { userId: user._id, transactionDate: { $gte: range.start, $lt: range.end } } },
      {
        $group: {
          _id: {
            $dateToString: {
              date: '$transactionDate',
              format: '%Y-%m-%d',
              timezone: user.timezone,
            },
          },
          spent: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
    ]),
    listTransactions(user, { month, page: 1, limit: 5, sort: 'date-desc' }),
  ]);
  const budget = buckets.reduce((s, b) => s + b.budget, 0);
  const spent = buckets.reduce((s, b) => s + b.spent, 0);
  const map = new Map(dailyRaw.map((d) => [d._id, d.spent]));
  const daily = Array.from({ length: daysInMonth(month) }, (_, i) => {
    const day = `${month}-${String(i + 1).padStart(2, '0')}`;
    return { day, spent: map.get(day) || 0 };
  });
  const now = currentDate(user.timezone);
  const nowMonth = now.slice(0, 7);
  const remainingDays =
    month < nowMonth
      ? 0
      : month > nowMonth
        ? daysInMonth(month)
        : daysInMonth(month) - Number(now.slice(-2)) + 1;
  const elapsedDays =
    month < nowMonth ? daysInMonth(month) : month === nowMonth ? Number(now.slice(-2)) : 0;
  return {
    monthKey: month,
    ...budgetMetrics(budget, spent),
    transactionCount: dailyRaw.reduce((n, d) => n + d.count, 0),
    previousSpent: trend.at(-2)?.spent || 0,
    dailyAllowance: remainingDays ? Math.floor(Math.max(0, budget - spent) / remainingDays) : 0,
    pace: {
      period: month < nowMonth ? 'past' : month === nowMonth ? 'current' : 'future',
      elapsedDays,
      remainingDays,
      totalDays: daysInMonth(month),
      spendingDays: dailyRaw.length,
      averageDailySpent: elapsedDays ? Math.round(spent / elapsedDays) : 0,
      projectedSpent:
        month === nowMonth && elapsedDays
          ? Math.round((spent / elapsedDays) * daysInMonth(month))
          : null,
    },
    buckets,
    trend,
    daily,
    recent: recent.items,
  };
}
