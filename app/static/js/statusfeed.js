/**
 * Status feed — right panel console log.
 */
const StatusFeed = {
    _el: null,

    init() {
        this._el = document.getElementById('status-feed');
    },

    _timestamp() {
        const d = new Date();
        return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },

    log(message, type = '') {
        const entry = document.createElement('div');
        entry.className = 'feed-entry' + (type ? ` feed-${type}` : '');
        entry.innerHTML = `<span class="feed-time">${this._timestamp()}</span>${message}`;
        this._el.appendChild(entry);
        while (this._el.children.length > 200) {
            this._el.removeChild(this._el.firstChild);
        }
        this._el.scrollTop = this._el.scrollHeight;
    },

    info(msg) { this.log(msg); },
    success(msg) { this.log(msg, 'success'); },
    warn(msg) { this.log(msg, 'warn'); },
    error(msg) { this.log(msg, 'error'); },
};
