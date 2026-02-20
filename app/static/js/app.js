/**
 * App initialization, router, and state management.
 */
const App = {
    _folders: [],
    _groups: [],
    _expandedGroups: new Set(),
    _activeFolderId: null,
    _importingPaths: new Set(),
    _currentRole: 'viewer',
    _eventSource: null,

    async init() {
        StatusFeed.init();
        Grid.init();
        OcrDetail.init();
        Viewer.init();
        Culler.init();
        Shortcuts.init();

        ROI.init();
        Settings.init();
        StatusFeed.info('Master Photo Library starting...');

        // Wire up login overlay (still used by settings Role section)
        document.getElementById('login-password').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this._handleLogin();
        });

        // Check existing session
        try {
            const sess = await API.getSession();
            this._currentRole = sess.role || 'viewer';
        } catch (_) {
            this._currentRole = 'viewer';
        }

        document.getElementById('btn-collapse-all').addEventListener('click', () => this.collapseAll());

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

        // Apply role restrictions before loading folders
        this.applyRoleRestrictions();

        // Load folders
        await this.loadFolders();

        // Start watching IMAGE_ROOT for new folders (e.g. synced from Google Drive)
        this._startFolderWatch();

        StatusFeed.success('Ready');
    },

    _startFolderWatch() {
        if (this._eventSource) this._eventSource.close();
        this._serverVersionId = null;

        this._eventSource = new EventSource('/api/events');

        this._eventSource.addEventListener('server_version', (e) => {
            const { id } = JSON.parse(e.data);
            if (this._serverVersionId === null) {
                this._serverVersionId = id;  // first connect — record baseline
            } else if (this._serverVersionId !== id) {
                this._serverVersionId = id;
                StatusFeed.warn('App updated — please refresh the page (⌘R / F5)');
            }
        });

        this._eventSource.addEventListener('root_changed', async () => {
            if (this._importingPaths.size > 0 || Grid.isOcrProcessing) return;
            const prevCount = this._folders.length;
            await this.loadFolders(false);
            if (this._folders.length > prevCount) {
                StatusFeed.info('New content detected — syncing folders…');
            }
        });

        this._eventSource.addEventListener('folder_changed', async (e) => {
            if (this._importingPaths.size > 0 || Grid.isOcrProcessing) return;
            const { path } = JSON.parse(e.data);
            // Refresh image list if the active folder changed on disk
            const activeFolder = this._folders.find(f => f.id === this._activeFolderId);
            if (activeFolder && activeFolder.path === path) {
                await Grid.loadFolder(this._activeFolderId);
            }
        });

        this._eventSource.addEventListener('folder_ocr_updated', async (e) => {
            const { folder_id } = JSON.parse(e.data);
            if (folder_id !== this._activeFolderId) return;

            // Re-fetch all OCR results for this folder, refresh badges + summary
            await Grid.loadOcrResults();
            StatusFeed.info('Warehouse updated tare weights — refreshed');

            // If viewer is open, rebuild its panel so the new tare_weight shows
            // (rebuilding naturally removes focus from any previously focused field)
            if (Viewer.isOpen && Viewer.currentImage) {
                Viewer._loadOcrPanel(Viewer.currentImage.id);
            }
            if (OcrDetail._currentImageId) {
                OcrDetail.show(OcrDetail._currentImageId);
            }
        });

        this._eventSource.onerror = () => {
            // EventSource auto-reconnects after a backoff delay — no manual retry needed
        };
    },

    async loadFolders(autoSelect = true) {
        try {
            const data = await API.getFolders();
            this._folders = data.folders || data;
            this._groups = data.groups || [];
            this._renderFolderList();

            // Only auto-select if no folder is currently active
            if (autoSelect && !this._activeFolderId) {
                const imported = this._folders.find(f => f.imported);
                if (imported) {
                    this._selectFolder(imported);
                }
            }

            // Auto-import unimported folders in the background
            const unimported = this._folders.filter(f => !f.imported && !this._importingPaths.has(f.path));
            if (unimported.length > 0) {
                this._backgroundImport(unimported);
            }
        } catch (err) {
            StatusFeed.error(`Failed to load folders: ${err.message}`);
        }
    },

    collapseAll() {
        this._expandedGroups.clear();
        this._renderFolderList();
    },

    async _backgroundImport(folders) {
        for (const folder of folders) {
            if (this._importingPaths.has(folder.path)) continue;
            this._importingPaths.add(folder.path);
            this._renderFolderList();
            StatusFeed.info(`Importing ${folder.name}...`);

            try {
                const result = await API.importFolder(folder.path);
                this._importingPaths.delete(folder.path);

                // Update the folder entry in-place
                folder.imported = true;
                folder.id = result.folder_id;
                folder.image_count = result.total;
                StatusFeed.success(`Imported ${folder.name} (${result.total} images)`);
            } catch (err) {
                this._importingPaths.delete(folder.path);
                StatusFeed.error(`Import failed for ${folder.name}: ${err.message}`);
            }

            this._renderFolderList();

            // If user is viewing this folder, load it now
            if (this._activeFolderId === folder.path) {
                this._activeFolderId = folder.id;
                this._selectFolder(folder);
            }
        }
    },

    /** macOS stores "/" in filenames as ":" on disk; reverse it for display. */
    _displayName(name) {
        return name ? name.replaceAll(':', '/') : name;
    },

    /**
     * Parse a folder name as a date for sorting.
     * Handles "M D", "M:D", "M D YY", "M D YYYY" (macOS stores "/" as ":").
     * Returns a timestamp, or null if not parseable as a date.
     */
    _parseFolderDate(name) {
        if (!name) return null;
        const parts = name.replace(/[:\/]/g, ' ').trim().split(/\s+/).map(Number);
        if (parts.length < 2 || parts.some(isNaN)) return null;
        const [month, day] = parts;
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        const year = parts[2]
            ? (parts[2] < 100 ? 2000 + parts[2] : parts[2])
            : new Date().getFullYear();
        return new Date(year, month - 1, day).getTime();
    },

    /** Sort an array of objects by folder name parsed as date, fallback to locale string sort. */
    _sortByDate(items, nameKey = 'name') {
        return [...items].sort((a, b) => {
            const da = this._parseFolderDate(a[nameKey]);
            const db = this._parseFolderDate(b[nameKey]);
            if (da !== null && db !== null) return da - db;
            if (da !== null) return -1;
            if (db !== null) return 1;
            return (a[nameKey] || '').localeCompare(b[nameKey] || '');
        });
    },

    _renderFolderItem(folder) {
        const item = document.createElement('div');
        item.className = 'folder-item';
        if ((folder.id && folder.id === this._activeFolderId) || folder.path === this._activeFolderId) {
            item.classList.add('active');
        }

        const name = document.createElement('span');
        name.className = 'folder-name';
        name.textContent = this._displayName(folder.name);

        const count = document.createElement('span');
        count.className = 'folder-count';
        count.textContent = folder.image_count;

        item.appendChild(name);
        item.appendChild(count);

        if (this._importingPaths.has(folder.path)) {
            const badge = document.createElement('span');
            badge.className = 'folder-badge badge-importing';
            badge.textContent = 'Importing';
            item.appendChild(badge);
        } else if (folder.manual_reviewed) {
            const badge = document.createElement('span');
            badge.className = 'folder-badge badge-readonly';
            badge.textContent = 'Read Only';
            item.appendChild(badge);
        }

        item.addEventListener('click', () => {
            if (this._importingPaths.has(folder.path)) {
                this._showImportingMessage(folder);
            } else if (folder.imported) {
                this._selectFolder(folder);
            } else {
                this._importFolder(folder);
            }
        });

        return item;
    },

    _renderFolderList() {
        const list = document.getElementById('folder-list');
        list.innerHTML = '';

        // Separate flat folders from grouped ones
        const flatFolders = this._sortByDate(this._folders.filter(f => !f.parent));
        const groupedByParent = {};
        this._folders.forEach(f => {
            if (f.parent) {
                if (!groupedByParent[f.parent]) groupedByParent[f.parent] = [];
                groupedByParent[f.parent].push(f);
            }
        });

        // Render flat folders first
        flatFolders.forEach(folder => {
            list.appendChild(this._renderFolderItem(folder));
        });

        // Render groups (sorted by date)
        this._sortByDate(this._groups).forEach(group => {
            const children = this._sortByDate(groupedByParent[group.name] || []);
            if (children.length === 0) return;

            const isExpanded = this._expandedGroups.has(group.name);
            const totalImages = children.reduce((sum, f) => sum + (f.image_count || 0), 0);
            const metaText = `${children.length} folders \u00B7 ${totalImages} imgs`;

            const wrapper = document.createElement('div');
            wrapper.className = 'folder-group';

            // Group header row
            const header = document.createElement('div');
            header.className = 'folder-group-header';
            header.addEventListener('click', () => {
                if (this._expandedGroups.has(group.name)) {
                    this._expandedGroups.delete(group.name);
                } else {
                    this._expandedGroups.add(group.name);
                }
                this._renderFolderList();
            });

            const arrow = document.createElement('span');
            arrow.className = 'toggle-arrow' + (isExpanded ? ' expanded' : '');

            const headerName = document.createElement('span');
            headerName.className = 'folder-name';
            headerName.textContent = this._displayName(group.name);

            header.appendChild(arrow);
            header.appendChild(headerName);
            wrapper.appendChild(header);

            // Expanded: per-child thread segments with curl on last
            if (isExpanded) {
                const childContainer = document.createElement('div');
                childContainer.className = 'folder-group-children';

                const collapseThread = (e) => {
                    e.stopPropagation();
                    this._expandedGroups.delete(group.name);
                    this._renderFolderList();
                };

                children.forEach((folder, idx) => {
                    const row = document.createElement('div');
                    row.className = 'thread-row';

                    const seg = document.createElement('div');
                    const isLast = idx === children.length - 1;
                    seg.className = 'thread-seg' + (isLast ? ' thread-seg-last' : '');
                    seg.title = 'Collapse';
                    seg.addEventListener('click', collapseThread);

                    const item = this._renderFolderItem(folder);
                    item.classList.add('thread-child-item');

                    row.appendChild(seg);
                    row.appendChild(item);
                    childContainer.appendChild(row);
                });

                wrapper.appendChild(childContainer);
            } else {
                // Collapsed: show count as expand indicator
                const collapsed = document.createElement('div');
                collapsed.className = 'folder-group-collapsed';
                collapsed.textContent = metaText;
                collapsed.addEventListener('click', () => {
                    this._expandedGroups.add(group.name);
                    this._renderFolderList();
                });
                wrapper.appendChild(collapsed);
            }

            list.appendChild(wrapper);
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

    _showImportingMessage(folder) {
        this._activeFolderId = folder.path; // temporary key until import finishes
        const gridTitleEl = document.getElementById('grid-title');
        gridTitleEl.innerHTML = '';
        gridTitleEl.textContent = folder.name;

        const grid = document.getElementById('thumbnail-grid');
        grid.innerHTML = '<div id="sync-loading-message"><span>Import in progress...</span></div>';

        // Hide buttons that don't apply
        document.getElementById('btn-export').style.display = 'none';
        document.getElementById('unit-toggle').classList.add('hidden');

        // Re-render sidebar to update active state
        this._renderFolderList();
    },

    async _selectFolder(folder) {
        if (!folder.imported) return;

        this._activeFolderId = folder.id;
        
        const gridTitleEl = document.getElementById('grid-title');
        gridTitleEl.innerHTML = ''; // Clear existing content

        const folderNameSpan = document.createElement('span');
        folderNameSpan.textContent = this._displayName(folder.name);
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

        // Hide manual-reviewed chip for non-data_entry roles
        if (this._currentRole !== 'data_entry') {
            manualReviewedChip.style.display = 'none';
        }

        manualReviewedChip.addEventListener('click', async (e) => {
            e.stopPropagation(); // Prevent folder click event if any
            const newStatus = !folder.manual_reviewed;
            try {
                await API.updateFolderManualReviewed(folder.id, newStatus);
                folder.manual_reviewed = newStatus; // Update closure's reference
                // Also sync the live _folders entry — it may be a different object
                // if loadFolders() refreshed the list since _selectFolder was called
                const liveEntry = this._folders.find(f => f.id === folder.id);
                if (liveEntry) liveEntry.manual_reviewed = newStatus;

                // Also update Grid's state if this is the active folder
                if (Grid.currentFolderId === folder.id) {
                    Grid._currentFolderManualReviewed = newStatus;
                    Grid.render();

                    // Show export button when manual_reviewed is on and there are tagged results
                    const hasTagged = Object.values(Grid._ocrResults).some(r => r.tag);
                    document.getElementById('btn-export').style.display =
                        (newStatus && hasTagged) ? '' : 'none';

                    // If Viewer is open, we need to refresh its current view too
                    if (Viewer.isOpen) {
                        Viewer._loadCurrent();
                    }
                }

                updateChipStyle(newStatus);
                this.updateFolderSummary();
                this._renderFolderList(); // Update sidebar badge
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

        // Re-render sidebar to update active state
        this._renderFolderList();

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

        // Check manual_reviewed status
        try {
            const folderData = await API.getFolder(this._activeFolderId);
            if (folderData.manual_reviewed) {
                StatusFeed.warn('Read Only: This folder is protected.');
                return;
            }
        } catch (_) { /* ignore */ }

        // Open ROI overlay to select tag region, then run OCR
        const folderId = this._activeFolderId;
        const firstImg = marked[0];
        const imageUrl = API.fullImageUrl(firstImg.id);

        // Load saved ROI from folder
        let savedCells = null;
        try {
            const folderData = await API.getFolder(folderId);
            if (folderData.ocr_roi) {
                savedCells = typeof folderData.ocr_roi === 'string'
                    ? JSON.parse(folderData.ocr_roi)
                    : folderData.ocr_roi;
            }
        } catch (_) { /* ignore */ }

        ROI.open(folderId, imageUrl, savedCells, async (cells) => {
            // Save ROI to folder
            if (cells && cells.length > 0) {
                try {
                    await API.setFolderROI(folderId, cells);
                } catch (_) { /* ignore */ }
            }
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
                const pipe = result.pipeline;
                const pipeTag = pipe ? pipe.tag : '?';
                const pipeScale = pipe ? pipe.scale : '?';
                const pipeStr = `[tag:${pipeTag} scale:${pipeScale}]`;

                doneCount++;
                StatusFeed.info(`${img.filename}: ${tag} | scale=${sw} ${pipeStr}`);
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

        // Refresh folder summary after OCR batch completes
        this.updateFolderSummary();
    },

    exportOcr() {
        if (!this._activeFolderId) return;
        // Trigger download by navigating to the export URL
        window.location.href = API.exportOcrUrl(this._activeFolderId);
    },

    updateFolderSummary() {
        const panel = document.getElementById('folder-summary');
        if (!panel) return;
        const folder = this._folders.find(f => f.id === this._activeFolderId);
        if (!folder || !folder.manual_reviewed) {
            panel.classList.add('hidden');
            return;
        }
        const results = Object.values(Grid._ocrResults);
        if (results.length === 0) {
            panel.classList.add('hidden');
            return;
        }

        let pallets = 0;
        let totalGross = 0;
        let totalTare = 0;
        const tagPattern = /^[A-Za-z]{3}\d{3}$/;

        results.forEach(r => {
            if (r.tag && tagPattern.test(r.tag)) pallets++;
            if (r.scale_weight != null && r.scale_weight !== '') {
                const w = parseFloat(r.scale_weight);
                if (!isNaN(w)) totalGross += w;
            }
            if (r.tare_weight != null && r.tare_weight !== '') {
                const w = parseFloat(r.tare_weight);
                if (!isNaN(w)) totalTare += w;
            }
        });

        document.getElementById('summary-pallets').textContent = pallets;
        document.getElementById('summary-gross').textContent = totalGross.toFixed(2);
        document.getElementById('summary-tare').textContent = totalTare.toFixed(2);
        document.getElementById('summary-net').textContent = (totalGross - totalTare).toFixed(2);
        panel.classList.remove('hidden');
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

    // ── Auth & Role Management ──────────────────────────────────

    get currentRole() { return this._currentRole; },

    _showLoginOverlay() {
        document.getElementById('login-overlay').classList.remove('hidden');
        document.getElementById('login-error').classList.add('hidden');
        document.getElementById('login-username').value = '';
        document.getElementById('login-password').value = '';
        document.getElementById('login-username').focus();
    },

    _closeLoginOverlay() {
        document.getElementById('login-overlay').classList.add('hidden');
    },

    async _handleLogin() {
        const role = document.getElementById('login-role').value;
        const username = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;
        const errorEl = document.getElementById('login-error');

        try {
            await API.login(role, username, password);
            this._currentRole = role;
            this._closeLoginOverlay();
            this.applyRoleRestrictions();
            // Reload folders (viewer filter may change)
            this._activeFolderId = null;
            await this.loadFolders();
            StatusFeed.success(`Logged in as ${role}`);
        } catch (err) {
            errorEl.textContent = err.message;
            errorEl.classList.remove('hidden');
        }
    },

    async handleLogout() {
        try {
            await API.logout();
        } catch (_) { /* ignore */ }
        this._currentRole = 'viewer';
        this.applyRoleRestrictions();
        this._activeFolderId = null;
        await this.loadFolders();
        StatusFeed.info('Logged out');
    },

    applyRoleRestrictions() {
        const role = this._currentRole;

        // Right panel (activity feed): hidden for viewer
        const rightPanel = document.getElementById('right-panel');
        rightPanel.style.display = role === 'viewer' ? 'none' : '';

        // Grid actions bar: hidden for viewer
        const gridActions = document.getElementById('grid-actions');
        gridActions.style.display = role === 'viewer' ? 'none' : '';

        // Unit toggle: hidden for viewer and warehouse
        const unitToggle = document.getElementById('unit-toggle');
        if (role === 'viewer' || role === 'warehouse') {
            unitToggle.classList.add('hidden');
        }
    },
};

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
