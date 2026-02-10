/**
 * Side-by-side culling tool.
 */
const Culler = {
    _overlay: null,
    _pickImg: null,
    _candidateImg: null,
    _candidateCounter: null,
    _sessionId: null,
    _images: [],        // Full image objects
    _pickedId: null,
    _candidateIndex: 1, // Index into _images for current candidate
    _isOpen: false,
    _removedIds: new Set(),

    init() {
        this._overlay = document.getElementById('culler-overlay');
        this._pickImg = document.getElementById('culler-pick-img');
        this._candidateImg = document.getElementById('culler-candidate-img');
        this._candidateCounter = document.getElementById('culler-candidate-counter');

        document.getElementById('btn-finalize').addEventListener('click', () => this.finalize());
        document.getElementById('btn-exit-cull').addEventListener('click', () => this.close());
    },

    get isOpen() { return this._isOpen; },

    async start(folderId, selectedImages) {
        if (selectedImages.length < 2) {
            StatusFeed.error('Need at least 2 images to cull');
            return;
        }

        try {
            const imageIds = selectedImages.map(img => img.id);
            const session = await API.startCulling(folderId, imageIds);
            this._sessionId = session.id;
            this._images = selectedImages;
            this._pickedId = selectedImages[0].id;
            this._candidateIndex = 1;
            this._removedIds = new Set();
            this._isOpen = true;
            this._overlay.classList.remove('hidden');
            this._render();

            StatusFeed.info(`Culling session started with ${selectedImages.length} images`);
        } catch (err) {
            StatusFeed.error(`Failed to start culling: ${err.message}`);
        }
    },

    close() {
        this._isOpen = false;
        this._overlay.classList.add('hidden');
        StatusFeed.info('Culling session closed');
    },

    _getActiveCandidates() {
        return this._images.filter(img => img.id !== this._pickedId && !this._removedIds.has(img.id));
    },

    _getAllCandidates() {
        return this._images.filter(img => img.id !== this._pickedId);
    },

    _render() {
        // Pick image
        this._pickImg.src = API.fullImageUrl(this._pickedId);

        // Candidate
        const candidates = this._getAllCandidates();
        if (candidates.length === 0) {
            this._candidateImg.src = '';
            this._candidateCounter.textContent = '(none remaining)';
            return;
        }

        // Clamp candidate index
        if (this._candidateIndex >= candidates.length) {
            this._candidateIndex = 0;
        }
        if (this._candidateIndex < 0) {
            this._candidateIndex = candidates.length - 1;
        }

        const candidate = candidates[this._candidateIndex];
        this._candidateImg.src = API.fullImageUrl(candidate.id);

        const isMarked = this._removedIds.has(candidate.id);
        const active = this._getActiveCandidates().length;
        this._candidateCounter.textContent = `(${this._candidateIndex + 1}/${candidates.length}, ${active} active)`;

        // Visual indicator for marked candidates
        const pane = document.getElementById('culler-candidate');
        if (isMarked) {
            pane.style.opacity = '0.4';
        } else {
            pane.style.opacity = '1';
        }
    },

    nextCandidate() {
        const candidates = this._getAllCandidates();
        if (candidates.length === 0) return;
        this._candidateIndex = (this._candidateIndex + 1) % candidates.length;
        this._render();
    },

    prevCandidate() {
        const candidates = this._getAllCandidates();
        if (candidates.length === 0) return;
        this._candidateIndex = (this._candidateIndex - 1 + candidates.length) % candidates.length;
        this._render();
    },

    async pickCandidate() {
        const candidates = this._getActiveCandidates();
        if (candidates.length === 0) return;

        const candidate = candidates[this._candidateIndex];

        try {
            await API.pickCullingImage(this._sessionId, candidate.id);
            this._pickedId = candidate.id;
            this._candidateIndex = 0;
            this._render();
            StatusFeed.success(`Picked ${candidate.filename}`);
        } catch (err) {
            StatusFeed.error(`Failed to pick: ${err.message}`);
        }
    },

    async toggleCandidateDeletion() {
        const candidates = this._getAllCandidates();
        if (candidates.length === 0) return;

        const candidate = candidates[this._candidateIndex];
        const isMarked = this._removedIds.has(candidate.id);

        try {
            const newStatus = isMarked ? 'active' : 'marked_delete';
            await API.updateImageStatus(candidate.id, newStatus);

            if (isMarked) {
                this._removedIds.delete(candidate.id);
                StatusFeed.info(`Unmarked ${candidate.filename}`);
            } else {
                this._removedIds.add(candidate.id);
                StatusFeed.warn(`Marked ${candidate.filename} for deletion`);
            }
            Grid.updateImageInPlace(candidate.id, newStatus);
            this._render();
        } catch (err) {
            StatusFeed.error(`Failed: ${err.message}`);
        }
    },

    async finalize() {
        if (!this._sessionId) return;

        try {
            const result = await API.finalizeCulling(this._sessionId);
            StatusFeed.success(`Culling finalized: kept pick, marked ${result.marked_for_deletion} for deletion`);

            // Update local image states
            this._images.forEach(img => {
                if (img.id !== this._pickedId) {
                    img.status = 'marked_delete';
                    Grid.updateImageInPlace(img.id, 'marked_delete');
                }
            });

            this.close();

            // Refresh grid
            if (Grid.currentFolderId) {
                Grid.loadFolder(Grid.currentFolderId);
            }
        } catch (err) {
            StatusFeed.error(`Finalize failed: ${err.message}`);
        }
    },
};
