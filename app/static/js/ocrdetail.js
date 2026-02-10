/**
 * OCR Detail panel — shows OCR result properties for the focused image.
 * Lives in #ocr-detail above the status feed.
 */
const OcrDetail = {
    _el: null,
    _bodyEl: null,
    _currentImageId: null,

    init() {
        this._el = document.getElementById('ocr-detail');
        this._bodyEl = document.getElementById('ocr-detail-body');
        document.getElementById('ocr-detail-close').addEventListener('click', () => this.hide());
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

        // Tag
        html += this._prop('tag', ocr.tag || 'not found', '');

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
    },

    _prop(label, value, valueCls) {
        return `<div class="ocr-prop"><span class="ocr-prop-label">${label}</span><span class="ocr-prop-value ${valueCls}" title="${value}">${value}</span></div>`;
    },
};
