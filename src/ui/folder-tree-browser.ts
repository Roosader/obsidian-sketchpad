import { App, TFolder, normalizePath } from 'obsidian';

export interface FolderTreeBrowserOptions {
	defaultFolder?: string;
	onChange?: (folder: TFolder) => void;
}

export class FolderTreeBrowser {
	private readonly app: App;
	private readonly treeEl: HTMLDivElement;
	private readonly expandedPaths: Set<string>;
	private readonly rootPath: string;
	private readonly onChange?: (folder: TFolder) => void;
	private selectedFolder: TFolder;

	constructor(app: App, options?: FolderTreeBrowserOptions) {
		this.app = app;
		this.onChange = options?.onChange;
		this.selectedFolder = app.vault.getRoot();
		// vault root (path '/') is always expanded and can't be collapsed
		this.rootPath = app.vault.getRoot().path;
		this.expandedPaths = new Set([this.rootPath]);
		this.treeEl = document.createElement('div');
		this.treeEl.addClass('sketchpad-folder-tree');
		this.preselectDefaultFolder(options?.defaultFolder?.trim() ?? '');
		this.renderFolderTree();
		this.setupTreeEvents();

		this.scheduleRevealSelected();
	}

	getElement(): HTMLDivElement {
		return this.treeEl;
	}

	getSelectedFolder(): TFolder {
		return this.selectedFolder;
	}

	selectFolder(folder: TFolder): void {
		this.selectedFolder = folder;
		this.onChange?.(folder);
		this.renderFolderTree();
		this.revealSelected();
	}

	revealSelected(): void {
		const row = this.treeEl.querySelector<HTMLElement>('.sketchpad-folder-row.is-selected');
		if (!row) {
			return;
		}
		const treeRect = this.treeEl.getBoundingClientRect();
		const rowRect = row.getBoundingClientRect();
		if (rowRect.top < treeRect.top || rowRect.bottom > treeRect.bottom) {
			const offset = rowRect.top - treeRect.top - (treeRect.height - rowRect.height) / 2;
			this.treeEl.scrollTop += offset;
		}
	}

	private scheduleRevealSelected(): void {
		const tryReveal = (remaining: number): void => {
			if (this.treeEl.isConnected && this.treeEl.clientHeight > 0) {
				this.revealSelected();
				return;
			}
			if (remaining > 0) {
				window.requestAnimationFrame(() => tryReveal(remaining - 1));
			}
		};
		if (this.treeEl.isConnected && this.treeEl.clientHeight > 0) {
			this.revealSelected();
			return;
		}
		tryReveal(30); // up to ~30 frames (~500ms) for the modal animation
	}

	private preselectDefaultFolder(defaultFolder: string): void {
		if (!defaultFolder) {
			return;
		}
		const target = this.app.vault.getAbstractFileByPath(normalizePath(defaultFolder));
		if (target instanceof TFolder) {
			this.expandTo(target);
			this.selectedFolder = target;
		}
	}

	private renderFolderTree(): void {
		this.treeEl.empty();
		this.renderFolderRow(this.treeEl, this.app.vault.getRoot(), 0);
	}

	// renders one folder row, recursing into its subfolders when expanded.
	private renderFolderRow(container: HTMLElement, folder: TFolder, depth: number): void {
		const path = folder.path;
		const childFolders = folder.children.filter((child): child is TFolder => child instanceof TFolder);
		const hasChildren = childFolders.length > 0;
		const isExpanded = path === this.rootPath || this.expandedPaths.has(path);

		const row = container.createDiv({ cls: 'sketchpad-folder-row' });
		row.setAttribute('data-path', path);
		row.style.paddingLeft = `${8 + depth * 14}px`;
		if (this.selectedFolder.path === path) {
			row.addClass('is-selected');
		}

		const chevron = row.createSpan({ cls: 'sketchpad-folder-chevron' });
		if (hasChildren) {
			chevron.addClass('has-children');
			if (isExpanded) {
				chevron.addClass('is-expanded');
			}
		} else {
			chevron.addClass('is-leaf');
		}

		row.createSpan({ cls: 'sketchpad-folder-name', text: folder.isRoot() ? '/' : folder.name });

		if (isExpanded) {
			for (const child of childFolders) {
				this.renderFolderRow(container, child, depth + 1);
			}
		}
	}

	private setupTreeEvents(): void {
		this.treeEl.addEventListener('click', (event) => {
			const target = event.target as HTMLElement;
			const row = target.closest<HTMLElement>('.sketchpad-folder-row');
			if (!row) {
				return;
			}
			const folder = this.findFolderByPath(row.getAttribute('data-path') ?? '');
			if (!folder) {
				return;
			}
			if (target.classList.contains('sketchpad-folder-chevron') && target.classList.contains('has-children')) {
				// chevron only expands/collapses without changing selection
				this.toggleFolder(folder);
				return;
			}
			this.handleRowClick(folder);
		});
	}

	private findFolderByPath(path: string): TFolder | null {
		if (path === this.rootPath || path === '') {
			return this.app.vault.getRoot();
		}
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFolder ? file : null;
	}

	private handleRowClick(folder: TFolder): void {
		this.selectedFolder = folder;
		if (!folder.isRoot()) {
			const path = folder.path;
			if (this.expandedPaths.has(path)) {
				this.expandedPaths.delete(path);
			} else {
				this.expandedPaths.add(path);
			}
		}
		this.onChange?.(folder);
		this.renderFolderTree();
		this.revealSelected();
	}

	private toggleFolder(folder: TFolder): void {
		if (folder.isRoot()) {
			return; // the vault root stays expanded at all times
		}
		const path = folder.path;
		if (this.expandedPaths.has(path)) {
			this.expandedPaths.delete(path);
		} else {
			this.expandedPaths.add(path);
		}
		this.renderFolderTree();
	}

	// adds every ancestor of the folder to the expanded set, so the folder is visible when the tree is first built
	private expandTo(folder: TFolder): void {
		this.expandedPaths.add(this.rootPath);
		const segments = folder.path.split('/').filter(Boolean);
		let current = '';
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			this.expandedPaths.add(current);
		}
	}
}
