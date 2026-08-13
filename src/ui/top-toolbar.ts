import { setIcon } from 'obsidian';
import type { ToolName, ViewTool } from '../utilities/types';

export interface ToolbarElements {
	toolButtons: HTMLButtonElement[];
}

export function buildToolbar(
	container: HTMLElement,
	_plugin: unknown,
	initialTool: ViewTool | null,
	_getCurrentTool: () => ViewTool,
	onSelectTool: (tool: ViewTool) => void
): ToolbarElements {
	const toolbar = container.createDiv({ cls: 'sketchpad-toolbar' });
	const markingTools = toolbar.createDiv({ cls: 'sketchpad-toolbar-marking-section' });
	const toolButtons: HTMLButtonElement[] = [];

	const eyeDropperTool = markingTools.createEl('button', { cls: 'sketchpad-tool' });
	setIcon(eyeDropperTool, 'pipette');
	eyeDropperTool.dataset.tool = 'eyedropper';
	eyeDropperTool.addEventListener('click', () => onSelectTool('eyedropper'));
	toolButtons.push(eyeDropperTool);
	
	const lassoButton = markingTools.createEl('button', {
		cls: `sketchpad-tool${initialTool === 'lasso' ? ' active' : ''}`,
	});
	setIcon(lassoButton, 'lasso-select');
	lassoButton.dataset.tool = 'lasso';
	lassoButton.addEventListener('click', () => onSelectTool('lasso'));
	toolButtons.push(lassoButton);

	for (const tool of ['pencil', 'pen', 'brush', 'eraser'] as ToolName[]) {
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
		}

		button.dataset.tool = tool;
		button.addEventListener('click', () => onSelectTool(tool));
		toolButtons.push(button);
	}

	const viewingTools = toolbar.createDiv({ cls: 'sketchpad-toolbar-viewing-section' });

	const handButton = viewingTools.createEl('button', {
		cls: `sketchpad-tool${initialTool === 'hand' ? ' active' : ''}`,
	});
	setIcon(handButton, 'hand');
	handButton.dataset.tool = 'hand';
	handButton.addEventListener('click', () => onSelectTool('hand'));
	toolButtons.push(handButton);


	const zoomInTool = viewingTools.createEl('button', { 
		cls: `sketchpad-tool${initialTool === 'zoom-in' ? ' active' : ''}`,
	});
	setIcon(zoomInTool, 'zoom-in');
	zoomInTool.dataset.tool = 'zoom-in';
	zoomInTool.addEventListener('click', () => onSelectTool('zoom-in'));
	toolButtons.push(zoomInTool);

	const zoomOutTool = viewingTools.createEl('button', { 
		cls: `sketchpad-tool${initialTool === 'zoom-out' ? ' active' : ''}`,
	});
	setIcon(zoomOutTool, 'zoom-out');
	zoomOutTool.dataset.tool = 'zoom-out';
	zoomOutTool.addEventListener('click', () => onSelectTool('zoom-out'));
	toolButtons.push(zoomOutTool);

	const rotateTool = viewingTools.createEl('button', { 
		cls: `sketchpad-tool${initialTool === 'rotate' ? ' active' : ''}`,
	});
	setIcon(rotateTool, 'refresh-ccw');
	rotateTool.dataset.tool = 'rotate';
	rotateTool.addEventListener('click', () => onSelectTool('rotate'));
	toolButtons.push(rotateTool);

	return { toolButtons };
}

// Highlights whichever button matches activeTool.
export function syncToolbarToTool(elements: ToolbarElements, activeTool: ViewTool): void {
	for (const button of elements.toolButtons) {
		button.classList.toggle('active', button.dataset.tool === activeTool);
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
		if (tool === 'pencil' || tool === 'pen' || tool === 'brush' || tool === 'eraser') {
			button.disabled = !(enabledMap[tool] ?? true);
		} else {
			button.disabled = false;
		}
	}
}
