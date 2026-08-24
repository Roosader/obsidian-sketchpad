import { PluginSettingTab, Setting, setIcon } from 'obsidian';
import SketchpadPlugin from '../main';
import type { LayerName, ViewTool, RotateAction, SizeAction } from './types';
import { MODIFIER_HOTKEY_KEYS, MIN_ROTATE_SENSITIVITY, MAX_ROTATE_SENSITIVITY, DEFAULT_FILE_NAME, DEFAULT_IMAGE_WIDTH, DEFAULT_IMAGE_HEIGHT, MAX_IMAGE_DIMENSION, MAX_GRID_SIZE, AUTOSAVE_INTERVAL_OPTIONS, DEFAULT_PREDICTION_DISTANCE_MS, MIN_PREDICTION_DISTANCE_MS, MAX_PREDICTION_DISTANCE_MS, MIN_PREDICTION_SENSITIVITY, MAX_PREDICTION_SENSITIVITY, DEFAULT_PREDICTION_SENSITIVITY } from './constants';
import {normalizeHotkeyKey, sensitivityToMinVelocity} from './utils';

const IGNORED_HOTKEY_KEYS = new Set([
	'CapsLock', 'Escape', 'Tab',
	'Process', 'Dead', 'AltGraph', 'NumLock', 'ScrollLock',
]);

const TOOL_HOTKEY_TOOLS: ViewTool[] = [
	'pencil', 'pen', 'brush', 'eraser', 'hand', 'lasso', 'rotate',
	'zoom-in', 'zoom-out', 'eyedropper',
];

const TOOL_HOTKEY_LABELS: Partial<Record<ViewTool, string>> = {
	pencil: 'Pencil',
	pen: 'Pen',
	brush: 'Brush',
	eraser: 'Eraser',
	hand: 'Hand',
	lasso: 'Lasso',
	rotate: 'Rotate',
	'zoom-in': 'Zoom in',
	'zoom-out': 'Zoom out',
	eyedropper: 'Eyedropper',
};

const ROTATE_HOTKEY_ACTIONS: RotateAction[] = ['rotate-ccw', 'rotate-cw'];

const ROTATE_HOTKEY_LABELS: Partial<Record<RotateAction, string>> = {
	'rotate-ccw': 'Rotate counter-clockwise',
	'rotate-cw': 'Rotate clockwise',
};

const SIZE_HOTKEY_ACTIONS: SizeAction[] = ['size-increase', 'size-decrease'];

const SIZE_HOTKEY_LABELS: Partial<Record<SizeAction, string>> = {
	'size-increase': 'Increase tool tip size',
	'size-decrease': 'Decrease tool tip size',
};

function displayHotkey(key: string): string {
	if (key === ' ') {
		return 'Space';
	}
	if (key === 'Shift') {
		return 'Shift';
	}
	if (key === 'Control') {
		return 'Ctrl';
	}
	if (key === 'Alt') {
		return 'Alt';
	}
	if (key === 'Meta') {
		return 'Cmd';
	}
	return key.length === 1 ? key.toUpperCase() : key;
}

export class SketchpadSettingTab extends PluginSettingTab 
{
    plugin: SketchpadPlugin;

