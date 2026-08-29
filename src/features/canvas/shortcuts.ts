/**
 * The canvas keyboard map, in one place.
 *
 * This array is the single source for the `?` overlay, the canvas's own
 * hidden description, and the README. If a binding is not listed here it does
 * not exist, and if it is listed here the overlay shows it - so the reference
 * cannot drift away from the behaviour.
 */
export interface Shortcut {
  readonly keys: readonly string[];
  readonly action: string;
  readonly group: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  {
    keys: ['Tab'],
    action: 'Move to the next node, top to bottom then left to right',
    group: 'Moving around',
  },
  { keys: ['Shift', 'Tab'], action: 'Move to the previous node', group: 'Moving around' },
  { keys: ['Space', 'drag'], action: 'Pan the canvas', group: 'Moving around' },
  { keys: ['Middle-drag'], action: 'Pan the canvas', group: 'Moving around' },
  { keys: ['Scroll'], action: 'Pan vertically and horizontally', group: 'Moving around' },
  { keys: ['Ctrl', 'Scroll'], action: 'Zoom about the pointer', group: 'Moving around' },
  { keys: ['F'], action: 'Fit every node in view', group: 'Moving around' },
  { keys: ['0'], action: 'Reset zoom to 100%', group: 'Moving around' },

  { keys: ['Arrows'], action: 'Move the selected nodes by 8px', group: 'Editing' },
  { keys: ['Shift', 'Arrows'], action: 'Move the selected nodes by 64px', group: 'Editing' },
  { keys: ['Enter'], action: "Edit the focused node's input", group: 'Editing' },
  { keys: ['Escape'], action: 'Leave the input and return to the node', group: 'Editing' },
  { keys: ['Shift', 'Enter'], action: 'Add the focused node to the selection', group: 'Editing' },
  { keys: ['Ctrl', 'A'], action: 'Select every node', group: 'Editing' },
  { keys: ['Ctrl', 'D'], action: 'Duplicate the selection', group: 'Editing' },
  { keys: ['Delete'], action: 'Delete the selection', group: 'Editing' },
  { keys: ['Ctrl', 'Z'], action: 'Undo', group: 'Editing' },
  { keys: ['Ctrl', 'Shift', 'Z'], action: 'Redo', group: 'Editing' },

  { keys: ['K'], action: 'Open the tool palette', group: 'Building' },
  { keys: ['C'], action: 'Connect from the focused node, without dragging', group: 'Building' },
  { keys: ['Escape'], action: 'Cancel the current dialog, drag or connection', group: 'Building' },
  { keys: ['?'], action: 'Show this list', group: 'Building' },
];

export const SHORTCUT_GROUPS = ['Moving around', 'Editing', 'Building'] as const;

/** One-line summary used as the canvas's accessible description. */
export const CANVAS_DESCRIPTION =
  'Node canvas. Press K to add a tool, Tab to move between nodes, C to connect from the focused node, ' +
  'arrow keys to move it, Delete to remove it, and question mark for the full list of shortcuts. ' +
  'Every action here is also available on the Tools page.';
