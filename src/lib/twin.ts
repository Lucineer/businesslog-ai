export interface TwinProfile {
  id: string;
  ownerName: string;
  role: string;
  department: string;
  communicationStyle: string;
  expertise: string[];
  decisionPatterns: string[];
  preferredTopics: string[];
  accuracy: number;
}

export interface MeetingTranscript {
  id: string;
  date: number;
  participants: string[];
  topic: string;
  messages: Array<{ speaker: string; text: string; ts: number }>;
  duration: number;
}

export interface IdeaBuffer {
  id: string;
  idea: string;
  source: string;
  status: 'buffered' | 'shared' | 'withdrawn' | 'researching';
  confidence: number;
  researchAgentId?: string;
  createdAt: number;
  sharedWith?: string[];
}

export interface MeetingSimulation {
  id: string;
  topic: string;
  participants: string[];
  twinInputs: Record<string, string>;
  outcome: string;
  quality: number;
  createdAt: number;
}

let counter = 0;
const uid = (prefix: string) => `${prefix}_${Date.now()}_${++counter}`;

export class BusinessTwinManager {
  private twins = new Map<string, TwinProfile>();
  private ideas = new Map<string, IdeaBuffer>();
  private simulations = new Map<string, MeetingSimulation>();

  createTwin(name: string, role: string, department: string): TwinProfile {
    const twin: TwinProfile = {
      id: uid('twin'),
      ownerName: name,
      role,
      department,
      communicationStyle: 'neutral',
      expertise: [],
      decisionPatterns: [],
      preferredTopics: [],
      accuracy: 0.5,
    };
    this.twins.set(twin.id, twin);
    return twin;
  }

  getTwin(id: string): TwinProfile | undefined {
    return this.twins.get(id);
  }

  getAllTwins(): TwinProfile[] {
    return Array.from(this.twins.values());
  }

  buildTwinFromTranscript(twinId: string, transcript: MeetingTranscript): void {
    const twin = this.twins.get(twinId);
    if (!twin) throw new Error(`Twin ${twinId} not found`);

    const userMessages = transcript.messages.filter((m) => m.speaker === twin.ownerName);
    if (userMessages.length === 0) return;

    // Extract topics
    const topicWords = new Set(transcript.topic.toLowerCase().split(/\s+/));
    topicWords.forEach((w) => {
      if (w.length > 3 && !twin.preferredTopics.includes(w)) {
        twin.preferredTopics.push(w);
      }
    });

    // Extract expertise from noun-like tokens (>6 chars as heuristic)
    const expertiseSet = new Set(twin.expertise);
    userMessages.forEach((m) => {
      m.text.split(/\s+/).forEach((word) => {
        const clean = word.toLowerCase().replace(/[^a-z]/g, '');
        if (clean.length > 6 && Math.random() < 0.15) {
          expertiseSet.add(clean);
        }
      });
    });
    twin.expertise = Array.from(expertiseSet).slice(0, 20);

    // Derive communication style from average message length
    const avgLen = userMessages.reduce((s, m) => s + m.text.length, 0) / userMessages.length;
    if (avgLen < 30) twin.communicationStyle = 'concise';
    else if (avgLen < 80) twin.communicationStyle = 'moderate, data-driven';
    else twin.communicationStyle = 'detailed, analytical';

    // Extract decision patterns
    const decisionKeywords = ['should', 'recommend', 'propose', 'decide', 'agree', 'suggest'];
    userMessages.forEach((m) => {
      const lower = m.text.toLowerCase();
      decisionKeywords.forEach((kw) => {
        if (lower.includes(kw) && !twin.decisionPatterns.includes(kw)) {
          twin.decisionPatterns.push(kw);
        }
      });
    });

    twin.accuracy = Math.min(1, twin.accuracy + 0.05);
  }