    constructor(plugin: SketchpadPlugin) {
        super(plugin.app, plugin);
        this.plugin = plugin;
    }
    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Enable touch to draw')
            .setDesc(createFragment((frag) => {
                frag.appendText('If disabled, one finger pans the canvas. Two fingers also pan, pinch to zoom, and twist to rotate. Two-finger tap to undo. Three-finger tap to redo.');
                frag.createEl('br');
                frag.appendText('When enabled, one finger will draw instead of panning the canvas. All other touch controls remain the same.');
            }))
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.touchToDrawEnabled)
                    .onChange(async (value) => {
                        this.plugin.touchToDrawEnabled = value;
                        await this.plugin.saveToolSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Enable minimal UI')
            .setDesc('Disable to fully expand the left and right sidebars.')
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.minimalUI)
                    .onChange(async (value) => {
                        this.plugin.minimalUI = value;
                        await this.plugin.saveToolSettings();
                    });
            });
        new Setting(containerEl)
            .setName('Reset sidebar positions')
            .addButton((button) => {
                button
                    .setButtonText('Reset')
                    .onClick(async () => {
                        this.plugin.leftSidebarPos = null;
                        this.plugin.rightSidebarPos = null;
                        await this.plugin.saveToolSettings();
                        this.plugin.resetPanelPositions();
                    });
            });

        new Setting(containerEl)
            .setName('Hide cursor while drawing')
            .setDesc('Hides the cursor while a drawing tool (pencil, pen, brush, eraser) is actively drawing. The cursor remains visible while hovering.')
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.hideCursorWhileDrawing)
                    .onChange(async (value) => {
                        this.plugin.hideCursorWhileDrawing = value;
                        await this.plugin.saveToolSettings();
                        this.plugin.notifyCursorSettingsChanged();
                    });
            });

        new Setting(containerEl)
            .setName('Pointer prediction')
            .setHeading();

        let distanceSlider: import('obsidian').SliderComponent;
        let sensitivitySlider: import('obsidian').SliderComponent;
        let distanceSetting: import('obsidian').Setting;
        let predSensitivitySetting: import('obsidian').Setting;

        new Setting(containerEl)
            .setName('Enable pointer prediction')
            .setDesc(createFragment((frag) => {
                frag.appendText('Extends the live stroke preview slightly ahead to mask input lag while drawing. May cause visual artifacts on fast strokes. Stroke predictions are never saved to the canvas.');
            }))
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.pointerPredictionEnabled)
                    .onChange(async (value) => {
                        this.plugin.pointerPredictionEnabled = value;
                        await this.plugin.saveToolSettings();
                        this.plugin.notifyPredictionSettingsChanged();
                        // enable/disable the sub-controls
                        distanceSlider.setDisabled(!value);
                        sensitivitySlider.setDisabled(!value);
                        distanceSetting.setDisabled(!value);
                        predSensitivitySetting.setDisabled(!value);
                    });
            });

        distanceSetting = new Setting(containerEl)
            .setName('Prediction distance')
            .setDesc('How far ahead of the real stroke the prediction renders. Higher setting hides more input lag but may overshoot on fast strokes.')
            .addSlider((slider) => {
                distanceSlider = slider;
                slider
                    .setLimits(MIN_PREDICTION_DISTANCE_MS, MAX_PREDICTION_DISTANCE_MS, 1)
                    .setValue(this.plugin.pointerPredictionDistanceMs)
                    .onChange(async (value) => {
                        this.plugin.pointerPredictionDistanceMs = value;
                        await this.plugin.saveToolSettings();
                        this.plugin.notifyPredictionSettingsChanged();
                    });
            });

        predSensitivitySetting = new Setting(containerEl)
            .setName('Prediction sensitivity')
            .setDesc('How readily prediction engages in response to drawing speed. Lower setting is more stable, higher setting feels more responsive on slow lines.')
            .addSlider((slider) => {
                sensitivitySlider = slider;
                slider
                    .setLimits(MIN_PREDICTION_SENSITIVITY, MAX_PREDICTION_SENSITIVITY, 1)
                    .setValue(this.plugin.pointerPredictionSensitivity)
                    .onChange(async (value) => {
                        this.plugin.pointerPredictionSensitivity = value;
                        await this.plugin.saveToolSettings();
                        this.plugin.notifyPredictionSettingsChanged();
                    });
            });

        // Apply initial disabled state based on the toggle
        const predictionEnabled = this.plugin.pointerPredictionEnabled;
        distanceSetting.setDisabled(!predictionEnabled);
        predSensitivitySetting.setDisabled(!predictionEnabled);

        new Setting(containerEl)
            .setName('Reset prediction settings')
            .addButton((button) => {
                button
                    .setButtonText('Reset to defaults')
                    .onClick(async () => {
                        this.plugin.pointerPredictionDistanceMs = DEFAULT_PREDICTION_DISTANCE_MS;
                        this.plugin.pointerPredictionSensitivity = DEFAULT_PREDICTION_SENSITIVITY;
                        await this.plugin.saveToolSettings();
                        this.plugin.notifyPredictionSettingsChanged();
                        // Refresh the whole settings tab so the sliders update
                        this.display();
                    });
            });

        new Setting(containerEl)
            .setName('Autosave')
            .setHeading();

        let autosaveIntervalSetting: Setting | undefined;
        new Setting(containerEl)
            .setName('Enable autosave')
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.autosaveEnabled)
                    .onChange(async (value) => {
                        this.plugin.autosaveEnabled = value;
                        await this.plugin.saveToolSettings();
                        this.plugin.setupAutosave();
                        autosaveIntervalSetting?.setDisabled(!value);
                    });
            });

        autosaveIntervalSetting = new Setting(containerEl)
            .setName('Autosave interval')
            .addDropdown((dropdown) => {
                for (const minutes of AUTOSAVE_INTERVAL_OPTIONS) {
                    dropdown.addOption(String(minutes), `${minutes} minutes`);
                }
                dropdown.setValue(String(this.plugin.autosaveIntervalMinutes));
                dropdown.onChange(async (value) => {
                    this.plugin.autosaveIntervalMinutes = Number.parseInt(value, 10);
                    await this.plugin.saveToolSettings();
                    this.plugin.setupAutosave();
                });
            });
        autosaveIntervalSetting.setDisabled(!this.plugin.autosaveEnabled);

        new Setting(containerEl)
            .setName('New file defaults')
            .setDesc('Default settings when creating a new sketch. Leave a field empty to use the built-in values.')
            .setHeading();

        new Setting(containerEl)
            .setName('Default file name')
            .addText((text) => {
                text.setPlaceholder(DEFAULT_FILE_NAME);
                text.setValue(this.plugin.defaultFileName);
                text.onChange(async (value) => {
                    this.plugin.defaultFileName = value.trim() || DEFAULT_FILE_NAME;
                    await this.plugin.saveToolSettings();
                });
            });

        new Setting(containerEl)
            .setName('Default image width (4096px max)')
            .addText((text) => {
                text.setPlaceholder(String(DEFAULT_IMAGE_WIDTH));
                text.inputEl.type = 'number';
                text.inputEl.min = '1';
                text.inputEl.max = String(MAX_IMAGE_DIMENSION);
                text.setValue(String(this.plugin.defaultImageWidth));
                text.onChange(async (value) => {
                    const parsed = Number.parseInt(value, 10);
                    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_IMAGE_DIMENSION) {
                        this.plugin.defaultImageWidth = parsed;
                        await this.plugin.saveToolSettings();
                    }
                });
            });

        new Setting(containerEl)
            .setName('Default image height (4096px max)')
            .addText((text) => {
                text.setPlaceholder(String(DEFAULT_IMAGE_HEIGHT));
                text.inputEl.type = 'number';
                text.inputEl.min = '1';
                text.inputEl.max = String(MAX_IMAGE_DIMENSION);
                text.setValue(String(this.plugin.defaultImageHeight));
                text.onChange(async (value) => {
                    const parsed = Number.parseInt(value, 10);
                    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_IMAGE_DIMENSION) {
                        this.plugin.defaultImageHeight = parsed;
                        await this.plugin.saveToolSettings();
                    }
                });
            });

        new Setting(containerEl)
            .setName('Default paper color')
            .addText((text) => {
                text.inputEl.type = 'color';
                text.inputEl.classList.add('sketchpad-paper-color-picker');
                text.setValue(this.plugin.defaultPaperColor);
                text.onChange(async (value) => {
                    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
                        this.plugin.defaultPaperColor = value;
                        await this.plugin.saveToolSettings();
                    }
                });
            });

        new Setting(containerEl)
            .setName('Default layer order')
            .setDesc('Layer order used when creating a new sketch. Paper always stays at the bottom.')
            .setHeading();

        this.addDefaultLayerOrderSetting(containerEl);

        new Setting(containerEl)
            .setName('Grid overlay')
            .setHeading();

        new Setting(containerEl)
            .setName(`Cell size (max ${MAX_GRID_SIZE}px)`)
            .addText((text) => {
                text.inputEl.type = 'number';
                text.inputEl.min = '1';
                text.inputEl.max = String(MAX_GRID_SIZE);
                text.setValue(String(this.plugin.gridSize));
                text.onChange(async (value) => {
                    const parsed = Number.parseInt(value, 10);
                    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_GRID_SIZE) {
                        this.plugin.gridSize = parsed;
                        await this.plugin.saveToolSettings();
                        this.plugin.notifyGridSettingsChanged();
                    }
                });
            });

        new Setting(containerEl)
            .setName('Grid color')
            .addText((text) => {
                text.inputEl.type = 'color';
                text.inputEl.classList.add('sketchpad-paper-color-picker');
                text.setValue(this.plugin.gridColor);
                text.onChange(async (value) => {
                    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
                        this.plugin.gridColor = value;
                        await this.plugin.saveToolSettings();
                        this.plugin.notifyGridSettingsChanged();
                    }
                });
            });

        new Setting(containerEl)
            .setName('Grid opacity')
            .addSlider((slider) => {
                slider
                    .setLimits(0, 100, 1)
                    .setValue(this.plugin.gridOpacity)
                    .onChange(async (value) => {
                        this.plugin.gridOpacity = Math.round(value);
                        await this.plugin.saveToolSettings();
                        this.plugin.notifyGridSettingsChanged();
                    });
            });

        new Setting(containerEl)
            .setName('Tool hotkeys')
            .setDesc('Tap a key to switch tools. Hold and release a key to use the tool temporarily. Press backspace to clear the key field.')
            .setHeading();

        for (const tool of TOOL_HOTKEY_TOOLS) {
            this.addToolHotkeySetting(containerEl, tool);
        }

        new Setting(containerEl)
            .setName('Canvas rotation hotkeys')
            //.setDesc('Rotate the canvas instantly with a hotkey. A press rotates by the sensitivity below; no hold-to-switch model applies.')
            .setHeading();

        for (const action of ROTATE_HOTKEY_ACTIONS) {
            this.addRotateHotkeySetting(containerEl, action);
        }

        const sensitivitySetting = new Setting(containerEl)
            .setName('Rotate sensitivity')
            .setDesc(`Degrees the canvas rotates per press of a rotate hotkey.`);

        sensitivitySetting.addSlider((slider) => {
            slider
                .setLimits(MIN_ROTATE_SENSITIVITY, MAX_ROTATE_SENSITIVITY, 1)
                .setValue(this.plugin.rotateSensitivity)
                .onChange(async (value) => {
                    this.plugin.rotateSensitivity = Math.round(value);
                    await this.plugin.saveToolSettings();
                });
        });

        new Setting(containerEl)
            .setName('Tool tip size hotkeys')
            .setHeading();

        for (const action of SIZE_HOTKEY_ACTIONS) {
            this.addSizeHotkeySetting(containerEl, action);
        }
    }

    private addDefaultLayerOrderSetting(containerEl: HTMLElement): void {
        const listEl = containerEl.createDiv({ cls: 'sketchpad-default-layer-order' });
        const render = (): void => {
            listEl.empty();
            // Display top-first: reverse the bottom-to-top stored order.
            const movable = this.plugin.defaultLayerOrder
                .filter((name) => name !== 'Paper')
                .reverse();
            movable.forEach((name, index) => {
                const row = listEl.createDiv({ cls: 'sketchpad-default-layer-order-row' });
                row.createSpan({ text: name });

                const upButton = row.createEl('button', { cls: 'sketchpad-layer-move-button' });
                setIcon(upButton, 'arrow-up');
                upButton.disabled = index === 0; // top-most can't go up
                upButton.addEventListener('click', () => {
                    this.moveDefaultLayer(name, 1);
                    render();
                });

                const downButton = row.createEl('button', { cls: 'sketchpad-layer-move-button' });
                setIcon(downButton, 'arrow-down');
                downButton.disabled = index === movable.length - 1; // bottom-most (above Paper) can't go down
                downButton.addEventListener('click', () => {
                    this.moveDefaultLayer(name, -1);
                    render();
                });
            });
        };
        render();
    }

    private moveDefaultLayer(name: LayerName, direction: -1 | 1): void {
        const order = [...this.plugin.defaultLayerOrder];
        const from = order.indexOf(name);
        if (from <= 0) {
            return;
        }
        const to = from + direction;
        if (to <= 0 || to >= order.length) {
            return;
        }
        const [moving] = order.splice(from, 1);
        if (!moving) {
            return;
        }
        order.splice(to, 0, moving);
        this.plugin.defaultLayerOrder = order;
        void this.plugin.saveToolSettings();
    }

    private addToolHotkeySetting(containerEl: HTMLElement, tool: ViewTool): void {
        this.addHotkeySetting(
            containerEl,
            TOOL_HOTKEY_LABELS[tool] ?? tool,
            () => this.plugin.toolHotkeys[tool],
            (key) => { this.plugin.toolHotkeys[tool] = key; },
            () => { delete this.plugin.toolHotkeys[tool]; },
        );
    }

    private addRotateHotkeySetting(containerEl: HTMLElement, action: RotateAction): void {
        this.addHotkeySetting(
            containerEl,
            ROTATE_HOTKEY_LABELS[action] ?? action,
            () => this.plugin.rotateHotkeys[action],
            (key) => { this.plugin.rotateHotkeys[action] = key; },
            () => { delete this.plugin.rotateHotkeys[action]; },
        );
    }

    private addSizeHotkeySetting(containerEl: HTMLElement, action: SizeAction): void {
        this.addHotkeySetting(
            containerEl,
            SIZE_HOTKEY_LABELS[action] ?? action,
            () => this.plugin.sizeHotkeys[action],
            (key) => { this.plugin.sizeHotkeys[action] = key; },
            () => { delete this.plugin.sizeHotkeys[action]; },
        );
    }

    private addHotkeySetting(
        containerEl: HTMLElement,
        name: string,
        getCurrent: () => string | undefined,
        commit: (key: string) => void,
        clear: () => void,
    ): void {
        new Setting(containerEl)
            .setName(name)
            .addText((text) => {
                text.setPlaceholder('None');
                text.inputEl.readOnly = true;
                const refresh = (): void => {
                    const current = getCurrent();
                    text.inputEl.value = current ? displayHotkey(current) : '';
                };
                refresh();
                text.inputEl.addClass('sketchpad-hotkey-input');

                let capturing = false;
                text.inputEl.addEventListener('focus', () => {
                    capturing = true;
                    text.inputEl.value = '';
                });
                text.inputEl.addEventListener('blur', () => {
                    capturing = false;
                    refresh();
                });
                text.inputEl.addEventListener('keydown', (event) => {
                    if (!capturing) {
                        return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    // Backspace / Delete clears the binding.
                    if (event.key === 'Backspace' || event.key === 'Delete') {
                        clear();
                        text.inputEl.value = '';
                        text.inputEl.blur();
                        void this.plugin.saveToolSettings();
                        return;
                    }
                    const key = normalizeHotkeyKey(event.key);
                    if (!key || IGNORED_HOTKEY_KEYS.has(key)) {
                        return;
                    }
                    // Modifier keys are valid standalone bindings
                    if (MODIFIER_HOTKEY_KEYS.has(key)) {
                        this.bindHotkey(key, commit, text.inputEl);
                        return;
                    }
                    // Regular keys - only bind single characters with no modifiers held.
                    if (key.length !== 1) {
                        return;
                    }
                    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
                        return;
                    }
                    this.bindHotkey(key, commit, text.inputEl);
                });
                // Keep the caret from appearing in the read-only-looking field.
                text.inputEl.addEventListener('click', (event) => {
                    event.preventDefault();
                });
            });
    }

    private bindHotkey(key: string, commit: (key: string) => void, inputEl: HTMLInputElement): void {
        // hotkey must be unique across every tool and action
        for (const other of TOOL_HOTKEY_TOOLS) {
            if (this.plugin.toolHotkeys[other] === key) {
                delete this.plugin.toolHotkeys[other];
            }
        }
        for (const action of ROTATE_HOTKEY_ACTIONS) {
            if (this.plugin.rotateHotkeys[action] === key) {
                delete this.plugin.rotateHotkeys[action];
            }
        }
        for (const action of SIZE_HOTKEY_ACTIONS) {
            if (this.plugin.sizeHotkeys[action] === key) {
                delete this.plugin.sizeHotkeys[action];
            }
        }
        commit(key);
        inputEl.value = displayHotkey(key);
        inputEl.blur();
        void this.plugin.saveToolSettings();
    }
}
