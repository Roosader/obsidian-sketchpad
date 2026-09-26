import { MODIFIER_HOTKEY_KEYS, TAP_THRESHOLD_MS, ROTATE_HOLD_DELAY_MS, ROTATE_REPEAT_INTERVAL_MS, SIZE_STEP } from '../utilities/constants';
import { normalizeHotkeyKey } from '../utilities/utils';
import type SketchpadPlugin from '../main';
import type { ViewTool } from '../utilities/types';
import type { CanvasViewport } from '../technical/viewport';

export interface HotkeyControllerDeps {
	plugin: SketchpadPlugin;
	viewport: CanvasViewport;
	isActive: () => boolean;
	getCurrentTool: () => ViewTool;
	setTool: (tool: ViewTool) => void;
	hasActiveSelection: () => boolean;
	cancelSelection: () => void;
	hasActiveImagePlacement?: () => boolean;
	cancelImagePlacement?: () => void;
	adjustToolSize: (delta: number) => void;
}

export class HotkeyController {

	private tempToolHold: { key: string; tool: ViewTool; prevTool: ViewTool; timer: number | null; held: boolean } | null = null;
	// hold a rotate hotkey to keep rotating
	private activeRotateHold: { key: string; degrees: number; timer: number | null; interval: number | null } | null = null;
	// hold a size hotkey to keep growing/shrinking
	private activeSizeHold: { key: string; delta: number; timer: number | null; interval: number | null } | null = null;

	constructor(private readonly deps: HotkeyControllerDeps) {}

	handleKeyDown = (event: KeyboardEvent): void => {
		if (event.key === 'Escape') {
			this.handleEscapeKey(event);
			return;
		}

		if (this.handleRotateHotkey(event)) {
			return;
		}
		if (this.handleSizeHotkey(event)) {
			return;
		}
		this.handleToolHotkeyDown(event);
	};

	// handles Escape while the sketchpad view is active
	// prevents Escape from switching tab focus
	// cancel an active selection/placement if there is one
	private handleEscapeKey(event: KeyboardEvent): void {
		if (!this.deps.isActive()) {
			return;
		}
		if (document.body.querySelector('.modal-container')) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (this.deps.hasActiveSelection()) {
			this.deps.cancelSelection();
		}
		if (this.deps.hasActiveImagePlacement?.()) {
			this.deps.cancelImagePlacement?.();
		}
	}

	handleKeyUp = (event: KeyboardEvent): void => {
		this.stopRotateHold(event);
		this.stopSizeHold(event);
		this.handleToolHotkeyUp(event);
	};

	clearTempToolHold(): void {
		if (this.tempToolHold) {
			if (this.tempToolHold.timer !== null) {
				window.clearTimeout(this.tempToolHold.timer);
			}
			this.tempToolHold = null;
		}
		this.stopRotateHold();
		this.stopSizeHold();
	}

	private handleRotateHotkey(event: KeyboardEvent): boolean {
		if (!this.isHotkeyEligible(event)) {
			return false;
		}
		const key = normalizeHotkeyKey(event.key);
		const { rotateHotkeys, rotateSensitivity } = this.deps.plugin;
		for (const [action, hotkey] of Object.entries(rotateHotkeys)) {
			if (hotkey !== key) {
				continue;
			}
			if (MODIFIER_HOTKEY_KEYS.has(key) || (!event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey)) {
				event.preventDefault();
				const degrees = action === 'rotate-ccw' ? -rotateSensitivity : rotateSensitivity;
				// Tap to rotate once immediately
				this.deps.viewport.rotateBy(degrees);
				// hold for continuous rotation after a delay
				this.stopRotateHold();
				const hold = { key, degrees, timer: null as number | null, interval: null as number | null };
				this.activeRotateHold = hold;
				hold.timer = window.setTimeout(() => {
					if (this.activeRotateHold !== hold) {
						return;
					}
					hold.timer = null;
					hold.interval = window.setInterval(() => {
						// stop if the sketchpad is no longer the active view
						if (!this.deps.isActive()) {
							this.stopRotateHold();
							return;
						}
						this.deps.viewport.rotateBy(hold.degrees);
					}, ROTATE_REPEAT_INTERVAL_MS);
				}, ROTATE_HOLD_DELAY_MS);
				return true;
			}
		}
		return false;
	}

