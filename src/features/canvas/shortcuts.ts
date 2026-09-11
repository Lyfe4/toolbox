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
  { keys: ['+'], action: 'Zoom in one step about the centre', group: 'Moving around' },
  { keys: ['-'], action: 'Zoom out one step about the centre', group: 'Moving around' },
  { keys: ['F'], action: 'Fit every node in view', group: 'Moving around' },
  { keys: ['0'], action: 'Reset zoom to 100%', group: 'Moving around' },

  { keys: ['Arrows'], action: 'Move the selected nodes by 8px', group: 'Editing' },
  { keys: ['Shift', 'Arrows'], action: 'Move the selected nodes by 64px', group: 'Editing' },
  {
    keys: ['Enter'],
    action: 'Open the inspector on the focused node and move into it',
    group: 'Editing',
  },
  { keys: ['Escape'], action: 'Leave the inspector and return to the node', group: 'Editing' },
  { keys: ['Shift', 'Enter'], action: 'Add the focused node to the selection', group: 'Editing' },
  { keys: ['Ctrl', 'A'], action: 'Select every node', group: 'Editing' },
  { keys: ['Ctrl', 'D'], action: 'Duplicate the selection', group: 'Editing' },
  { keys: ['Delete'], action: 'Delete the selection', group: 'Editing' },
  { keys: ['Ctrl', 'Z'], action: 'Undo', group: 'Editing' },
  { keys: ['Ctrl', 'Shift', 'Z'], action: 'Redo', group: 'Editing' },

  { keys: ['K'], action: 'Open the tool palette', group: 'Building' },
  {
    keys: ['I'],
    action: "Show or hide the inspector - a node's input, options and output",
    group: 'Building',
  },
  {
    keys: ['C'],
    action:
      'Connect from the focused node, without dragging - the same flow the node’s Connect button opens',
    group: 'Building',
  },
  { keys: ['Escape'], action: 'Cancel the current dialog, drag or connection', group: 'Building' },
  { keys: ['?'], action: 'Show this list', group: 'Building' },
  /*
   * Radix binds F8 to the toast viewport. It is the only way to reach a
   * notification on demand - the canvas's live region is shared and a message
   * there can be replaced within moments, so the toast is the durable copy and
   * has to be summonable rather than merely present.
   */
  { keys: ['F8'], action: 'Move focus to the latest notification', group: 'Building' },
];

export const SHORTCUT_GROUPS = ['Moving around', 'Editing', 'Building'] as const;

/**
 * WHAT IS REACHABLE WITH NO KEYBOARD AT ALL.
 *
 * A companion to the table above rather than part of it: every row here is a
 * gesture or a visible control, so none of them has a key to print in the Keys
 * column, and putting them there would mean inventing one.
 *
 * It exists because the honest answer used to be embarrassing. The keyboard map
 * covered undo, redo, fit, the palette, delete, duplicate, select-all and this
 * reference; undo, redo, fit, the palette and this reference had visible
 * controls, and Delete, Duplicate and Select-all did not - so on a phone you
 * could add nodes to a canvas and never remove one, and once connecting became
 * tappable you could wire two tools together and be unable to rewire them,
 * because an occupied input refuses a second wire and says to remove the first.
 *
 * IT IS A LIST IN CODE, in the same file as the keyboard map, for the reason
 * that map is: the overlay renders it rather than restating it, and
 * `overlays.test.tsx` walks this array against what the panel draws. A route
 * that stops existing stops being listed. Documentation of what is REACHABLE is
 * exactly the documentation that goes stale, and it goes stale silently -
 * nothing breaks when a page promises a control that is not there.
 */
export interface TouchRoute {
  readonly gesture: string;
  readonly action: string;
}

export const TOUCH_ROUTES: readonly TouchRoute[] = [
  { gesture: 'Drag empty canvas', action: 'Pan' },
  { gesture: 'Pinch', action: 'Zoom about the midpoint of two fingers' },
  { gesture: 'Tap a node', action: 'Select it, which reveals its Connect button' },
  {
    gesture: 'Tap a wire',
    action:
      'Select it - the grab band is finger-sized and stays that size at every zoom, and the nearest wire wins where two run close together',
  },
  {
    gesture: 'Selection bar',
    action: 'Delete, Duplicate and Select all, on whatever is currently selected',
  },
  {
    gesture: 'Undo, in the notification',
    action: 'Reverse a deletion the moment it happens, without hunting for the toolbar',
  },
  {
    gesture: 'Disconnect, in the inspector',
    action: 'Remove the wire feeding an input, named, with no curve to aim at',
  },
  { gesture: 'Add tool, Fit, Inspector', action: 'On the toolbar at every width' },
];

/**
 * What makes one row of the reference distinct from another.
 *
 * The group and the KEYS, not the action: two bindings can do the same thing
 * and be different shortcuts - Space-drag and middle-drag both pan - and a
 * row identified by its action put those two under one id. React noticed
 * before anybody else did. The action is kept in the identity as well, so a
 * genuine duplicate binding is a collision rather than a silent merge.
 */
export function shortcutRowKey(shortcut: Shortcut): string {
  return `${shortcut.group}|${shortcut.keys.join('+')}|${shortcut.action}`;
}

/** One-line summary used as the canvas's accessible description. */
export const CANVAS_DESCRIPTION =
  'Node canvas. Press K to add a tool, Tab to move between nodes, C to connect from the focused node - ' +
  'a selected node also carries a Connect button, which opens the same flow - ' +
  'Enter or I to open the inspector where a node’s input, options and output live, ' +
  'arrow keys to move it, Delete to remove it, and question mark for the full list of shortcuts. ' +
  'Whatever is selected also gets a bar of controls below the toolbar, with Delete, Duplicate and Select all; ' +
  'a wire is removed either there or from the Disconnect button beside the input it feeds in the inspector. ' +
  'Every action here is also available on the Tools page.';
