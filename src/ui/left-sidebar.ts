import {setTooltip, setIcon} from "obsidian";
import type { LayerName, OraLayer } from '../utilities/types';

import { clampZoom, type ViewTransform } from '../technical/view-transform';
import {MIN_ZOOM, MAX_ZOOM, DEFAULT_PAPER_COLOR} from '../utilities/constants'
import type { ViewTool } from '../utilities/types';
import { wirePanelDrag, type PanelDragPosition } from './panel-drag';

export interface ViewControlElements {
	zoomInput: HTMLInputElement;
	zoomValueEl: HTMLElement;
	rotationInput: HTMLInputElement;
	rotationValueEl: HTMLElement;
	flipHButton: HTMLButtonElement;
	flipVButton: HTMLButtonElement;
	fitToViewButton: HTMLButtonElement;
}

export interface ViewControlCallbacks {
	onZoomChange: (zoom: number) => void;
	onRotationChange: (rotation: number) => void;
	onToggleFlipX: () => void;
	onToggleFlipY: () => void;
	onFitToView: () => void;

	onPanelMove?: (position: PanelDragPosition) => void;

	onLayerPanelToggle?: (visible: boolean) => void;
}

export type LayerControls = Map<LayerName, { card: HTMLDivElement; opacity: HTMLInputElement; blendMode: HTMLSelectElement }>;

