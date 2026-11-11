export type BudgetStatus = 'normal' | 'warning' | 'reached' | 'overspending' | 'unbudgeted';
export interface User {
  id: string;
  name: string;
  email: string;
  currency: string;
  timezone: string;
  isDemo: boolean;
}
export interface Bucket {
  id: string;
  name: string;
  icon: string;
  color: string;
  isDefault: boolean;
  isArchived: boolean;
  sortOrder: number;
  budget: number;
  spent: number;
  remaining: number;
  utilization: number;
  status: BudgetStatus;
}
export interface Transaction {
  id: string;
  description: string;
  amount: number;
  transactionDate: string;
  dateKey: string;
  notes: string;
  createdAt: string;
  bucket: Pick<Bucket, 'id' | 'name' | 'icon' | 'color' | 'isArchived'>;
}
export interface Overview {
  monthKey: string;
  budget: number;
  spent: number;
  remaining: number;
  utilization: number;
  status: BudgetStatus;
  transactionCount: number;
  previousSpent: number;
  dailyAllowance: number;
  pace: {
    period: 'past' | 'current' | 'future';
    elapsedDays: number;
    remainingDays: number;
    totalDays: number;
    spendingDays: number;
    averageDailySpent: number;
    projectedSpent: number | null;
  };
  buckets: Bucket[];
  trend: { month: string; spent: number; budget: number }[];
  daily: { day: string; spent: number }[];
  recent: Transaction[];
}
export interface PageResult<T> {
  items: T[];
  page: number;
  pages: number;
  total: number;
  totalAmount?: number;
}
export interface ExpenseInput {
  description: string;
  amount: number;
  bucketId: string;
  date: string;
  notes?: string;
}
