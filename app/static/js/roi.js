/**
 * ROI grid overlay — 8x8 cell selector for OCR region of interest.
 *
 * Grid coordinates: X = columns 1-8 (left to right),
 * Y = rows 1-8 (bottom to top, origin at bottom-left).
 */
const ROI = {
    _folderId: null,
    _selectedCells: new Set(),   // "x,y" strings
    _onConfirm: null,
    _built: false,
    _gridSize: 8,

    get isOpen() {
        return !document.getElementById('roi-overlay').classList.contains('hidden');
    },

    init() {
        this._buildGrid();
        document.getElementById('btn-roi-clear').addEventListener('click', () => this._clear());
    },

    _buildGrid() {
        if (this._built) return;
        const grid = document.getElementById('roi-grid');
        const gs = this._gridSize;
        for (let row = 0; row < gs; row++) {
            for (let col = 0; col < gs; col++) {
                const x = col + 1;
                const y = gs - row;  // top row = y=gridSize, bottom row = y=1
                const cell = document.createElement('div');
                cell.className = 'roi-cell';
                cell.dataset.x = x;
                cell.dataset.y = y;
                cell.addEventListener('click', () => this._toggleCell(x, y, cell));
                grid.appendChild(cell);
            }
        }
        this._built = true;
    },

    open(folderId, imageUrl, savedCells, onConfirm) {
        this._folderId = folderId;
        this._onConfirm = onConfirm;
        this._selectedCells.clear();

        // Set reference image
        const img = document.getElementById('roi-image');
        img.src = imageUrl;

        // Pre-select saved cells
        this._clearHighlights();
        if (savedCells && savedCells.length) {
            savedCells.forEach(([x, y]) => {
                const key = `${x},${y}`;
                this._selectedCells.add(key);
                const cell = this._getCellEl(x, y);
                if (cell) cell.classList.add('roi-selected');
            });
        }

        // Show overlay
        document.getElementById('roi-overlay').classList.remove('hidden');
    },

    _getCellEl(x, y) {
        return document.querySelector(`.roi-cell[data-x="${x}"][data-y="${y}"]`);
    },

    _toggleCell(x, y, cellEl) {
        const key = `${x},${y}`;
        if (this._selectedCells.has(key)) {
            this._selectedCells.delete(key);
            cellEl.classList.remove('roi-selected');
        } else {
            this._selectedCells.add(key);
            cellEl.classList.add('roi-selected');
        }
    },

    _confirm() {
        const cells = [];
        this._selectedCells.forEach(key => {
            const [x, y] = key.split(',').map(Number);
            cells.push([x, y]);
        });

        const cb = this._onConfirm;
        this.close();
        if (cb) cb(cells);
    },

    _clear() {
        this._selectedCells.clear();
        this._clearHighlights();
    },

    _clearHighlights() {
        document.querySelectorAll('.roi-cell.roi-selected').forEach(el => {
            el.classList.remove('roi-selected');
        });
    },

    close() {
        document.getElementById('roi-overlay').classList.add('hidden');
        this._onConfirm = null;
    },
};
