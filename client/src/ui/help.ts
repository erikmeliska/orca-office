// The rows of the controls help (openHelp in hud.ts), in the order it shows them: a key or an emoji, and
// what it does. A new control is a new row here. The first few are for keeping an eye on the agents
// (M6 A10) and always show; the rest fold away under "All controls".

import { IS_MAC } from './termkeys';

/** What you need to look after the agents: shown first, always. */
export const SUPERVISE_ROWS: readonly (readonly [string, string])[] = [
  ['N', 'Next one waiting for you, on any floor: agents asking first, longest waiting first, then decision gates and the done ones nobody looked at'],
  [IS_MAC ? '⌘K' : 'Ctrl+K', 'Find anything: a worker on any floor, a board, a PR or issue, an action. Enter goes there'],
  ['E', 'At a desk: the agent’s live terminal (a chat agent’s last message). At an empty desk: a new task'],
  ['O', 'Open the desk’s worktree in Orca, its terminal focused'],
  ['R', 'Mark the desk read in Orca'],
  ['M', 'The floor’s map: every desk in its state. Click one to go there'],
  ['V', 'Overview from above, where you start. A step or a click takes you back down'],
];

/** Rows about the games and the company, hidden with the fun off (M6 A11, see fun.ts). */
export const FUN_ROWS: ReadonlySet<string> = new Set(['🕹️', '🎉', '🏀', 'Q', '🍸', '🎯', 'F', 'T', 'G / 1–6']);

/** Everything else, folded away. */
export const HELP_ROWS: readonly (readonly [string, string])[] = [
  ['P', 'Prompt: type a line into the input box of the agent at the desk you face'],
  ['C', 'Comment: the note Orca keeps on the desk’s worktree'],
  ['L', 'Links: the PRs, issues and tickets Orca linked to the desk’s worktree, to open in the browser'],
  ['/', 'Search the chat and every terminal on your floor, back to before the office last restarted'],
  ['Esc', 'Close any window and get back to looking around'],
  ['Ctrl + [', 'Send Esc to a terminal instead, to close a menu like Claude’s /skills or interrupt Claude. ⎋ Esc in the terminal’s header does the same'],
  ['Ctrl+Space', 'Dictate: in a worker’s terminal or a prompt box, hold Ctrl+Space (or the 🎤) and talk, and what you said is typed in when you let go, for you to read over and send. A quick tap leaves it listening until you tap again. The browser does the listening (Chrome, Edge and Safari can), so there’s nothing to install'],
  ['`', 'The ☰ menu, top right: every window, and what shows on screen. Pin what you use most to the top bar'],
  ['Tab', 'Moves the focus through the top bar’s buttons, the banner and the windows; Enter or Space presses the one in focus'],
  ['W A S D', 'Walk (hold Shift to run)'],
  ['Space', 'Jump'],
  ['Mouse', 'Look around in first person (click to capture the mouse, Esc to free it)'],
  ['Click / E', "Use what you look at: hire a worker, open its terminal, read a board, watch the TV, sit on a couch, a beanbag, a chair or the balcony bench (walk off to get up)"],
  ['Drag / wheel', 'Orbit and zoom the camera in third person'],
  ['🛗', 'Every project is a floor: step into the elevator on the north wall and press E (or click the project name, top left) to go to another one or add a project. It goes down to the garage too, and back up from there'],
  ['👥', 'Click someone under "In the office" to walk over to them (on another floor, you ride the elevator first). The line under their name says what they have open or where they are'],
  ['⚙️', 'Settings (in the ☰ menu): switch between first and third person'],
  ['🚧', 'Room to grow: E at the sign on the north wall past the gong knocks through into a back office with 2 more desks, and again for 2 more. The same sign walls a row back up'],
  ['F', 'Hang a picture from the web on a wall. Look at a picture and press E to move, edit or take it down'],
  ['T', 'Chat'],
  ['G / 1–6', 'Emote: hold G, point at one and let go (or tap G and click one), or press 1–6: wave, thumbs up, clap, dance, point, facepalm. Everyone on your floor sees it'],
  ['🐶', 'Walk up to the office dog and press E to pet it. When a worker needs input, it runs to that desk and barks. Name it in ⚙️ Settings'],
  ['☕', 'Press E at the coffee machine in the kitchen for a minute of quicker walking and higher jumps. Three cups in a row gives you the jitters'],
  ['🕹️', 'The arcade cabinet in the lounge plays BLOCKFALL: arrows (or WASD) move and turn, Space drops, C holds, P pauses. Everyone on the floor sees your game on it, and E there watches whoever is playing. One of your workers needing input pauses it'],
  ['🎉', 'Whenever a pull request merges, the gong next to the PR board rings, confetti rains down all over the floor and every worker gets up on its desk for a quick dance. Walk up to the gong and press E to bang it yourself'],
  ['🏀', 'The hoop on the west wall, by the exit door: E at the ball picks it up. Hold E (or the mouse, in first person) and let go when the meter is in the green to sink it. In first person it goes where you look. Q drops it. Everyone on your floor sees your shot'],
  ['Q', 'Drop the basketball'],
  ['🍸', 'The elevator goes up to the rooftop bar: a DJ playing drum and bass under the lights, and the city all around. Press E at the bar for a drink (it goes to your head for a bit) and at the DJ booth for the air horn'],
  ['🎯', 'Up on the roof, in the corner past the DJ: a dart board and an axe-throwing lane. E at either steps up to the line. The mouse (or the arrow keys) aims, and your hand wanders more after a few drinks. Hold Space (or the mouse button) and let go in the green: three darts a visit, five axes a round, chalked up for everyone up there. E steps back'],
];
