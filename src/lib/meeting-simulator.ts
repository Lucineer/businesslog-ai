// src/lib/meeting-simulator.ts

/**
 * Interface for an Action Item within a meeting.
 */
interface ActionItem {
  id: string;
  assignee: string;
  task: string;
  dueDate: number; // Unix timestamp in milliseconds
  status: 'pending' | 'in-progress' | 'done';
  priority: 'low' | 'medium' | 'high';
}

/**
 * Interface for a Meeting.
 */
interface Meeting {
  id: string;
  title: string;
  attendees: string[];
  date: number; // Unix timestamp in milliseconds
  duration: number; // in minutes
  agenda: string[];
  notes: string;
  actionItems: ActionItem[];
  decisions: string[];
  status: 'scheduled' | 'in-progress' | 'completed' | 'cancelled';
}

/**
 * Helper function to generate a unique ID.
 * Simple random string for simulation purposes.
 */
function generateUniqueId(): string {
  return Math.random().toString(36).substring(2, 11);
}

/**
 * MeetingSimulator class for managing meeting scheduling and note-taking.
 */
export class MeetingSimulator {
  private meetings = new Map<string, Meeting>();

  /**
   * Helper to retrieve a meeting by ID or throw an error if not found.
   * @param id The ID of the meeting.
   * @returns The Meeting object.
   * @throws Error if the meeting is not found.
   */
  private getMeetingOrThrow(id: string): Meeting {
    const meeting = this.meetings.get(id);
    if (!meeting) {
      throw new Error(`Meeting with ID ${id} not found.`);
    }
    return meeting;
  }

  /**
   * 1. Schedules a new meeting.
   * @param title The title of the meeting.
   * @param attendees An array of attendee names.
   * @param date The Unix timestamp (milliseconds) for the meeting date/time.
   * @param duration The duration of the meeting in minutes.
   * @param agenda An array of agenda items.
   * @returns The newly created Meeting object.
   */
  schedule(title: string, attendees: string[], date: number, duration: number, agenda: string[]): Meeting {
    const id = generateUniqueId();
    const newMeeting: Meeting = {
      id,
      title,
      attendees,
      date,
      duration,
      agenda,
      notes: '',
      actionItems: [],
      decisions: [],
      status: 'scheduled',
    };
    this.meetings.set(id, newMeeting);
    return newMeeting;
  }

  /**
   * 2. Retrieves a meeting by its ID.
   * @param id The ID of the meeting.
   * @returns The Meeting object or undefined if not found.
   */
  getMeeting(id: string): Meeting | undefined {
    return this.meetings.get(id);
  }

  /**
   * 3. Starts