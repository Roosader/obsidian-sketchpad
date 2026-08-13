import { App, Plugin, TFile } from 'obsidian';
import { getMergedImageDataUrl } from '../ora/ora-parser';

// renders embeds of .ora sketch files ![[file.ora]] as an <img> preview of 
// the .ora file's mergedimage.png
export function registerOraEmbedPreview(plugin: Plugin): void {
	plugin.registerMarkdownPostProcessor((el, ctx) => {
		el.querySelectorAll<HTMLElement>('.internal-embed, .file-embed').forEach((embed) => {
			processEmbed(plugin, embed, ctx.sourcePath);
		});
	});

	const observer = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			for (const node of Array.from(mutation.addedNodes)) {
				if (!node.instanceOf(HTMLElement)) {
					continue;
				}
				const embeds = node.matches('.internal-embed, .file-embed')
					? [node]
					: Array.from(node.querySelectorAll<HTMLElement>('.internal-embed, .file-embed'));
				for (const embed of embeds) {
					processEmbed(plugin, embed);
				}
			}
			// Re-apply if Obsidian repopulated an embed in place (removing our
			// preview image); processEmbed is idempotent, so this is a no-op
			// when our preview is already present.
			const target = mutation.target as HTMLElement | null;
			if (target?.matches('.internal-embed, .file-embed')) {
				processEmbed(plugin, target);
			}
		}
	});
	observer.observe(document.body, { childList: true, subtree: true });
	plugin.register(() => observer.disconnect());
}

function processEmbed(plugin: Plugin, embedEl: HTMLElement, sourcePath = ''): void {
	const done = embedEl.hasAttribute('data-sketchpad-ora');
	const hasPreview = !!embedEl.querySelector('img.sketchpad-ora-image');
	if (done && hasPreview) {
		return;
	}
	const file = resolveOraFile(plugin, embedEl, sourcePath);
	if (!file) {
		return;
	}
	void loadMergedImage(plugin.app, file).then((src) => {
		if (!src || !embedEl.isConnected) {
			return;
		}
		embedEl.setAttribute('data-sketchpad-ora', '');
		// block clicks so sketchpad view is not opened
		if (!embedEl.hasAttribute('data-sketchpad-ora-click')) {
			embedEl.setAttribute('data-sketchpad-ora-click', '');
			embedEl.addEventListener(
				'click',
				(ev) => {
					ev.preventDefault();
					ev.stopPropagation();
				},
				true,
			);
		}
		embedEl.empty();
		embedEl.addClass('sketchpad-ora-embed');
		const preview = embedEl.createEl('img', { cls: 'sketchpad-ora-image' });
		preview.setAttribute('alt', file.basename);
		preview.setAttribute('src', src);
	});
}

function resolveOraFile(plugin: Plugin, embedEl: HTMLElement, sourcePath: string): TFile | null {
	const raw =
		embedEl.getAttribute('data-src') ??
		embedEl.getAttribute('src') ??
		embedEl.getAttribute('data-path') ??
		embedEl.getAttribute('data-link') ??
		'';
	// strip any block/section reference and display alias.
	const link = raw.split('#')[0]?.split('|')[0]?.trim() ?? '';
	if (!link || !link.toLowerCase().endsWith('.ora')) {
		return null;
	}
	const fromCache = plugin.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
	if (fromCache instanceof TFile) {
		return fromCache;
	}
	const byPath = plugin.app.vault.getAbstractFileByPath(link);
	return byPath instanceof TFile ? byPath : null;
}

async function loadMergedImage(app: App, file: TFile): Promise<string | null> {
	try {
		const binary = await app.vault.readBinary(file);
		return getMergedImageDataUrl(binary);
	} catch {
		return null;
	}
}
