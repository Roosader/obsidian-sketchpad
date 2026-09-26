//for lazily loading the images rendered in .sketchpad-file-thumbnail-grid (Open sketch / Import image modals).


// callback invoked once when a grid card scrolls near the visible area.
export type ThumbnailVisibleCallback = (target: Element) => void;



export function createThumbnailObserver(
    root: HTMLElement,
    onVisible: ThumbnailVisibleCallback,
    rootMargin = '200px 0px',
): IntersectionObserver {
    return new IntersectionObserver(
        (entries, observer) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) {
                    continue;
                }
                observer.unobserve(entry.target);
                onVisible(entry.target);
            }
        },
        { root, rootMargin, threshold: 0 }, //preload margin: start loading before cards enter view
    );
}

// FIFO task queue that runs at most `limit` async tasks concurrently
export interface ThumbnailQueue {
    enqueue(task: () => Promise<void>): void;
    clear(): void;
}

// Bounds concurrent vault reads (Open sketch thumbnails each trigger a full readBinary + unzip)
// so scrolling through a large folder does not flood the vault with simultaneous reads
export function createConcurrencyQueue(limit = 4): ThumbnailQueue {
    let running = 0;
    const pending: Array<() => Promise<void>> = [];

    const pump = (): void => {
        while (running < limit && pending.length > 0) {
            const task = pending.shift();
            if (!task) {
                return;
            }
            running += 1;
            void task()
                .catch(() => {
                    // Loaders handle/report their own errors; never stall the queue.
                })
                .finally(() => {
                    running -= 1;
                    pump();
                });
        }
    };

    return {
        enqueue(task: () => Promise<void>): void {
            pending.push(task);
            pump();
        },
        clear(): void {
            pending.length = 0;
        },
    };
}
