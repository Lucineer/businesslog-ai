// src/lib/budget-tracker.ts

/**
 * Represents a budget category with allocated funds, spending limits, and transactions.
 */
interface BudgetCategory {
  id: string;
  name: string;
  allocated: number; // Initial funds allocated to this category
  spent: number;     // Actual expenses incurred in this category
  limit: number;     // Maximum spending limit for this category
  color: string;
  transactions: Transaction[]; // Transactions specific to this category
}

/**
 * Represents a single financial transaction.
 */
interface Transaction {
  id: string;
  date: number; // Unix timestamp
  amount: number;
  description: string;
  category: string; // ID of the BudgetCategory this transaction belongs to
  type: 'income' | 'expense';
  recurring: boolean;
}

/**
 * Manages budget planning and expense