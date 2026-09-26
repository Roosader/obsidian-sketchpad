import type { RotateAction, SizeAction, ViewTool } from './types';
import { normalizeHotkeyKey } from './utils';

// Hotkey bindings are global: one key can only ever belong to a single owner
// (a tool, a rotate action, or a size action). This module is the single
// source of truth for which owners exist, in which order they are presented,
// what they are called, and how a key maps to its owner. Both the settings tab
// and the load-time repair in main.ts use it so the two can't drift apart.

// Canonical order: the settings tab renders rows in this order and load-time
// duplicate repair gives the key to the first owner in this order (i.e. the
// topmost settings row keeps it), which is deterministic and explainable.
export const TOOL_HOTKEY_TOOLS: ViewTool[] = [
	'pencil', 'pen', 'brush', 'eraser', 'marker', 'hand', 'lasso', 'rotate',
	'zoom-in', 'zoom-out', 'eyedropper',
];

export const TOOL_HOTKEY_LABELS: Partial<Record<ViewTool, string>> = {
	pencil: 'Pencil',
	pen: 'Pen',
	brush: 'Brush',
	eraser: 'Eraser',
	marker: 'Marker',
	hand: 'Hand',
	lasso: 'Lasso',
	rotate: 'Rotate',
	'zoom-in': 'Zoom in',
	'zoom-out': 'Zoom out',
	eyedropper: 'Eyedropper',
};

export const ROTATE_HOTKEY_ACTIONS: RotateAction[] = ['rotate-ccw', 'rotate-cw'];

export const ROTATE_HOTKEY_LABELS: Partial<Record<RotateAction, string>> = {
	'rotate-ccw': 'Rotate counter-clockwise',
	'rotate-cw': 'Rotate clockwise',
};

export const SIZE_HOTKEY_ACTIONS: SizeAction[] = ['size-increase', 'size-decrease'];

export const SIZE_HOTKEY_LABELS: Partial<Record<SizeAction, string>> = {
	'size-increase': 'Increase tool tip size',
	'size-decrease': 'Decrease tool tip size',
};

export interface HotkeyBindings {
	toolHotkeys: Partial<Record<ViewTool, string>>;
	rotateHotkeys: Partial<Record<RotateAction, string>>;
	sizeHotkeys: Partial<Record<SizeAction, string>>;
}

export type HotkeyOwner =
	| { kind: 'tool'; tool: ViewTool }
	| { kind: 'rotate'; action: RotateAction }
	| { kind: 'size'; action: SizeAction };

// Human-readable form of a stored key for input fields and dialog copy.
export function displayHotkeyKey(key: string): string {
	if (key === ' ') {
		return 'Space';
	}
	if (key === 'Control') {
		return 'Ctrl';
	}
	if (key === 'Meta') {
		return 'Cmd';
	}
	return key.length === 1 ? key.toUpperCase() : key;
}

// Phrase used mid-sentence, e.g. 'the Pen tool' / 'the rotate clockwise action'.
export function describeHotkeyOwner(owner: HotkeyOwner): string {
	switch (owner.kind) {
		case 'tool':
			return `the ${TOOL_HOTKEY_LABELS[owner.tool] ?? owner.tool} tool`;
		case 'rotate':
			return `the ${(ROTATE_HOTKEY_LABELS[owner.action] ?? owner.action).toLowerCase()} rotate action`;
		case 'size':
			return `the ${(SIZE_HOTKEY_LABELS[owner.action] ?? owner.action).toLowerCase()} action`;
	}
}

export function readHotkey(bindings: HotkeyBindings, owner: HotkeyOwner): string | undefined {
	switch (owner.kind) {
		case 'tool':
			return bindings.toolHotkeys[owner.tool];
		case 'rotate':
			return bindings.rotateHotkeys[owner.action];
		case 'size':
			return bindings.sizeHotkeys[owner.action];
	}
}

