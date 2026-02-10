/**
 * Full-size image viewer with DOM preloading pool, OCR side panel,
 * and magnifying glass (Z to toggle).
 */
const Viewer = {
    _overlay: null,
    _main: null,
    _container: null,
    _counter: null,
    _filenameEl: null,
    _badge: null,
    _ocrDetailEl: null,
    _tagRoiImg: null,
    _tagRoiEmpty: null,
    _ledImg: null,
    _ledEmpty: null,
    _magnifier: null,
    _images: [],
    _currentIndex: -1,
    _pool: [],
    _isOpen: false,
    _renaming: false,
    _magActive: false,

    POOL_SIZE: 5,
    // Magnifier: sample a 50x50 area relative to 1080p, display in a 250px lens
    MAG_SAMPLE: 50,
    MAG_REF_H: 1080,
    MAG_SIZE: 250,

    init() {
        this._overlay = document.getElementById('viewer-overlay');
        this._main = document.getElementById('viewer-main');
        this._container = document.getElementById('viewer-container');
        this._counter = document.getElementById('viewer-counter');
        this._filenameEl = document.getElementById('viewer-filename');
        this._badge = document.getElementById('viewer-status-badge');
        this._ocrDetailEl = document.getElementById('viewer-ocr-detail');
        this._tagRoiImg = document.getElementById('viewer-tagroi-img');
        this._tagRoiEmpty = document.getElementById('viewer-tagroi-empty');
        this._ledImg = document.getElementById('viewer-led-img');
        this._ledEmpty = document.getElementById('viewer-led-empty');
        this._magnifier = document.getElementById('viewer-magnifier');

        document.getElementById('viewer-close').addEventListener('click', () => this.close());

        // Magnifier mouse tracking
        this._main.addEventListener('mousemove', (e) => this._onMouseMove(e));
        this._main.addEventListener('mouseleave', () => {
            if (this._magActive) this._magnifier.classList.add('hidden');
        });
        this._main.addEventListener('mouseenter', () => {
            if (this._magActive) this._magnifier.classList.remove('hidden');
        });

        for (let i = 0; i < this.POOL_SIZE; i++) {
            const img = document.createElement('img');
            img.style.display = 'none';
            this._container.appendChild(img);
            this._pool.push(img);
        }
    },

    get isOpen() { return this._isOpen; },
    get isRenaming() { return this._renaming; },
    get currentImage() { return this._images[this._currentIndex]; },

    open(images, startIndex) {
        this._images = images;
        this._currentIndex = startIndex;
        this._isOpen = true;
        this._overlay.classList.remove('hidden');
        this._loadCurrent();
        StatusFeed.info(`Viewer opened: ${images[startIndex].filename}`);
    },

    close() {
        if (this._renaming) return;
        this._isOpen = false;
        this._magActive = false;
        this._magnifier.classList.add('hidden');
        this._overlay.classList.add('hidden');
        this._pool.forEach(img => {
            img.src = '';
            img.style.display = 'none';
            delete img.dataset.loadedId;
        });
    },

    navigate(delta) {
        if (this._renaming) return;
        const newIndex = this._currentIndex + delta;
        if (newIndex < 0 || newIndex >= this._images.length) return;
        this._currentIndex = newIndex;
        this._loadCurrent();
    },

    next() { this.navigate(1); },
    prev() { this.navigate(-1); },

    _loadCurrent() {
        const indices = [
            this._currentIndex,
            this._currentIndex + 1,
            this._currentIndex + 2,
            this._currentIndex - 1,
            this._currentIndex - 2,
        ].filter(i => i >= 0 && i < this._images.length);

        this._pool.forEach(img => img.style.display = 'none');

        indices.forEach((imgIdx, poolIdx) => {
            if (poolIdx >= this._pool.length) return;
            const poolImg = this._pool[poolIdx];
            const url = API.fullImageUrl(this._images[imgIdx].id);

            if (poolImg.dataset.loadedId !== String(this._images[imgIdx].id)) {
                poolImg.src = url;
                poolImg.dataset.loadedId = String(this._images[imgIdx].id);
            }

            if (imgIdx === this._currentIndex) {
                poolImg.style.display = 'block';
            }
        });

        const img = this._images[this._currentIndex];

        // Update counter
        this._counter.textContent = `${this._currentIndex + 1} / ${this._images.length}`;

        // Update filename
        this._filenameEl.textContent = img.filename;

        // Update status badge
        this._badge.className = 'hidden';
        if (img.status === 'marked_delete') {
            this._badge.className = 'badge-delete';
            this._badge.textContent = 'MARKED FOR DELETE';
            this._badge.id = 'viewer-status-badge';
        } else if (img.status === 'marked_ocr') {
            this._badge.className = 'badge-ocr';
            this._badge.textContent = 'MARKED FOR OCR';
            this._badge.id = 'viewer-status-badge';
        } else {
            this._badge.id = 'viewer-status-badge';
            this._badge.className = 'hidden';
        }

        // Update magnifier background for new image
        if (this._magActive) {
            this._setupMagBackground();
        }

        // Sync grid selection to current viewer image
        this._syncGridFocus(img.id);

        // Update side panel
        this._loadOcrPanel(img.id);
        this._loadCropImage(API.tagRoiUrl(img.id), this._tagRoiImg, this._tagRoiEmpty);
        this._loadCropImage(API.ledCropUrl(img.id), this._ledImg, this._ledEmpty);
    },

    _syncGridFocus(imageId) {
        const cards = Grid._gridEl.children;
        for (let i = 0; i < cards.length; i++) {
            if (parseInt(cards[i].dataset.imageId) === imageId) {
                Grid._setFocus(i);
                return;
            }
        }
    },

    // ── Side panel: OCR detail (editable) ──────────────────────

    async _loadOcrPanel(imageId) {
        let ocr = Grid._ocrResults[imageId];

        if (!ocr) {
            try {
                ocr = await API.getOcrResult(imageId);
            } catch {
                // no result
            }
        }

        if (!ocr) {
            this._ocrDetailEl.innerHTML = '<div class="viewer-no-ocr">No OCR result</div>';
            return;
        }

        this._ocrDetailEl.innerHTML = '';

        // Tag — editable
        this._ocrDetailEl.appendChild(
            this._editableRow('tag', ocr.tag || '', imageId)
        );

        // Scale weight — editable
        this._ocrDetailEl.appendChild(
            this._editableRow('scale_weight', ocr.scale_weight != null ? String(ocr.scale_weight) : '', imageId)
        );
    },

    _editableRow(field, value, imageId) {
        const row = document.createElement('div');
        row.className = 'ocr-prop';

        const label = document.createElement('span');
        label.className = 'ocr-prop-label';
        label.textContent = field;

        const valSpan = document.createElement('span');
        valSpan.className = 'ocr-prop-value ocr-editable';
        valSpan.textContent = value || '—';
        valSpan.title = 'Click to edit';

        valSpan.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'ocr-edit-input';
            input.value = value;
            valSpan.textContent = '';
            valSpan.appendChild(input);
            input.focus();
            input.select();

            const commit = async () => {
                const newVal = input.value.trim();
                input.replaceWith();
                valSpan.textContent = newVal || '—';

                if (newVal === value) return;
                value = newVal;

                const payload = {};
                if (field === 'scale_weight') {
                    payload[field] = newVal ? parseFloat(newVal) : null;
                } else {
                    payload[field] = newVal || null;
                }

                try {
                    await API.updateOcrResult(imageId, payload);
                    // Update grid cache
                    if (Grid._ocrResults[imageId]) {
                        Grid._ocrResults[imageId][field] = payload[field];
                    }
                    StatusFeed.success(`Updated ${field} → ${newVal || '(cleared)'}`);

                    // Rename file to {tag}.jpg when tag is edited
                    if (field === 'tag' && newVal) {
                        const newName = newVal + '.jpg';
                        const img = this._images[this._currentIndex];
                        if (img && img.id === imageId) {
                            await API.renameImage(imageId, newName);
                            img.filename = newName;
                            img.filepath = img.filepath.replace(/[^/]+$/, newName);
                            this._filenameEl.textContent = newName;
                            Grid.updateImageInPlace(img.id, img.status);
                        }
                    }
                } catch (err) {
                    StatusFeed.error(`Save failed: ${err.message}`);
                }
            };

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.replaceWith(); valSpan.textContent = value || '—'; }
            });
            input.addEventListener('blur', commit);
        });

        row.appendChild(label);
        row.appendChild(valSpan);
        return row;
    },

    // ── Side panel: crop images ────────────────────────────────

    _loadCropImage(url, imgEl, emptyEl) {
        imgEl.classList.add('hidden');
        emptyEl.style.display = '';

        const test = new Image();
        test.onload = () => {
            imgEl.src = url;
            imgEl.classList.remove('hidden');
            emptyEl.style.display = 'none';
        };
        test.onerror = () => {
            imgEl.classList.add('hidden');
            emptyEl.style.display = '';
        };
        test.src = url;
    },

    // ── TAB field cycling ────────────────────────────────────────

    focusNextField(reverse = false) {
        const fields = Array.from(this._ocrDetailEl.querySelectorAll('.ocr-editable'));
        if (fields.length === 0) return;

        // Find which field has an active input (if any)
        let activeIdx = -1;
        fields.forEach((f, i) => {
            if (f.querySelector('.ocr-edit-input')) activeIdx = i;
        });

        // Commit the current input via blur before moving
        const activeInput = this._ocrDetailEl.querySelector('.ocr-edit-input');
        if (activeInput) activeInput.blur();

        // Move to next/prev field
        let nextIdx;
        if (activeIdx === -1) {
            nextIdx = reverse ? fields.length - 1 : 0;
        } else {
            nextIdx = reverse ? activeIdx - 1 : activeIdx + 1;
            if (nextIdx < 0) nextIdx = fields.length - 1;
            if (nextIdx >= fields.length) nextIdx = 0;
        }

        // Small delay to let blur/commit finish before clicking next
        setTimeout(() => fields[nextIdx].click(), 50);
    },

    // ── Magnifier ──────────────────────────────────────────────

    toggleMagnifier() {
        this._magActive = !this._magActive;
        if (this._magActive) {
            this._setupMagBackground();
            this._magnifier.classList.remove('hidden');
        } else {
            this._magnifier.classList.add('hidden');
        }
    },

    _setupMagBackground() {
        const visible = this._pool.find(p => p.style.display === 'block');
        if (!visible) return;
        this._magnifier.style.backgroundImage = `url(${visible.src})`;
    },

    _onMouseMove(e) {
        if (!this._magActive) return;
        const visible = this._pool.find(p => p.style.display === 'block');
        if (!visible) return;

        const rect = visible.getBoundingClientRect();
        // Cursor relative to the displayed image (0-1)
        const rx = (e.clientX - rect.left) / rect.width;
        const ry = (e.clientY - rect.top) / rect.height;
        if (rx < 0 || rx > 1 || ry < 0 || ry > 1) {
            this._magnifier.classList.add('hidden');
            return;
        }
        this._magnifier.classList.remove('hidden');

        const natW = visible.naturalWidth;
        const natH = visible.naturalHeight;

        // Scale factor: how the image maps to a 1080p-height display
        const refScale = this.MAG_REF_H / natH;
        // 50 screen-px at 1080p = 50/refScale source pixels
        const sampleSrc = this.MAG_SAMPLE / refScale;
        // Magnification: blow sampleSrc source pixels up to MAG_SIZE display pixels
        const zoom = this.MAG_SIZE / sampleSrc;
        const bgW = natW * zoom;
        const bgH = natH * zoom;

        // Position the lens: offset so the sampled center aligns with lens center
        const bgX = -(rx * bgW) + this.MAG_SIZE / 2;
        const bgY = -(ry * bgH) + this.MAG_SIZE / 2;

        this._magnifier.style.backgroundSize = `${bgW}px ${bgH}px`;
        this._magnifier.style.backgroundPosition = `${bgX}px ${bgY}px`;

        // Position lens near cursor (offset so it doesn't block the pointer)
        const mainRect = this._main.getBoundingClientRect();
        let lx = e.clientX - mainRect.left + 20;
        let ly = e.clientY - mainRect.top + 20;
        // Keep within the main panel
        if (lx + this.MAG_SIZE > mainRect.width) lx = e.clientX - mainRect.left - this.MAG_SIZE - 20;
        if (ly + this.MAG_SIZE > mainRect.height) ly = e.clientY - mainRect.top - this.MAG_SIZE - 20;

        this._magnifier.style.left = `${lx}px`;
        this._magnifier.style.top = `${ly}px`;
    },

    // ── Rename ──────────────────────────────────────────────────

    startRename() {
        const img = this._images[this._currentIndex];
        if (!img) return;

        this._renaming = true;

        const baseName = img.filename.replace(/\.[^.]+$/, '');
        const ext = img.filename.slice(baseName.length);

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'viewer-rename-input';
        input.value = baseName;

        this._filenameEl.textContent = '';
        this._filenameEl.appendChild(input);
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
                await API.renameImage(img.id, newName);
                img.filename = newName;
                img.filepath = img.filepath.replace(/[^/]+$/, newName);
                StatusFeed.success(`Renamed to ${newName}`);
                Grid.updateImageInPlace(img.id, img.status);
            } catch (err) {
                StatusFeed.error(`Rename failed: ${err.message}`);
            }
            this._renaming = false;
            this._filenameEl.textContent = img.filename;
        };

        const cancel = () => {
            this._renaming = false;
            this._filenameEl.textContent = img.filename;
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
        });

        input.addEventListener('blur', () => {
            if (this._renaming) cancel();
        });
    },

    // ── Mark ────────────────────────────────────────────────────

    async markCurrentForDeletion() {
        const img = this._images[this._currentIndex];
        if (!img) return;

        const newStatus = img.status === 'marked_delete' ? 'active' : 'marked_delete';
        try {
            await API.updateImageStatus(img.id, newStatus);
            img.status = newStatus;
            this._loadCurrent();
            Grid.updateImageInPlace(img.id, newStatus);

            if (newStatus === 'marked_delete') {
                StatusFeed.warn(`Marked ${img.filename} for deletion`);
            } else {
                StatusFeed.info(`Unmarked ${img.filename}`);
            }
        } catch (err) {
            StatusFeed.error(`Failed: ${err.message}`);
        }
    },
};