export function buildLayerSidebar(
	container: HTMLElement, 
	layers: OraLayer[], 
	onChange: () => void,
	firstOpen?: boolean,
	getActiveLayer?: () => LayerName,
	onActivateLayer?: (layer: LayerName) => void,
	getPaperColor?: () => string,
	onPaperColorChange?: (color: string) => void,
	getGridEnabled?: () => boolean,
	onGridToggle?: (enabled: boolean) => void,
	getReorderEnabled?: () => boolean,
	onReorderToggle?: (enabled: boolean) => void,
	onMoveLayer?: (layer: LayerName, direction: -1 | 1) => void,
	onAddLayer?: () => void,
	onDeleteLayer?: () => void,
	canAddLayer?: () => boolean): LayerControls {

	const layerControlEl = container.querySelector('.sketchpad-layer-controls') ?? container.createDiv({ cls: 'sketchpad-layer-controls' });
	layerControlEl.empty();
	container.insertBefore(layerControlEl, container.firstChild);
	layerControlEl.createDiv({ text: 'Layers', cls: 'sketchpad-layer-controls-title' });

	const layerControls: LayerControls = new Map();

	if (firstOpen) {return layerControls;}; //there are no layers when the plugin is first opened

	const actionsRow = layerControlEl.createDiv({ cls: 'sketchpad-layer-actions' });
	// add / delete layer actions at the top of the panel
	if (onAddLayer || onDeleteLayer) {
		if (onDeleteLayer) {
			const deleteButton = actionsRow.createEl('button', { cls: 'sketchpad-layer-action-button mod-warning' });
			setIcon(deleteButton, 'trash');
			setTooltip(deleteButton, 'Delete layer')
			deleteButton.addEventListener('click', () => onDeleteLayer());
		}
		if (onAddLayer) {
			const addButton = actionsRow.createEl('button', { cls: 'sketchpad-layer-action-button'});
			setIcon(addButton, 'plus');
			setTooltip(addButton, 'Add a layer to the document, up to 6 extra layers');
			addButton.disabled = canAddLayer ? !canAddLayer() : false;
			addButton.addEventListener('click', () => onAddLayer());
		}
	}

	const reorderButton = actionsRow.createEl('button', {cls: 'sketchpad-layer-action-button sketchpad-reorder-toggle-button'});
	setIcon(reorderButton,'list-chevrons-down-up');
	setTooltip(reorderButton, 'Toggle layer reordering buttons');
	reorderButton.classList.toggle('is-active', getReorderEnabled?.() ?? false);
	reorderButton.addEventListener('click', () => {
		const enabled = !reorderButton.classList.contains('is-active');
		reorderButton.classList.toggle('is-active', enabled);
		onReorderToggle?.(enabled);
	});


	const gridButton = actionsRow.createEl('button', {cls:'sketchpad-layer-action-button sketchpad-grid-toggle-button'});
	setIcon(gridButton,'grid');
	setTooltip(gridButton, 'Toggle grid overlay over the document');
	gridButton.classList.toggle('is-active', getGridEnabled?.() ?? false);
	gridButton.addEventListener('click', () => {
		const enabled = !gridButton.classList.contains('is-active');
		gridButton.classList.toggle('is-active', enabled);
		onGridToggle?.(enabled);
	});


	const reorderEnabled = getReorderEnabled?.() ?? false;

	for (let i = layers.length - 1; i >= 0; i--) {
		const layer = layers[i];
		if (!layer) continue;

		const card = layerControlEl.createDiv({ cls: 'sketchpad-layer-card' });
		if (layer.name !== 'Paper' && getActiveLayer && getActiveLayer() === layer.name) {
			card.classList.add('sketchpad-layer-active');
		}
		if (layer.name !== 'Paper' && onActivateLayer) {
			card.addEventListener('click', (event) => {
				if (event.target instanceof HTMLElement && event.target.closest('button, select, input')) {
					return;
				}
				onActivateLayer(layer.name);
			});
		}
		const cardHeader = card.createDiv({ cls: 'sketchpad-layer-row' });

		const visibilitybutton = cardHeader.createEl('button', { cls: 'sketchpad-layer-visibility-button' });
		setIcon(visibilitybutton, layer.visible ? 'eye' : 'eye-off');
		setTooltip(visibilitybutton, layer.visible ? 'Hide layer' : 'Show layer');
		visibilitybutton.classList.toggle('sketchpad-layer-hidden', !layer.visible);
		visibilitybutton.addEventListener('click', () => {
			layer.visible = !layer.visible;
			setIcon(visibilitybutton, layer.visible ? 'eye' : 'eye-off');
			setTooltip(visibilitybutton, layer.visible ? 'Hide layer' : 'Show layer');
			visibilitybutton.classList.toggle('sketchpad-layer-hidden', !layer.visible);
			onChange();
		});
		
		cardHeader.createDiv({ text: layer.name });

		if (layer.name !== 'Paper' && reorderEnabled) {
			const moveUp = cardHeader.createEl('button', { cls: 'sketchpad-layer-move-button' });
			setIcon(moveUp, 'arrow-up');
			setTooltip(moveUp, 'Move layer up');
			moveUp.disabled = i >= layers.length - 1;
			moveUp.addEventListener('click', () => onMoveLayer?.(layer.name, 1));

			const moveDown = cardHeader.createEl('button', { cls: 'sketchpad-layer-move-button' });
			setIcon(moveDown, 'arrow-down');
			setTooltip(moveDown, 'Move layer down');
			moveDown.disabled = i <= 1;
			moveDown.addEventListener('click', () => onMoveLayer?.(layer.name, -1));
		}


		const blendMode = cardHeader.createEl('select');
		blendMode.classList.add('sketchpad-dropdown');
		setTooltip(blendMode, 'Layer blending mode');

		const normalOption = blendMode.createEl('option', { text: 'Normal' });
		normalOption.setAttribute('value', 'normal');
		const multiplyOption = blendMode.createEl('option', { text: 'Multiply' });
		multiplyOption.setAttribute('value', 'multiply');
		blendMode.value = layer.blendMode;
		blendMode.addEventListener('change', () => {
			layer.blendMode = blendMode.value === 'multiply' ? 'multiply' : 'normal';
			onChange();
		});

		if (layer.name === 'Paper') {
			blendMode.disabled = true;
			blendMode.classList.add('sketchpad-hidden');

			const paperColorInput = cardHeader.createEl('input');
			setTooltip(paperColorInput, 'Set paper color');
			paperColorInput.classList.add('sketchpad-paper-color-picker');
			paperColorInput.setAttribute('type', 'color');
			paperColorInput.setAttribute('value', getPaperColor?.() ?? DEFAULT_PAPER_COLOR);
			paperColorInput.addEventListener('input', () => {
				onPaperColorChange?.(paperColorInput.value);
			});
		}

		const opacityRow = card.createDiv({ cls: 'sketchpad-layer-row' });
		const opacity = opacityRow.createEl('input');
		opacity.classList.add('sketchpad-horizontal-slider');
		opacity.setAttribute('type', 'range');
		opacity.setAttribute('min', '0');
		opacity.setAttribute('max', '100');
		opacity.setAttribute('value', String(layer.opacity));
		opacity.style.setProperty('--percent', `${layer.opacity}%`);

		const opacityValueEl = opacityRow.createSpan({ cls: 'sketchpad-tool-setting-value' });
		opacityValueEl.classList.add('sketchpad-layer-opacity-value');
		setTooltip(opacityValueEl, 'Layer opacity');
		opacityValueEl.setText(`${Math.round(layer.opacity)}%`);

		opacity.addEventListener('input', () => {
			layer.opacity = Number(opacity.value);
			const percent = Math.round(layer.opacity);
			opacity.style.setProperty('--percent', `${percent}%`);
			opacityValueEl.setText(`${percent}%`);
			onChange();
		});

		layerControls.set(layer.name, { card, opacity, blendMode });
	}

	return layerControls;
}

