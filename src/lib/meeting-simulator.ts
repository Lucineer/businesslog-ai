// src/lib/meeting-simulator.ts

export type Personality = 'leader' | 'analyst' | 'creative' | 'skeptic' | 'mediator' | 'neutral';
export type SpeakingStyle = 'direct' | 'detailed' | 'enthusiastic' | 'cautious' | 'diplomatic' | 'neutral';
export type Sentiment = 'positive' | 'negative' | 'neutral' | 'mixed';
export type Priority = 'high' | 'medium' | 'low';

export interface MeetingParticipant {
  id: string;
  name: string;
  role: string;
  personality: Personality;
  speakingStyle: SpeakingStyle;
  positions: string[];
}

export interface MeetingAgenda {
  topic: string;
  duration: number; // in minutes
  points: string[];
  decisionNeeded: boolean;
}

export interface MeetingMessage {
  participantId: string;
  content: string;
  timestamp: Date;
  sentiment: Sentiment;
}

export interface ActionItem {
  assignee: string;
  task: string;
  deadline: Date;
  priority: Priority;
}

export interface MeetingSimulation {
  id: string;
  participants: MeetingParticipant[];
  agenda: MeetingAgenda;
  transcript: MeetingMessage[];
  summary: string;
  decisions: string[];
  actionItems: ActionItem[];
  createdAt: Date;
  updatedAt: Date;
  isActive: boolean;
}

export class MeetingSimulator {
  private meetings: Map<string, MeetingSimulation> = new Map();
  private meetingHistory: MeetingSimulation[] = [];

