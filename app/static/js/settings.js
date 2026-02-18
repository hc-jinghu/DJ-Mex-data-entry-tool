/**
 * Settings panel — gear icon in left panel opens a modal overlay
 * for managing item codes and other configuration.
 */
const Settings = {
    get isOpen() {
        return !document.getElementById('settings-overlay').classList.contains('hidden');
    },

    init() {
        document.getElementById('btn-settings').addEventListener('click', () => this.open());
        document.getElementById('settings-close').addEventListener('click', () => this.close());
        document.getElementById('settings-overlay').addEventListener('click', (e) => {
            if (e.target.id === 'settings-overlay') this.close();
        });
        document.getElementById('settings-add-btn').addEventListener('click', () => this._addItemCode());
        document.getElementById('settings-code-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('settings-desc-input').focus();
        });
        document.getElementById('settings-desc-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this._addItemCode();
        });

        document.getElementById('settings-path-save-btn').addEventListener('click', () => this._saveLibraryPath());
        document.getElementById('settings-path-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this._saveLibraryPath();
        });

        // Nav item switching
        document.querySelectorAll('.settings-nav-item').forEach(item => {
            item.addEventListener('click', () => this._switchSection(item.dataset.section));
        });
    },

    _switchSection(section) {
        // Update nav active state
        document.querySelectorAll('.settings-nav-item').forEach(el => {
            el.classList.toggle('active', el.dataset.section === section);
        });
        // Show matching section, hide others
        document.querySelectorAll('.settings-section').forEach(el => {
            el.style.display = el.id === `settings-section-${section}` ? '' : 'none';
        });
    },

    open() {
        document.getElementById('settings-overlay').classList.remove('hidden');
        this._loadItemCodes();
        this._loadLibraryPath();
        document.getElementById('settings-code-input').focus();
    },

    close() {
        document.getElementById('settings-overlay').classList.add('hidden');
    },

    async _loadItemCodes() {
        const list = document.getElementById('settings-item-list');
        list.innerHTML = '<div class="settings-loading">Loading...</div>';

        try {
            const codes = await API.getItemCodes();
            const entries = Object.entries(codes || {});
            if (entries.length === 0) {
                list.innerHTML = '<div class="settings-empty">No item codes yet</div>';
                return;
            }
            list.innerHTML = '';
            entries.forEach(([code, description]) => {
                const row = document.createElement('div');
                row.className = 'settings-item-row';
                row.innerHTML = `<span class="settings-item-code">${code}</span><span class="settings-item-desc">${description}</span>`;
                list.appendChild(row);
            });
        } catch (err) {
            list.innerHTML = `<div class="settings-empty">Failed to load: ${err.message}</div>`;
        }
    },

    async _loadLibraryPath() {
        const input = document.getElementById('settings-path-input');
        const status = document.getElementById('settings-path-status');
        try {
            const settings = await API.getSettings();
            input.value = settings.image_root || '';
            status.textContent = '';
        } catch (err) {
            status.textContent = `Failed to load: ${err.message}`;
        }
    },

    async _saveLibraryPath() {
        const input = document.getElementById('settings-path-input');
        const status = document.getElementById('settings-path-status');
        const path = input.value.trim();
        if (!path) {
            status.textContent = 'Path cannot be empty.';
            return;
        }
        status.textContent = 'Saving…';
        try {
            const result = await API.updateSettings({ image_root: path });
            input.value = result.image_root;
            status.textContent = `Saved.`;
            StatusFeed.success('Library path updated — refresh the folder list to see changes');
        } catch (err) {
            status.textContent = err.message;
            StatusFeed.error(`Failed to save path: ${err.message}`);
        }
    },

    async _addItemCode() {
        const codeInput = document.getElementById('settings-code-input');
        const descInput = document.getElementById('settings-desc-input');
        const code = codeInput.value.trim();
        const description = descInput.value.trim();

        if (!code || !description) {
            StatusFeed.warn('Both code and description are required');
            return;
        }

        try {
            await API.addItemCode(code, description);
            codeInput.value = '';
            descInput.value = '';
            codeInput.focus();
            this._loadItemCodes();
            StatusFeed.success(`Item code ${code} added`);
        } catch (err) {
            StatusFeed.error(`Failed to add item code: ${err.message}`);
        }
    },
};
