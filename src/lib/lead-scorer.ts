// src/lib/lead-scorer.ts

/**
 * Represents a single lead in the sales pipeline.
 */
interface Lead {
  id: string;
  name: string;
  company: string;
  email: string;
  score: number;
  stage: 'new' | 'contacted' | 'qualified' | 'proposal' | 'negotiation' | 'closed-won' | 'closed-lost';
  source: string;
  value: number; // Estimated deal value
  lastContact: number; // Timestamp in milliseconds of the last interaction
  notes: string[];
  activities: LeadActivity[];
}

/**
 * Represents an activity associated with a lead.
 */
interface LeadActivity {
  type: string; // e.g., 'email_sent', 'call_made', 'demo_given'
  date: number; // Timestamp in milliseconds