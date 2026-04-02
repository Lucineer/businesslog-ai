interface InvoiceItem { description: string; qty: number; price: number; amount: number }
interface Invoice { id: string; number: string; contactId: string; items: InvoiceItem[]; subtotal: number; tax: number; total: number; status: 'draft'|'sent'|'paid'|'overdue'|'cancelled'; issued: string; due: string; paidDate?: string; notes: string }
interface Payment { invoiceId: string; amount: number; method: string; date: string; ref: string }

export class InvoiceSystem {
  private invoices = new Map<string, Invoice>();
  private payments = new Map<string, Payment[]>();
  private nextNum = 1001;

  create(contactId: string, items: Array<{description:string;qty:number;price:number}>, dueDays: number = 30): Invoice {
    const invItems = items.map(i => ({ ...i, amount: i.qty * i.price }));
    const subtotal = invItems.reduce((s, i) => s + i.amount, 0);
    const inv: Invoice = { id: crypto.randomUUID(), number: `INV-${this.nextNum++}`, contactId, items: invItems, subtotal, tax: 0, total: subtotal, status: 'draft', issued: new Date().toISOString(), due: new Date(Date.now() + dueDays * 86400000).toISOString(), notes: '' };
    this.invoices.set(inv.id, inv); return inv;
  }

  get(id: string): Invoice | undefined { return this.invoices.get(id); }
  update(id: string, updates: Partial<Invoice>): Invoice | undefined { const inv = this.invoices.get(id); if (!inv) return; Object.assign(inv, updates); return inv; }
  delete(id: string): void { this.invoices.delete(id); this.payments.delete(id); }

  addItem(id: string, item: {description:string;qty:number;price:number}): void {
    const inv = this.invoices.get(id); if (!inv) return;
    inv.items.push({ ...item, amount: item.qty * item.price });
    inv.subtotal = inv.items.reduce((s, i) => s + i.amount, 0);
    inv.total = inv.subtotal + inv.tax;
  }

  send(id: string): Invoice | undefined { const inv = this.invoices.get(id); if (!inv || inv.status !== 'draft') return; inv.status = 'sent'; return inv; }

  recordPayment(id: string, amount: number, method: string, ref: string = ''): Invoice | undefined {
    const inv = this.invoices.get(id); if (!inv) return;
    const payment: Payment = { invoiceId: id, amount, method, date: new Date().toISOString(), ref };
    const invPayments = this.payments.get(id) || [];
    invPayments.push(payment); this.payments.set(id, invPayments);
    const totalPaid = invPayments.reduce((s, p) => s + p.amount, 0);
    if (totalPaid >= inv.total) { inv.status = 'paid'; inv.paidDate = new Date().toISOString(); }
    return inv;
  }

  markOverdue(id: string): void { const inv = this.invoices.get(id); if (inv && inv.status === 'sent') inv.status = 'overdue'; }
  cancel(id: string): void { const inv = this.invoices.get(id); if (inv) inv.status = 'cancelled'; }

  getByStatus(status: string): Invoice[] { return [...this.invoices.values()].filter(i => i.status === status); }
  getByContact(contactId: string): Invoice[] { return [...this.invoices.values()].filter(i => i.contactId === contactId); }
  getOverdue(): Invoice[] { return this.getByStatus('overdue'); }
  getOutstanding(): number { return [...this.invoices.values()].filter(i => i.status === 'sent' || i.status === 'overdue').reduce((s, i) => s + i.total, 0); }
  getPaidTotal(months: number = 1): number {
    const cutoff = Date.now() - months * 30 * 86400000;
    return [...this.payments.values()].flat().filter(p => new Date(p.date).getTime() >= cutoff).reduce((s, p) => s + p.amount, 0);
  }

  getRevenue(months: number = 6): Array<{month:string;revenue:number;invoices:number;avg:number}> {
    const result = new Map<string, {revenue:number;invoices:number}>();
    for (const inv of this.invoices.values()) {
      if (inv.status !== 'paid' || !inv.paidDate) continue;
      const month = inv.paidDate.substring(0, 7);
      const entry = result.get(month) || { revenue: 0, invoices: 0 };
      entry.revenue += inv.total; entry.invoices++;
      result.set(month, entry);
    }
    return [...result.entries()].map(([month, d]) => ({ month, revenue: d.revenue, invoices: d.invoices, avg: d.revenue / d.invoices || 0 })).slice(-months);
  }

  getPaymentHistory(id: string): Payment[] { return this.payments.get(id) || []; }
  serialize(): string { return JSON.stringify({ invoices: [...this.invoices.values()], payments: [...this.payments.entries()], nextNum: this.nextNum }); }
  deserialize(data: string): void { const d = JSON.parse(data); this.invoices = new Map(d.invoices.map((i: Invoice) => [i.id, i])); this.payments = new Map(d.payments); this.nextNum = d.nextNum; }
}
