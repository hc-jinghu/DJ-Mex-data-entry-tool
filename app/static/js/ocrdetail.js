/**
 * OCR Detail panel — shows OCR result properties for the focused image.
 * Lives in #ocr-detail above the status feed.
 */
const OcrDetail = {
    _el: null,
    _bodyEl: null,
    _currentImageId: null,
    _itemCodes: null,

    async init() {
        this._el = document.getElementById('ocr-detail');
        this._bodyEl = document.getElementById('ocr-detail-body');
        document.getElementById('ocr-detail-close').addEventListener('click', () => this.hide());

        try {
            const response = await fetch('/api/item_codes');
            this._itemCodes = await response.json();
        } catch (error) {
            console.error('Error fetching item codes:', error);
            this._itemCodes = {};
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
        if (ocr.original_filename && ocr.original_filename !== filename.replace(/\.[^.]+$/, '')) {
            html += `<div class="ocr-detail-filename" style="color:var(--text-muted);font-size:11px;" title="Original: ${ocr.original_filename}">${ocr.original_filename}</div>`;
        }
        html += '<hr class="ocr-detail-divider">';

        // Skip tag/item/scale_weight if image hasn't been OCR'd yet
        if (ocr.status === 'pending') {
            this._bodyEl.innerHTML = html;
            return;
        }

        // Tag
        html += this._prop('tag', ocr.tag || '-', '');

        // Item — read-only, resolve code to description
        let itemDisplay = '-';
        if (ocr.item) {
            if (this._itemCodes && this._itemCodes[ocr.item]) {
                itemDisplay = `${ocr.item} - ${this._itemCodes[ocr.item]}`;
            } else {
                itemDisplay = ocr.item;
            }
        }
        html += this._prop('item', itemDisplay, '');

        // Scale weight
        const swVal = ocr.scale_weight != null ? ocr.scale_weight : null;
        html += this._prop('scale_weight', swVal != null ? swVal : '-', '');

        // Processed at
        if (ocr.processed_at) {
            html += '<hr class="ocr-detail-divider">';
            const t = new Date(ocr.processed_at).toLocaleString();
            html += this._prop('processed', t, '');
        }

        this._bodyEl.innerHTML = html;
    },

    _prop(label, value, valueCls) {
        return `<div class="ocr-prop"><span class="ocr-prop-label">${label}</span><span class="ocr-prop-value ${valueCls}" title="${value}">${value}</span></div>`;
    },
};
