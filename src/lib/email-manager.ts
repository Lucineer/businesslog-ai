interface Email { id:string; to:string[]; cc:string[]; subject:string; body:string; status:'draft'|'sent'|'scheduled'|'replied'|'failed'; sentAt?:number; scheduledAt?:number; threadId?:string; labels:string[] }
interface Template { id:string; name:string; subject:string; body:string; vars:string[]; category:string }
const uid = () => crypto.randomUUID();
export class EmailManager {
  private emails = new Map<string, Email>();
  private templates = new Map<string, Template>();
  private threads = new Map<string, string[]>();
  draft(to: string[], subject: string, body: string): Email { const e: Email = { id: uid(), to, cc: [], subject, body, status: 'draft', labels: [] }; this.emails.set(e.id, e); return e; }
  send(id: string): Email | undefined { const e = this.emails.get(id); if (!e || e.status !== 'draft') return; e.status = 'sent'; e.sentAt = Date.now(); return e; }
  schedule(id: string, at: number): void { const e = this.emails.get(id); if (e) { e.status = 'scheduled'; e.scheduledAt = at; } }
  reply(emailId: string, body: string): Email | undefined { const orig = this.emails.get(emailId); if (!orig) return; const r = this.draft(orig.to, `Re: ${orig.subject}`, body); r.threadId = orig.threadId || orig.id; const thread = this.threads.get(r.threadId) || []; thread.push(r.id); this.threads.set(r.threadId, thread); orig.status = 'replied'; return r; }
  forward(emailId: string, to: string[], note?: string): Email | undefined { const orig = this.emails.get(emailId); if (!orig) return; return this.draft(to, `Fwd: ${orig.subject}`, (note ? note + '\n\n' : '') + '---\n' + orig.body); }
  get(id: string): Email | undefined { return this.emails.get(id); }
  search(q: string): Email[] { const l = q.toLowerCase(); return [...this.emails.values()].filter(e => e.subject.toLowerCase().includes(l) || e.body.toLowerCase().includes(l) || e.to.some(t => t.includes(l))); }
  byLabel(label: string): Email[] { return [...this.emails.values()].filter(e => e.labels.includes(label)); }
  byThread(threadId: string): Email[] { const ids = this.threads.get(threadId) || []; return ids.map(id => this.emails.get(id)).filter(Boolean) as Email[]; }
  createTemplate(name: string, subject: string, body: string, vars: string[], category: string): Template { const t: Template = { id: uid(), name, subject, body, vars, category }; this.templates.set(t.id, t); return t; }
  useTemplate(templateId: string, variables: Record<string, string>): Email | undefined { const t = this.templates.get(templateId); if (!t) return; let subj = t.subject, bod = t.body; for (const [k, v] of Object.entries(variables)) { subj = subj.replace(`{{${k}}}`, v); bod = bod.replace(`{{${k}}}`, v); } return this.draft([], subj, bod); }
  getTemplates(cat?: string): Template[] { return [...this.templates.values()].filter(t => !cat || t.category === cat); }
  sentCount(days: number): number { const cutoff = Date.now() - days * 86400000; return [...this.emails.values()].filter(e => e.status === 'sent' && e.sentAt && e.sentAt >= cutoff).length; }
  replyRate(days: number): number { const sent = [...this.emails.values()].filter(e => e.sentAt && e.sentAt >= Date.now() - days * 86400000); if (!sent.length) return 0; return sent.filter(e => e.status === 'replied').length / sent.length; }
  addLabel(id: string, label: string): void { const e = this.emails.get(id); if (e && !e.labels.includes(label)) e.labels.push(label); }
  deleteEmail(id: string): void { this.emails.delete(id); }
  serialize(): string { return JSON.stringify({ emails: [...this.emails.values()], templates: [...this.templates.values()], threads: [...this.threads.entries()] }); }
  deserialize(data: string): void { const d = JSON.parse(data); this.emails = new Map(d.emails.map((e: Email) => [e.id, e])); this.templates = new Map(d.templates.map((t: Template) => [t.id, t])); this.threads = new Map(d.threads); }
}