	private stopRotateHold(event?: KeyboardEvent): void {
		if (!this.activeRotateHold) {
			return;
		}
		if (event && normalizeHotkeyKey(event.key) !== this.activeRotateHold.key) {
			return;
		}
		const { timer, interval } = this.activeRotateHold;
		if (timer !== null) {
			window.clearTimeout(timer);
		}
		if (interval !== null) {
			window.clearInterval(interval);
		}
		this.activeRotateHold = null;
	}

	private handleSizeHotkey(event: KeyboardEvent): boolean {
		if (!this.isHotkeyEligible(event)) {
			return false;
		}
		const key = normalizeHotkeyKey(event.key);
		const { sizeHotkeys } = this.deps.plugin;
		for (const [action, hotkey] of Object.entries(sizeHotkeys)) {
			if (hotkey !== key) {
				continue;
			}
			if (MODIFIER_HOTKEY_KEYS.has(key) || (!event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey)) {
				event.preventDefault();
				const delta = action === 'size-increase' ? SIZE_STEP : -SIZE_STEP;
				// Tap to change size once immediately
				this.deps.adjustToolSize(delta);
				// hold for continuous change after a delay
				this.stopSizeHold();
				const hold = { key, delta, timer: null as number | null, interval: null as number | null };
				this.activeSizeHold = hold;
				hold.timer = window.setTimeout(() => {
					if (this.activeSizeHold !== hold) {
						return;
					}
					hold.timer = null;
					hold.interval = window.setInterval(() => {
						// stop if the sketchpad is no longer the active view
						if (!this.deps.isActive()) {
							this.stopSizeHold();
							return;
						}
						this.deps.adjustToolSize(hold.delta);
					}, ROTATE_REPEAT_INTERVAL_MS);
				}, ROTATE_HOLD_DELAY_MS);
				return true;
			}
		}
		return false;
	}

	private stopSizeHold(event?: KeyboardEvent): void {
		if (!this.activeSizeHold) {
			return;
		}
		if (event && normalizeHotkeyKey(event.key) !== this.activeSizeHold.key) {
			return;
		}
		const { timer, interval } = this.activeSizeHold;
		if (timer !== null) {
			window.clearTimeout(timer);
		}
		if (interval !== null) {
			window.clearInterval(interval);
		}
		this.activeSizeHold = null;
	}

	// tool hotkeys switch to a tool on key press. 
	// holding the key keeps the tool active temporarily
	private handleToolHotkeyDown(event: KeyboardEvent): void {
		if (!this.isHotkeyEligible(event)) {
			return;
		}
		const tool = this.toolForHotkey(event);
		if (!tool) {
			return;
		}
		const key = normalizeHotkeyKey(event.key);
		if (this.tempToolHold) {
			return; // a tool key is already being held
		}
		event.preventDefault();
		const prevTool = this.deps.getCurrentTool();
		this.tempToolHold = { key, tool, prevTool, timer: null, held: false };
		this.deps.setTool(tool);

		this.tempToolHold.timer = window.setTimeout(() => {
			if (this.tempToolHold && this.tempToolHold.key === key) {
				this.tempToolHold.held = true;
			}
		}, TAP_THRESHOLD_MS);
	}

	private handleToolHotkeyUp(event: KeyboardEvent): void {
		const key = normalizeHotkeyKey(event.key);
		if (!this.tempToolHold || this.tempToolHold.key !== key) {
			return;
		}
		const { held, prevTool } = this.tempToolHold;
		this.clearTempToolHold();
		if (held) {
			this.deps.setTool(prevTool);
		}
	}

	private toolForHotkey(event: KeyboardEvent): ViewTool | null {
		const key = normalizeHotkeyKey(event.key);
		for (const [tool, hotkey] of Object.entries(this.deps.plugin.toolHotkeys)) {
			if (hotkey !== key) {
				continue;
			}
			if (MODIFIER_HOTKEY_KEYS.has(key)) {
				return tool as ViewTool;
			}
			// regular keys only match when no modifiers are held
			if (!event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
				return tool as ViewTool;
			}
		}
		return null;
	}

	// only react to tool hotkeys while this sketchpad view is active, the key isn't auto-repeating, and the user isn't typing into a field
	private isHotkeyEligible(event: KeyboardEvent): boolean {
		if (!this.deps.isActive()) {
			return false;
		}
		if (event.repeat) {
			return false;
		}
		const target = event.target as Node | null;
		if (target instanceof HTMLElement) {
			if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
				return false;
			}
		}
		return true;
	}
}
