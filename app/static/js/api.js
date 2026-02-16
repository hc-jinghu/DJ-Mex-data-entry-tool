/**
 * API client — fetch wrapper for all backend calls.
 */
const API = {
    async _fetch(url, options = {}) {
        const res = await fetch(url, {
            headers: { 'Content-Type': 'application/json' },
            ...options,
        });
        let data;
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            data = await res.json();
        } else {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text.substring(0, 200)}`);
        }
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
    },

    // Folders
    getFolders() {
        return this._fetch('/api/folders');
    },

    importFolder(path) {
        return this._fetch('/api/folders/import', {
            method: 'POST',
            body: JSON.stringify({ path }),
        });
    },

    getFolder(id) {
        return this._fetch(`/api/folders/${id}`);
    },

    updateFolderManualReviewed(folderId, manualReviewed) {
        return this._fetch(`/api/folders/${folderId}/manual-reviewed`, {
            method: 'PUT',
            body: JSON.stringify({ manual_reviewed: manualReviewed }),
        });
    },

    // Images
    getImages(folderId, status = 'all') {
        return this._fetch(`/api/folders/${folderId}/images?status=${status}`);
    },

    getImage(id) {
        return this._fetch(`/api/images/${id}`);
    },

    thumbnailUrl(id) {
        return `/api/images/${id}/thumbnail`;
    },

    fullImageUrl(id) {
        return `/api/images/${id}/full`;
    },

    rotateImage(id) {
        return this._fetch(`/api/images/${id}/rotate`, { method: 'POST' });
    },

    renameImage(id, filename) {
        return this._fetch(`/api/images/${id}/rename`, {
            method: 'PUT',
            body: JSON.stringify({ filename }),
        });
    },

    updateImageStatus(id, status) {
        return this._fetch(`/api/images/${id}/status`, {
            method: 'PUT',
            body: JSON.stringify({ status }),
        });
    },

    bulkUpdateStatus(imageIds, status) {
        return this._fetch('/api/images/bulk-status', {
            method: 'POST',
            body: JSON.stringify({ image_ids: imageIds, status }),
        });
    },

    // Actions
    getPendingActions() {
        return this._fetch('/api/actions/pending');
    },

    executeActions() {
        return this._fetch('/api/actions/execute', { method: 'POST' });
    },

    // Culling
    startCulling(folderId, imageIds) {
        return this._fetch('/api/culling/start', {
            method: 'POST',
            body: JSON.stringify({ folder_id: folderId, image_ids: imageIds }),
        });
    },

    getCullingSession(id) {
        return this._fetch(`/api/culling/${id}`);
    },

    pickCullingImage(sessionId, imageId) {
        return this._fetch(`/api/culling/${sessionId}/pick`, {
            method: 'PUT',
            body: JSON.stringify({ image_id: imageId }),
        });
    },

    finalizeCulling(sessionId) {
        return this._fetch(`/api/culling/${sessionId}/finalize`, {
            method: 'POST',
        });
    },

    setFolderUnit(folderId, unit) {
        return this._fetch(`/api/folders/${folderId}/unit`, {
            method: 'PUT',
            body: JSON.stringify({ weight_unit: unit }),
        });
    },

    // ROI
    setFolderROI(folderId, cells) {
        return this._fetch(`/api/folders/${folderId}/roi`, {
            method: 'PUT',
            body: JSON.stringify({ cells }),
        });
    },

    // OCR
    processOcrImage(imageId) {
        return this._fetch(`/api/ocr/process/${imageId}`, { method: 'POST' });
    },

    submitOcr(imageIds) {
        return this._fetch('/api/ocr/submit', {
            method: 'POST',
            body: JSON.stringify({ image_ids: imageIds }),
        });
    },

    getOcrResults(folderId) {
        return this._fetch(`/api/ocr/results/${folderId}`);
    },

    getOcrResult(imageId) {
        return this._fetch(`/api/ocr/result/${imageId}`);
    },

    tagRoiUrl(imageId) {
        return `/api/ocr/tag-roi/${imageId}`;
    },

    ledCropUrl(imageId) {
        return `/api/ocr/led-crop/${imageId}`;
    },

    exportOcrUrl(folderId) {
        return `/api/ocr/export/${folderId}`;
    },

    updateOcrResult(imageId, data) {
        return this._fetch(`/api/ocr/result/${imageId}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
    },

    // Auth
    login(role, username, password) {
        return this._fetch('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ role, username, password }),
        });
    },

    logout() {
        return this._fetch('/api/auth/logout', { method: 'POST' });
    },

    getSession() {
        return this._fetch('/api/auth/session');
    },
};