  private generateId(): string {
    return `meeting_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private getParticipantById(meetingId: string, participantId: string): MeetingParticipant | undefined {
    const meeting = this.meetings.get(meetingId);
    return meeting?.participants.find(p => p.id === participantId);
  }

  private generateResponse(
    participant: MeetingParticipant,
    topic: string,
    previousMessages: MeetingMessage[] = []
  ): string {
    const responses: Record<Personality, string[]> = {
      leader: [
        `I think we need to make a decision on ${topic}. Let's focus on the key objectives.`,
        `Based on what I'm hearing, I propose we move forward with the following approach...`,
        `Time is limited. Let's decide on this now and assign clear responsibilities.`,
        `I'll take ownership of this. Here's what we should do...`
      ],
      analyst: [
        `Before we decide, let's look at the data. What metrics are we tracking for ${topic}?`,
        `I've analyzed the numbers and here are three key insights...`,
        `We need to consider the risks. The probability of success based on historical data is...`,
        `Let me break down the cost-benefit analysis for each option.`
      ],
      creative: [
        `What if we approached ${topic} from a completely different angle?`,
        `I have a bold idea that could revolutionize how we handle this...`,
        `Imagine if we combined this with emerging trends in the market...`,
        `Let's think outside the box here. Traditional approaches won't cut it.`
      ],
      skeptic: [
        `I'm concerned about ${topic}. What are the potential downsides?`,
        `Has anyone considered the risks involved with this approach?`,
        `I'm not convinced this will work. We need more evidence.`,
        `This seems too optimistic. Let's prepare for worst-case scenarios.`
      ],
      mediator: [
        `I understand both sides. Maybe we can find a middle ground on ${topic}?`,
        `Let's make sure everyone's voice is heard. What does the team think?`,
        `I sense some disagreement. Can we explore options that address everyone's concerns?`,
        `Perhaps we can combine the best elements from each suggestion.`
      ],
      neutral: [
        `I see the points being made about ${topic}.`,
        `Let's continue the discussion on this matter.`,
        `Thank you for sharing those perspectives.`,
        `We should document all viewpoints on this topic.`
      ]
    };

    const styleModifiers: Record<SpeakingStyle, string> = {
      direct: '',
      detailed: 'To elaborate further, ',
      enthusiastic: 'I\'m really excited about this! ',
      cautious: 'With all due respect, ',
      diplomatic: 'If I may offer a perspective, ',
      neutral: ''
    };

    const participantResponses = responses[participant.personality];
    const baseResponse = participantResponses[Math.floor(Math.random() * participantResponses.length)];
    const modifier = styleModifiers[participant.speakingStyle];
    
    // Add some variation based on positions
    if (participant.positions.length > 0 && Math.random() > 0.5) {
      const position = participant.positions[Math.floor(Math.random() * participant.positions.length)];
      return `${modifier}${baseResponse} From my perspective as ${participant.role}, ${position}`;
    }
    
    return `${modifier}${baseResponse}`;
  }

  private determineSentiment(personality: Personality, content: string): Sentiment {
    const positiveKeywords = ['excited', 'great', 'excellent', 'agree', 'support', 'progress'];
    const negativeKeywords = ['concerned', 'risk', 'worried', 'disagree', 'problem', 'issue'];
    
    const lowerContent = content.toLowerCase();
    const positiveCount = positiveKeywords.filter(kw => lowerContent.includes(kw)).length;
    const negativeCount = negativeKeywords.filter(kw => lowerContent.includes(kw)).length;
    
    if (positiveCount > negativeCount) return 'positive';
    if (negativeCount > positiveCount) return 'negative';
    if (positiveCount === negativeCount && positiveCount > 0) return 'mixed';
    
    // Personality-based defaults
    switch (personality) {
      case 'leader': return 'positive';
      case 'skeptic': return 'negative';
      case 'creative': return 'positive';
      default: return 'neutral';
    }
  }

  createMeeting(participants: MeetingParticipant[], agenda: MeetingAgenda): MeetingSimulation {
    const meeting: MeetingSimulation = {
      id: this.generateId(),
      participants,
      agenda,
      transcript: [],
      summary: '',
      decisions: [],
      actionItems: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      isActive: false
    };

    this.meetings.set(meeting.id, meeting);
    return meeting;
  }

  addParticipant(meetingId: string, participant: MeetingParticipant): void {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) throw new Error(`Meeting ${meetingId} not found`);
    
    if (meeting.participants.some(p => p.id === participant.id)) {
      throw new Error(`Participant ${participant.id} already exists in meeting`);
    }
    
    meeting.participants.push(participant);
    meeting.updatedAt = new Date();
  }

  startSimulation(meetingId: string): MeetingSimulation {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) throw new Error(`Meeting ${meetingId} not found`);
    
    if (meeting.isActive) {
      throw new Error(`Meeting ${meetingId} is already active`);
    }

    meeting.isActive = true;
    meeting.transcript = [];

    // Generate initial messages
    const messageCount = Math.floor(Math.random() * 6) + 15; // 15-20 messages
    const { topic } = meeting.agenda;

    for (let i = 0; i < messageCount; i++) {
      const participantIndex = i % meeting.participants.length;
      const participant = meeting.participants[participantIndex];
      
      const content = this.generateResponse(participant, topic, meeting.transcript);
      const sentiment = this.determineSentiment(participant.personality, content);
      
      const message: MeetingMessage = {
        participantId: participant.id,
        content,
        timestamp: new Date(Date.now() + i * 60000), // 1 minute intervals
        sentiment
      };

      meeting.transcript.push(message);
    }

    // Generate summary and decisions
    meeting.summary = this.generateSummary(meeting);
    meeting.decisions = this.extractDecisions(meeting);
    meeting.actionItems = this.generateActionItems(meeting);
    
    meeting.updatedAt = new Date();
    
    // Save to history
    this.meetingHistory.push({...meeting});
    
    return meeting;
  }

  private generateSummary(meeting: MeetingSimulation): string {
    const participantNames = meeting.participants.map(p => p.name).join(', ');
    const topic = meeting.agenda.topic;
    const messageCount = meeting.transcript.length;
    
    return `Meeting on "${topic}" with ${participantNames}. ${messageCount} messages exchanged. ` +
           `Key decisions: ${meeting.decisions.length}. Action items: ${meeting.actionItems.length}.`;
  }

  private extractDecisions(meeting: MeetingSimulation): string[] {
    const decisions: string[] = [];
    const leaderMessages = meeting.transcript.filter(msg => {
      const participant = this.getParticipantById(meeting.id, msg.participantId);
      return participant?.personality === 'leader';
    });

    leaderMessages.forEach(msg => {
      if (msg.content.includes('decide') || msg.content.includes('decision') || 
          msg.content.includes('propose') || msg.content.includes('agree')) {
        decisions.push(`Decision based on: "${msg.content.substring(0, 100)}..."`);
      }
    });

    return decisions.length > 0 ? decisions : ['No formal decisions recorded'];
  }

  private generateActionItems(meeting: MeetingSimulation): ActionItem[] {
    const actionItems: ActionItem[] = [];
    const priorities: Priority[] = ['high', 'medium', 'low'];
    
    // Assign tasks to participants based on their personality
    meeting.participants.forEach(participant => {
      if (Math.random() > 0.3) { // 70% chance of getting an action item
        const taskTypes: Record<Personality, string[]> = {
          leader: ['Lead implementation', 'Finalize strategy', 'Coordinate team'],
          analyst: ['Analyze data', 'Prepare report', 'Research metrics'],
          creative: ['Brainstorm solutions', 'Design approach', 'Explore alternatives'],
          skeptic: ['Risk assessment', 'Quality check', 'Review assumptions'],
          mediator: ['Follow up with stakeholders', 'Document agreements', 'Schedule next meeting'],
          neutral: ['Take notes', 'Distribute minutes', 'Update documentation']
        };

        const tasks = taskTypes[participant.personality];
        const task = tasks[Math.floor(Math.random() * tasks.length)];
        const priority = priorities[Math.floor(Math.random() * priorities.length)];
        
        // Deadline 1-4 weeks from now
        const deadline = new Date();
        deadline.setDate(deadline.getDate() + (Math.floor(Math.random() * 28) + 7));

        actionItems.push({
          assignee: participant.name,
          task: `${task} for ${meeting.agenda.topic}`,
          deadline,
          priority
        });
      }
    });

    return actionItems;
  }

  addHumanInput(meetingId: string, message: Omit<MeetingMessage, 'timestamp'>): void {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) throw new Error(`Meeting ${meetingId} not found`);
    
    if (!meeting.isActive) {
      throw new Error(`Meeting ${meetingId} is not active`);
    }

    const fullMessage: MeetingMessage = {
      ...message,
      timestamp: new Date()
    };

    meeting.transcript.push(fullMessage);
    meeting.updatedAt = new Date();
  }

  getTranscript(meetingId: string): MeetingMessage[] {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) throw new Error(`Meeting ${meetingId} not found`);
    
    return [...meeting.transcript];
  }

  getSummary(meetingId: string): string {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) throw new Error(`Meeting ${meetingId} not found`);
    
    return meeting.summary || this.generateSummary(meeting);
  }

  getDecisions(meetingId: string): string[] {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) throw new Error(`Meeting ${meetingId} not found`);
    
    return [...meeting.decisions];
  }

  getActionItems(meetingId: string): ActionItem[] {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) throw new Error(`Meeting ${meetingId} not found`);
    
    return [...meeting.actionItems];
  }

  getConflicts(meetingId: string): string[] {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) throw new Error(`Meeting ${meetingId} not found`);
    
    const conflicts: string[] = [];
    const negativeMessages = meeting.transcript.filter(msg => msg.sentiment === 'negative');
    
    negativeMessages.forEach(msg => {
      const participant = this.getParticipantById(meetingId, msg.participantId);
      if (participant) {
        conflicts.push(`${participant.name} expressed concern: "${msg.content.substring(0, 80)}..."`);
      }