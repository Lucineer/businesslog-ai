interface KPI { id:string; name:string; value:number; target:number; unit:string; history:Array<{date:number;value:number}>; category:string }
const uid = () => crypto.randomUUID();
export class AnalyticsEngine {
  private kpis = new Map<string, KPI>();
  createKPI(name: string, value: number, target: number, unit: string, category: string): KPI { const k: KPI = { id:uid(), name, value, target, unit, history:[{date:Date.now(),value}], category }; this.kpis.set(k.id, k); return k; }
  updateKPI(id: string, value: number): void { const k = this.kpis.get(id); if (k) { k.history.push({date:Date.now(),value}); k.value = value; } }
  getKPI(id: string): KPI | undefined { return this.kpis.get(id); }
  getAllKPIs(): KPI[] { return [...this.kpis.values()]; }
  getByCategory(cat: string): KPI[] { return [...this.kpis.values()].filter(k => k.category === cat); }
  getOnTrack(): KPI[] { return [...this.kpis.values()].filter(k => k.value >= k.target); }
  getOffTrack(): KPI[] { return [...this.kpis.values()].filter(k => k.value < k.target); }
  getProgress(id: string): number { const k = this.kpis.get(id); return k ? Math.min(100, Math.round((k.value/k.target)*100)) : 0; }
  getOverallHealth(): number { const kpis = [...this.kpis.values()]; if (!kpis.length) return 0; return Math.round(kpis.reduce((a,k) => a + Math.min(100, (k.value/k.target)*100), 0) / kpis.length); }
  getTrend(id: string, days: number): string { const k = this.kpis.get(id); if (!k || k.history.length < 2) return 'stable'; const cutoff = Date.now() - days*86400000; const recent = k.history.filter(h => h.date > cutoff); if (recent.length < 2) return 'stable'; return recent[recent.length-1].value > recent[0].value ? 'improving' : recent[recent.length-1].value < recent[0].value ? 'declining' : 'stable'; }
  getAlerts(): string[] { return [...this.kpis.values()].filter(k => k.value < k.target * 0.5).map(k => `⚠️ ${k.name} at ${Math.round(k.value/k.target*100)}% of target`); }
  getScorecard() { return [...this.kpis.values()].map(k => ({name:k.name, value:k.value, target:k.target, progress:this.getProgress(k.id)})); }
  serialize(): string { return JSON.stringify({kpis:[...this.kpis.values()]}); }
  deserialize(data: string): void { const d = JSON.parse(data); this.kpis = new Map(d.kpis.map((k: KPI) => [k.id, k])); }
}
