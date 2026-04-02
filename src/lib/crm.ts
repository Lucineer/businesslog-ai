// src/lib/crm.ts

// --- Interfaces ---
interface Contact {
  id: string;
  name: string;
  email: string;
  company: string;
  role: string;
  phone: string;
  notes: string;
  tags: string[];
  status: 'active' | 'inactive' | 'lead' | 'prospect' | 'customer';
  lastContact: string; // ISO date string (e.g., "2023-10-27T10:00:00.000Z")
  value: number; // Total value of CLOSED_WON deals associated with this contact
}

interface Deal {
  id: string;
  contactId: string;
  title: string;
  value: number;
  stage: 'discovery' | 'proposal' | 'negotiation' | 'closed_won' | 'closed_lost';
  probability: number; // 0-1 (e.g., 0.7 for 70%)
  expectedClose: string; // ISO date string
  notes: string;
}

interface Interaction {
  id: string;
  contactId: string;
  type: 'email