export function writeHotkey(bindings: HotkeyBindings, owner: HotkeyOwner, key: string): void {
	switch (owner.kind) {
		case 'tool':
			bindings.toolHotkeys[owner.tool] = key;
			return;
		case 'rotate':
			bindings.rotateHotkeys[owner.action] = key;
			return;
		case 'size':
			bindings.sizeHotkeys[owner.action] = key;
	}
}

export function clearHotkey(bindings: HotkeyBindings, owner: HotkeyOwner): void {
	switch (owner.kind) {
		case 'tool':
			delete bindings.toolHotkeys[owner.tool];
			return;
		case 'rotate':
			delete bindings.rotateHotkeys[owner.action];
			return;
		case 'size':
			delete bindings.sizeHotkeys[owner.action];
	}
}

// The single owner currently holding `key`, or null when the key is free.
// Searched in canonical (display) order.
export function findHotkeyOwner(bindings: HotkeyBindings, key: string): HotkeyOwner | null {
	for (const tool of TOOL_HOTKEY_TOOLS) {
		if (bindings.toolHotkeys[tool] === key) {
			return { kind: 'tool', tool };
		}
	}
	for (const action of ROTATE_HOTKEY_ACTIONS) {
		if (bindings.rotateHotkeys[action] === key) {
			return { kind: 'rotate', action };
		}
	}
	for (const action of SIZE_HOTKEY_ACTIONS) {
		if (bindings.sizeHotkeys[action] === key) {
			return { kind: 'size', action };
		}
	}
	return null;
}

export function unbindHotkeyOwner(bindings: HotkeyBindings, owner: HotkeyOwner): void {
	clearHotkey(bindings, owner);
}

/**
 * Make a loaded set of bindings unique and normalized, in place.
 *
 * Stored data can contain duplicates (hand-edited data.json, a user binding
 * that collides with a default of another entry, or data written before the
 * uniqueness check existed). Duplicates make hotkey resolution depend on
 * object insertion order, so one owner silently stops working. This repair is
 * deterministic: the first owner in canonical (display) order keeps the key.
 *
 * Also normalizes keys (so a hand-edited 'P' matches 'p') and drops empty
 * values and keys that belong to no known owner. Returns true when anything
 * changed, so the caller can persist the repaired data.
 */
export function repairHotkeyBindings(bindings: HotkeyBindings): boolean {
	let changed = false;
	const seen = new Set<string>();

	const scrub = <K extends string>(record: Partial<Record<K, string>>, owners: readonly K[]): void => {
		const known = new Set<string>(owners);
		// Drop bindings for owners that no longer exist: the runtime resolves
		// keys by iterating the record, so stray keys could still shadow.
		for (const owner of Object.keys(record) as K[]) {
			if (!known.has(owner)) {
				delete record[owner];
				changed = true;
			}
		}
		for (const owner of owners) {
			const raw = record[owner];
			if (raw === undefined) {
				continue;
			}
			// Deliberately no trim(): a single space is the Space binding.
			const normalized = normalizeHotkeyKey(raw);
			if (normalized === '') {
				delete record[owner];
				changed = true;
				continue;
			}
			if (seen.has(normalized)) {
				delete record[owner];
				changed = true;
				continue;
			}
			seen.add(normalized);
			if (normalized !== raw) {
				record[owner] = normalized;
				changed = true;
			}
		}
	};

	scrub(bindings.toolHotkeys, TOOL_HOTKEY_TOOLS);
	scrub(bindings.rotateHotkeys, ROTATE_HOTKEY_ACTIONS);
	scrub(bindings.sizeHotkeys, SIZE_HOTKEY_ACTIONS);
	return changed;
}

export function sameHotkeyOwner(a: HotkeyOwner, b: HotkeyOwner): boolean {
	if (a.kind !== b.kind) {
		return false;
	}
	switch (a.kind) {
		case 'tool':
			return b.kind === 'tool' && a.tool === b.tool;
		case 'rotate':
			return b.kind === 'rotate' && a.action === b.action;
		case 'size':
			return b.kind === 'size' && a.action === b.action;
	}
}
