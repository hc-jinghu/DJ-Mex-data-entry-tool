/**
 * App initialization, router, and state management.
 */
const App = {
    _folders: [],
    _activeFolderId: null,

    async init() {
        StatusFeed.init();
        Grid.init();
        OcrDetail.init();
        Viewer.init();
        Culler.init();
        Shortcuts.init();

        ROI.init();
        StatusFeed.info('Master Photo Library starting...');

        // Wire up buttons
        document.getElementById('btn-cull').addEventListener('click', () => this.startCulling());
        document.getElementById('btn-execute').addEventListener('click', () => this.executeActions());
        document.getElementById('btn-export').addEventListener('click', () => this.exportOcr());

        // Wire unit toggle
        document.querySelectorAll('input[name="weight-unit"]').forEach(radio => {
            radio.addEventListener('change', async (e) => {
                if (!this._activeFolderId) return;
                try {
                    await API.setFolderUnit(this._activeFolderId, e.target.value);
                    StatusFeed.info(`Weight unit set to ${e.target.value}`);
                } catch (err) {
                    StatusFeed.error(`Failed to set unit: ${err.message}`);
                }
            });
        });

        // Load folders
        await this.loadFolders();

        StatusFeed.success('Ready');
    },

    async loadFolders(autoSelect = true) {
        try {
            this._folders = await API.getFolders();
            this._renderFolderList();

            // Only auto-select if no folder is currently active
            if (autoSelect && !this._activeFolderId) {
                const imported = this._folders.find(f => f.imported);
                if (imported) {
                    this._selectFolder(imported);
                } else if (this._folders.length > 0) {
                    this._selectFolder(this._folders[0]);
                }
            }
        } catch (err) {
            StatusFeed.error(`Failed to load folders: ${err.message}`);
        }
    },

    _renderFolderList() {
        const list = document.getElementById('folder-list');
        list.innerHTML = '';

        this._folders.forEach(folder => {
            const item = document.createElement('div');
            item.className = 'folder-item';
            if (folder.id === this._activeFolderId) {
                item.classList.add('active');
            }

            const name = document.createElement('span');
            name.className = 'folder-name';
            name.textContent = folder.name;

            const count = document.createElement('span');
            count.className = 'folder-count';
            count.textContent = folder.image_count;

            item.appendChild(name);
            item.appendChild(count);

            if (folder.imported) {
                const badge = document.createElement('span');
                badge.className = 'folder-badge badge-imported';
                badge.textContent = 'OK';
                item.appendChild(badge);
            } else {
                const badge = document.createElement('span');
                badge.className = 'folder-badge badge-import';
                badge.textContent = 'Import';
                badge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._importFolder(folder);
                });
                item.appendChild(badge);
            }

            item.addEventListener('click', () => {
                if (folder.imported) {
                    this._selectFolder(folder);
                } else {
                    this._importFolder(folder);
                }
            });

            list.appendChild(item);
        });
    },

    async _importFolder(folder) {
        StatusFeed.info(`Importing ${folder.name}...`);
        document.getElementById('grid-title').textContent = `Importing ${folder.name}...`;

        try {
            const result = await API.importFolder(folder.path);
            StatusFeed.success(`Imported ${result.imported} images from ${result.folder_name}`);

            // Reload folders to get updated state
            await this.loadFolders();

            // Select the newly imported folder
            const updated = this._folders.find(f => f.path === folder.path);
            if (updated) {
                this._selectFolder(updated);
            }
        } catch (err) {
            StatusFeed.error(`Import failed: ${err.message}`);
        }
    },

    async _selectFolder(folder) {
        if (!folder.imported) return;

        this._activeFolderId = folder.id;
        
        const gridTitleEl = document.getElementById('grid-title');
        gridTitleEl.innerHTML = ''; // Clear existing content

        const folderNameSpan = document.createElement('span');
        folderNameSpan.textContent = folder.name;
        gridTitleEl.appendChild(folderNameSpan);

        const modeIndicatorSpan = document.createElement('span');
        modeIndicatorSpan.id = 'grid-mode-indicator';
        gridTitleEl.appendChild(modeIndicatorSpan);

        // Add manual reviewed chip
        const manualReviewedChip = document.createElement('span');
        manualReviewedChip.className = 'manual-reviewed-chip';
        manualReviewedChip.title = 'Toggle manual review status for this folder';
        
        const updateChipStyle = (isChecked) => {
            manualReviewedChip.classList.toggle('checked', isChecked);
            manualReviewedChip.classList.toggle('unchecked', !isChecked);
            manualReviewedChip.textContent = isChecked ? 'Manually Reviewed' : 'awaiting manual review';
        };

        updateChipStyle(folder.manual_reviewed);

        manualReviewedChip.addEventListener('click', async (e) => {
            e.stopPropagation(); // Prevent folder click event if any
            const newStatus = !folder.manual_reviewed;
            try {
                await API.updateFolderManualReviewed(folder.id, newStatus);
                folder.manual_reviewed = newStatus; // Update local state
                
                // Also update Grid's state if this is the active folder
                if (Grid.currentFolderId === folder.id) {
                    Grid._currentFolderManualReviewed = newStatus;
                    Grid.render();
                    
                    // If Viewer is open, we need to refresh its current view too
                    if (Viewer.isOpen) {
                        Viewer._loadCurrent();
                    }
                }

                updateChipStyle(newStatus); // Update chip style immediately
                if (newStatus) {
                    StatusFeed.info(`Folder "${folder.name}" marked as manually reviewed.`);
                } else {
                    StatusFeed.info(`Folder "${folder.name}" unmarked as manually reviewed.`);
                }
            } catch (err) {
                StatusFeed.error(`Failed to update manual review status: ${err.message}`);
                // Revert chip state on error
                updateChipStyle(folder.manual_reviewed); 
            }
        });

        gridTitleEl.appendChild(manualReviewedChip);


        // Update active state in sidebar
        document.querySelectorAll('.folder-item').forEach((item, idx) => {
            item.classList.toggle('active', this._folders[idx].id === folder.id);
        });

        // Show unit toggle and sync to folder's setting
        const toggle = document.getElementById('unit-toggle');
        toggle.classList.remove('hidden');
        try {
            const data = await API.getFolder(folder.id);
            const unit = data.weight_unit || 'kg';
            const radio = document.querySelector(`input[name="weight-unit"][value="${unit}"]`);
            if (radio) radio.checked = true;
        } catch (_) {
            // default kg already checked
        }

        Grid.loadFolder(folder.id);
    },

    async startCulling() {
        const folder = this._folders.find(f => f.id === Grid.currentFolderId);
        if (folder && folder.manual_reviewed) {
            StatusFeed.warn('Cannot start culling: this folder has completed manual review.');
            return;
        }

        const selected = Grid.getSelectedImages();
        if (selected.length < 2) {
            StatusFeed.warn('Select at least 2 images to start culling');
            return;
        }
        await Culler.start(Grid.currentFolderId, selected);
    },

    async submitOcr() {
        if (Grid.isOcrProcessing) {
            StatusFeed.info('OCR is already running');
            return;
        }

        const marked = Grid.images.filter(i => i.status === 'marked_ocr');
        if (marked.length === 0) {
            StatusFeed.info('No images marked for OCR');
            return;
        }

        // Get first image URL for reference
        const refUrl = API.fullImageUrl(marked[0].id);

        // Fetch folder's saved ROI and manual_reviewed status
        let savedCells = [];
        let folderData;
        try {
            folderData = await API.getFolder(this._activeFolderId);
            if (folderData.ocr_roi) {
                savedCells = JSON.parse(folderData.ocr_roi);
            }
            if (folderData.manual_reviewed) {
                StatusFeed.warn('Read Only: This folder is protected.');
                return;
            }
        } catch (_) { /* ignore */ }

        // Open ROI overlay — actual OCR starts in the callback
        ROI.open(this._activeFolderId, refUrl, savedCells, async (cells) => {
            await this._runOcrBatch(marked);
        });
    },

    async _runOcrBatch(marked) {
        const total = marked.length;
        const progressEl = document.getElementById('ocr-progress');
        const labelEl = document.getElementById('ocr-progress-label');
        const fillEl = document.getElementById('ocr-progress-fill');

        // Unmark from marked_ocr → active, apply blue processing highlight
        const ids = marked.map(i => i.id);
        try {
            await API.bulkUpdateStatus(ids, 'active');
            marked.forEach(img => {
                img.status = 'active';
                Grid.updateImageInPlace(img.id, 'active');
            });
        } catch (_) { /* best effort */ }
        Grid.setOcrProcessing(ids);
        Grid.setMode('normal');

        // Show progress bar
        progressEl.classList.remove('hidden');
        fillEl.style.width = '0%';
        labelEl.textContent = `Processing 0/${total}...`;
        StatusFeed.success(`Starting OCR for ${total} image(s)...`);

        let doneCount = 0;
        let errorCount = 0;

        for (let i = 0; i < marked.length; i++) {
            const img = marked[i];
            labelEl.textContent = `Processing ${i + 1}/${total}...`;
            fillEl.style.width = `${((i) / total) * 100}%`;

            try {
                const result = await API.processOcrImage(img.id);

                // If file was renamed by OCR, update the image object
                if (result.renamed) {
                    img.filename = result.renamed;
                    img.filepath = img.filepath.replace(/[^/]+$/, result.renamed);
                    Grid.updateImageInPlace(img.id, img.status);
                }

                // Update grid badge immediately
                Grid.updateOcrBadge(img.id, result);

                // Log per-image result to status feed
                const tag = result.tag || '???';
                const sw = result.scale_weight != null ? result.scale_weight : '???';

                doneCount++;
                StatusFeed.info(`${img.filename}: ${tag} | scale=${sw}`);
            } catch (err) {
                errorCount++;
                StatusFeed.info(`${img.filename}: failed — ${err.message}`);
            }

            Grid.clearOcrProcessing(img.id);

            // Update fill after processing
            fillEl.style.width = `${((i + 1) / total) * 100}%`;
        }

        // Hide progress bar and show summary
        progressEl.classList.add('hidden');
        StatusFeed.success(
            `OCR complete: ${doneCount} done, ${errorCount} error(s)`
        );

        // Clear saved ROI so next batch starts fresh
        if (this._activeFolderId) {
            try {
                await API.setFolderROI(this._activeFolderId, []);
            } catch (_) { /* ignore */ }
        }
    },

    exportOcr() {
        if (!this._activeFolderId) return;
        // Trigger download by navigating to the export URL
        window.location.href = API.exportOcrUrl(this._activeFolderId);
    },

    async executeActions() {
        const folder = this._folders.find(f => f.id === Grid.currentFolderId);
        if (folder && folder.manual_reviewed) {
            StatusFeed.warn('Cannot execute deletions: this folder has completed manual review.');
            return;
        }

        const pending = Grid.images.filter(i => i.status === 'marked_delete');
        if (pending.length === 0) {
            StatusFeed.info('No pending deletions');
            return;
        }

        StatusFeed.warn(`Executing ${pending.length} deletion(s)...`);

        try {
            const result = await API.executeActions();
            StatusFeed.success(`Deleted ${result.deleted} image(s)`);

            if (result.errors && result.errors.length > 0) {
                result.errors.forEach(e => {
                    StatusFeed.error(`Error deleting ${e.filename}: ${e.error}`);
                });
            }

            // Reload grid, then update sidebar counts
            if (Grid.currentFolderId) {
                await Grid.loadFolder(Grid.currentFolderId);
            }
            await this.loadFolders(false);
        } catch (err) {
            StatusFeed.error(`Execution failed: ${err.message}`);
        }
    },
};

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