//highlights active layer
export function syncLayerSidebar(layerControls: LayerControls, activeLayer: LayerName): void {
	for (const [name, controls] of layerControls) {
		controls.card.classList.toggle('sketchpad-layer-active', name === activeLayer && name !== 'Paper');
	}
}

export function buildViewControls(
	container: HTMLElement, 
	initialView: ViewTransform, 
	callbacks: ViewControlCallbacks,
	minimalUI?: boolean,
	initialLayerPanelCollapsed?: boolean,
	): ViewControlElements {

	const viewControlEl = container.createDiv({ cls: 'sketchpad-view-controls' });
	container.insertAfter(viewControlEl, container.firstChild);

	const fitToViewButton = viewControlEl.createEl('button');
	fitToViewButton.classList.add('sketchpad-view-controls-button');
	setIcon(fitToViewButton, 'fullscreen');
	setTooltip(fitToViewButton, 'Fit to view');
	fitToViewButton.addEventListener('click', () => callbacks.onFitToView());

	const flipHButton = viewControlEl.createEl('button', { cls: 'sketchpad-view-controls-button' });
	setTooltip(flipHButton, 'Flip horizontally');
	setIcon(flipHButton, 'flip-horizontal-2');
	flipHButton.addEventListener('click', () => callbacks.onToggleFlipX());

	const flipVButton = viewControlEl.createEl('button', { cls: 'sketchpad-view-controls-button' });
	setTooltip(flipVButton, 'Flip vertically');
	setIcon(flipVButton, 'flip-vertical-2');
	flipVButton.addEventListener('click', () => callbacks.onToggleFlipY());

	const zoomValueEl = viewControlEl.createSpan({ cls: 'sketchpad-tool-setting-value' });
	setTooltip(zoomValueEl, 'Zoom level');
	zoomValueEl.classList.add('sketchpad-view-controls-label');

	const zoomReset = viewControlEl.createEl('button', { cls: 'sketchpad-view-reset-button' });
	setIcon(zoomReset, 'reset');
	setTooltip(zoomReset, 'Reset zoom');
	zoomReset.addEventListener('click', () => callbacks.onZoomChange(1)); //set the zoom to 100%
	
	// logarithmic zoom slider: 0-100 maps to MIN_ZOOM-MAX_ZOOM
	const zoomInput = viewControlEl.createEl('input');
	zoomInput.classList.add('sketchpad-vertical-slider');
	zoomInput.setAttribute('type', 'range');
	zoomInput.setAttribute('min', "0");
	zoomInput.setAttribute('max', "100");

	zoomInput.value = String(Math.round(zoomToSlider(initialView.zoom)));
	zoomValueEl.setText(`${Math.round(initialView.zoom*100)}%`);
	zoomInput.addEventListener('input', () => {
		const zoom = sliderToZoom(Number(zoomInput.value));
		callbacks.onZoomChange(clampZoom(zoom));
	});

	const rotationValueEl = viewControlEl.createSpan({ cls: 'sketchpad-tool-setting-value' });
	setTooltip(rotationValueEl, 'Rotation angle');
	rotationValueEl.classList.add('sketchpad-view-controls-label');

	const rotationReset = viewControlEl.createEl('button', { cls: 'sketchpad-view-reset-button' });
	setIcon(rotationReset, 'reset');
	setTooltip(rotationReset, 'Reset rotation');
	rotationReset.addEventListener('click', () => callbacks.onRotationChange(0)); //set the rotation to 0

	const rotationInput = viewControlEl.createEl('input');
	rotationInput.classList.add('sketchpad-vertical-slider');
	rotationInput.setAttribute('type', 'range');
	rotationInput.setAttribute('min', '-180');
	rotationInput.setAttribute('max', '180');
	rotationInput.value = String((initialView.rotation).toFixed(1));
	rotationValueEl.setText(`${rotationInput.value}°`);
	rotationInput.addEventListener('input', () => {
		callbacks.onRotationChange(Number(rotationInput.value));
	});

	const toggleLayerPanelButton = viewControlEl.createEl('button', { cls: 'sketchpad-expand-collapse-button' });
	viewControlEl.insertBefore(toggleLayerPanelButton, viewControlEl.firstChild);
	setIcon(toggleLayerPanelButton, 'list');
	setTooltip(toggleLayerPanelButton, 'Toggle layer panel');

	const layerControlEl = container.querySelector('.sketchpad-layer-controls');
	if (layerControlEl) {
		layerControlEl.classList.toggle('sketchpad-collapsed', initialLayerPanelCollapsed ?? false);
	}
	toggleLayerPanelButton.classList.toggle('is-active', !(initialLayerPanelCollapsed ?? false));

	toggleLayerPanelButton.addEventListener('click', () => {
		const layerControlEl = container.querySelector('.sketchpad-layer-controls');
		if (!layerControlEl) {
			return;
		}
		const collapsed = layerControlEl.classList.toggle('sketchpad-collapsed');
		toggleLayerPanelButton.classList.toggle('is-active', !collapsed);
		callbacks.onLayerPanelToggle?.(!collapsed);
	});

	if (minimalUI) {
		const panelMoveButton = viewControlEl.createEl('button', { cls: 'sketchpad-panel-move-button' });
		setIcon(panelMoveButton, 'move');
		setTooltip(panelMoveButton, 'Drag to move the left sidebar');
		viewControlEl.insertAfter(panelMoveButton, viewControlEl.lastChild);
		const shell = container.parentElement;
		if (shell && callbacks.onPanelMove) {
			wirePanelDrag(panelMoveButton, container, shell, callbacks.onPanelMove, 'left');
		}
	}

	return { zoomInput, zoomValueEl, rotationInput, rotationValueEl, flipHButton, flipVButton, fitToViewButton };
}

function zoomToSlider(zoom: number): number {
	return (Math.log(zoom/MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM)) * 100;
}
function sliderToZoom(sliderValue: number): number {
	return MIN_ZOOM * Math.pow(MAX_ZOOM / MIN_ZOOM, sliderValue / 100);
}

export function syncViewControls(elements: ViewControlElements, view: ViewTransform, currentTool: ViewTool): void {
	elements.zoomInput.value = String(Math.round(zoomToSlider(view.zoom)));
	elements.zoomValueEl.setText(`${Math.round(view.zoom * 100)}%`);
	
	elements.rotationInput.value = String(view.rotation);
	elements.rotationValueEl.setText(`${(view.rotation).toFixed(1)}°`);
	
	elements.flipHButton.classList.toggle('is-active', view.flipX);
	elements.flipVButton.classList.toggle('is-active', view.flipY);
}
