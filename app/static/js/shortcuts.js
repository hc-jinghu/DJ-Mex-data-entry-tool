/**
 * Keyboard shortcut manager — dispatches keys based on active mode.
 *
 * Grid modes:
 *   Normal: arrows navigate, Space/Enter opens viewer, X enters delete mode,
 *           O enters OCR mode, C enters culling mode
 *   Delete mode: X toggles deletion mark on focused image, arrows navigate, Esc exits
 *   OCR mode: O toggles OCR mark on focused image, arrows navigate, Esc exits
 *
 * Viewer: arrows navigate, X toggles deletion mark, Space/Esc closes
 * Culler: arrows navigate candidates, P picks, X toggles mark, Enter finalizes, Esc closes
 */
const Shortcuts = {
    init() {
        document.addEventListener('keydown', (e) => this._handle(e));
    },

    _handle(e) {
        // Block all keyboard shortcuts while syncing
        if (Grid.isSyncing) {
            e.preventDefault();
            return;
        }

        // Allow Tab through to viewer handler even from OCR edit inputs
        const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
        if (inInput && e.key !== 'Tab') return;

        if (ROI.isOpen) {
            this._handleROI(e);
            return;
        }

        if (Culler.isOpen) {
            this._handleCulling(e);
            return;
        }

        if (Viewer.isOpen) {
            this._handleViewer(e);
            return;
        }

        this._handleGrid(e);
    },

    _handleGrid(e) {
        // Don't intercept keys while renaming (input handles its own keys)
        if (Grid.isRenaming) return;

        const mode = Grid.mode;

        switch (e.key) {
            case 'ArrowLeft':
                e.preventDefault();
                Grid.navigate('left', e.shiftKey);
                break;
            case 'ArrowRight':
                e.preventDefault();
                Grid.navigate('right', e.shiftKey);
                break;
            case 'ArrowUp':
                e.preventDefault();
                Grid.navigate('up', e.shiftKey);
                break;
            case 'ArrowDown':
                e.preventDefault();
                Grid.navigate('down', e.shiftKey);
                break;

            case 'Enter':
                e.preventDefault();
                if (mode === 'delete') {
                    App.executeActions();
                } else if (mode === 'ocr') {
                    App.submitOcr();
                } else {
                    Grid.startRename();
                }
                break;

            case ' ':
                e.preventDefault();
                Grid.openFocused();
                break;

            case 'x':
            case 'X':
            case 'Delete':
                if (mode === 'ocr') break; // can't delete-mark while in OCR mode
                e.preventDefault();
                if (mode !== 'delete') {
                    Grid.setMode('delete');
                }
                Grid.toggleFocusedMark();
                break;

            case 'o':
            case 'O':
                if (mode === 'delete') break; // can't OCR-mark while in delete mode
                e.preventDefault();
                if (mode !== 'ocr') {
                    Grid.setMode('ocr');
                }
                Grid.toggleFocusedMark();
                break;

            case 'c':
            case 'C':
                if (mode !== 'normal') break; // can't cull while in a mark mode
                if (!e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    App.startCulling();
                }
                break;

            case 'a':
                if (e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    Grid.selectAll();
                }
                break;
            case 'A':
                if (!e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    Grid.selectAll();
                }
                break;

            case 'Escape':
                e.preventDefault();
                Grid.exitMode();
                break;
        }
    },

    _handleViewer(e) {
        // TAB cycles editable OCR fields even when an input is focused
        if (e.key === 'Tab') {
            e.preventDefault();
            Viewer.focusNextField(e.shiftKey);
            return;
        }

        // Don't intercept keys while renaming (input handles its own keys)
        if (Viewer.isRenaming) return;

        switch (e.key) {
            case 'ArrowLeft':
                e.preventDefault();
                Viewer.prev();
                break;
            case 'ArrowRight':
                e.preventDefault();
                Viewer.next();
                break;
            case 'x':
            case 'X':
            case 'Delete':
                e.preventDefault();
                Viewer.markCurrentForDeletion();
                break;
            case 'r':
            case 'R':
                e.preventDefault();
                Viewer.rotateCurrent();
                break;
            case 'z':
            case 'Z':
                e.preventDefault();
                Viewer.toggleMagnifier();
                break;
            case ' ':
            case 'Escape':
                e.preventDefault();
                Viewer.close();
                break;
        }
    },

    _handleROI(e) {
        switch (e.key) {
            case 'Enter':
                e.preventDefault();
                ROI._confirm();
                break;
            case 'Escape':
                e.preventDefault();
                ROI.close();
                break;
        }
    },

    _handleCulling(e) {
        switch (e.key) {
            case 'ArrowLeft':
                e.preventDefault();
                Culler.prevCandidate();
                break;
            case 'ArrowRight':
                e.preventDefault();
                Culler.nextCandidate();
                break;
            case 'p':
            case 'P':
                e.preventDefault();
                Culler.pickCandidate();
                break;
            case 'x':
            case 'X':
            case 'Delete':
                e.preventDefault();
                Culler.toggleCandidateDeletion();
                break;
            case 'Enter':
                e.preventDefault();
                Culler.finalize();
                break;
            case 'Escape':
                e.preventDefault();
                Culler.close();
                break;
        }
    },
};
