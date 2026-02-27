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
    _rotating: false,
    _cacheBust: {},  // imageId -> timestamp, set on rotate to defeat browser cache
    _itemCodes: null,

    POOL_SIZE: 5,
    // Magnifier: sample a 50x50 area relative to 1080p, display in a 500px lens
    MAG_SAMPLE: 75,
    MAG_REF_H: 1080,
    MAG_SIZE: 500,

    async init() {
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
        document.getElementById('viewer-rotate-btn').addEventListener('click', () => this.rotateCurrent());

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

        try {
            const response = await fetch('/api/item_codes');
            this._itemCodes = await response.json();
        } catch (error) {
            console.error('Error fetching item codes:', error);
            this._itemCodes = {};
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
        // StatusFeed.info(`Viewer opened: ${images[startIndex].filename}`);
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
            const imgId = this._images[imgIdx].id;
            let url = API.fullImageUrl(imgId);
            if (this._cacheBust[imgId]) url += '?t=' + this._cacheBust[imgId];

            if (poolImg.dataset.loadedId !== String(imgId) + (this._cacheBust[imgId] || '')) {
                poolImg.src = url;
                poolImg.dataset.loadedId = String(imgId) + (this._cacheBust[imgId] || '');
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

        // Hide rotate button for non-data_entry
        document.getElementById('viewer-rotate-btn').style.display =
            App.currentRole === 'data_entry' ? '' : 'none';

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
            const role = App.currentRole;
            if (role === 'warehouse') {
                // Warehouse can set tare_weight even before OCR runs
                this._ocrDetailEl.innerHTML = '';
                this._ocrDetailEl.appendChild(
                    this._editableRow('tare_weight', '', imageId, false)
                );
            } else {
                this._ocrDetailEl.innerHTML = '<div class="viewer-no-ocr">No Metadata</div>';
            }
            return;
        }

        this._ocrDetailEl.innerHTML = '';
        const isReadonly = Grid._currentFolderManualReviewed;
        const role = App.currentRole;
        const isPending = ocr.status === 'pending';

        // Show original filename if different from current
        if (ocr.original_filename) {
            const currentBase = (ocr.filename || '').replace(/\.[^.]+$/, '');
            if (ocr.original_filename !== currentBase) {
                const origRow = document.createElement('div');
                origRow.className = 'ocr-prop';
                origRow.innerHTML = `<span class="ocr-prop-label">original</span><span class="ocr-prop-value" style="color:var(--text-muted)">${ocr.original_filename}</span>`;
                this._ocrDetailEl.appendChild(origRow);
            }
        }

        // Skip tag/item/scale_weight/tare_weight if image hasn't been OCR'd yet
        if (isPending) {
            if (role === 'warehouse') {
                // Warehouse can set tare_weight even on pending images
                const tw = ocr.tare_weight != null ? String(ocr.tare_weight) : '';
                this._ocrDetailEl.appendChild(this._editableRow('tare_weight', tw, imageId, false));
            }
            return;
        }

        // EVS tag check: only EVS tags unlock weight/item fields
        const isEvs = /^[A-Za-z]{3}\d{3}$/.test(ocr.tag);

        // For warehouse: tag, item, scale_weight are always read-only
        const mainFieldsReadonly = isReadonly || role === 'warehouse' || role === 'viewer';

        // Tag — editable (data_entry only), 30 char max
        this._ocrDetailEl.appendChild(
            this._editableRow('tag', ocr.tag || '', imageId, mainFieldsReadonly, { maxLength: 30, isTagField: true })
        );

        // Item, scale_weight, tare_weight — locked if tag is not EVS
        const evsLockedReadonly = !isEvs || mainFieldsReadonly;

        // Item — searchable dropdown (data_entry only, EVS tags only)
        this._ocrDetailEl.appendChild(
            this._itemDropdownRow('item', isEvs ? (ocr.item || '') : '', imageId, evsLockedReadonly)
        );

        // Scale weight — editable (data_entry only, EVS tags only)
        this._ocrDetailEl.appendChild(
            this._editableRow('scale_weight', isEvs && ocr.scale_weight != null ? String(ocr.scale_weight) : '', imageId, evsLockedReadonly)
        );

        // Tare weight — warehouse can always edit regardless of EVS tag or folder lock
        // data_entry: editable only on non-reviewed folders with EVS tags
        const tareReadonly = role === 'viewer' || (role !== 'warehouse' && (!isEvs || isReadonly));
        const tareValue = ocr.tare_weight != null && (isEvs || role === 'warehouse') ? String(ocr.tare_weight) : '';
        this._ocrDetailEl.appendChild(
            this._editableRow('tare_weight', tareValue, imageId, tareReadonly)
        );
    },

    _itemDropdownRow(field, selectedValue, imageId, isReadonly) {
        const row = document.createElement('div');
        row.className = 'ocr-prop';

        const label = document.createElement('span');
        label.className = 'ocr-prop-label';
        label.textContent = field;

        let displayValue = '-';
        if (selectedValue) { // Only try to find description if selectedValue is not falsy
            if (this._itemCodes && this._itemCodes[selectedValue]) {
                displayValue = `${selectedValue} - ${this._itemCodes[selectedValue]}`;
            } else {
                displayValue = selectedValue;
            }
        }

        const container = document.createElement('div');
        container.className = 'ocr-item-container';
        if (isReadonly) container.classList.add('grid-readonly');

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'ocr-item-input';
        input.value = displayValue;
        input.placeholder = isReadonly ? '' : 'Search...';
        input.dataset.code = selectedValue || '';
        input.autocomplete = 'off';
        if (isReadonly) {
            input.readOnly = true;
            input.disabled = true;
        }

        const dropdown = document.createElement('div');
        dropdown.className = 'ocr-item-dropdown hidden';

        container.appendChild(input);
        container.appendChild(dropdown);

        if (isReadonly) {
            row.appendChild(label);
            row.appendChild(container);
            return row;
        }

        const populate = (filter = '') => {
            if (!this._itemCodes) return;
            let html = '';
            const term = filter.toLowerCase();
            let first = true;
            for (const [code, desc] of Object.entries(this._itemCodes)) {
                const text = `${code} - ${desc}`;
                if (text.toLowerCase().includes(term)) {
                    const cls = first ? 'ocr-item-option selected' : 'ocr-item-option';
                    html += `<div class="${cls}" data-code="${code}">${text}</div>`;
                    first = false;
                }
            }
            if (!html) {
                html = '<div class="ocr-item-option" style="cursor:default; color:var(--text-muted);">No matches</div>';
            }
            dropdown.innerHTML = html;
        };

        const selectOption = async (code, text) => {
            input.value = text;
            input.dataset.code = code;
            dropdown.classList.add('hidden');

            try {
                await API.updateOcrResult(imageId, { item: code });
                if (!Grid._ocrResults[imageId]) {
                    Grid._ocrResults[imageId] = { image_id: imageId, status: 'pending' };
                }
                Grid._ocrResults[imageId].item = code;
                // Refresh grid's metadata panel if it's showing this image
                if (OcrDetail._currentImageId === imageId) {
                    OcrDetail.show(imageId);
                }
                StatusFeed.success(`Updated item → ${code}`);
            } catch (error) {
                console.error('Error updating item code:', error);
                StatusFeed.error(`Save failed: ${error.message}`);
            }
        };

        input.addEventListener('focus', () => {
            input.select();
            populate('');
            dropdown.classList.remove('hidden');
        });

        input.addEventListener('input', () => {
            populate(input.value);
            dropdown.classList.remove('hidden');
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                dropdown.classList.add('hidden');
                // Revert input value on escape without selection
                const savedCode = input.dataset.code;
                let displayValue = '-';
                if (savedCode) {
                    if (this._itemCodes && this._itemCodes[savedCode]) {
                        displayValue = `${savedCode} - ${this._itemCodes[savedCode]}`;
                    } else {
                        displayValue = savedCode;
                    }
                }
                input.value = displayValue;
                input.blur();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const options = [...dropdown.querySelectorAll('.ocr-item-option[data-code]')];
                if (!options.length) return;
                const selectedIdx = options.findIndex(o => o.classList.contains('selected'));
                let nextIdx;
                if (e.key === 'ArrowDown') {
                    nextIdx = selectedIdx < options.length - 1 ? selectedIdx + 1 : 0;
                } else {
                    nextIdx = selectedIdx > 0 ? selectedIdx - 1 : options.length - 1;
                }
                options.forEach(o => o.classList.remove('selected'));
                options[nextIdx].classList.add('selected');
                options[nextIdx].scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter') {
                const selectedOption = dropdown.querySelector('.ocr-item-option.selected[data-code]');
                if (selectedOption) {
                    selectOption(selectedOption.dataset.code, selectedOption.textContent);
                    input.blur();
                }
            }
        });

        input.addEventListener('blur', () => {
            setTimeout(() => {
                dropdown.classList.add('hidden');
                // Revert to saved value if not committed
                const savedCode = input.dataset.code;
                let displayValue = '-'; // Default to '-'
                if (savedCode) { // Only try to find description if savedCode is not falsy
                    if (this._itemCodes && this._itemCodes[savedCode]) {
                        displayValue = `${savedCode} - ${this._itemCodes[savedCode]}`;
                    } else {
                        displayValue = savedCode;
                    }
                }
                input.value = displayValue;
            }, 150);
        });

        dropdown.addEventListener('mousedown', (e) => {
            const option = e.target.closest('.ocr-item-option');
            if (option && option.dataset.code) {
                selectOption(option.dataset.code, option.textContent);
            }
        });

        row.appendChild(label);
        row.appendChild(container);
        return row;
    },

    _editableRow(field, value, imageId, isReadonly, opts = {}) {
        const row = document.createElement('div');
        row.className = 'ocr-prop';

        const label = document.createElement('span');
        label.className = 'ocr-prop-label';
        label.textContent = field;

        const container = document.createElement('div');
        container.className = 'ocr-item-container';
        if (isReadonly) container.classList.add('grid-readonly');

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'ocr-item-input';
        input.value = value;
        input.autocomplete = 'off';
        if (opts.maxLength) input.maxLength = opts.maxLength;
        if (isReadonly) {
            input.readOnly = true;
            input.disabled = true;
        }

        container.appendChild(input);
        row.appendChild(label);
        row.appendChild(container);

        if (isReadonly) return row;

        const commit = async () => {
            const newVal = input.value.trim();
            if (newVal === value) return;
            const oldValue = value;
            value = newVal;
            input.value = newVal;

            const payload = {};
            if (field === 'scale_weight' || field === 'tare_weight') {
                payload[field] = newVal ? parseFloat(newVal) : null;
            } else {
                payload[field] = newVal || null;
            }

            // Step 1: save the field value
            try {
                await API.updateOcrResult(imageId, payload);
                // Ensure a local entry exists (may not if OCR was never run on this image)
                if (!Grid._ocrResults[imageId]) {
                    Grid._ocrResults[imageId] = { image_id: imageId, status: 'pending' };
                }
                Grid._ocrResults[imageId][field] = payload[field];
                if (OcrDetail._currentImageId === imageId) {
                    OcrDetail.show(imageId);
                }
                StatusFeed.success(`Updated ${field} → ${newVal || '(cleared)'}`);
            } catch (err) {
                value = oldValue;
                input.value = oldValue;
                StatusFeed.error(`Save failed: ${err.message}`);
                return;
            }

            // Step 2: tag-specific actions — always re-render panel so locked fields
            // update immediately without requiring the viewer to be closed/reopened
            if (opts.isTagField) {
                if (Grid._ocrResults[imageId]) {
                    const isEvs = /^[A-Za-z]{3}\d{3}$/.test(newVal);
                    if (!isEvs) {
                        Grid._ocrResults[imageId].item = null;
                        Grid._ocrResults[imageId].scale_weight = null;
                        Grid._ocrResults[imageId].tare_weight = null;
                    }
                }
                this._loadOcrPanel(imageId);
                Grid.updateOcrBadge(imageId, Grid._ocrResults[imageId]);

                // Step 3: rename file if tag is EVS (separate try so rename failure
                // doesn't prevent the panel from having already refreshed above)
                if (newVal && /^[A-Za-z]{3}\d{3}$/.test(newVal)) {
                    const img = this._images[this._currentIndex];
                    if (img && img.id === imageId) {
                        const ext = img.filename.replace(/^.*(\.[^.]+)$/, '$1');
                        const newName = newVal + ext;
                        try {
                            await API.renameImage(imageId, newName);
                            img.filename = newName;
                            img.filepath = img.filepath.replace(/[^/]+$/, newName);
                            this._filenameEl.textContent = newName;
                            Grid.updateImageInPlace(img.id, img.status);
                        } catch (renameErr) {
                            StatusFeed.error(`Rename failed: ${renameErr.message}`);
                        }
                    }
                }
            }
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); input.blur(); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.value = value; input.blur(); }
        });
        input.addEventListener('blur', commit);

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
        const fields = Array.from(this._ocrDetailEl.querySelectorAll('.ocr-item-input:not(:disabled)'));
        if (fields.length === 0) return;

        // Find which field is currently active
        let activeIdx = -1;
        const activeEl = document.activeElement;
        fields.forEach((f, i) => {
            if (f === activeEl) activeIdx = i;
        });

        // Blur current input to commit changes
        if (activeEl && activeEl.classList.contains('ocr-item-input')) {
            activeEl.blur();
        }

        // Move to next/prev field
        let nextIdx;
        if (activeIdx === -1) {
            nextIdx = reverse ? fields.length - 1 : 0;
        } else {
            nextIdx = reverse ? activeIdx - 1 : activeIdx + 1;
            if (nextIdx < 0) nextIdx = fields.length - 1;
            if (nextIdx >= fields.length) nextIdx = 0;
        }

        // Small delay to let blur/commit finish before focusing next
        setTimeout(() => {
            fields[nextIdx].focus();
            fields[nextIdx].select();
        }, 50);
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

        // Position lens centered on cursor, clamped within the main panel
        const mainRect = this._main.getBoundingClientRect();
        let lx = e.clientX - mainRect.left - this.MAG_SIZE / 2;
        let ly = e.clientY - mainRect.top - this.MAG_SIZE / 2;
        lx = Math.max(0, Math.min(lx, mainRect.width - this.MAG_SIZE));
        ly = Math.max(0, Math.min(ly, mainRect.height - this.MAG_SIZE));

        this._magnifier.style.left = `${lx}px`;
        this._magnifier.style.top = `${ly}px`;
    },

    // ── Rename ──────────────────────────────────────────────────

    startRename() {
        if (App.currentRole !== 'data_entry') return;
        if (Grid._currentFolderManualReviewed) {
            StatusFeed.warn('Cannot rename files: this folder has completed manual review.');
            return;
        }
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

    // ── Rotate ──────────────────────────────────────────────────

    async rotateCurrent() {
        if (App.currentRole !== 'data_entry') return;
        if (this._rotating) return;
        const img = this._images[this._currentIndex];
        if (!img) return;

        this._rotating = true;

        try {
            const result = await API.rotateImage(img.id);
            img.width = result.width;
            img.height = result.height;

            // Invalidate all pool entries and cache-bust reload
            const bust = Date.now();
            this._cacheBust[img.id] = bust;
            this._pool.forEach(p => { delete p.dataset.loadedId; });

            const visible = this._pool.find(p => p.style.display === 'block');
            if (visible) {
                // Instant visual feedback: CSS rotate while the real image loads
                visible.style.transition = 'transform 0.15s ease';
                visible.style.transform = 'rotate(90deg)';

                visible.addEventListener('load', () => {
                    visible.style.transition = '';
                    visible.style.transform = '';
                    if (this._magActive) this._setupMagBackground();
                    this._rotating = false;
                }, { once: true });
                visible.src = API.fullImageUrl(img.id) + '?t=' + bust;
                visible.dataset.loadedId = String(img.id) + bust;
            } else {
                this._rotating = false;
            }

            Grid.refreshThumbnail(img.id);
        } catch (err) {
            this._rotating = false;
            StatusFeed.error(`Rotate failed: ${err.message}`);
        }
    },

    // ── Mark ────────────────────────────────────────────────────

    async markCurrentForDeletion() {
        if (App.currentRole !== 'data_entry') return;
        if (Grid._currentFolderManualReviewed) {
            StatusFeed.warn('Cannot mark for deletion: this folder has completed manual review.');
            return;
        }
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
