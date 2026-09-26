import { setIcon } from 'obsidian';
import type { LayerName, ToolName, ViewTool } from '../utilities/types';
import { isFixedLayerName } from '../technical/sketchpad-document';

export interface ToolbarElements {
	toolbar: HTMLDivElement;
	toolButtons: HTMLButtonElement[];
}

export function buildToolbar(
	container: HTMLElement,
	_plugin: unknown,
	initialTool: ViewTool | null,
	getCurrentTool: () => ViewTool,
	onSelectTool: (tool: ViewTool) => void
): ToolbarElements {
	const toolbar = container.createDiv({ cls: 'sketchpad-toolbar' });
	const markingTools = toolbar.createDiv({ cls: 'sketchpad-toolbar-marking-section' });
	const toolButtons: HTMLButtonElement[] = [];

	const eyeDropperTool = markingTools.createEl('button', { cls: 'sketchpad-tool' });
	setIcon(eyeDropperTool, 'pipette');
	eyeDropperTool.dataset.tool = 'eyedropper';
	toolButtons.push(eyeDropperTool);
	
	const lassoButton = markingTools.createEl('button', {
		cls: `sketchpad-tool${initialTool === 'lasso' ? ' active' : ''}`,
	});
	setIcon(lassoButton, 'lasso-select');
	lassoButton.dataset.tool = 'lasso';
	toolButtons.push(lassoButton);

	for (const tool of ['pencil', 'pen', 'brush', 'eraser', 'marker'] as ToolName[]) {
		const button = markingTools.createEl('button', {
			cls: `sketchpad-tool${tool === initialTool ? ' active' : ''}`
		});
		
		switch (tool) {
			case 'pencil':
				setIcon(button, 'pencil-line');
				break;
			case 'pen':
				setIcon(button, 'pen-tool');
				break;
			case 'brush':
				setIcon(button, 'paintbrush');
				break;
			case 'eraser':
				setIcon(button, 'eraser');
				break;
			case 'marker':
				setIcon(button, 'highlighter');
				break;
		}

		button.dataset.tool = tool;
		toolButtons.push(button);
	}

	const viewingTools = toolbar.createDiv({ cls: 'sketchpad-toolbar-viewing-section' });

	const handButton = viewingTools.createEl('button', {
		cls: `sketchpad-tool${initialTool === 'hand' ? ' active' : ''}`,
	});
	setIcon(handButton, 'hand');
	handButton.dataset.tool = 'hand';
	toolButtons.push(handButton);


	const zoomInTool = viewingTools.createEl('button', { 
		cls: `sketchpad-tool${initialTool === 'zoom-in' ? ' active' : ''}`,
	});
	setIcon(zoomInTool, 'zoom-in');
	zoomInTool.dataset.tool = 'zoom-in';
	toolButtons.push(zoomInTool);

	const zoomOutTool = viewingTools.createEl('button', { 
		cls: `sketchpad-tool${initialTool === 'zoom-out' ? ' active' : ''}`,
	});
	setIcon(zoomOutTool, 'zoom-out');
	zoomOutTool.dataset.tool = 'zoom-out';
	toolButtons.push(zoomOutTool);

	const rotateTool = viewingTools.createEl('button', { 
		cls: `sketchpad-tool${initialTool === 'rotate' ? ' active' : ''}`,
	});
	setIcon(rotateTool, 'refresh-ccw');
	rotateTool.dataset.tool = 'rotate';
	toolButtons.push(rotateTool);

	// Activate tools on pointer down
	const toolButtonAt = (target: EventTarget | null): HTMLButtonElement | null => {
		const element = target instanceof Element ? target.closest<HTMLElement>('button[data-tool]') : null;
		return element instanceof HTMLButtonElement ? element : null;
	};

	toolbar.addEventListener('pointerdown', (event) => {
		if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) {
			return;
		}
		const button = toolButtonAt(event.target);
		if (button === null || button.disabled) {
			return;
		}
		onSelectTool(button.dataset.tool as ViewTool);
	});
	return { toolbar, toolButtons };
}

// Highlights whichever button matches activeTool.
export function syncToolbarToTool(elements: ToolbarElements, activeTool: ViewTool): void {
	for (const button of elements.toolButtons) {
		button.classList.toggle('active', button.dataset.tool === activeTool);
	}
}

// Highlights the button whose tool targets the active layer,
// independent of whichever tool is currently selected.
// Pass null (no open file) to clear the highlight from every button.
export function syncToolbarToActiveLayer(elements: ToolbarElements, activeLayer: LayerName | null): void {
	const layerTools: Partial<Record<LayerName, ToolName>> = {
		Sketch: 'pencil',
		Ink: 'pen',
		Paint: 'brush',
	};
	// extra layers have no dedicated tool: the marker draws on them
	const layerTool = activeLayer === null
		? undefined
		: (layerTools[activeLayer] ?? (!isFixedLayerName(activeLayer) ? 'marker' : undefined));
	for (const button of elements.toolButtons) {
		button.classList.toggle('layer-active', layerTool !== undefined && button.dataset.tool === layerTool);
	}
}

//disable drawing tools if their associated layer is hidden
export function syncToolbarToLayerVisibility(
	elements: ToolbarElements,
	enabledMap: Partial<Record<ToolName, boolean>>,
): void {
	for (const button of elements.toolButtons) {
		const tool = button.dataset.tool;
		if (!tool) {
			continue;
		}
		if (tool === 'pencil' || tool === 'pen' || tool === 'brush' || tool === 'eraser' || tool === 'marker') {
			button.disabled = !(enabledMap[tool] ?? true);
		} else {
			button.disabled = false;
		}
	}
}
