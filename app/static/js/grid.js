/**
 * Thumbnail grid view with lazy loading, selection, and mark modes.
 *
 * Modes: 'normal' | 'delete' | 'ocr'
 *   X → enter delete mode, toggle mark on focused image
 *   O → enter OCR mode, toggle mark on focused image
 *   Escape → exit mode back to normal (or deselect if already normal)
 */
const Grid = {
    _images: [],
    _selected: new Set(),
    _gridEl: null,
    _observer: null,
    _currentFolderId: null,
    _focusIndex: -1,
    _mode: 'normal',  // 'normal' | 'delete' | 'ocr'
    _ocrResults: {},  // image_id -> ocr result
    _ocrProcessingIds: new Set(),  // image IDs currently being OCR-processed
    _currentFolderManualReviewed: false, // New property to store folder's manual_reviewed status

    init() {
        this._gridEl = document.getElementById('thumbnail-grid');
        this._setupObserver();
    },

    _setupObserver() {
        this._observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target.querySelector('img');
                    if (img && img.dataset.src) {
                        img.src = img.dataset.src;
                        delete img.dataset.src;
                        this._observer.unobserve(entry.target);
                    }
                }
            });
        }, { root: this._gridEl, rootMargin: '200px' });
    },

    get images() { return this._images; },
    get selected() { return this._selected; },
    get currentFolderId() { return this._currentFolderId; },
    get mode() { return this._mode; },

    getSelectedImages() {
        return this._images.filter(img => this._selected.has(img.id));
    },

    // ── Mode management ────────────────────────────────────────

    setMode(mode) {
        if (mode === 'ocr' || mode === 'delete') {
            const currentFolderId = this._currentFolderId;
            if (currentFolderId) {
                try {
                    const folder = App._folders.find(f => f.id === currentFolderId);
                    if (folder && folder.manual_reviewed) {
                        StatusFeed.warn(`Cannot enter ${mode.toUpperCase()} mode: this folder has completed manual review.`);
                        return; // Prevent setting mode
                    }
                } catch (err) {
                    StatusFeed.error(`Failed to check folder status for ${mode.toUpperCase()} mode.`);
                    return; // Prevent setting mode on error
                }
            }
        }
        this._mode = mode;
        this._updateModeIndicator();

        if (mode === 'normal') {
            StatusFeed.info('Normal mode');
        } else if (mode === 'delete') {
            StatusFeed.warn('DELETE mode — X to toggle, Esc to exit');
        } else if (mode === 'ocr') {
            StatusFeed.info('OCR mode — O to toggle, Esc to exit');
        }
    },

    _updateModeIndicator() {
        const modeIndicator = document.getElementById('grid-mode-indicator');
        if (!modeIndicator) return; // Should not happen if App._selectFolder runs first

        // Clear existing content and classes
        modeIndicator.textContent = '';
        modeIndicator.classList.remove('mode-delete', 'mode-ocr');

        if (this._mode === 'delete') {
            modeIndicator.textContent = ' — DELETE MODE';
            modeIndicator.classList.add('mode-delete');
        } else if (this._mode === 'ocr') {
            modeIndicator.textContent = ' — OCR MODE';
            modeIndicator.classList.add('mode-ocr');
        }
    },

    async exitMode() {
        if (this._mode === 'normal') {
            this.deselectAll();
            return;
        }

        // Unmark all images that were marked in this mode
        const markStatus = this._mode === 'delete' ? 'marked_delete' : 'marked_ocr';
        const markedIds = this._images
            .filter(i => i.status === markStatus)
            .map(i => i.id);

        if (markedIds.length > 0) {
            try {
                await API.bulkUpdateStatus(markedIds, 'active');
                markedIds.forEach(id => {
                    const img = this._images.find(i => i.id === id);
                    if (img) img.status = 'active';
                });
                this.render();
                StatusFeed.info(`Unmarked ${markedIds.length} image(s)`);
                this._updateExecuteButton();
            } catch (err) {
                StatusFeed.error(`Failed to unmark: ${err.message}`);
            }
        }

        this.setMode('normal');
    },

    // ── Mark actions ───────────────────────────────────────────

    _getMarkStatus() {
        return this._mode === 'delete' ? 'marked_delete' : 'marked_ocr';
    },

    _hasAnyMarked() {
        const markStatus = this._getMarkStatus();
        return this._images.some(i => i.status === markStatus);
    },

    async toggleFocusedMark() {
        if (this._mode === 'normal' || this._currentFolderManualReviewed) return;

        const cards = this._gridEl.children;
        if (this._focusIndex < 0 || this._focusIndex >= cards.length) return;

        const markStatus = this._getMarkStatus();

        // If multiple images are selected, mark/unmark all of them
        if (this._selected.size > 1) {
            const selectedImages = this.getSelectedImages();
            // Toggle based on focused image's current status
            const focusedId = parseInt(cards[this._focusIndex].dataset.imageId);
            const focusedImg = this._images.find(i => i.id === focusedId);
            if (!focusedImg) return;
            const newStatus = focusedImg.status === markStatus ? 'active' : markStatus;

            const ids = selectedImages.map(i => i.id);
            try {
                await API.bulkUpdateStatus(ids, newStatus);
                selectedImages.forEach(img => {
                    img.status = newStatus;
                    this.updateImageInPlace(img.id, newStatus);
                });

                if (newStatus === 'active') {
                    StatusFeed.info(`Unmarked ${ids.length} image(s)`);
                } else if (newStatus === 'marked_delete') {
                    StatusFeed.warn(`Marked ${ids.length} image(s) for deletion`);
                } else {
                    StatusFeed.info(`Marked ${ids.length} image(s) for OCR`);
                }
                this._updateExecuteButton();

                if (!this._hasAnyMarked()) {
                    this.setMode('normal');
                }
            } catch (err) {
                StatusFeed.error(`Failed: ${err.message}`);
            }
            return;
        }

        // Single image: toggle focused image only
        const imageId = parseInt(cards[this._focusIndex].dataset.imageId);
        const img = this._images.find(i => i.id === imageId);
        if (!img) return;

        const newStatus = img.status === markStatus ? 'active' : markStatus;

        try {
            await API.updateImageStatus(imageId, newStatus);
            img.status = newStatus;
            this.updateImageInPlace(imageId, newStatus);

            if (newStatus === 'active') {
                StatusFeed.info(`Unmarked ${img.filename}`);
            } else if (newStatus === 'marked_delete') {
                StatusFeed.warn(`Marked ${img.filename} for deletion`);
            } else {
                StatusFeed.info(`Marked ${img.filename} for OCR`);
            }
            this._updateExecuteButton();

            // Auto-exit mode if no images are marked
            if (!this._hasAnyMarked()) {
                this.setMode('normal');
            }
        } catch (err) {
            StatusFeed.error(`Failed: ${err.message}`);
        }
    },

    // ── Navigation ─────────────────────────────────────────────

    _getColumnCount() {
        const cards = this._gridEl.children;
        if (cards.length < 2) return 1;
        const firstTop = cards[0].getBoundingClientRect().top;
        for (let i = 1; i < cards.length; i++) {
            if (cards[i].getBoundingClientRect().top !== firstTop) return i;
        }
        return cards.length;
    },

    _setFocus(index, addToSelection = false) {
        const cards = this._gridEl.children;
        const count = cards.length;
        if (count === 0) return;

        if (index < 0) index = 0;
        if (index >= count) index = count - 1;

        const oldFocused = this._gridEl.querySelector('.thumb-card.focused');
        if (oldFocused) oldFocused.classList.remove('focused');

        this._focusIndex = index;
        const card = cards[index];
        card.classList.add('focused');

        const imageId = parseInt(card.dataset.imageId);
        if (!addToSelection) {
            this._selected.clear();
            this._gridEl.querySelectorAll('.thumb-card.selected').forEach(c => c.classList.remove('selected'));
        }
        this._selected.add(imageId);
        card.classList.add('selected');

        this._lastClicked = imageId;
        this._lastClickedIndex = index;
        this._updateCullButton();

        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

        // Show OCR detail for focused image
        OcrDetail.show(imageId);
    },

    navigate(direction, shiftHeld = false) {
        const cards = this._gridEl.children;
        if (cards.length === 0) return;

        const cols = this._getColumnCount();
        let newIndex = this._focusIndex;

        if (newIndex < 0) {
            this._setFocus(0, false);
            return;
        }

        switch (direction) {
            case 'left':  newIndex--; break;
            case 'right': newIndex++; break;
            case 'up':    newIndex -= cols; break;
            case 'down':  newIndex += cols; break;
        }

        if (newIndex < 0 || newIndex >= cards.length) return;
        this._setFocus(newIndex, shiftHeld);
    },

    openFocused() {
        const cards = this._gridEl.children;
        if (this._focusIndex < 0 || this._focusIndex >= cards.length) return;
        const imageId = parseInt(cards[this._focusIndex].dataset.imageId);
        const activeImages = this._images.filter(i => i.status !== 'deleted');
        const idx = activeImages.findIndex(i => i.id === imageId);
        if (idx >= 0) Viewer.open(activeImages, idx);
    },

    // ── Rename ──────────────────────────────────────────────────

    _renaming: false,
    get isRenaming() { return this._renaming; },

    startRename() {
        if (this._currentFolderManualReviewed) {
            StatusFeed.warn('Cannot rename files: this folder has completed manual review.');
            return;
        }
        const cards = this._gridEl.children;
        if (this._focusIndex < 0 || this._focusIndex >= cards.length) return;

        const card = cards[this._focusIndex];
        const imageId = parseInt(card.dataset.imageId);
        const img = this._images.find(i => i.id === imageId);
        if (!img) return;

        this._renaming = true;

        const nameEl = card.querySelector('.thumb-filename');
        const baseName = img.filename.replace(/\.[^.]+$/, '');
        const ext = img.filename.slice(baseName.length);

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'thumb-rename-input';
        input.value = baseName;

        nameEl.textContent = '';
        nameEl.appendChild(input);
        input.focus();
        input.select();

        const commit = async () => {
            const newBase = input.value.trim();
            if (!newBase || newBase + ext === img.filename) {
                cancel();
                return;
            }
            const newName = newBase + ext;
            try {
                await API.renameImage(imageId, newName);
                img.filename = newName;
                img.filepath = img.filepath.replace(/[^/]+$/, newName);
                StatusFeed.success(`Renamed to ${newName}`);
            } catch (err) {
                StatusFeed.error(`Rename failed: ${err.message}`);
            }
            this._renaming = false;
            nameEl.textContent = img.filename;
        };

        const cancel = () => {
            this._renaming = false;
            nameEl.textContent = img.filename;
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                commit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancel();
            }
        });

        input.addEventListener('blur', () => {
            if (this._renaming) cancel();
        });
    },

    // ── Folder loading ─────────────────────────────────────────

    async clearAllMarks() {
        const markedIds = this._images
            .filter(i => i.status === 'marked_delete' || i.status === 'marked_ocr')
            .map(i => i.id);
        if (markedIds.length > 0) {
            try {
                await API.bulkUpdateStatus(markedIds, 'active');
                markedIds.forEach(id => {
                    const img = this._images.find(i => i.id === id);
                    if (img) img.status = 'active';
                });
            } catch (err) {
                // Best-effort cleanup
            }
        }
    },

    async loadOcrResults() {
        if (!this._currentFolderId) return;
        try {
            const results = await API.getOcrResults(this._currentFolderId);
            this._ocrResults = {};
            results.forEach(r => { this._ocrResults[r.image_id] = r; });
            this._updateOcrBadges();
            // Show export button if there are OCR results
            document.getElementById('btn-export').style.display = results.length > 0 ? '' : 'none';
        } catch (err) {
            // OCR results are optional, don't block
        }
    },

    async loadFolder(folderId) {
        // Clear marks from previous folder before switching (only if switching to a different folder)
        if (this._currentFolderId && this._currentFolderId !== folderId && this._images.length > 0) {
            await this.clearAllMarks();
        }

        this._currentFolderId = folderId;
        this._selected.clear();
        this._focusIndex = -1;
        this._mode = 'normal';
        this._renaming = false;
        this._ocrResults = {};
        this._currentFolderManualReviewed = false; // Reset before loading new folder
        this._updateModeIndicator();
        this._updateCullButton();
        document.getElementById('btn-export').style.display = 'none';

        try {
            const folderData = await API.getFolder(folderId); // Fetch folder data including manual_reviewed status
            this._currentFolderManualReviewed = folderData.manual_reviewed;

            this._images = (await API.getImages(folderId, 'all')).filter(i => i.status !== 'deleted');
            this.render();
            StatusFeed.info(`Loaded ${this._images.length} images`);
            // Load OCR results after render
            this.loadOcrResults();
        } catch (err) {
            StatusFeed.error(`Failed to load images: ${err.message}`);
        }
    },

    // ── Rendering ──────────────────────────────────────────────

    render() {
        this._gridEl.innerHTML = '';

        const activeImages = this._images.filter(img => img.status !== 'deleted');

        activeImages.forEach((img, index) => {
            const card = document.createElement('div');
            card.className = 'thumb-card';
            card.dataset.imageId = img.id;
            card.dataset.index = index;

            // Only apply status classes if the folder is NOT manual_reviewed
            if (!this._currentFolderManualReviewed) {
                if (img.status !== 'active') {
                    card.classList.add(`status-${img.status}`);
                }
            } else {
                // If manual_reviewed, ensure no OCR specific classes are added,
                // but still allow delete status if applicable
                if (img.status === 'marked_delete') {
                    card.classList.add('status-marked_delete');
                }
            }
            if (this._selected.has(img.id)) {
                card.classList.add('selected');
            }
            if (index === this._focusIndex) {
                card.classList.add('focused');
            }

            const imgEl = document.createElement('img');
            imgEl.dataset.src = API.thumbnailUrl(img.id);
            imgEl.alt = img.filename;

            const nameEl = document.createElement('div');
            nameEl.className = 'thumb-filename';
            nameEl.textContent = img.filename;

            card.appendChild(imgEl);
            card.appendChild(nameEl);

            card.addEventListener('click', (e) => this._handleClick(e, img, card));
            card.addEventListener('dblclick', () => this._handleDoubleClick(img));

            this._gridEl.appendChild(card);
            this._observer.observe(card);
        });

        this._updateExecuteButton();
    },

    // ── Click handling ─────────────────────────────────────────

    _handleClick(e, img, card) {
        if (e.shiftKey && this._lastClicked != null) {
            const cards = Array.from(this._gridEl.children);
            const currentIdx = cards.indexOf(card);
            const lastIdx = this._lastClickedIndex;
            const start = Math.min(currentIdx, lastIdx);
            const end = Math.max(currentIdx, lastIdx);

            for (let i = start; i <= end; i++) {
                const id = parseInt(cards[i].dataset.imageId);
                this._selected.add(id);
                cards[i].classList.add('selected');
            }
        } else if (e.metaKey || e.ctrlKey) {
            if (this._selected.has(img.id)) {
                this._selected.delete(img.id);
                card.classList.remove('selected');
            } else {
                this._selected.add(img.id);
                card.classList.add('selected');
            }
        } else {
            this._selected.clear();
            this._gridEl.querySelectorAll('.thumb-card.selected').forEach(c => c.classList.remove('selected'));
            this._selected.add(img.id);
            card.classList.add('selected');
        }

        this._lastClicked = img.id;
        this._lastClickedIndex = Array.from(this._gridEl.children).indexOf(card);

        const oldFocused = this._gridEl.querySelector('.thumb-card.focused');
        if (oldFocused) oldFocused.classList.remove('focused');
        this._focusIndex = this._lastClickedIndex;
        card.classList.add('focused');

        this._updateCullButton();

        // Show OCR detail for clicked image
        OcrDetail.show(img.id);
    },

    _handleDoubleClick(img) {
        const activeImages = this._images.filter(i => i.status !== 'deleted');
        const idx = activeImages.findIndex(i => i.id === img.id);
        Viewer.open(activeImages, idx);
    },

    // ── Selection ──────────────────────────────────────────────

    selectAll() {
        this._selected.clear();
        const activeImages = this._images.filter(img => img.status !== 'deleted');
        activeImages.forEach(img => this._selected.add(img.id));
        this._gridEl.querySelectorAll('.thumb-card').forEach(c => c.classList.add('selected'));
        this._updateCullButton();
    },

    deselectAll() {
        this._selected.clear();
        this._gridEl.querySelectorAll('.thumb-card.selected').forEach(c => c.classList.remove('selected'));
        this._updateCullButton();
    },

    // ── UI updates ─────────────────────────────────────────────

    _updateCullButton() {
        const btn = document.getElementById('btn-cull');
        btn.disabled = this._selected.size < 2;
    },

    _updateOcrBadges() {
        const cards = this._gridEl.children;
        for (const card of cards) {
            const imageId = parseInt(card.dataset.imageId);
            const ocr = this._ocrResults[imageId];
            const nameEl = card.querySelector('.thumb-filename');
            if (nameEl && ocr && ocr.tag) {
                nameEl.classList.add('thumb-renamed');
            }
        }
    },

    updateOcrBadge(imageId, result) {
        this._ocrResults[imageId] = result;

        // Refresh OCR detail panel if showing this image
        if (OcrDetail._currentImageId === imageId) {
            OcrDetail.show(imageId);
        }

        const card = this._gridEl.querySelector(`[data-image-id="${imageId}"]`);
        if (!card) return;

        const nameEl = card.querySelector('.thumb-filename');
        if (nameEl && result.tag) {
            nameEl.classList.add('thumb-renamed');
        }
    },

    get isOcrProcessing() { return this._ocrProcessingIds.size > 0; },

    setOcrProcessing(ids) {
        if (this._currentFolderManualReviewed) return; // Do not show processing if folder is manual reviewed
        ids.forEach(id => {
            this._ocrProcessingIds.add(id);
            const card = this._gridEl.querySelector(`[data-image-id="${id}"]`);
            if (card) card.classList.add('ocr-processing');
        });
    },

    clearOcrProcessing(id) {
        this._ocrProcessingIds.delete(id);
        const card = this._gridEl.querySelector(`[data-image-id="${id}"]`);
        if (card) card.classList.remove('ocr-processing');
    },

    _updateExecuteButton() {
        const pendingCount = this._images.filter(i => i.status === 'marked_delete').length;
        const btn = document.getElementById('btn-execute');
        if (pendingCount > 0) {
            btn.style.display = '';
            btn.textContent = `Execute ${pendingCount} Deletion(s)`;
        } else {
            btn.style.display = 'none';
        }
    },

    refreshThumbnail(imageId) {
        const card = this._gridEl.querySelector(`[data-image-id="${imageId}"]`);
        if (!card) return;
        const imgEl = card.querySelector('img');
        if (imgEl) {
            imgEl.src = API.thumbnailUrl(imageId) + '?t=' + Date.now();
        }
    },

    updateImageInPlace(imageId, newStatus) {
        const img = this._images.find(i => i.id === imageId);
        if (img) {
            img.status = newStatus;
            const card = this._gridEl.querySelector(`[data-image-id="${imageId}"]`);
            if (card) {
                card.className = 'thumb-card';
                if (this._selected.has(imageId)) card.classList.add('selected');
                if (this._focusIndex >= 0) {
                    const cards = this._gridEl.children;
                    if (cards[this._focusIndex] === card) card.classList.add('focused');
                }
                // Update filename label
                const nameEl = card.querySelector('.thumb-filename');
                if (nameEl) {
                    nameEl.textContent = img.filename;
                    // Green background if OCR renamed this file
                    const ocr = this._ocrResults[imageId];
                    if (ocr && ocr.tag) {
                        nameEl.classList.add('thumb-renamed');
                    }
                }
                if (newStatus !== 'active') {
                    // Only apply status-marked_ocr if the folder is NOT manual_reviewed
                    if (this._currentFolderManualReviewed && newStatus === 'marked_ocr') {
                        // Do not add ocr status
                    } else {
                        card.classList.add(`status-${newStatus}`);
                    }
                }
            }
            this._updateExecuteButton();
        }
    },
};
