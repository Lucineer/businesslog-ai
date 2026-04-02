interface Widget { id:string; type:'metric'|'chart'|'list'|'table'|'text'; title:string; data:any; config:Record<string,any> }
const uid = () => crypto.randomUUID();
export class Dashboard {
  private widgets = new Map<string, Widget>();
  private metrics = new Map<string, {value:number;label:string;prev:number}>();
  addMetric(key: string, value: number, label: string): void { const prev = this.metrics.get(key)?.value || 0; this.metrics.set(key, { value, label, prev }); }
  getMetric(key: string): {value:number;label:string;change:number} { const m = this.metrics.get(key); if (!m) return {value:0,label:'',change:0}; return { value:m.value, label:m.label, change:m.prev ? +((m.value-m.prev)/m.prev*100).toFixed(1) : 0 }; }
  addWidget(type: Widget['type'], title: string, data: any, config: Record<string,any> = {}): Widget { const w: Widget = { id:uid(), type, title, data, config }; this.widgets.set(w.id, w); return w; }
  removeWidget(id: string): void { this.widgets.delete(id); }
  getWidget(id: string): Widget | undefined { return this.widgets.get(id); }
  getAllWidgets(): Widget[] { return [...this.widgets.values()]; }
  getMetrics(): Array<{key:string;value:number;label:string;change:number}> { return [...this.metrics.entries()].map(([k, m]) => ({ key:k, value:m.value, label:m.label, change:m.prev ? +((m.value-m.prev)/m.prev*100).toFixed(1) : 0 })); }
  generateHTML(): string {
    const metrics = this.getMetrics().map(m => `<div class="metric"><div class="metric-label">${m.label}</div><div class="metric-value">${m.value}</div><div class="metric-change ${m.change>=0?'positive':'negative'}">${m.change>=0?'+':''}${m.change}%</div></div>`).join('');
    const widgets = this.getAllWidgets().map(w => `<div class="widget"><h3>${w.title}</h3><div class="widget-content">${JSON.stringify(w.data).slice(0,200)}</div></div>`).join('');
    return `<div class="dashboard"><div class="metrics">${metrics}</div><div class="widgets">${widgets}</div></div>`;
  }
  generateJSON(): string { return JSON.stringify({ metrics: this.getMetrics(), widgets: [...this.widgets.values()] }); }
  exportReport(): string { return this.getMetrics().map(m => `${m.label}: ${m.value} (${m.change>=0?'+':''}${m.change}%)`).join('\n'); }
  serialize(): string { return JSON.stringify({ widgets: [...this.widgets.values()], metrics: [...this.metrics.entries()] }); }
  deserialize(data: string): void { const d = JSON.parse(data); this.widgets = new Map(d.widgets.map((w: Widget) => [w.id, w])); this.metrics = new Map(d.metrics); }
}