  calibrateTwin(twinId: string, actualResponse: string, twinPredicted: string): void {
    const twin = this.twins.get(twinId);
    if (!twin) throw new Error(`Twin ${twinId} not found`);

    const tokenize = (s: string) =>
      new Set(s.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter((w) => w.length > 2));

    const actualTokens = tokenize(actualResponse);
    const predictedTokens = tokenize(twinPredicted);

    let overlap = 0;
    actualTokens.forEach((t) => predictedTokens.has(t) && overlap++);
    const similarity = actualTokens.size > 0 ? overlap / actualTokens.size : 0;

    // Weighted moving average toward measured similarity
    twin.accuracy = twin.accuracy * 0.7 + similarity * 0.3;
  }

  bufferIdea(twinId: string, idea: string, confidence: number): IdeaBuffer {
    const twin = this.twins.get(twinId);
    if (!twin) throw new Error(`Twin ${twinId} not found`);

    const entry: IdeaBuffer = {
      id: uid('idea'),
      idea,
      source: twinId,
      status: 'buffered',
      confidence: Math.max(0, Math.min(1, confidence)),
      createdAt: Date.now(),
    };
    this.ideas.set(entry.id, entry);
    return entry;
  }

  shareIdea(ideaId: string, targetTwinIds: string[]): void {
    const idea = this.ideas.get(ideaId);
    if (!idea || idea.status === 'withdrawn') return;

    targetTwinIds.forEach((tid) => {
      if (!this.twins.has(tid)) throw new Error(`Twin ${tid} not found`);
    });

    idea.status = 'shared';
    idea.sharedWith = targetTwinIds;
  }

  withdrawIdea(ideaId: string): void {
    const idea = this.ideas.get(ideaId);
    if (idea) idea.status = 'withdrawn';
  }

  spawnResearchAgent(ideaId: string): string {
    const idea = this.ideas.get(ideaId);
    if (!idea) throw new Error(`Idea ${ideaId} not found`);

    const agentId = uid('agent');
    idea.status = 'researching';
    idea.researchAgentId = agentId;
    return agentId;
  }

  getBufferedIdeas(twinId: string): IdeaBuffer[] {
    return Array.from(this.ideas.values()).filter(
      (i) => i.source === twinId && i.status === 'buffered'
    );
  }

  simulateMeeting(topic: string, participantTwinIds: string[]): MeetingSimulation {
    const twins = participantTwinIds.map((id) => {
      const t = this.twins.get(id);
      if (!t) throw new Error(`Twin ${id} not found`);
      return t;
    });

    const inputs: Record<string, string> = {};
    let totalQuality = 0;

    twins.forEach((t) => {
      const topicRelevance = t.preferredTopics.some((pt) =>
        topic.toLowerCase().includes(pt.toLowerCase())
      )
        ? 0.3
        : 0;

      const input = [
        `From a ${t.role} perspective in ${t.department},`,
        topicRelevance ? `given my expertise in this area,` : `while this is adjacent to my focus,`,
        `I'd recommend we approach this with ${t.communicationStyle} analysis.`,
        t.decisionPatterns.length > 0
          ? `I ${t.decisionPatterns[0]} we align on clear next steps.`
          : `Let's define action items.`,
      ].join(' ');

      inputs[t.id] = input;
      totalQuality += t.accuracy * 0.5 + topicRelevance + t.confidence * 0.2;
    });

    const sim: MeetingSimulation = {
      id: uid('sim'),
      topic,
      participants: participantTwinIds,
      twinInputs: inputs,
      outcome: `Simulation completed with ${twins.length} participants. Key themes: alignment on ${topic}.`,
      quality: twins.length > 0 ? Math.min(1, totalQuality / twins.length) : 0,
      createdAt: Date.now(),
    };

    this.simulations.set(sim.id, sim);
    return sim;
  }

  serialize(): string {
    return JSON.stringify({
      twins: Array.from(this.twins.entries()),
      ideas: Array.from(this.ideas.entries()),
      simulations: Array.from(this.simulations.entries()),
    });
  }

  deserialize(json: string): void {
    const data = JSON.parse(json);
    this.twins = new Map(data.twins);
    this.ideas = new Map(data.ideas);
    this.simulations = new Map(data.simulations);
  }
}