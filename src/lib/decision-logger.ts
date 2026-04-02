// src/lib/decision-logger.ts

export interface Decision {
  id: string;
  title: string;
  description: string;
  context: string;
  rationale: string;
  alternatives: string[];
  decidedBy: string;
  decidedAt: number;
  stakeholders: string[];
  impact: 'low' | 'medium' | 'high' | 'critical';
  status: 'proposed' | 'decided' | 'implemented' | 'reversed';
  outcome?: string;
  tags: string[];
}

export interface DecisionTimeline {
  period: string;
  decisions: Decision[];
  themes: string[];
  reversals: Decision[];
  avgTimeToImplement: number;
}

export class DecisionLogger {
  private decisions: Map<string, Decision> = new Map();
  private counter = 0;

  logDecision(
    title: string, description: string, context: string, rationale: string,
    alternatives: string[], decidedBy: string, impact: Decision['impact'], stakeholders: string[]
  ): Decision {
    const id = `dec_${Date.now()}_${++this.counter}`;
    const decision: Decision = {
      id, title, description, context, rationale, alternatives,
      decidedBy, decidedAt: Date.now(), stakeholders, impact,
      status: 'decided',
      tags: [impact, ...stakeholders.map(s => s.toLowerCase()), ...title.toLowerCase().split(/\s+/).filter(w => w.length > 3)]
    };
    this.decisions.set(id, decision);
    return decision;
  }

  getDecision(id: string): Decision | undefined {
    return this.decisions.get(id);
  }

  updateOutcome(id: string, outcome: string): void {
    const d = this.decisions.get(id);
    if (d) { d.outcome = outcome; d.status = 'implemented'; }
  }

  reverseDecision(id: string, reason: string): void {
    const d = this.decisions.get(id);
    if (d) { d.status = 'reversed'; d.outcome = `Reversed: ${reason}`; }
  }

  getDecisionsByImpact(impact: Decision['impact']): Decision[] {
    return [...this.decisions.values()].filter(d => d.impact === impact);
  }

  getDecisionsByStatus(status: Decision['status']): Decision[] {
    return [...this.decisions.values()].filter(d => d.status === status);
  }

  getDecisionsByStakeholder(name: string): Decision[] {
    const q = name.toLowerCase();
    return [...this.decisions.values()].filter(d =>
      d.stakeholders.some(s => s.toLowerCase() === q) || d.decidedBy.toLowerCase() === q
    );
  }

  getRecentDecisions(count: number): Decision[] {
    return [...this.decisions.values()]
      .sort((a, b) => b.decidedAt - a.decidedAt)
      .slice(0, count);
  }

  searchDecisions(query: string): Decision[] {
    const q = query.toLowerCase();
    return [...this.decisions.values()].filter(d =>
      d.title.toLowerCase().includes(q) ||
      d.description.toLowerCase().includes(q) ||
      d.rationale.toLowerCase().includes(q) ||
      d.context.toLowerCase().includes(q) ||
      d.tags.some(t => t.includes(q))
    );
  }

  generateTimeline(period: string): DecisionTimeline {
    const now = Date.now();
    let start: number;
    switch (period) {
      case 'week': start = now - 7 * 86400000; break;
      case 'month': start = now - 30 * 86400000; break;
      case 'quarter': start = now - 90 * 86400000; break;
      case 'year': start = now - 365 * 86400000; break;
      default: start = 0;
    }

    const filtered = [...this.decisions.values()]
      .filter(d => d.decidedAt >= start)
      .sort((a, b) => a.decidedAt - b.decidedAt);

    const reversals = filtered.filter(d => d.status === 'reversed');
    const implemented = filtered.filter(d => d.status === 'implemented');

    const wordFreq: Record<string, number> = {};
    filtered.forEach(d => d.tags.forEach(t => { wordFreq[t] = (wordFreq[t] || 0) + 1; }));
    const themes = Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5).map(([w]) => w);

    const avgTimeToImplement = implemented.length > 0
      ? implemented.reduce((s, d) => s + (d.outcome ? 1 : 0), 0) / implemented.length
      : 0;

    return { period, decisions: filtered, themes, reversals, avgTimeToImplement };
  }

  getReversalRate(): number {
    const total = this.decisions.size;
    if (total === 0) return 0;
    const reversed = [...this.decisions.values()].filter(d => d.status === 'reversed').length;
    return reversed / total;
  }

  getStakeholderInfluence(): Record<string, number> {
    const weights = { low: 1, medium: 2, high: 3, critical: 4 };
    const scores: Record<string, number> = {};
    this.decisions.forEach(d => {
      const w = weights[d.impact];
      scores[d.decidedBy] = (scores[d.decidedBy] || 0) + w;
      d.stakeholders.forEach(s => { scores[s] = (scores[s] || 0) + w * 0.5; });
    });
    return scores;
  }

  getDecisionStats(): {
    total: number; byImpact: Record<string, number>;
    byStatus: Record<string, number>; avgTimeToOutcome: number;
  } {
    const all = [...this.decisions.values()];
    const byImpact: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    const byStatus: Record<string, number> = { proposed: 0, decided: 0, implemented: 0, reversed: 0 };
    
    all.forEach(d => { byImpact[d.impact]++; byStatus[d.status]++; });

    return { total: all.length, byImpact, byStatus, avgTimeToOutcome: 0 };
  }

  exportMarkdown(dateRange?: { start: number; end: number }): string {
    let ds = [...this.decisions.values()].sort((a, b) => b.decidedAt - a.decidedAt);
    if (dateRange) ds = ds.filter(d => d.decidedAt >= dateRange.start && d.decidedAt <= dateRange.end);

    let md = `# Decision Log\n_Exported: ${new Date().toISOString()}_\n\n`;
    ds.forEach(d => {
      md += `## ${d.title}\n`;
      md += `- **Impact**: ${d.impact} | **Status**: ${d.status} | **By**: ${d.decidedBy}\n`;
      md += `- **Context**: ${d.context}\n- **Rationale**: ${d.rationale}\n`;
      if (d.alternatives.length) md += `- **Alternatives**: ${d.alternatives.join(', ')}\n`;
      if (d.outcome) md += `- **Outcome**: ${d.outcome}\n`;
      md += `\n`;
    });
    return md;
  }

  serialize(): string {
    return JSON.stringify([...this.decisions.values()]);
  }

  deserialize(json: string): void {
    try {
      const arr: Decision[] = JSON.parse(json);
      this.decisions.clear();
      arr.forEach(d => this.decisions.set(d.id, d));
    } catch { throw new Error('Invalid decision log data format.'); }
  }
}