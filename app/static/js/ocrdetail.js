/**
 * OCR Detail panel — shows OCR result properties for the focused image.
 * Lives in #ocr-detail above the status feed.
 */
const OcrDetail = {
    _el: null,
    _bodyEl: null,
    _currentImageId: null,
    _itemCodes: null, // New property to store item codes

    async init() { // Make init async to await fetch
        this._el = document.getElementById('ocr-detail');
        this._bodyEl = document.getElementById('ocr-detail-body');
        document.getElementById('ocr-detail-close').addEventListener('click', () => this.hide());

        try {
            const response = await fetch('/api/item_codes');
            this._itemCodes = await response.json();
        } catch (error) {
            console.error('Error fetching item codes:', error);
            // Handle error, maybe display a message to the user
            this._itemCodes = {}; // Initialize as empty object to prevent further errors
        }
    },

    hide() {
        this._el.classList.add('hidden');
        this._currentImageId = null;
    },

    /**
     * Show OCR result for given image. Fetches from API if not in Grid cache.
     */
    async show(imageId) {
        if (!imageId) { this.hide(); return; }

        // Check grid's cached OCR results first
        let ocr = Grid._ocrResults[imageId];

        if (!ocr) {
            // Try fetching from API
            try {
                ocr = await API.getOcrResult(imageId);
            } catch {
                this.hide();
                return;
            }
        }

        if (!ocr) { this.hide(); return; }

        this._currentImageId = imageId;
        this._render(ocr);
        this._el.classList.remove('hidden');
    },

    _render(ocr) {
        const filename = ocr.filename || `Image #${ocr.image_id}`;

        let html = `<div class="ocr-detail-filename" title="${filename}">${filename}</div>`;
        html += '<hr class="ocr-detail-divider">';

        const isReadonly = Grid._currentFolderManualReviewed;

        // Tag
        html += this._prop('tag', ocr.tag || 'not found', '');

        // Item (new dropdown)
        html += this._itemProp('item', ocr.item || '', isReadonly);

        // Scale weight
        const swVal = ocr.scale_weight != null ? ocr.scale_weight : null;
        html += this._prop('scale_weight', swVal != null ? swVal : 'not found', '');

        // Processed at
        if (ocr.processed_at) {
            html += '<hr class="ocr-detail-divider">';
            const t = new Date(ocr.processed_at).toLocaleString();
            html += this._prop('processed', t, '');
        }

        this._bodyEl.innerHTML = html;

        // Setup the custom item dropdown
        this._setupItemDropdown();
    },

    _prop(label, value, valueCls) {
        return `<div class="ocr-prop"><span class="ocr-prop-label">${label}</span><span class="ocr-prop-value ${valueCls}" title="${value}">${value}</span></div>`;
    },

    _itemProp(label, selectedValue, isReadonly) {
        let displayValue = '-';
        if (selectedValue) { // Only try to find description if selectedValue is not falsy
            if (this._itemCodes && this._itemCodes[selectedValue]) {
                displayValue = `${selectedValue} - ${this._itemCodes[selectedValue]}`;
            } else {
                displayValue = selectedValue;
            }
        }

        const readonlyClass = isReadonly ? 'grid-readonly' : '';
        const disabledAttr = isReadonly ? 'readonly disabled' : '';

        return `
            <div class="ocr-prop">
                <span class="ocr-prop-label">${label}</span>
                <div class="ocr-item-container ${readonlyClass}">
                    <input type="text" class="ocr-item-input" 
                           value="${displayValue}" 
                           ${disabledAttr}
                           data-code="${selectedValue || ''}"
                           autocomplete="off">
                    ${isReadonly ? '' : '<div class="ocr-item-dropdown hidden"></div>'}
                </div>
            </div>
        `;
    },

    _setupItemDropdown() {
        const container = this._bodyEl.querySelector('.ocr-item-container');
        if (!container || container.classList.contains('grid-readonly')) return;

        const input = container.querySelector('.ocr-item-input');
        const dropdown = container.querySelector('.ocr-item-dropdown');

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

        const show = () => {
            dropdown.classList.remove('hidden');
            populate(input.value); // Initial populate based on current text (or empty)
        };

        const hide = () => {
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
        };

        const selectOption = async (code, text) => {
            input.value = text;
            input.dataset.code = code;
            dropdown.classList.add('hidden');

            const imageId = this._currentImageId;
            if (imageId) {
                try {
                    await API.updateOcrResult(imageId, { item: code });
                    if (Grid._ocrResults[imageId]) {
                        Grid._ocrResults[imageId].item = code;
                    }
                } catch (error) {
                    console.error('Error updating item code:', error);
                }
            }
        };

        // Event listeners
        input.addEventListener('focus', () => {
            // If the input has a value that matches a code, we might want to show all options instead of filtering by the current full value
            // But standard behavior is to filter. Let's just filter.
            // If the user wants to see all, they clear the text.
            // Actually, if a value is selected "514 - ...", searching for that is useless.
            // Better UX: select all text on focus so typing replaces it?
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
            } else if (e.key === 'Enter') {
                const firstOption = dropdown.querySelector('.ocr-item-option[data-code]');
                if (firstOption) {
                    selectOption(firstOption.dataset.code, firstOption.textContent);
                    input.blur();
                }
            }
        });

        input.addEventListener('blur', hide);

        // Handle selection
        dropdown.addEventListener('mousedown', async (e) => {
            // Use mousedown to fire before blur
            const option = e.target.closest('.ocr-item-option');
            if (!option || !option.dataset.code) return;

            selectOption(option.dataset.code, option.textContent);
        });
    },
};
