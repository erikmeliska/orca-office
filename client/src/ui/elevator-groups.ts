import type { FloorInfo } from '@orca-office/shared/office/protocol';

/**
 * The elevator panel's buttons, top to bottom (design #11, issue #31): the project rooms up on the
 * roof first, then the bots' Staff floor, then the repositories' floors from the top one down. Each
 * repository floor keeps its number (1 at the bottom); rooms get a sign instead of a number.
 */
export interface ElevatorStop {
  floor: FloorInfo;
  /** The repository floor's number, counted from the bottom; null for a room. */
  no: number | null;
  /** The heading this stop starts, when it is the first of its group and groups are shown. */
  heading?: string;
}

export function elevatorStops(floors: FloorInfo[]): ElevatorStop[] {
  const rooms = floors.filter((f) => f.room === 'project');
  const staff = floors.filter((f) => f.room === 'staff');
  const repos = floors.filter((f) => !f.room);
  // Groups only say something when there is more than one kind of stop.
  const grouped = rooms.length > 0 || staff.length > 0;
  const out: ElevatorStop[] = [];
  // The room that needs you most on top.
  const byUrgency = [...rooms].sort((a, b) => b.waiting - a.waiting || b.busy - a.busy || a.name.localeCompare(b.name));
  byUrgency.forEach((f, i) => out.push({ floor: f, no: null, ...(grouped && i === 0 ? { heading: '🏗️ Project rooms on the roof' } : {}) }));
  staff.forEach((f, i) => out.push({ floor: f, no: null, ...(grouped && i === 0 ? { heading: '🤖 Staff' } : {}) }));
  const numbered = repos.map((f, i) => ({ floor: f, no: i + 1 }));
  numbered.reverse().forEach((s, i) => out.push({ ...s, ...(grouped && i === 0 ? { heading: '🏢 Floors' } : {}) }));
  return out;
}

/** The badges a stop wears: who needs you there and who is working, nothing when it is quiet. */
export function stopBadges(f: FloorInfo): { needsYou: number; working: number } {
  return { needsYou: Math.max(0, f.waiting | 0), working: Math.max(0, f.busy | 0) };
}

/** Everyone who needs you anywhere but `here`: for the floor badge on the HUD. */
export function needsYouElsewhere(floors: FloorInfo[], here: string | null | undefined): number {
  return floors.reduce((n, f) => (f.id === here || f.cloning ? n : n + stopBadges(f).needsYou), 0);
}
