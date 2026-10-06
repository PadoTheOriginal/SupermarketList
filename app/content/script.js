/* Shopping List - no framework, no jQuery.
 *
 * The page is rendered from a JSON state object. Edits update that object
 * first (so the UI reacts instantly), then go to the server; if the server
 * says no, we reload the state and tell the user. A long-poll on /api/version
 * keeps other devices in sync without ever reloading the page.
 */
(function () {
    'use strict';

    var initialStateElement = document.getElementById('initial-state');
    var state = JSON.parse(initialStateElement.textContent);

    var ui = {
        listbar: document.getElementById('listbar'),
        panel: document.getElementById('list-panel'),
        listName: document.getElementById('list-name'),
        items: document.getElementById('items'),
        bought: document.getElementById('bought'),
        boughtToggle: document.getElementById('bought-toggle'),
        boughtLabel: document.getElementById('bought-label'),
        itemsEmpty: document.getElementById('items-empty'),
        suggestions: document.getElementById('suggestions'),
        emptyState: document.getElementById('empty-state'),
        emptyNewList: document.getElementById('empty-new-list'),
        composer: document.getElementById('composer'),
        newName: document.getElementById('new-name'),
        newQuantity: document.getElementById('new-quantity'),
        newPrice: document.getElementById('new-price'),
        priceLabel: document.getElementById('price-label'),
        progress: document.getElementById('progress'),
        progressBar: document.getElementById('progress-bar'),
        totalCart: document.getElementById('total-cart'),
        totalLeft: document.getElementById('total-left'),
        totalAll: document.getElementById('total-all'),
        searchToggle: document.getElementById('search-toggle'),
        searchRow: document.getElementById('search-row'),
        searchInput: document.getElementById('search-input'),
        searchClear: document.getElementById('search-clear'),
        menuButton: document.getElementById('list-menu-button'),
        menu: document.getElementById('list-menu'),
        menuShare: document.getElementById('menu-share'),
        menuLeave: document.getElementById('menu-leave'),
        sharedNote: document.getElementById('shared-note'),
        sharedNoteText: document.getElementById('shared-note-text'),
        themeToggle: document.getElementById('theme-toggle'),
        syncDot: document.getElementById('sync-dot'),
        toasts: document.getElementById('toasts'),
        offlineBanner: document.getElementById('offline-banner'),
        scrollFab: document.getElementById('scroll-fab'),
        itemTemplate: document.getElementById('item-template'),
        accountButton: document.getElementById('account-button'),
        accountMenu: document.getElementById('account-menu'),
        accountHeadingName: document.getElementById('account-heading-name'),
        accountHeadingRole: document.getElementById('account-heading-role'),
        manageUsersItem: document.getElementById('manage-users-item'),
        modalOverlay: document.getElementById('modal-overlay'),
        modalCard: document.getElementById('modal-card'),
        modalTitle: document.getElementById('modal-title'),
        modalBody: document.getElementById('modal-body'),
        modalClose: document.getElementById('modal-close'),
        confirmOverlay: document.getElementById('confirm-overlay'),
        confirmTitle: document.getElementById('confirm-title'),
        confirmMessage: document.getElementById('confirm-message'),
        confirmOk: document.getElementById('confirm-ok'),
        confirmCancel: document.getElementById('confirm-cancel')
    };

    var activeListId = null;
    var filterText = '';
    var pendingRequests = 0;
    // Placeholder ids for optimistic rows are negative, so they never collide
    // with a real (positive, autoincrement) item id from the server.
    var nextTempId = -1;

    // Item edits are written to the server through an offline-tolerant outbox
    // (see the "Offline outbox" section): when the network is down they queue
    // up locally and replay, in order, once it comes back.
    var OUTBOX_KEY = 'outbox-v1';
    var outbox = [];
    var flushing = false;
    var flushTimer = null;

    // ===================================================================== //
    // Small helpers
    // ===================================================================== //

    // Tiny DOM builder so the settings screens can be assembled without a pile
    // of createElement/appendChild boilerplate.
    function el(tag, props, children) {
        var node = document.createElement(tag);
        if (props) {
            Object.keys(props).forEach(function (key) {
                if (key === 'class') {
                    node.className = props[key];
                } else if (key === 'text') {
                    node.textContent = props[key];
                } else if (key === 'html') {
                    node.innerHTML = props[key];
                } else if (key.slice(0, 2) === 'on' && typeof props[key] === 'function') {
                    node.addEventListener(key.slice(2).toLowerCase(), props[key]);
                } else if (props[key] === true) {
                    node.setAttribute(key, '');
                } else if (props[key] !== false && props[key] != null) {
                    node.setAttribute(key, props[key]);
                }
            });
        }
        (Array.isArray(children) ? children : children != null ? [children] : [])
            .forEach(function (child) {
                if (child == null) return;
                node.appendChild(typeof child === 'string'
                    ? document.createTextNode(child) : child);
            });
        return node;
    }

    function storageGet(key, fallback) {
        try {
            var value = localStorage.getItem(key);
            return value === null ? fallback : value;
        } catch (error) {
            return fallback;
        }
    }

    function storageSet(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (error) { /* private mode */ }
    }

    var currencyFormatter = new Intl.NumberFormat(state.locale, {
        style: 'currency',
        currency: state.currency
    });

    function money(value) {
        try {
            return currencyFormatter.format(value || 0);
        } catch (error) {
            return (value || 0).toFixed(2);
        }
    }

    function currencySymbol() {
        try {
            var parts = currencyFormatter.formatToParts(0);
            for (var i = 0; i < parts.length; i++) {
                if (parts[i].type === 'currency') return parts[i].value;
            }
        } catch (error) { /* fall through */ }
        return 'Price';
    }

    function quantityText(value) {
        var number = Number(value) || 0;
        return Number.isInteger(number) ? String(number) : String(Math.round(number * 1000) / 1000);
    }

    function activeList() {
        for (var i = 0; i < state.lists.length; i++) {
            if (state.lists[i].id === activeListId) return state.lists[i];
        }
        return null;
    }

    function findItem(list, itemId) {
        for (var i = 0; i < list.items.length; i++) {
            if (list.items[i].id === itemId) return list.items[i];
        }
        return null;
    }

    function setBusy(delta) {
        pendingRequests = Math.max(0, pendingRequests + delta);
        var queued = outbox.length;
        if (!navigator.onLine) {
            ui.syncDot.dataset.state = 'error';
            ui.syncDot.title = queued
                ? queued + ' change' + (queued === 1 ? '' : 's') + ' waiting - offline'
                : 'Offline';
        } else if (pendingRequests > 0 || queued) {
            ui.syncDot.dataset.state = 'busy';
            ui.syncDot.title = queued
                ? 'Syncing ' + queued + ' change' + (queued === 1 ? '' : 's') + '...'
                : 'Saving...';
        } else {
            ui.syncDot.dataset.state = 'idle';
            ui.syncDot.title = 'All changes saved';
        }
    }

    // ===================================================================== //
    // Server access
    // ===================================================================== //

    function api(method, url, body) {
        var options = {
            method: method,
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json' }
        };

        if (body !== undefined) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        }

        setBusy(1);

        return fetch(url, options)
            .then(function (response) {
                if (response.status === 401) {
                    window.location.href = '/login';
                    throw new Error('Signed out');
                }
                return response.json()
                    .catch(function () { return {}; })
                    .then(function (payload) {
                        if (!response.ok) {
                            throw new Error(payload.error || 'Request failed (' + response.status + ')');
                        }
                        if (typeof payload.version === 'number') state.version = payload.version;
                        return payload;
                    });
            })
            .finally(function () {
                setBusy(-1);
            });
    }

    function refreshState() {
        return api('GET', '/api/state').then(function (payload) {
            state = payload;
            // Re-apply anything still queued locally so pending edits are not
            // wiped by the server's (older) view of the list.
            applyOutboxToState();
            render();
            return payload;
        });
    }

    /** Something went wrong: tell the user and resync so the UI is not a lie. */
    function failed(error) {
        toast(error && error.message ? error.message : 'Something went wrong', 'error');
        refreshState().catch(function () { /* offline; the banner covers it */ });
    }

    // ===================================================================== //
    // Offline outbox
    // ===================================================================== //
    //
    // Every item edit is applied to the local state right away (so the UI reacts
    // instantly) and recorded as a high-level "op" in a persisted queue. A single
    // worker drains that queue to the server, one op at a time, in order:
    //
    //   * success            -> drop the op and move on;
    //   * server said no     -> drop the op, tell the user, keep going;
    //   * network is down    -> stop and retry when we are back online.
    //
    // Because the ops are intents (not raw requests) a freshly-created item's
    // temporary id can be rewritten to its real id once the server assigns one,
    // and the whole queue survives a reload while offline.

    function loadOutbox() {
        try {
            var raw = JSON.parse(storageGet(OUTBOX_KEY, '[]'));
            outbox = Array.isArray(raw) ? raw : [];
        } catch (error) {
            outbox = [];
        }
        // Keep new temporary ids clear of any still queued from a past session.
        outbox.forEach(function (op) {
            if (op.kind === 'createItem' && op.tempId <= nextTempId) {
                nextTempId = op.tempId - 1;
            }
        });
    }

    function persistOutbox() {
        storageSet(OUTBOX_KEY, JSON.stringify(outbox));
    }

    /** Queue an op, folding it into earlier ones where that is safe. */
    function enqueue(op) {
        op.opId = Date.now() + ':' + Math.random().toString(36).slice(2);

        // The front op, while flushing, is already on the wire: we must not fold
        // into it (its request carries the old values) nor quietly remove it.
        function frontLocked(index) { return flushing && index === 0; }

        if (op.kind === 'deleteItem') {
            var createInFlight = flushing && outbox.length
                && outbox[0].kind === 'createItem' && outbox[0].tempId === op.itemId;

            // Drop the item's queued create/edits; they are moot now. Keep the
            // in-flight create so its request is not orphaned server-side.
            outbox = outbox.filter(function (other, index) {
                if (createInFlight && index === 0) return true;
                return !(other.itemId === op.itemId
                    || (other.kind === 'createItem' && other.tempId === op.itemId));
            });

            // A brand-new item deleted before its create ever left never needs
            // the server at all. (If the create is in flight we still queue the
            // delete; remapTempId will point it at the real id afterwards.)
            if (op.itemId < 0 && !createInFlight) {
                persistOutbox();
                setBusy(0);
                return;
            }
        } else if (op.kind === 'updateItem') {
            // Fold consecutive edits to the same item into one request. For an
            // item that has not been created yet, fold straight into its create
            // so it is born with the final values.
            for (var i = outbox.length - 1; i >= 0; i--) {
                var prev = outbox[i];
                if (prev.kind === 'createItem' && prev.tempId === op.itemId) {
                    if (frontLocked(i)) break;
                    applyFieldsToCreate(prev, op.fields);
                    persistOutbox();
                    setBusy(0);
                    return;
                }
                if (prev.kind === 'updateItem' && prev.itemId === op.itemId) {
                    if (frontLocked(i)) break;
                    Object.keys(op.fields).forEach(function (key) { prev.fields[key] = op.fields[key]; });
                    persistOutbox();
                    setBusy(0);
                    return;
                }
                // Anything else touching this item breaks the run - stop folding.
                if (opTouchesItem(prev, op.itemId)) break;
            }
        }

        outbox.push(op);
        persistOutbox();
        setBusy(0);
        flushOutbox();
    }

    function opTouchesItem(op, itemId) {
        if (op.kind === 'updateItem' || op.kind === 'deleteItem') return op.itemId === itemId;
        if (op.kind === 'createItem') return op.tempId === itemId;
        return op.kind === 'setAllChecked' || op.kind === 'clearChecked';
    }

    function applyFieldsToCreate(createOp, fields) {
        if ('name' in fields) createOp.name = fields.name;
        if ('quantity' in fields) createOp.quantity = fields.quantity;
        if ('price' in fields) createOp.price = fields.price;
        if ('checked' in fields) createOp.checked = fields.checked;
    }

    function isNetworkError(error) {
        return !navigator.onLine
            || !error
            || error.name === 'TypeError'
            || error.message === 'Failed to fetch'
            || error.message === 'Load failed';
    }

    function scheduleFlush(delay) {
        if (flushTimer) return;
        flushTimer = setTimeout(function () {
            flushTimer = null;
            flushOutbox();
        }, delay || 4000);
    }

    function flushOutbox() {
        if (flushing || !outbox.length || !navigator.onLine) return;

        flushing = true;
        var op = outbox[0];

        sendOp(op)
            .then(function () {
                flushing = false;
                dropFrontOp();
                if (outbox.length) flushOutbox();
                else drained();
            })
            .catch(function (error) {
                flushing = false;
                if (isNetworkError(error)) {
                    // Leave the op in place and try again once we are back.
                    setBusy(0);
                    scheduleFlush();
                    return;
                }
                // The server rejected this op for good (validation, gone,
                // permission). Undo its optimistic effect, warn once, continue.
                rollbackOp(op);
                dropFrontOp();
                toast(error && error.message ? error.message : 'A change could not be saved', 'error');
                if (outbox.length) flushOutbox();
                else drained();
            });
    }

    function dropFrontOp() {
        outbox.shift();
        persistOutbox();
        setBusy(0);
    }

    /** Queue is empty: if the sync loop saw newer server state while we were
     *  busy, pull it now so shared edits from other devices merge back in. */
    function drained() {
        setBusy(0);
        if (missedSync && navigator.onLine) {
            missedSync = false;
            refreshState().catch(function () { /* went offline */ });
        }
    }

    function sendOp(op) {
        if (op.kind === 'createItem') {
            return api('POST', '/api/lists/' + op.listId + '/items', {
                name: op.name, quantity: op.quantity, price: op.price, checked: !!op.checked
            }).then(function (payload) {
                remapTempId(op.tempId, payload.item);
            });
        }
        if (op.kind === 'updateItem') {
            return api('PATCH', '/api/items/' + op.itemId, op.fields);
        }
        if (op.kind === 'deleteItem') {
            return api('DELETE', '/api/items/' + op.itemId).catch(function (error) {
                // Already gone on the server? That is the outcome we wanted.
                if (!isNetworkError(error) && /not found/i.test(error.message || '')) return;
                throw error;
            });
        }
        if (op.kind === 'setAllChecked') {
            return api('POST', '/api/lists/' + op.listId + '/checked', { checked: op.checked });
        }
        if (op.kind === 'clearChecked') {
            return api('DELETE', '/api/lists/' + op.listId + '/checked');
        }
        return Promise.resolve();
    }

    /** Swap a placeholder item for the server's real one, everywhere it appears. */
    function remapTempId(tempId, realItem) {
        state.lists.forEach(function (list) {
            var item = findItem(list, tempId);
            if (item) {
                Object.keys(realItem).forEach(function (key) { item[key] = realItem[key]; });
                delete item.pending;
            }
        });
        outbox.forEach(function (op) {
            if ((op.kind === 'updateItem' || op.kind === 'deleteItem') && op.itemId === tempId) {
                op.itemId = realItem.id;
            }
        });
        persistOutbox();
        render();
    }

    /** Undo the local effect of an op the server refused. */
    function rollbackOp(op) {
        if (op.kind === 'createItem') {
            state.lists.forEach(function (list) {
                list.items = list.items.filter(function (item) { return item.id !== op.tempId; });
            });
            render();
        }
        // Other kinds are corrected by the resync that runs once the queue drains.
    }

    /** Replay the queued ops on top of a fresh server state after a resync. */
    function applyOutboxToState() {
        if (!outbox.length) return;
        outbox.forEach(function (op) {
            var list = null;
            if (op.kind === 'createItem') {
                state.lists.forEach(function (candidate) { if (candidate.id === op.listId) list = candidate; });
                if (list && !findItem(list, op.tempId)) {
                    list.items.push({
                        id: op.tempId, listId: op.listId, name: op.name,
                        quantity: op.quantity, price: op.price, checked: !!op.checked,
                        position: list.items.length + 1, pending: true
                    });
                }
            } else if (op.kind === 'updateItem') {
                state.lists.forEach(function (candidate) {
                    var item = findItem(candidate, op.itemId);
                    if (item) Object.keys(op.fields).forEach(function (key) { item[key] = op.fields[key]; });
                });
            } else if (op.kind === 'deleteItem') {
                state.lists.forEach(function (candidate) {
                    candidate.items = candidate.items.filter(function (item) { return item.id !== op.itemId; });
                });
            } else if (op.kind === 'setAllChecked') {
                state.lists.forEach(function (candidate) {
                    if (candidate.id === op.listId) {
                        candidate.items.forEach(function (item) { item.checked = op.checked; });
                    }
                });
            } else if (op.kind === 'clearChecked') {
                state.lists.forEach(function (candidate) {
                    if (candidate.id === op.listId) {
                        candidate.items = candidate.items.filter(function (item) { return !item.checked; });
                    }
                });
            }
        });
    }

    // ===================================================================== //
    // Toasts
    // ===================================================================== //

    // More than two at once buries the list under notifications.
    var MAX_TOASTS = 2;

    function toast(message, type, action) {
        var element = document.createElement('div');
        element.className = 'toast' + (type ? ' ' + type : '');

        var text = document.createElement('span');
        text.className = 'toast-message';
        text.textContent = message;
        element.appendChild(text);

        var life = action ? 7000 : 3500;
        var timer;

        function dismiss() {
            if (!element.isConnected) return;
            clearTimeout(timer);
            element.classList.add('leaving');
            setTimeout(function () { element.remove(); }, 200);
        }

        if (action) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'toast-action';
            button.textContent = action.label;
            button.addEventListener('click', function () {
                dismiss();
                action.run();
            });
            element.appendChild(button);
        }

        // Held while a swipe is in progress, so it cannot expire under the finger.
        element.stopTimer = function () { clearTimeout(timer); };
        element.restartTimer = function () {
            clearTimeout(timer);
            timer = setTimeout(dismiss, life);
        };

        ui.toasts.appendChild(element);
        timer = setTimeout(dismiss, life);

        // Never stack more than two - past that they cover the list and the
        // oldest is stale news anyway. Ones already animating out do not count,
        // and the snapshot is taken up front so dismissing cannot loop.
        var live = Array.prototype.filter.call(ui.toasts.children, function (node) {
            return !node.classList.contains('leaving');
        });
        while (live.length > MAX_TOASTS) {
            var oldest = live.shift();
            if (oldest.dismiss) oldest.dismiss();
            else oldest.remove();
        }

        element.dismiss = dismiss;
        return dismiss;
    }

    // Swipe a notification to the left to get rid of it early - same gesture as
    // deleting a row, so it needs no explaining.
    function setupToastSwipe() {
        var card = null;
        var startX = 0;
        var startY = 0;
        var deltaX = 0;
        var swiping = false;

        ui.toasts.addEventListener('touchstart', function (event) {
            if (event.touches.length !== 1) return;
            var candidate = event.target.closest('.toast');
            if (!candidate || candidate.classList.contains('leaving')) return;
            // Leave the Undo button alone; it is a tap target, not a handle.
            if (event.target.closest('button')) return;

            card = candidate;
            startX = event.touches[0].clientX;
            startY = event.touches[0].clientY;
            deltaX = 0;
            swiping = false;
            // Do not let it time out from under the finger mid-swipe.
            if (card.stopTimer) card.stopTimer();
        }, { passive: true });

        ui.toasts.addEventListener('touchmove', function (event) {
            if (!card) return;

            deltaX = event.touches[0].clientX - startX;
            var deltaY = event.touches[0].clientY - startY;

            if (!swiping && Math.abs(deltaX) > 12 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
                swiping = true;
                card.style.transition = 'none';
                card.style.animation = 'none';
            }

            if (swiping) {
                var travel = Math.min(0, deltaX);
                card.style.transform = 'translateX(' + travel + 'px)';
                card.style.opacity = String(1 + travel / (card.offsetWidth || 1));
            }
        }, { passive: true });

        ui.toasts.addEventListener('touchend', function () {
            if (!card) return;

            var target = card;
            target.style.transition = '';

            if (swiping && deltaX < -(target.offsetWidth || 0) * 0.35) {
                target.style.transform = 'translateX(-110%)';
                target.style.opacity = '0';
                setTimeout(function () { target.remove(); }, 200);
            } else {
                target.style.transform = '';
                target.style.opacity = '';
                // Released without dismissing: give it its full time again.
                if (target.restartTimer) target.restartTimer();
            }

            card = null;
            swiping = false;
        });
    }

    // ===================================================================== //
    // Rendering
    // ===================================================================== //

    // A render in the middle of a gesture pulls the row out from under the
    // finger: place() puts every row back in the server's order and
    // updateItemRow rewrites its fields. Both are exactly what a drag or a
    // swipe is busy contradicting, so renders wait for the finger to come off.
    // (The sync poll fires every few seconds - without this, a long drag is
    // near certain to be interrupted by one.)
    var dragActive = false;
    var swipeActive = false;
    var renderQueued = false;

    /** Run the render a gesture held back, if there was one. */
    function flushRender() {
        if (!renderQueued || dragActive || swipeActive) return;
        renderQueued = false;
        render();
    }

    function render() {
        if (dragActive || swipeActive) {
            renderQueued = true;
            return;
        }
        renderQueued = false;

        reflectUser();

        if (!activeList() && state.lists.length) {
            activeListId = state.lists[0].id;
        }
        if (!state.lists.length) activeListId = null;

        renderListbar();

        var list = activeList();
        ui.panel.hidden = !list;
        ui.composer.hidden = !list;
        ui.emptyState.hidden = !!list;
        updateFab();

        if (!list) return;

        storageSet('activeList', String(list.id));

        if (document.activeElement !== ui.listName) ui.listName.value = list.name;

        if (list.shared) {
            ui.sharedNoteText.textContent = 'Shared with you by ' + (list.owner || 'someone');
            ui.sharedNote.hidden = false;
        } else {
            ui.sharedNote.hidden = true;
        }

        renderItems(list);
        renderTotals(list);
    }

    function canShare() {
        return !!(state.user && (state.user.isAdmin || state.user.canShare));
    }

    function renderListbar() {
        var fragment = document.createDocumentFragment();

        state.lists.forEach(function (list) {
            var chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'list-chip';
            chip.setAttribute('role', 'tab');
            chip.setAttribute('aria-selected', list.id === activeListId ? 'true' : 'false');
            chip.dataset.id = String(list.id);

            if (list.shared) {
                var holder = document.createElement('span');
                holder.innerHTML = '<svg class="icon chip-shared" aria-hidden="true"><use href="#i-users"></use></svg>';
                chip.appendChild(holder.firstChild);
                chip.title = 'Shared by ' + (list.owner || 'someone');
            }

            var label = document.createElement('span');
            label.textContent = list.name;
            chip.appendChild(label);

            var remaining = list.items.filter(function (item) { return !item.checked; }).length;
            if (remaining) {
                var count = document.createElement('span');
                count.className = 'count';
                count.textContent = String(remaining);
                chip.appendChild(count);
            }

            chip.addEventListener('click', function () {
                activeListId = list.id;
                filterText = '';
                ui.searchInput.value = '';
                ui.searchRow.hidden = true;
                render();
            });

            fragment.appendChild(chip);
        });

        var addChip = document.createElement('button');
        addChip.type = 'button';
        addChip.className = 'list-chip add';
        addChip.title = 'New list';
        addChip.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-plus"></use></svg><span>New list</span>';
        addChip.addEventListener('click', createList);
        fragment.appendChild(addChip);

        ui.listbar.textContent = '';
        ui.listbar.appendChild(fragment);

        // Rebuilding the strip loses its horizontal scroll, so put the selected
        // chip back in view - by scrolling the strip itself. Never scrollIntoView:
        // the strip lives at the top of the page, so asking the browser to reveal
        // a chip drags the whole page up to it, throwing the user back to the top
        // of the list on every single render (every add, delete and sync poll).
        var selected = ui.listbar.querySelector('[aria-selected="true"]');
        if (selected) {
            var left = selected.offsetLeft - ui.listbar.offsetLeft;
            var right = left + selected.offsetWidth;
            if (left < ui.listbar.scrollLeft) {
                ui.listbar.scrollLeft = Math.max(0, left - 12);
            } else if (right > ui.listbar.scrollLeft + ui.listbar.clientWidth) {
                ui.listbar.scrollLeft = right - ui.listbar.clientWidth + 12;
            }
        }
    }

    function matchesFilter(list) {
        var items = list.items.slice();
        if (filterText) {
            var needle = filterText.toLowerCase();
            items = items.filter(function (item) {
                return item.name.toLowerCase().indexOf(needle) !== -1;
            });
        }
        return items;
    }

    function createItemRow(item) {
        var row = ui.itemTemplate.content.firstElementChild.cloneNode(true);
        row.dataset.id = String(item.id);

        var checkbox = row.querySelector('.item-checked');
        var name = row.querySelector('.item-name');
        var quantity = row.querySelector('.item-quantity');
        var price = row.querySelector('.item-price');

        checkbox.addEventListener('change', function () {
            toggleChecked(item.id, checkbox.checked);
        });

        name.addEventListener('change', function () {
            commitField(item.id, 'name', name.value.trim(), name);
        });
        name.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') name.blur();
            if (event.key === 'Escape') {
                var current = findItem(activeList(), item.id);
                if (current) name.value = current.name;
                name.blur();
            }
        });
        [quantity, price].forEach(function (input) {
            var field = input === quantity ? 'quantity' : 'price';
            input.addEventListener('input', function () {
                previewNumber(item.id, field, input.value);
            });
            input.addEventListener('change', function () {
                commitField(item.id, field, input.value, input);
            });
            input.addEventListener('focus', function () { input.select(); });
            input.addEventListener('keydown', function (event) {
                if (event.key === 'Enter') input.blur();
            });
        });

        row.querySelector('.delete').addEventListener('click', function () {
            deleteItem(item.id);
        });

        // Quantity/price and delete stay hidden until the row is put in edit
        // mode, so the default list is compact and fits more items on screen.
        var editButton = row.querySelector('.item-edit');
        var editTimer = null;
        editButton.addEventListener('click', function () {
            var editing = row.classList.toggle('editing');
            editButton.setAttribute('aria-expanded', editing ? 'true' : 'false');
            editButton.setAttribute('aria-label', editing ? 'Done editing' : 'Edit item');

            // Opening is animated; closing is not, so the row gets out of the
            // way the moment it is dismissed. Clearing the class first (and
            // reading back a layout to make the browser act on it) is what lets
            // a row closed and reopened in quick succession play it again.
            clearTimeout(editTimer);
            row.classList.remove('edit-opening');
            if (!editing) return;
            void row.offsetWidth;
            row.classList.add('edit-opening');
            editTimer = setTimeout(function () { row.classList.remove('edit-opening'); }, 260);
        });

        attachDrag(row);
        return row;
    }

    function updateItemRow(row, item) {
        var checkbox = row.querySelector('.item-checked');
        var name = row.querySelector('.item-name');
        var quantity = row.querySelector('.item-quantity');
        var price = row.querySelector('.item-price');

        row.classList.toggle('checked', item.checked);
        checkbox.checked = item.checked;

        // A pending row is dimmed while it waits for its real id, but stays fully
        // interactive: the outbox folds any edits into the queued create (or
        // remaps them once the id arrives), so editing offline is safe.
        row.classList.toggle('pending', !!item.pending);

        // Never overwrite a field the user is currently typing in.
        if (document.activeElement !== name) name.value = item.name;
        if (document.activeElement !== quantity) quantity.value = quantityText(item.quantity);
        if (document.activeElement !== price) price.value = Number(item.price).toFixed(2);

        row.querySelector('.item-total').textContent = money(item.quantity * item.price);
    }

    function renderItems(list) {
        var grouped = sinkChecked();
        var searching = !!filterText;
        var wanted = matchesFilter(list);

        // Grouped: bought items live in their own collapsible list at the
        // bottom. Ungrouped: everything stays inline in its natural order.
        var active = grouped ? wanted.filter(function (i) { return !i.checked; }) : wanted;
        var done = grouped ? wanted.filter(function (i) { return i.checked; }) : [];

        // Rows may currently sit in either list; index them all before placing.
        var existing = new Map();
        [ui.items, ui.bought].forEach(function (container) {
            Array.prototype.forEach.call(container.children, function (row) {
                existing.set(Number(row.dataset.id), row);
            });
        });

        function place(container, items) {
            items.forEach(function (item, index) {
                var row = existing.get(item.id);
                if (row) existing.delete(item.id);
                else row = createItemRow(item);

                updateItemRow(row, item);

                if (container.children[index] !== row) {
                    container.insertBefore(row, container.children[index] || null);
                }
            });
        }

        place(ui.items, active);
        place(ui.bought, done);

        existing.forEach(function (row) { row.remove(); });

        // A filter should never hide its own matches behind the collapse.
        var open = boughtOpen() || searching;
        var hasBought = grouped && done.length > 0;
        ui.boughtToggle.hidden = !hasBought;
        ui.bought.hidden = !(hasBought && open);
        if (hasBought) {
            ui.boughtLabel.textContent = done.length + ' bought';
            ui.boughtToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            ui.boughtToggle.classList.toggle('open', open);
        }

        ui.itemsEmpty.hidden = wanted.length > 0;
        ui.itemsEmpty.textContent = list.items.length && !wanted.length
            ? 'No items match "' + filterText + '".'
            : 'Nothing here yet - add your first item below.';
    }

    function boughtOpen() {
        return storageGet('boughtOpen', '0') === '1';
    }

    function toggleBought() {
        storageSet('boughtOpen', boughtOpen() ? '0' : '1');
        var list = activeList();
        if (list) renderItems(list);
    }

    function renderTotals(list) {
        var cart = 0;
        var left = 0;
        var checkedCount = 0;

        list.items.forEach(function (item) {
            var total = item.quantity * item.price;
            if (item.checked) {
                cart += total;
                checkedCount += 1;
            } else {
                left += total;
            }
        });

        ui.totalCart.textContent = money(cart);
        ui.totalLeft.textContent = money(left);
        ui.totalAll.textContent = money(cart + left);

        var percentage = list.items.length ? Math.round((checkedCount / list.items.length) * 100) : 0;
        ui.progressBar.style.width = percentage + '%';
        ui.progress.setAttribute('aria-valuenow', String(percentage));
        ui.progress.setAttribute('aria-valuetext', checkedCount + ' of ' + list.items.length + ' items in the cart');
    }

    // ===================================================================== //
    // Mutations
    // ===================================================================== //

    function createList() {
        api('POST', '/api/lists', { name: 'New list' })
            .then(function (payload) {
                state.lists.push(payload.list);
                activeListId = payload.list.id;
                render();
                ui.listName.focus();
                ui.listName.select();
            })
            .catch(failed);
    }

    function renameList(name) {
        var list = activeList();
        if (!list || !name || name === list.name) {
            if (list) ui.listName.value = list.name;
            return;
        }

        var previous = list.name;
        list.name = name;
        renderListbar();

        api('PATCH', '/api/lists/' + list.id, { name: name }).catch(function (error) {
            list.name = previous;
            failed(error);
        });
    }

    function deleteList() {
        var list = activeList();
        if (!list) return;

        var itemCount = list.items.length;
        var detail = itemCount
            ? ' and its ' + itemCount + ' item' + (itemCount === 1 ? '' : 's')
            : '';

        confirmDialog({
            title: 'Delete list',
            message: 'Delete "' + list.name + '"' + detail + '? This cannot be undone.',
            confirmText: 'Delete',
            danger: true
        }).then(function (ok) {
            if (!ok) return;
            api('DELETE', '/api/lists/' + list.id)
                .then(function () {
                    state.lists = state.lists.filter(function (candidate) { return candidate.id !== list.id; });
                    activeListId = state.lists.length ? state.lists[0].id : null;
                    render();
                    toast('List deleted', 'success');
                })
                .catch(failed);
        });
    }

    function leaveList() {
        var list = activeList();
        if (!list || !list.shared) return;
        confirmDialog({
            title: 'Leave list',
            message: 'Leave "' + list.name + '"? It stays with the owner, but you will no longer see it.',
            confirmText: 'Leave'
        }).then(function (ok) {
            if (!ok) return;
            api('DELETE', '/api/lists/' + list.id + '/shares/' + state.user.id)
                .then(function () {
                    state.lists = state.lists.filter(function (candidate) { return candidate.id !== list.id; });
                    activeListId = state.lists.length ? state.lists[0].id : null;
                    render();
                    toast('You left the list', 'success');
                })
                .catch(failed);
        });
    }

    function duplicateList() {
        var list = activeList();
        if (!list) return;

        api('POST', '/api/lists/' + list.id + '/duplicate')
            .then(function (payload) {
                state.lists.push(payload.list);
                activeListId = payload.list.id;
                render();
                toast('List duplicated', 'success');
            })
            .catch(failed);
    }

    function addItem(event) {
        event.preventDefault();

        var list = activeList();
        if (!list) return;

        var name = ui.newName.value.trim();
        if (!name) {
            ui.newName.focus();
            return;
        }

        var quantity = parseFloat(ui.newQuantity.value);
        var price = parseFloat(ui.newPrice.value);

        var body = {
            name: name,
            quantity: isFinite(quantity) && quantity > 0 ? quantity : 1,
            price: isFinite(price) && price > 0 ? price : 0
        };

        // Show the row instantly with a temporary id, then reconcile with the
        // real item once the server answers. The composer is cleared right away
        // so the next item can be typed without waiting for the network.
        var tempId = nextTempId--;
        var optimistic = {
            id: tempId,
            listId: list.id,
            name: body.name,
            quantity: body.quantity,
            price: body.price,
            checked: false,
            position: list.items.length + 1,
            pending: true
        };
        list.items.push(optimistic);

        ui.newName.value = '';
        ui.newQuantity.value = '1';
        ui.newPrice.value = '';
        ui.newName.focus();
        hideSuggestions();
        syncComposerFields();
        saveDraft();
        rememberItem(body.name);
        render();

        // No scrollIntoView on the new row: it is inserted directly above the
        // composer, which you must be looking at to have added anything.

        // The queue swaps the placeholder for the server's real item (and its id)
        // once it flushes; offline, the row simply stays pending until it can.
        enqueue({
            kind: 'createItem', listId: list.id, tempId: tempId,
            name: body.name, quantity: body.quantity, price: body.price, checked: false
        });
    }

    /** Green wash over a row that was just ticked off. */
    function flashChecked(itemId) {
        var row = ui.items.querySelector('[data-id="' + itemId + '"]')
            || ui.bought.querySelector('[data-id="' + itemId + '"]');
        if (!row) return;

        row.classList.add('just-checked');
        setTimeout(function () { row.classList.remove('just-checked'); }, 600);
    }

    function toggleChecked(itemId, checked) {
        var list = activeList();
        var item = list && findItem(list, itemId);
        if (!item) return;

        item.checked = checked;
        render();

        // Play the flash after the render, on the row in its new home: with
        // grouping on, ticking something off moves it to the bought list, and
        // rows are reused across renders so this is the same element either way.
        if (checked) flashChecked(itemId);

        enqueue({ kind: 'updateItem', itemId: itemId, fields: { checked: checked } });
    }

    /** Live totals while typing, without touching the server yet. */
    function previewNumber(itemId, field, rawValue) {
        var list = activeList();
        var item = list && findItem(list, itemId);
        if (!item) return;

        var value = parseFloat(rawValue);
        if (!isFinite(value)) return;

        item[field] = field === 'quantity' ? Math.max(0.001, value) : Math.max(0, value);

        var row = ui.items.querySelector('[data-id="' + itemId + '"]');
        if (row) row.querySelector('.item-total').textContent = money(item.quantity * item.price);
        renderTotals(list);
    }

    function commitField(itemId, field, rawValue, input) {
        var list = activeList();
        var item = list && findItem(list, itemId);
        if (!item) return;

        var value;
        if (field === 'name') {
            value = String(rawValue).trim();
            if (!value) {
                input.value = item.name;
                return;
            }
        } else {
            value = parseFloat(rawValue);
            if (!isFinite(value)) value = field === 'quantity' ? 1 : 0;
            value = field === 'quantity' ? Math.max(0.001, value) : Math.max(0, value);
        }

        // Apply locally first (the number preview may already have), then queue.
        item[field] = value;
        if (field === 'name') rememberItem(value);
        render();

        var fields = {};
        fields[field] = value;
        enqueue({ kind: 'updateItem', itemId: itemId, fields: fields });
    }

    function deleteItem(itemId) {
        var list = activeList();
        var item = list && findItem(list, itemId);
        if (!item) return;

        var snapshot = {
            name: item.name,
            quantity: item.quantity,
            price: item.price,
            checked: item.checked
        };
        var listId = list.id;

        list.items = list.items.filter(function (candidate) { return candidate.id !== itemId; });
        render();

        enqueue({ kind: 'deleteItem', itemId: itemId });

        toast('Removed "' + snapshot.name + '"', null, {
            label: 'Undo',
            run: function () {
                var target = null;
                state.lists.forEach(function (candidate) { if (candidate.id === listId) target = candidate; });
                if (!target) return;

                var tempId = nextTempId--;
                target.items.push({
                    id: tempId, listId: listId, name: snapshot.name,
                    quantity: snapshot.quantity, price: snapshot.price, checked: snapshot.checked,
                    position: target.items.length + 1, pending: true
                });
                render();
                enqueue({
                    kind: 'createItem', listId: listId, tempId: tempId,
                    name: snapshot.name, quantity: snapshot.quantity,
                    price: snapshot.price, checked: snapshot.checked
                });
            }
        });
    }

    function setAllChecked(checked) {
        var list = activeList();
        if (!list) return;

        list.items.forEach(function (item) { item.checked = checked; });
        render();

        enqueue({ kind: 'setAllChecked', listId: list.id, checked: checked });
    }

    function clearChecked() {
        var list = activeList();
        if (!list) return;

        var count = list.items.filter(function (item) { return item.checked; }).length;
        if (!count) {
            toast('No checked items to remove');
            return;
        }
        var noun = 'item' + (count === 1 ? '' : 's');
        confirmDialog({
            title: 'Remove checked items',
            message: 'Remove ' + count + ' checked ' + noun + '?',
            confirmText: 'Remove',
            danger: true
        }).then(function (ok) {
            if (!ok) return;
            list.items = list.items.filter(function (item) { return !item.checked; });
            render();

            enqueue({ kind: 'clearChecked', listId: list.id });
            toast('Removed ' + count + ' ' + noun, 'success');
        });
    }

    function commitOrder() {
        var list = activeList();
        if (!list) return;

        var ids = Array.prototype.map.call(ui.items.children, function (row) {
            return Number(row.dataset.id);
        });

        // Bought items are reordered out of a separate list; keep their existing
        // positions after the active ones so nothing collides or jumps.
        list.items.forEach(function (item) {
            if (ids.indexOf(item.id) === -1) ids.push(item.id);
        });

        var byId = {};
        list.items.forEach(function (item) { byId[item.id] = item; });

        var reordered = [];
        ids.forEach(function (id) {
            if (byId[id]) {
                reordered.push(byId[id]);
                delete byId[id];
            }
        });
        Object.keys(byId).forEach(function (id) { reordered.push(byId[id]); });

        list.items = reordered;
        list.items.forEach(function (item, index) { item.position = index + 1; });

        api('POST', '/api/lists/' + list.id + '/items/reorder', { ids: ids }).catch(failed);
    }

    // ===================================================================== //
    // Drag to reorder (pointer events: works with mouse, pen and touch)
    // ===================================================================== //

    // The gap between rows in .items: the swap maths has to know how far a row
    // travels when it changes places with a neighbour.
    var LIST_GAP = 8;

    // How to end whichever drag is currently live. A second one closes the first
    // rather than being turned away, so a drag whose pointerup never arrived
    // costs one awkward gesture instead of locking reordering up for good.
    var endActiveDrag = null;

    function attachDrag(row) {
        var handle = row.querySelector('.drag-handle');
        var startY = 0;
        var offset = 0;
        var pointerY = 0;
        var pointerId = null;
        var scrollTick = null;

        function draw() {
            offset = pointerY - startY;
            row.style.transform = 'translateY(' + offset + 'px)';
        }

        /** Trade places with whichever neighbours the row has been pulled past. */
        function considerSwap() {
            // A flick clears more than one row between two pointer events, so
            // keep going until the row sits between its true neighbours again.
            // (One swap per event was the old behaviour, and it is why a fast
            // drag used to leave the row lagging several places behind.)
            for (var guard = 0; guard < 30; guard++) {
                var movingDown = offset > 0;
                var sibling = movingDown ? row.nextElementSibling : row.previousElementSibling;
                if (!sibling || !sibling.classList.contains('item')) return;

                var bounds = sibling.getBoundingClientRect();
                var rowBounds = row.getBoundingClientRect();
                var siblingMid = bounds.top + bounds.height / 2;

                // The leading edge passing the neighbour's middle is enough -
                // waiting for the two middles to meet means dragging a whole row
                // height before anything gives, which is what made reordering
                // feel stuck. It also does the right thing when the two rows are
                // different heights, as an open editor and a plain row are.
                var crossed = movingDown
                    ? rowBounds.bottom > siblingMid
                    : rowBounds.top < siblingMid;
                if (!crossed) return;

                // Always move the neighbour, never the dragged row. Re-inserting
                // a node takes it out of the document first, and browsers drop
                // pointer capture on a removed element - which killed the drag
                // mid-gesture every time it was dragged upwards.
                if (movingDown) ui.items.insertBefore(sibling, row);
                else ui.items.insertBefore(sibling, row.nextSibling);

                // The row's own slot has just moved by one neighbour, so move
                // the origin with it or the row jumps out from under the finger.
                startY += movingDown ? bounds.height + LIST_GAP : -(bounds.height + LIST_GAP);
                draw();
            }
        }

        /** Creep the page along when the row is dragged against an edge. */
        function edgeScroll() {
            if (pointerId === null) return;
            scrollTick = requestAnimationFrame(edgeScroll);

            // Stay clear of the sticky top bar and the composer: a row parked
            // under either is out of sight, so that is where the list has to
            // start moving instead of the row.
            var top = 96;
            var bottom = window.innerHeight - 132;
            var speed = 0;
            if (pointerY < top) speed = Math.max(-16, (pointerY - top) / 3);
            else if (pointerY > bottom) speed = Math.min(16, (pointerY - bottom) / 3);
            if (!speed) return;

            var before = window.scrollY;
            window.scrollBy(0, speed);
            var moved = window.scrollY - before;
            if (!moved) return;

            // The list slid under a finger that never moved, so the row's slot
            // went with it - shift the origin by as much or the row drifts off.
            startY -= moved;
            draw();
            considerSwap();
        }

        function onPointerDown(event) {
            if (event.button !== undefined && event.button !== 0) return;
            // One drag at a time: a second finger on another handle would fight
            // the first over the same list.
            if (endActiveDrag) endActiveDrag();
            if (filterText) {
                toast('Clear the filter to reorder items');
                return;
            }
            // Bought items live in their own group and are not reorderable.
            if (row.classList.contains('checked')) return;

            dragActive = true;
            endActiveDrag = finish;
            pointerId = event.pointerId;
            startY = event.clientY;
            pointerY = event.clientY;
            offset = 0;
            row.classList.add('dragging');
            if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId);

            // On the document rather than the handle: if the browser drops the
            // capture mid-drag, events stop reaching the handle and the row
            // freezes under the finger. They always reach the document.
            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
            document.addEventListener('pointercancel', onPointerUp);
            scrollTick = requestAnimationFrame(edgeScroll);
            event.preventDefault();
        }

        function onPointerMove(event) {
            if (event.pointerId !== pointerId) return;
            pointerY = event.clientY;
            draw();
            considerSwap();
        }

        function onPointerUp(event) {
            if (event.pointerId !== pointerId) return;
            finish();
        }

        function finish() {
            if (pointerId === null) return;

            var id = pointerId;
            pointerId = null;
            dragActive = false;
            endActiveDrag = null;
            cancelAnimationFrame(scrollTick);
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
            document.removeEventListener('pointercancel', onPointerUp);
            if (handle.hasPointerCapture && handle.hasPointerCapture(id)) {
                handle.releasePointerCapture(id);
            }

            // Ride the last few pixels home instead of snapping: the row is
            // already in its new slot, so this is only the offset unwinding.
            row.classList.remove('dragging');
            row.classList.add('dropping');
            void row.offsetWidth;
            row.style.transform = '';
            setTimeout(function () { row.classList.remove('dropping'); }, 200);

            commitOrder();
            flushRender();
        }

        handle.addEventListener('pointerdown', onPointerDown);
    }

    // ===================================================================== //
    // Row swipes (touch only): left deletes, right marks bought
    //
    // Both lists take swipes: right on something already bought puts it back on
    // the list, which on phones - where the checkbox is hidden - is the only way
    // to undo a tick.
    // ===================================================================== //

    // How far across a row you have to push before letting go commits it.
    var SWIPE_THRESHOLD = 0.35;

    /** Put a row back where it belongs, leaving no swipe state behind on it. */
    function clearSwipe(row) {
        row.style.transform = '';
        row.style.opacity = '';
        row.style.removeProperty('--swipe-w');
        row.style.removeProperty('--swipe-p');
        row.classList.remove('swiping', 'swipe-armed', 'swipe-left', 'swipe-right');
    }

    function setupSwipe() {
        var row = null;
        var startX = 0;
        var startY = 0;
        var deltaX = 0;
        var width = 1;
        var swiping = false;
        var frame = null;

        // Everything the finger does lands in deltaX; the row is only actually
        // moved once per frame. Touch events can outpace the display several
        // times over, and every one of those writes used to force a layout.
        function paint() {
            frame = null;
            if (!row || !swiping) return;

            var travelled = Math.abs(deltaX);
            row.style.transform = 'translateX(' + deltaX + 'px)';
            row.style.setProperty('--swipe-w', travelled + 'px');
            row.style.setProperty('--swipe-p', String(Math.min(1, travelled / (width * SWIPE_THRESHOLD))));
            row.classList.toggle('swipe-left', deltaX < 0);
            row.classList.toggle('swipe-right', deltaX > 0);
            row.classList.toggle('swipe-armed', travelled > width * SWIPE_THRESHOLD);
        }

        function stopPaint() {
            if (frame === null) return;
            cancelAnimationFrame(frame);
            frame = null;
        }

        function onStart(event) {
            if (event.touches.length !== 1) return;
            var candidate = event.target.closest('.item');
            if (!candidate || event.target.closest('input, button, label')) return;

            // Belt and braces: whatever left a row half open (a gesture the
            // system stole, a render that landed mid-swipe), touching it again
            // is the moment to make it whole. Never mid-flight, though - that
            // row is on its way out and snapping it back would be a flicker.
            if (!candidate.classList.contains('swipe-animating')) clearSwipe(candidate);

            row = candidate;
            startX = event.touches[0].clientX;
            startY = event.touches[0].clientY;
            deltaX = 0;
            swiping = false;
        }

        function onMove(event) {
            if (!row) return;

            deltaX = event.touches[0].clientX - startX;
            var deltaY = event.touches[0].clientY - startY;

            if (!swiping) {
                // Whichever axis wins first wins for the whole gesture. Without
                // that, drifting sideways halfway through a flick down the list
                // starts peeling rows open under the finger.
                if (Math.abs(deltaY) > 10 && Math.abs(deltaY) >= Math.abs(deltaX)) {
                    row = null;
                    return;
                }
                if (Math.abs(deltaX) <= 12 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.5) return;

                swiping = true;
                swipeActive = true;
                // Measured once per gesture: reading it back on every move made
                // the browser re-do layout in the middle of the animation.
                width = row.offsetWidth || 1;
                row.classList.add('swiping');
                row.style.transition = 'none';
            }

            // The row follows the finger both ways, and the strip fills the gap
            // it opens up behind it - red with a bin going left, green with a
            // tick going right.
            if (frame === null) frame = requestAnimationFrame(paint);
        }

        // Renders stay held back until the row has finished moving, not just
        // until the finger comes off: one landing mid-flight would reorder the
        // list around a row that is still in the air.
        function done() {
            if (swiping) return;
            swipeActive = false;
            flushRender();
        }

        /** Slide a half-open row shut. */
        function settle(target) {
            // The move set transition: none inline to keep the row glued to the
            // finger. Drop it and let the browser take the new value in before
            // the transform goes back, or there is nothing to animate from and
            // the row snaps home - or worse, stays exactly where it was let go.
            target.style.transition = '';
            target.classList.add('swipe-animating');
            void target.offsetWidth;
            clearSwipe(target);
            setTimeout(function () {
                target.classList.remove('swipe-animating');
                done();
            }, 220);
        }

        function onEnd() {
            if (!row) return;

            var target = row;
            var travelled = deltaX;
            row = null;
            stopPaint();

            if (!swiping) return;
            swiping = false;

            if (Math.abs(travelled) <= width * SWIPE_THRESHOLD) {
                // Close the gap at once: a strip left standing beside a row that
                // is already home would read as a second, phantom row.
                settle(target);
                return;
            }

            var id = Number(target.dataset.id);
            var list = activeList();
            var item = list && findItem(list, id);

            // Let the strip grow to the row's full width, so the colour is what
            // is left standing in its place as it flies off.
            target.style.transition = '';
            target.classList.add('swipe-animating');
            void target.offsetWidth;
            target.style.setProperty('--swipe-w', width + 'px');
            target.style.setProperty('--swipe-p', '1');
            target.style.transform = 'translateX(' + (travelled < 0 ? '-100%' : '100%') + ')';
            target.style.opacity = '0';

            if (travelled < 0) {
                setTimeout(function () {
                    done();
                    deleteItem(id);
                }, 200);
                return;
            }

            setTimeout(function () {
                // Unlike a delete, this row is not going away - it only moves
                // between the two lists, and rows are reused across renders. So
                // it has to be put back on screen before the toggle re-renders
                // it, or it would arrive there still flung aside and invisible.
                target.style.transition = 'none';
                target.classList.remove('swipe-animating');
                clearSwipe(target);
                void target.offsetWidth;
                target.style.transition = '';
                done();
                if (item) toggleChecked(id, !item.checked);
            }, 200);
        }

        function onCancel() {
            // Nothing else fires once the system takes the gesture over (an edge
            // swipe turning into a back navigation is the usual one), so without
            // this the row would sit half open until something re-rendered it.
            if (!row) return;
            var target = row;
            row = null;
            stopPaint();
            if (!swiping) return;
            swiping = false;
            settle(target);
        }

        [ui.items, ui.bought].forEach(function (container) {
            container.addEventListener('touchstart', onStart, { passive: true });
            container.addEventListener('touchmove', onMove, { passive: true });
            container.addEventListener('touchend', onEnd);
            container.addEventListener('touchcancel', onCancel, { passive: true });
        });
    }

    // ===================================================================== //
    // Row gestures: double tap or hold opens edit (touch only)
    //
    // Phones hide the Edit button to keep rows compact, so these two stand in
    // for it there - the double tap toggles the form, the hold only ever opens
    // it. Both work in the bought list too, since a row keeps its quantity and
    // price after it has been ticked off.
    //
    // The name field is deaf to taps on touch (see custom.css) because brushing
    // it while scrolling used to pop the keyboard open. Opening the form is what
    // hands it back, so renaming stays a deliberate act.
    // ===================================================================== //

    var HOLD_MS = 500;

    function setupTapToggle() {
        var lastId = null;
        var lastTap = 0;
        var startX = 0;
        var startY = 0;
        var moved = false;
        var holdTimer = null;
        var held = false;

        function cancelHold() {
            clearTimeout(holdTimer);
            holdTimer = null;
        }

        function beginEdit(row) {
            // Set before anything can bail out: whatever comes of the hold, the
            // touch that ends it is no longer a tap.
            held = true;
            var editButton = row.querySelector('.item-edit');
            if (!editButton || row.classList.contains('editing')) return;

            // Same thing the button does, so the row's state and labels stay in
            // step - a hold opens the form, it never closes it again.
            editButton.click();
            // A short buzz is what tells you the hold registered.
            if (navigator.vibrate) navigator.vibrate(12);
        }

        function onStart(event) {
            if (event.touches.length !== 1) return;
            startX = event.touches[0].clientX;
            startY = event.touches[0].clientY;
            moved = false;
            held = false;

            var row = event.target.closest('.item');
            cancelHold();
            if (!row || event.target.closest('input, button, label')) return;
            holdTimer = setTimeout(function () { beginEdit(row); }, HOLD_MS);
        }

        function onMove(event) {
            if (event.touches.length !== 1) return;
            if (Math.abs(event.touches[0].clientX - startX) > 10
                || Math.abs(event.touches[0].clientY - startY) > 10) {
                moved = true;
                cancelHold();
            }
        }

        function onEnd(event) {
            cancelHold();

            var row = event.target.closest('.item');
            // A swipe, a drag or a hold is not a tap, and the buttons and the
            // fields already have their own jobs - double tapping a word inside
            // one of them is the browser selecting text, not a gesture.
            if (!row || moved || held || event.target.closest('input, button, label')) return;

            var id = Number(row.dataset.id);
            var now = Date.now();

            if (id !== lastId || now - lastTap > 350) {
                lastId = id;
                lastTap = now;
                return;
            }

            lastId = null;
            var editButton = row.querySelector('.item-edit');
            if (!editButton) return;

            // Stop the tap from landing on anything underneath, and drop the
            // keyboard if the row was mid-rename.
            event.preventDefault();
            if (document.activeElement && row.contains(document.activeElement)) {
                document.activeElement.blur();
            }
            // Going through the button rather than the class keeps its label and
            // aria state in step: on phones it is hidden, not gone.
            editButton.click();
        }

        [ui.items, ui.bought].forEach(function (container) {
            container.addEventListener('touchstart', onStart, { passive: true });
            container.addEventListener('touchmove', onMove, { passive: true });
            container.addEventListener('touchend', onEnd);
            container.addEventListener('touchcancel', cancelHold, { passive: true });
        });
    }

    // ===================================================================== //
    // Export
    // ===================================================================== //

    function listAsText(list) {
        var lines = [list.name, ''];

        list.items.forEach(function (item) {
            lines.push(
                (item.checked ? '[x] ' : '[ ] ') +
                quantityText(item.quantity) + ' x ' + item.name +
                (item.price ? '  -  ' + money(item.quantity * item.price) : '')
            );
        });

        var total = list.items.reduce(function (sum, item) { return sum + item.quantity * item.price; }, 0);
        lines.push('', 'Total: ' + money(total));
        return lines.join('\n');
    }

    function copyList() {
        var list = activeList();
        if (!list) return;

        var text = listAsText(list);
        var done = function () { toast('List copied to the clipboard', 'success'); };

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
        } else {
            fallbackCopy(text, done);
        }
    }

    function fallbackCopy(text, done) {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();

        try {
            document.execCommand('copy');
            done();
        } catch (error) {
            toast('Could not copy the list', 'error');
        }

        area.remove();
    }

    function exportCsv() {
        var list = activeList();
        if (!list) return;

        function cell(value) {
            return '"' + String(value).replace(/"/g, '""') + '"';
        }

        var rows = [['Item', 'Quantity', 'Price', 'Total', 'Bought'].map(cell).join(',')];

        list.items.forEach(function (item) {
            rows.push([
                cell(item.name),
                cell(quantityText(item.quantity)),
                cell(Number(item.price).toFixed(2)),
                cell((item.quantity * item.price).toFixed(2)),
                cell(item.checked ? 'yes' : 'no')
            ].join(','));
        });

        var blob = new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = list.name.replace(/[^\w\d -]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() + '.csv';
        document.body.appendChild(link);
        link.click();
        setTimeout(function () {
            URL.revokeObjectURL(link.href);
            link.remove();
        }, 0);
    }

    // ===================================================================== //
    // Preferences
    // ===================================================================== //

    function sinkChecked() {
        return storageGet('sinkChecked', '1') === '1';
    }

    function toggleSinkChecked() {
        storageSet('sinkChecked', sinkChecked() ? '0' : '1');
        updateMenuLabels();
        render();
    }

    function updateMenuLabels() {
        var button = ui.menu.querySelector('[data-action="toggle-sink"] .menu-item-state');
        if (button) button.textContent = sinkChecked() ? 'On' : 'Off';
    }

    function applyTheme(theme) {
        if (theme) {
            document.documentElement.dataset.theme = theme;
            storageSet('theme', theme);
        } else {
            delete document.documentElement.dataset.theme;
            storageSet('theme', '');
        }
    }

    function toggleTheme() {
        var current = document.documentElement.dataset.theme;
        if (!current) {
            var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            current = prefersDark ? 'dark' : 'light';
        }
        applyTheme(current === 'dark' ? 'light' : 'dark');
    }

    function saveDraft() {
        var list = activeList();
        if (!list) return;
        storageSet('draft-' + list.id, JSON.stringify({
            name: ui.newName.value,
            quantity: ui.newQuantity.value,
            price: ui.newPrice.value
        }));
    }

    function loadDraft() {
        var list = activeList();
        if (!list) return;

        try {
            var draft = JSON.parse(storageGet('draft-' + list.id, 'null'));
            if (!draft) return;
            ui.newName.value = draft.name || '';
            ui.newQuantity.value = draft.quantity || '1';
            ui.newPrice.value = draft.price || '';
        } catch (error) { /* ignore malformed drafts */ }
    }

    // The quantity/price fields (and Add button) only appear once there's a
    // name to add — keeps the composer to a single line until it's needed.
    function syncComposerFields() {
        var expanded = ui.newName.value.trim() !== ''
            || document.activeElement === ui.newQuantity
            || document.activeElement === ui.newPrice;
        var grew = expanded && !ui.composer.classList.contains('expanded');
        ui.composer.classList.toggle('expanded', expanded);
        // Typing the first letter adds a whole row (qty/price/Add) under the
        // input, which on a phone appears behind the keyboard.
        if (grew) revealComposer();
    }

    /** Bottom of what the browser is actually showing, i.e. above the keyboard. */
    function visibleBottom() {
        var vv = window.visualViewport;
        // While pinch-zoomed the visual viewport is not a keyboard measurement.
        if (!vv || vv.scale > 1.05) return window.innerHeight;
        return vv.offsetTop + vv.height;
    }

    var revealTimer = null;

    // Nudge the page up so the Add button clears the keyboard. Deliberately a
    // one-shot, and late enough that the browser's own focus scroll has settled:
    // correcting continuously (on visualViewport events) means fighting that
    // scroll, which shows up as the page juddering at the bottom.
    function revealComposer() {
        if (ui.composer.hidden || revealTimer) return;
        revealTimer = setTimeout(function () {
            revealTimer = null;
            if (ui.composer.hidden) return;
            var overflow = ui.composer.getBoundingClientRect().bottom + 12 - visibleBottom();
            // Ignore absurd corrections: those mean the composer is simply
            // scrolled away, not hidden by a hair behind the keyboard.
            if (overflow > 1 && overflow < 400) window.scrollBy(0, overflow);
        }, 350);
    }

    // A large built-in grocery list, bundled here (and cached by the service
    // worker) so suggestions keep working with no network.
    var GROCERIES = [
        // Fruit
        'Apples', 'Green apples', 'Red apples', 'Fuji apples', 'Gala apples', 'Bananas',
        'Plantains', 'Oranges', 'Blood orange', 'Mandarins', 'Tangerines', 'Clementines',
        'Lemons', 'Limes', 'Key lime', 'Grapefruit', 'Grapes', 'Green grapes', 'Red grapes',
        'Seedless grapes', 'Strawberries', 'Blueberries', 'Raspberries', 'Blackberries',
        'Cranberries', 'Mixed berries', 'Pineapple', 'Mango', 'Papaya', 'Avocado', 'Pears',
        'Peaches', 'Nectarines', 'Apricots', 'Plums', 'Prunes', 'Cherries', 'Watermelon',
        'Cantaloupe', 'Honeydew melon', 'Kiwi', 'Golden kiwi', 'Pomegranate', 'Figs',
        'Coconut', 'Passion fruit', 'Guava', 'Lychee', 'Persimmon', 'Dragon fruit',
        'Star fruit', 'Rhubarb', 'Currants', 'Gooseberries', 'Dates', 'Jackfruit',
        'Acerola', 'Soursop', 'Cupuacu', 'Acai', 'Tamarind', 'Quince', 'Mangosteen',
        'Cactus pear', 'Cashew fruit', 'Elderberry',
        // Vegetables
        'Tomatoes', 'Cherry tomatoes', 'Roma tomatoes', 'Grape tomatoes', 'Potatoes',
        'Russet potatoes', 'Red potatoes', 'Yukon potatoes', 'Baby potatoes',
        'Sweet potatoes', 'Yams', 'Cassava', 'Yuca', 'Taro', 'Onions', 'Red onions',
        'White onions', 'Yellow onions', 'Green onions', 'Pearl onions', 'Shallots',
        'Garlic', 'Ginger', 'Carrots', 'Baby carrots', 'Celery', 'Broccoli', 'Broccolini',
        'Cauliflower', 'Brussels sprouts', 'Spinach', 'Baby spinach', 'Lettuce',
        'Romaine lettuce', 'Iceberg lettuce', 'Butter lettuce', 'Arugula', 'Kale',
        'Baby kale', 'Swiss chard', 'Collard greens', 'Mustard greens', 'Watercress',
        'Radicchio', 'Endive', 'Mixed greens', 'Microgreens', 'Cabbage', 'Red cabbage',
        'Green cabbage', 'Savoy cabbage', 'Napa cabbage', 'Bok choy', 'Cucumber',
        'Zucchini', 'Yellow squash', 'Butternut squash', 'Acorn squash', 'Spaghetti squash',
        'Pumpkin', 'Squash blossoms', 'Chayote', 'Bell peppers', 'Red bell pepper',
        'Green bell pepper', 'Yellow bell pepper', 'Jalapenos', 'Serrano peppers',
        'Habanero peppers', 'Poblano peppers', 'Chili peppers', 'Mushrooms',
        'Portobello mushrooms', 'Shiitake mushrooms', 'Cremini mushrooms',
        'Oyster mushrooms', 'Green beans', 'Snap peas', 'Snow peas', 'Sugar snap peas',
        'Peas', 'Fava beans', 'Lima beans', 'Edamame', 'Corn', 'Corn on the cob',
        'Sweet corn', 'Asparagus', 'Eggplant', 'Okra', 'Artichokes', 'Hearts of palm',
        'Beets', 'Radishes', 'Daikon', 'Turnips', 'Parsnips', 'Rutabaga', 'Kohlrabi',
        'Leeks', 'Fennel', 'Celeriac', 'Horseradish root', 'Bean sprouts',
        'Alfalfa sprouts',
        // Fresh herbs
        'Cilantro', 'Parsley', 'Basil', 'Mint', 'Rosemary', 'Thyme', 'Sage', 'Dill',
        'Chives', 'Tarragon', 'Oregano', 'Marjoram', 'Bay leaf', 'Lemongrass',
        'Curry leaves', 'Chervil', 'Sorrel', 'Chicory', 'Basil leaves', 'Fresh ginger',
        // Dairy & eggs
        'Milk', 'Whole milk', 'Skim milk', '2% milk', 'Lactose-free milk', 'Powdered milk',
        'Almond milk', 'Soy milk', 'Oat milk', 'Coconut milk', 'Rice milk', 'Cashew milk',
        'Buttermilk', 'Half and half', 'Heavy cream', 'Whipping cream', 'Sour cream',
        'Clotted cream', 'Eggs', 'Egg whites', 'Free-range eggs', 'Quail eggs', 'Butter',
        'Unsalted butter', 'Salted butter', 'Margarine', 'Ghee', 'Cheese', 'Cheddar cheese',
        'Sharp cheddar', 'Mozzarella', 'Fresh mozzarella', 'Parmesan', 'Provolone',
        'Swiss cheese', 'Gouda', 'Brie', 'Camembert', 'Feta cheese', 'Goat cheese',
        'Blue cheese', 'Ricotta', 'Cream cheese', 'Cottage cheese', 'Mascarpone',
        'String cheese', 'Requeijao', 'Minas cheese', 'Curd cheese', 'Grated cheese',
        'Shredded cheese', 'Sliced cheese', 'Yogurt', 'Greek yogurt', 'Plain yogurt',
        'Vanilla yogurt', 'Fruit yogurt', 'Yogurt drink', 'Kefir', 'Condensed milk',
        'Evaporated milk', 'Whipped cream', 'Custard', 'Pudding', 'Flan', 'Dulce de leche',
        // Bakery
        'Bread', 'White bread', 'Whole wheat bread', 'Multigrain bread', 'Sourdough bread',
        'Rye bread', 'Brioche', 'Ciabatta', 'Baguette', 'French bread', 'Sliced bread',
        'Bagels', 'English muffins', 'Tortillas', 'Corn tortillas', 'Flour tortillas',
        'Pita bread', 'Naan', 'Flatbread', 'Croissants', 'Muffins', 'Blueberry muffins',
        'Banana bread', 'Cheese bread', 'Dinner rolls', 'Hamburger buns', 'Hot dog buns',
        'Buns', 'Rolls', 'Sweet bread', 'Cake', 'Birthday cake', 'Pound cake', 'Cupcakes',
        'Cookies', 'Brownies', 'Donuts', 'Pastries', 'Pie', 'Apple pie', 'Cheesecake',
        'Crackers', 'Breadsticks', 'Toast', 'Melba toast', 'Rusk', 'Panettone',
        'Sponge cake', 'Roll cake', 'Danish pastry', 'Scones', 'Biscuits', 'Puff pastry',
        'Pizza dough',
        // Meat & poultry
        'Chicken', 'Chicken breast', 'Chicken thighs', 'Chicken wings',
        'Chicken drumsticks', 'Whole chicken', 'Ground chicken', 'Rotisserie chicken',
        'Chicken liver', 'Chicken feet', 'Ground beef', 'Beef', 'Steak', 'Ribeye steak',
        'Sirloin steak', 'Filet mignon', 'Rump steak', 'Flank steak', 'Brisket',
        'Beef roast', 'Beef ribs', 'Stew meat', 'Oxtail', 'Beef tongue', 'Beef liver',
        'Ground turkey', 'Turkey', 'Turkey breast', 'Duck', 'Quail', 'Rabbit', 'Lamb',
        'Lamb chops', 'Leg of lamb', 'Goat meat', 'Veal', 'Pork', 'Pork chops', 'Pork loin',
        'Pork ribs', 'Pork belly', 'Ground pork', 'Pork shoulder', 'Pork tenderloin',
        'Bacon', 'Ham', 'Smoked ham', 'Prosciutto', 'Turkey breast deli', 'Mortadella',
        'Sausages', 'Italian sausage', 'Breakfast sausage', 'Chorizo', 'Salami',
        'Pepperoni', 'Hot dogs', 'Blood sausage', 'Calabresa sausage', 'Pancetta',
        // Seafood
        'Salmon', 'Smoked salmon', 'Salmon fillet', 'Tuna', 'Tuna steak', 'Shrimp',
        'Jumbo shrimp', 'Crab', 'Crab meat', 'Lobster', 'Scallops', 'Mussels', 'Clams',
        'Oysters', 'Squid', 'Octopus', 'Fish', 'Cod', 'Salted cod', 'Tilapia', 'Halibut',
        'Trout', 'Sea bass', 'Snapper', 'Grouper', 'Mackerel', 'Sardines', 'Anchovies',
        'Herring', 'Catfish', 'Hake', 'Fish fillet', 'Fish sticks', 'Crab sticks', 'Caviar',
        'Fish roe',
        // Deli & plant protein
        'Tofu', 'Firm tofu', 'Silken tofu', 'Tempeh', 'Seitan', 'Veggie burgers',
        'Plant-based sausage', 'Plant-based ground', 'Textured soy protein', 'Deli meat',
        'Sliced turkey', 'Sliced ham', 'Roast beef', 'Pastrami', 'Liverwurst',
        'Chicken nuggets', 'Meatballs', 'Hummus', 'Falafel', 'Edamame beans',
        // Grains, rice & pasta
        'Rice', 'White rice', 'Brown rice', 'Basmati rice', 'Jasmine rice', 'Arborio rice',
        'Wild rice', 'Parboiled rice', 'Sushi rice', 'Quinoa', 'Couscous',
        'Moroccan couscous', 'Bulgur', 'Barley', 'Farro', 'Millet', 'Oats', 'Rolled oats',
        'Steel-cut oats', 'Cornmeal', 'Polenta', 'Semolina', 'Tapioca', 'Tapioca flour',
        'Pasta', 'Spaghetti', 'Penne', 'Fusilli', 'Macaroni', 'Rigatoni', 'Farfalle',
        'Lasagna noodles', 'Fettuccine', 'Linguine', 'Angel hair pasta', 'Egg noodles',
        'Rice noodles', 'Ramen noodles', 'Instant noodles', 'Udon noodles', 'Soba noodles',
        'Orzo', 'Gnocchi', 'Ravioli', 'Tortellini', 'Cannelloni', 'Flour',
        'All-purpose flour', 'Whole wheat flour', 'Bread flour', 'Self-rising flour',
        'Almond flour', 'Cassava flour', 'Corn flour', 'Chickpea flour', 'Rice flour',
        'Wheat germ', 'Bran',
        // Breakfast & cereal
        'Cereal', 'Cornflakes', 'Granola', 'Muesli', 'Oatmeal', 'Instant oatmeal',
        'Chocolate cereal', 'Bran flakes', 'Puffed rice', 'Pancake mix', 'Waffle mix',
        'Hash browns', 'Breakfast bars', 'Toaster pastries', 'Maple syrup', 'Honey', 'Jam',
        'Strawberry jam', 'Grape jelly', 'Marmalade', 'Peanut butter', 'Almond butter',
        'Nutella', 'Chocolate spread', 'Cocoa powder drink', 'Coffee creamer',
        'Powdered chocolate', 'Breakfast biscuits', 'Croutons', 'Tapioca starch',
        // Canned & jarred
        'Canned tomatoes', 'Diced tomatoes', 'Crushed tomatoes', 'Tomato sauce',
        'Tomato paste', 'Tomato puree', 'Pasta sauce', 'Marinara sauce', 'Alfredo sauce',
        'Pizza sauce', 'Canned beans', 'Black beans', 'Kidney beans', 'Pinto beans',
        'Cannellini beans', 'Chickpeas', 'Refried beans', 'Baked beans', 'Lentils',
        'Split peas', 'Canned corn', 'Canned peas', 'Canned carrots', 'Canned mushrooms',
        'Canned tuna', 'Canned sardines', 'Canned salmon', 'Canned chicken', 'Canned soup',
        'Chicken noodle soup', 'Tomato soup', 'Broth', 'Chicken broth', 'Beef broth',
        'Vegetable broth', 'Bone broth', 'Coconut cream', 'Canned coconut milk',
        'Canned pineapple', 'Canned peaches', 'Fruit cocktail', 'Applesauce', 'Olives',
        'Green olives', 'Black olives', 'Pickles', 'Capers', 'Sun-dried tomatoes',
        'Roasted red peppers', 'Artichoke hearts', 'Water chestnuts', 'Bamboo shoots',
        'Sauerkraut', 'Pickled beets', 'Corn kernels', 'Green peas jar', 'Jackfruit canned',
        // Oils, vinegars & condiments
        'Olive oil', 'Extra virgin olive oil', 'Vegetable oil', 'Canola oil', 'Coconut oil',
        'Avocado oil', 'Sesame oil', 'Sunflower oil', 'Soybean oil', 'Corn oil',
        'Cooking spray', 'Vinegar', 'White vinegar', 'Apple cider vinegar',
        'Balsamic vinegar', 'Red wine vinegar', 'Rice vinegar', 'Soy sauce', 'Tamari',
        'Teriyaki sauce', 'Fish sauce', 'Oyster sauce', 'Hoisin sauce',
        'Worcestershire sauce', 'Ketchup', 'Mustard', 'Dijon mustard', 'Yellow mustard',
        'Honey mustard', 'Mayonnaise', 'Garlic mayonnaise', 'Ranch dressing',
        'Caesar dressing', 'Italian dressing', 'Vinaigrette', 'Salad dressing', 'Hot sauce',
        'Sriracha', 'Tabasco', 'Buffalo sauce', 'Barbecue sauce', 'Steak sauce',
        'Tartar sauce', 'Cocktail sauce', 'Salsa', 'Salsa verde', 'Chimichurri',
        'Guacamole', 'Pesto', 'Tahini', 'Chili garlic sauce', 'Sweet chili sauce', 'Gravy',
        'Maple syrup topping', 'Agave nectar', 'Molasses', 'Corn syrup', 'Coconut aminos',
        'Relish', 'Horseradish sauce',
        // Spices & seasonings
        'Salt', 'Sea salt', 'Kosher salt', 'Pink salt', 'Black pepper', 'White pepper',
        'Cinnamon', 'Ground cinnamon', 'Nutmeg', 'Ground ginger', 'Cloves', 'Allspice',
        'Cardamom', 'Cumin', 'Coriander', 'Paprika', 'Smoked paprika', 'Sweet paprika',
        'Cayenne pepper', 'Chili powder', 'Red pepper flakes', 'Curry powder',
        'Garam masala', 'Turmeric', 'Saffron', 'Garlic powder', 'Onion powder',
        'Dried oregano', 'Dried basil', 'Dried thyme', 'Dried rosemary', 'Dried parsley',
        'Bay leaves', 'Italian seasoning', 'Taco seasoning', 'Cajun seasoning',
        'Chicken seasoning', 'Meat seasoning', 'All-purpose seasoning', 'Garlic salt',
        'Seasoned salt', 'Bouillon cubes', 'Vegetable seasoning', 'Fennel seeds',
        'Sesame seeds', 'Poppy seeds', 'Mustard seeds', 'Chia seeds', 'Flax seeds',
        'Sunflower seeds', 'Pumpkin seeds', 'Star anise', 'Anise', 'Vanilla beans',
        'Peppercorns', 'Dried chili', 'Za\'atar', 'Sumac', 'Nutritional yeast',
        // Baking
        'Sugar', 'Brown sugar', 'Powdered sugar', 'Cane sugar', 'Coconut sugar',
        'Demerara sugar', 'Stevia', 'Sweetener', 'Baking soda', 'Baking powder', 'Yeast',
        'Active dry yeast', 'Fresh yeast', 'Vanilla extract', 'Almond extract',
        'Cocoa powder', 'Chocolate chips', 'White chocolate chips', 'Baking chocolate',
        'Cornstarch', 'Breadcrumbs', 'Panko', 'Gelatin', 'Agar agar', 'Food coloring',
        'Sprinkles', 'Cake mix', 'Brownie mix', 'Frosting', 'Pie crust',
        'Condensed milk baking', 'Shredded coconut', 'Marzipan', 'Fondant',
        'Whipping cream powder', 'Powdered milk baking', 'Raisins', 'Dried cranberries',
        'Candied fruit', 'Chocolate sprinkles', 'Golden syrup',
        // Snacks
        'Chips', 'Potato chips', 'Tortilla chips', 'Corn chips', 'Pita chips',
        'Cheese puffs', 'Popcorn', 'Microwave popcorn', 'Pretzels', 'Rice cakes', 'Nuts',
        'Almonds', 'Peanuts', 'Roasted peanuts', 'Cashews', 'Brazil nuts', 'Walnuts',
        'Pecans', 'Pistachios', 'Macadamia nuts', 'Hazelnuts', 'Pine nuts', 'Mixed nuts',
        'Trail mix', 'Granola bars', 'Protein bars', 'Cereal bars', 'Fruit snacks',
        'Crackers snack', 'Cheese crackers', 'Beef jerky', 'Seaweed snack', 'Dried fruit',
        'Banana chips', 'Vegetable chips', 'Rice crackers',
        // Sweets & candy
        'Chocolate', 'Dark chocolate', 'Milk chocolate', 'White chocolate', 'Chocolate bar',
        'Chocolate truffles', 'Candy', 'Gummy bears', 'Lollipops', 'Hard candy', 'Caramel',
        'Toffee', 'Gum', 'Mints', 'Marshmallows', 'Cookies sweet', 'Wafer',
        'Chocolate cookies', 'Brigadeiro', 'Condensed milk candy', 'Honey candy',
        'Jellybeans', 'Licorice', 'Fudge', 'Nougat', 'Peanut brittle', 'Coconut candy',
        'Guava paste', 'Quince paste', 'Chocolate wafer',
        // Frozen
        'Frozen vegetables', 'Frozen peas', 'Frozen corn', 'Frozen broccoli',
        'Frozen spinach', 'Frozen mixed vegetables', 'Frozen green beans', 'Frozen fruit',
        'Frozen berries', 'Frozen strawberries', 'Frozen mango', 'Frozen acai',
        'Frozen pizza', 'French fries', 'Tater tots', 'Onion rings', 'Frozen chicken',
        'Frozen nuggets', 'Fish sticks frozen', 'Frozen fish', 'Frozen shrimp',
        'Frozen waffles', 'Frozen pancakes', 'Frozen burritos', 'Frozen lasagna',
        'Frozen dinners', 'Frozen dumplings', 'Frozen pastry', 'Ice cream',
        'Chocolate ice cream', 'Vanilla ice cream', 'Popsicles', 'Ice cream sandwiches',
        'Frozen yogurt', 'Ice', 'Ice cubes', 'Frozen bread dough', 'Frozen pie',
        'Frozen meatballs', 'Frozen spring rolls',
        // Beverages
        'Water', 'Bottled water', 'Sparkling water', 'Still water', 'Flavored water',
        'Juice', 'Orange juice', 'Apple juice', 'Grape juice', 'Cranberry juice',
        'Pineapple juice', 'Mango juice', 'Passion fruit juice', 'Lemon juice',
        'Grapefruit juice', 'Tomato juice', 'Coconut water', 'Lemonade', 'Iced tea',
        'Powdered juice', 'Juice box', 'Coffee', 'Ground coffee', 'Coffee beans',
        'Instant coffee', 'Coffee pods', 'Cold brew', 'Decaf coffee', 'Tea', 'Green tea',
        'Black tea', 'Herbal tea', 'Chamomile tea', 'Peppermint tea', 'Hibiscus tea',
        'Mate tea', 'Matcha', 'Soda', 'Cola', 'Diet soda', 'Guarana soda', 'Lemon soda',
        'Ginger ale', 'Root beer', 'Tonic water', 'Club soda', 'Energy drink',
        'Sports drink', 'Kombucha', 'Smoothie', 'Milkshake', 'Hot chocolate',
        'Chocolate milk', 'Protein shake',
        // Alcohol
        'Beer', 'Light beer', 'Craft beer', 'Wine', 'Red wine', 'White wine', 'Rose wine',
        'Sparkling wine', 'Champagne', 'Prosecco', 'Whiskey', 'Vodka', 'Rum', 'Cachaca',
        'Gin', 'Tequila', 'Cognac', 'Liqueur', 'Vermouth', 'Cider', 'Sangria', 'Sake',
        // Household & cleaning
        'Dish soap', 'Dishwasher detergent', 'Dishwasher tablets', 'Rinse aid',
        'Laundry detergent', 'Liquid detergent', 'Laundry pods', 'Fabric softener',
        'Dryer sheets', 'Stain remover', 'Bleach', 'Oxygen bleach', 'All-purpose cleaner',
        'Glass cleaner', 'Bathroom cleaner', 'Toilet cleaner', 'Floor cleaner',
        'Wood cleaner', 'Disinfectant', 'Disinfectant wipes', 'Multi-surface spray',
        'Degreaser', 'Furniture polish', 'Descaler', 'Drain cleaner', 'Air freshener',
        'Scented candles', 'Insect spray', 'Ant killer', 'Mothballs', 'Sponges',
        'Steel wool', 'Scrub brush', 'Cleaning cloths', 'Microfiber cloth', 'Dust cloth',
        'Broom', 'Mop', 'Dustpan', 'Bucket', 'Rubber gloves', 'Clothespins',
        'Laundry basket', 'Batteries', 'Light bulbs', 'Matches', 'Lighter', 'Duct tape',
        'Super glue', 'Trash bags', 'Garbage bags',
        // Paper & kitchen supplies
        'Paper towels', 'Toilet paper', 'Facial tissues', 'Napkins', 'Paper plates',
        'Paper cups', 'Plastic cups', 'Plastic cutlery', 'Plastic wrap', 'Aluminum foil',
        'Parchment paper', 'Wax paper', 'Sandwich bags', 'Freezer bags', 'Storage bags',
        'Vacuum bags', 'Food containers', 'Straws', 'Toothpicks', 'Coffee filters',
        'Baking cups', 'Skewers', 'Ice cube trays', 'Kitchen twine',
        // Personal care
        'Shampoo', 'Conditioner', 'Dry shampoo', 'Hair mask', 'Leave-in conditioner',
        'Hair oil', 'Hairspray', 'Hair gel', 'Hair mousse', 'Body wash', 'Bar soap',
        'Hand soap', 'Hand sanitizer', 'Body lotion', 'Face lotion', 'Hand cream',
        'Foot cream', 'Sunscreen', 'After-sun lotion', 'Toothpaste', 'Kids toothpaste',
        'Toothbrush', 'Electric toothbrush heads', 'Mouthwash', 'Dental floss', 'Deodorant',
        'Antiperspirant', 'Roll-on deodorant', 'Razors', 'Razor blades', 'Shaving cream',
        'Shaving foam', 'Aftershave', 'Cotton balls', 'Cotton swabs', 'Makeup remover',
        'Face wash', 'Facial scrub', 'Moisturizer', 'Face serum', 'Lip balm',
        'Nail clippers', 'Nail file', 'Nail polish', 'Nail polish remover', 'Tweezers',
        'Comb', 'Hairbrush', 'Hair ties', 'Bobby pins', 'Perfume', 'Body spray',
        'Talcum powder', 'Feminine pads', 'Tampons', 'Panty liners', 'Menstrual cup',
        'Wet wipes',
        // Health & pharmacy
        'Vitamins', 'Multivitamins', 'Vitamin C', 'Vitamin D', 'Vitamin B12',
        'Iron supplement', 'Calcium supplement', 'Magnesium', 'Zinc', 'Fish oil', 'Omega-3',
        'Probiotics', 'Collagen', 'Protein powder', 'Creatine', 'Pain reliever',
        'Ibuprofen', 'Acetaminophen', 'Aspirin', 'Dipyrone', 'Allergy medicine',
        'Cold medicine', 'Cough syrup', 'Throat lozenges', 'Nasal spray', 'Saline solution',
        'Antacid', 'Laxative', 'Anti-diarrhea', 'Motion sickness pills', 'Band-aids',
        'Bandages', 'Gauze', 'Medical tape', 'Antiseptic', 'Rubbing alcohol',
        'Hydrogen peroxide', 'Cotton pads', 'Thermometer', 'Eye drops',
        'Contact lens solution', 'Sunscreen stick', 'Insect repellent',
        // Baby
        'Diapers', 'Newborn diapers', 'Baby wipes', 'Baby formula', 'Baby food',
        'Baby cereal', 'Baby snacks', 'Baby lotion', 'Baby shampoo', 'Baby soap',
        'Diaper cream', 'Baby powder', 'Baby oil', 'Pacifiers', 'Baby bottles',
        'Bottle nipples', 'Teething gel', 'Baby cotton', 'Bibs', 'Baby detergent',
        // Pet
        'Dog food', 'Wet dog food', 'Dry dog food', 'Dog treats', 'Puppy food', 'Dog bones',
        'Cat food', 'Wet cat food', 'Dry cat food', 'Cat treats', 'Cat litter',
        'Pet shampoo', 'Flea treatment', 'Pet wipes', 'Bird seed', 'Fish food', 'Pee pads',
        'Poop bags', 'Pet toys', 'Cat scratcher',
        // International & specialty
        'Nori', 'Wakame', 'Pickled ginger', 'Wasabi', 'Miso paste', 'Rice paper',
        'Spring roll wrappers', 'Wonton wrappers', 'Dumpling wrappers', 'Kimchi',
        'Curry paste', 'Red curry paste', 'Coconut milk thai', 'Rice noodles thin',
        'Taco shells', 'Tortilla wraps', 'Enchilada sauce', 'Refried beans mexican',
        'Nacho cheese', 'Falafel mix', 'Tahini paste', 'Harissa', 'Couscous mix',
        'Polenta ready', 'Gnocchi ready', 'Plantain chips', 'Coconut cream specialty',
        'Dulce de leche jar', 'Yerba mate', 'Farofa', 'Cassava starch', 'Palm oil',
        'Cornstarch pudding mix', 'Panettone specialty', 'Chestnuts', 'Olive tapenade',
        'Anchovy paste', 'Curry sauce jar', 'Soy protein chunks', 'Gochujang',
        'Ponzu sauce', 'Masala chai',
        // More fruit & veg
        'Rambutan', 'Blackcurrant', 'Green papaya', 'Baby corn', 'Turnip greens',
        'Arracacha', 'Frisee', 'Green tomatoes',
        // More dairy & bakery
        'Processed cheese', 'Cheese spread', 'Focaccia', 'Cornbread', 'Pretzel bread',
        'Milk cream',
        // More meat & grains
        'Beef shank', 'Pork sausage', 'Dried beef', 'Vermicelli', 'Pearl couscous',
        // More pantry
        'Canned lentils', 'Canned chickpeas', 'Tomato passata', 'Garlic sauce',
        'Mint sauce', 'Apple butter', 'Herbs de Provence', 'Onion flakes',
        // More snacks & drinks
        'Cheese balls', 'Corn nuts', 'Chocolate coins', 'Almond drink', 'Barley water',
        'Ginger tea',
        // More household & care
        'Fabric spray', 'Shoe polish', 'Drain unclogger', 'Beard oil', 'Cuticle oil',
        'Vitamin E', 'Melatonin', 'Cat grass',
        // More fruit
        'Loquat', 'Sapodilla', 'Jabuticaba', 'Pitanga', 'Seriguela', 'Genipap',
        'Sugar apple', 'Custard apple', 'Physalis', 'Kumquat', 'Green coconut',
        'Silver banana', 'Nanica banana', 'Apple banana', 'Umbu', 'Buriti', 'Pequi',
        'Feijoa', 'Longan',
        // More vegetables
        'Bitter melon', 'Purslane', 'Escarole', 'Catalonia chicory', 'Amaranth leaves',
        'Jambu', 'Taro leaves', 'Purple yam', 'White yam', 'Purple sweet potato',
        'Lotus root', 'Nettle', 'Sword bean', 'Long beans',
        // More meat & seafood
        'Chicken heart', 'Chicken gizzard', 'Beef short ribs', 'Beef chuck',
        'Beef rump cap', 'Beef knuckle', 'Beef bottom round', 'Beef top round', 'Pork feet',
        'Pork ear', 'Smoked ribs', 'Cod fritters', 'Fish cake', 'Peeled shrimp',
        'Dried shrimp', 'Whole fish',
        // More pantry & prepared
        'Instant mashed potatoes', 'Ready rice', 'Boxed mac and cheese', 'Instant soup',
        'Ramen cup', 'Canned ravioli', 'Stuffing mix', 'Gravy mix', 'Bread mix',
        'Cornbread mix', 'Tapioca pearls', 'Pizza kit', 'Lasagna kit', 'Taco kit',
        'Pancake syrup', 'Ice cream topping', 'Cake sprinkles', 'Whipped topping',
        // More condiments & sauces
        'Aioli', 'Blue cheese dressing', 'Thousand island', 'Honey garlic sauce',
        'Peanut sauce', 'Plum sauce', 'Black bean sauce', 'Cranberry sauce', 'Cheese sauce',
        'White sauce', 'Bechamel', 'Bolognese sauce', 'Green pepper sauce', 'Wasabi mayo',
        // Household & office
        'Sponge cloths', 'Scouring pads', 'Toilet brush', 'Squeegee', 'Feather duster',
        'Trash can', 'Recycling bags', 'Extension cord', 'Power strip', 'AA batteries',
        'AAA batteries', '9V battery', 'LED bulb', 'Notebook', 'Pens', 'Pencils',
        'Sticky notes', 'Scissors', 'Envelopes', 'Printer paper', 'Glue stick', 'Markers',
        'Stapler', 'Paper clips',
        // Party & seasonal
        'Birthday candles', 'Party hats', 'Balloons', 'Party plates', 'Party cups',
        'Streamers', 'Gift wrap', 'Gift bags', 'Ribbon', 'Greeting cards',
        'Disposable tablecloth', 'Chocolate eggs', 'Nougat candy', 'Dried figs',
        'Christmas nuts',
        // Quantities, packs & sizes
        'Kilo of apples', 'Kilo of green apples', 'Kilo of red apples',
        'Kilo of fuji apples', 'Kilo of gala apples', 'Kilo of bananas',
        'Kilo of plantains', 'Kilo of oranges', 'Kilo of blood orange', 'Kilo of mandarins',
        'Kilo of tangerines', 'Kilo of clementines', 'Kilo of lemons', 'Kilo of limes',
        'Kilo of key lime', 'Kilo of grapefruit', 'Kilo of grapes', 'Kilo of green grapes',
        'Kilo of red grapes', 'Kilo of seedless grapes', 'Kilo of strawberries',
        'Kilo of blueberries', 'Kilo of raspberries', 'Kilo of blackberries',
        'Kilo of cranberries', 'Kilo of mixed berries', 'Kilo of pineapple',
        'Kilo of mango', 'Kilo of papaya', 'Kilo of avocado', 'Kilo of pears',
        'Kilo of peaches', 'Kilo of nectarines', 'Kilo of apricots', 'Kilo of plums',
        'Kilo of prunes', 'Kilo of cherries', 'Kilo of watermelon', 'Kilo of cantaloupe',
        'Kilo of honeydew melon', 'Kilo of kiwi', 'Kilo of golden kiwi',
        'Kilo of pomegranate', 'Kilo of figs', 'Kilo of coconut', 'Kilo of passion fruit',
        'Kilo of guava', 'Kilo of lychee', 'Kilo of persimmon', 'Kilo of dragon fruit',
        'Kilo of star fruit', 'Kilo of rhubarb', 'Kilo of currants', 'Kilo of gooseberries',
        'Kilo of dates', 'Kilo of jackfruit', 'Kilo of acerola', 'Kilo of soursop',
        'Kilo of cupuacu', 'Kilo of acai', 'Kilo of tamarind', 'Kilo of quince',
        'Kilo of mangosteen', 'Kilo of cactus pear', 'Kilo of cashew fruit',
        'Kilo of elderberry', 'Kilo of tomatoes', 'Kilo of cherry tomatoes',
        'Kilo of roma tomatoes', 'Kilo of grape tomatoes', 'Kilo of potatoes',
        'Kilo of russet potatoes', 'Kilo of red potatoes', 'Kilo of yukon potatoes',
        'Kilo of baby potatoes', 'Kilo of sweet potatoes', 'Kilo of yams',
        'Kilo of cassava', 'Kilo of yuca', 'Kilo of taro', 'Kilo of onions',
        'Kilo of red onions', 'Kilo of white onions', 'Kilo of yellow onions',
        'Kilo of green onions', 'Kilo of pearl onions', 'Kilo of shallots',
        'Kilo of garlic', 'Kilo of ginger', 'Kilo of carrots', 'Kilo of baby carrots',
        'Kilo of celery', 'Kilo of broccoli', 'Kilo of broccolini', 'Kilo of cauliflower',
        'Kilo of brussels sprouts', 'Kilo of spinach', 'Kilo of baby spinach',
        'Kilo of lettuce', 'Kilo of romaine lettuce', 'Kilo of iceberg lettuce',
        'Kilo of butter lettuce', 'Kilo of arugula', 'Kilo of kale', 'Kilo of baby kale',
        'Kilo of swiss chard', 'Kilo of collard greens', 'Kilo of mustard greens',
        'Kilo of watercress', 'Kilo of radicchio', 'Kilo of endive', 'Kilo of mixed greens',
        'Kilo of microgreens', 'Kilo of cabbage', 'Kilo of red cabbage',
        'Kilo of green cabbage', 'Kilo of savoy cabbage', 'Kilo of napa cabbage',
        'Kilo of bok choy', 'Kilo of cucumber', 'Kilo of zucchini', 'Kilo of yellow squash',
        'Kilo of butternut squash', 'Kilo of acorn squash', 'Kilo of spaghetti squash',
        'Kilo of pumpkin', 'Kilo of squash blossoms', 'Kilo of chayote',
        'Kilo of bell peppers', 'Kilo of red bell pepper', 'Kilo of green bell pepper',
        'Kilo of yellow bell pepper', 'Kilo of jalapenos', 'Kilo of serrano peppers',
        'Kilo of habanero peppers', 'Kilo of poblano peppers', 'Kilo of chili peppers',
        'Kilo of mushrooms', 'Kilo of portobello mushrooms', 'Kilo of shiitake mushrooms',
        'Kilo of cremini mushrooms', 'Kilo of oyster mushrooms', 'Kilo of green beans',
        'Kilo of snap peas', 'Kilo of snow peas', 'Kilo of sugar snap peas', 'Kilo of peas',
        'Kilo of fava beans', 'Kilo of lima beans', 'Kilo of edamame', 'Kilo of corn',
        'Kilo of corn on the cob', 'Kilo of sweet corn', 'Kilo of asparagus',
        'Kilo of eggplant', 'Kilo of okra', 'Kilo of artichokes', 'Kilo of hearts of palm',
        'Kilo of beets', 'Kilo of radishes', 'Kilo of daikon', 'Kilo of turnips',
        'Kilo of parsnips', 'Kilo of rutabaga', 'Kilo of kohlrabi', 'Kilo of leeks',
        'Kilo of fennel', 'Kilo of celeriac', 'Kilo of horseradish root',
        'Kilo of bean sprouts', 'Kilo of alfalfa sprouts', 'Bunch of cilantro',
        'Bunch of parsley', 'Bunch of basil', 'Bunch of mint', 'Bunch of rosemary',
        'Bunch of thyme', 'Bunch of sage', 'Bunch of dill', 'Bunch of chives',
        'Bunch of tarragon', 'Bunch of oregano', 'Bunch of marjoram', 'Bunch of bay leaf',
        'Bunch of lemongrass', 'Bunch of curry leaves', 'Bunch of chervil',
        'Bunch of sorrel', 'Bunch of chicory', 'Bunch of basil leaves',
        'Bunch of fresh ginger', 'Pack of milk', 'Pack of whole milk', 'Pack of skim milk',
        'Pack of 2% milk', 'Pack of lactose-free milk', 'Pack of powdered milk',
        'Pack of almond milk', 'Pack of soy milk', 'Pack of oat milk',
        'Pack of coconut milk', 'Pack of rice milk', 'Pack of cashew milk',
        'Pack of buttermilk', 'Pack of half and half', 'Pack of heavy cream',
        'Pack of whipping cream', 'Pack of sour cream', 'Pack of clotted cream',
        'Pack of eggs', 'Pack of egg whites', 'Pack of free-range eggs',
        'Pack of quail eggs', 'Pack of butter', 'Pack of unsalted butter',
        'Pack of salted butter', 'Pack of margarine', 'Pack of ghee', 'Pack of cheese',
        'Pack of cheddar cheese', 'Pack of sharp cheddar', 'Pack of mozzarella',
        'Pack of fresh mozzarella', 'Pack of parmesan', 'Pack of provolone',
        'Pack of swiss cheese', 'Pack of gouda', 'Pack of brie', 'Pack of camembert',
        'Pack of feta cheese', 'Pack of goat cheese', 'Pack of blue cheese',
        'Pack of ricotta', 'Pack of cream cheese', 'Pack of cottage cheese',
        'Pack of mascarpone', 'Pack of string cheese', 'Pack of requeijao',
        'Pack of minas cheese', 'Pack of curd cheese', 'Pack of grated cheese',
        'Pack of shredded cheese', 'Pack of sliced cheese', 'Pack of yogurt',
        'Pack of greek yogurt', 'Pack of plain yogurt', 'Pack of vanilla yogurt',
        'Pack of fruit yogurt', 'Pack of yogurt drink', 'Pack of kefir',
        'Pack of condensed milk', 'Pack of evaporated milk', 'Pack of whipped cream',
        'Pack of custard', 'Pack of pudding', 'Pack of flan', 'Pack of dulce de leche',
        'Pack of bread', 'Pack of white bread', 'Pack of whole wheat bread',
        'Pack of multigrain bread', 'Pack of sourdough bread', 'Pack of rye bread',
        'Pack of brioche', 'Pack of ciabatta', 'Pack of baguette', 'Pack of french bread',
        'Pack of sliced bread', 'Pack of bagels', 'Pack of english muffins',
        'Pack of tortillas', 'Pack of corn tortillas', 'Pack of flour tortillas',
        'Pack of pita bread', 'Pack of naan', 'Pack of flatbread', 'Pack of croissants',
        'Pack of muffins', 'Pack of blueberry muffins', 'Pack of banana bread',
        'Pack of cheese bread', 'Pack of dinner rolls', 'Pack of hamburger buns',
        'Pack of hot dog buns', 'Pack of buns', 'Pack of rolls', 'Pack of sweet bread',
        'Pack of cake', 'Pack of birthday cake', 'Pack of pound cake', 'Pack of cupcakes',
        'Pack of cookies', 'Pack of brownies', 'Pack of donuts', 'Pack of pastries',
        'Pack of pie', 'Pack of apple pie', 'Pack of cheesecake', 'Pack of crackers',
        'Pack of breadsticks', 'Pack of toast', 'Pack of melba toast', 'Pack of rusk',
        'Pack of panettone', 'Pack of sponge cake', 'Pack of roll cake',
        'Pack of danish pastry', 'Pack of scones', 'Pack of biscuits',
        'Pack of puff pastry', 'Pack of pizza dough', 'Kilo of chicken',
        'Kilo of chicken breast', 'Kilo of chicken thighs', 'Kilo of chicken wings',
        'Kilo of chicken drumsticks', 'Kilo of whole chicken', 'Kilo of ground chicken',
        'Kilo of rotisserie chicken', 'Kilo of chicken liver', 'Kilo of chicken feet',
        'Kilo of ground beef', 'Kilo of beef', 'Kilo of steak', 'Kilo of ribeye steak',
        'Kilo of sirloin steak', 'Kilo of filet mignon', 'Kilo of rump steak',
        'Kilo of flank steak', 'Kilo of brisket', 'Kilo of beef roast', 'Kilo of beef ribs',
        'Kilo of stew meat', 'Kilo of oxtail', 'Kilo of beef tongue', 'Kilo of beef liver',
        'Kilo of ground turkey', 'Kilo of turkey', 'Kilo of turkey breast', 'Kilo of duck',
        'Kilo of quail', 'Kilo of rabbit', 'Kilo of lamb', 'Kilo of lamb chops',
        'Kilo of leg of lamb', 'Kilo of goat meat', 'Kilo of veal', 'Kilo of pork',
        'Kilo of pork chops', 'Kilo of pork loin', 'Kilo of pork ribs',
        'Kilo of pork belly', 'Kilo of ground pork', 'Kilo of pork shoulder',
        'Kilo of pork tenderloin', 'Kilo of bacon', 'Kilo of ham', 'Kilo of smoked ham',
        'Kilo of prosciutto', 'Kilo of turkey breast deli', 'Kilo of mortadella',
        'Kilo of sausages', 'Kilo of italian sausage', 'Kilo of breakfast sausage',
        'Kilo of chorizo', 'Kilo of salami', 'Kilo of pepperoni', 'Kilo of hot dogs',
        'Kilo of blood sausage', 'Kilo of calabresa sausage', 'Kilo of pancetta',
        'Kilo of salmon', 'Kilo of smoked salmon', 'Kilo of salmon fillet', 'Kilo of tuna',
        'Kilo of tuna steak', 'Kilo of shrimp', 'Kilo of jumbo shrimp', 'Kilo of crab',
        'Kilo of crab meat', 'Kilo of lobster', 'Kilo of scallops', 'Kilo of mussels',
        'Kilo of clams', 'Kilo of oysters', 'Kilo of squid', 'Kilo of octopus',
        'Kilo of fish', 'Kilo of cod', 'Kilo of salted cod', 'Kilo of tilapia',
        'Kilo of halibut', 'Kilo of trout', 'Kilo of sea bass', 'Kilo of snapper',
        'Kilo of grouper', 'Kilo of mackerel', 'Kilo of sardines', 'Kilo of anchovies',
        'Kilo of herring', 'Kilo of catfish', 'Kilo of hake', 'Kilo of fish fillet',
        'Kilo of fish sticks', 'Kilo of crab sticks', 'Kilo of caviar', 'Kilo of fish roe',
        'Pack of tofu', 'Pack of firm tofu', 'Pack of silken tofu', 'Pack of tempeh',
        'Pack of seitan', 'Pack of veggie burgers', 'Pack of plant-based sausage',
        'Pack of plant-based ground', 'Pack of textured soy protein', 'Pack of deli meat',
        'Pack of sliced turkey', 'Pack of sliced ham', 'Pack of roast beef',
        'Pack of pastrami', 'Pack of liverwurst', 'Pack of chicken nuggets',
        'Pack of meatballs', 'Pack of hummus', 'Pack of falafel', 'Pack of edamame beans',
        'Pack of rice', 'Pack of white rice', 'Pack of brown rice', 'Pack of basmati rice',
        'Pack of jasmine rice', 'Pack of arborio rice', 'Pack of wild rice',
        'Pack of parboiled rice', 'Pack of sushi rice', 'Pack of quinoa',
        'Pack of couscous', 'Pack of moroccan couscous', 'Pack of bulgur', 'Pack of barley',
        'Pack of farro', 'Pack of millet', 'Pack of oats', 'Pack of rolled oats',
        'Pack of steel-cut oats', 'Pack of cornmeal', 'Pack of polenta', 'Pack of semolina',
        'Pack of tapioca', 'Pack of tapioca flour', 'Pack of pasta', 'Pack of spaghetti',
        'Pack of penne', 'Pack of fusilli', 'Pack of macaroni', 'Pack of rigatoni',
        'Pack of farfalle', 'Pack of lasagna noodles', 'Pack of fettuccine',
        'Pack of linguine', 'Pack of angel hair pasta', 'Pack of egg noodles',
        'Pack of rice noodles', 'Pack of ramen noodles', 'Pack of instant noodles',
        'Pack of udon noodles', 'Pack of soba noodles', 'Pack of orzo', 'Pack of gnocchi',
        'Pack of ravioli', 'Pack of tortellini', 'Pack of cannelloni', 'Pack of flour',
        'Pack of all-purpose flour', 'Pack of whole wheat flour', 'Pack of bread flour',
        'Pack of self-rising flour', 'Pack of almond flour', 'Pack of cassava flour',
        'Pack of corn flour', 'Pack of chickpea flour', 'Pack of rice flour',
        'Pack of wheat germ', 'Pack of bran', 'Box of cereal', 'Box of cornflakes',
        'Box of granola', 'Box of muesli', 'Box of oatmeal', 'Box of instant oatmeal',
        'Box of chocolate cereal', 'Box of bran flakes', 'Box of puffed rice',
        'Box of pancake mix', 'Box of waffle mix', 'Box of hash browns',
        'Box of breakfast bars', 'Box of toaster pastries', 'Box of maple syrup',
        'Box of honey', 'Box of jam', 'Box of strawberry jam', 'Box of grape jelly',
        'Box of marmalade', 'Box of peanut butter', 'Box of almond butter',
        'Box of nutella', 'Box of chocolate spread', 'Box of cocoa powder drink',
        'Box of coffee creamer', 'Box of powdered chocolate', 'Box of breakfast biscuits',
        'Box of croutons', 'Box of tapioca starch', 'Can of canned tomatoes',
        'Can of diced tomatoes', 'Can of crushed tomatoes', 'Can of tomato sauce',
        'Can of tomato paste', 'Can of tomato puree', 'Can of pasta sauce',
        'Can of marinara sauce', 'Can of alfredo sauce', 'Can of pizza sauce',
        'Can of canned beans', 'Can of black beans', 'Can of kidney beans',
        'Can of pinto beans', 'Can of cannellini beans', 'Can of chickpeas',
        'Can of refried beans', 'Can of baked beans', 'Can of lentils', 'Can of split peas',
        'Can of canned corn', 'Can of canned peas', 'Can of canned carrots',
        'Can of canned mushrooms', 'Can of canned tuna', 'Can of canned sardines',
        'Can of canned salmon', 'Can of canned chicken', 'Can of canned soup',
        'Can of chicken noodle soup', 'Can of tomato soup', 'Can of broth',
        'Can of chicken broth', 'Can of beef broth', 'Can of vegetable broth',
        'Can of bone broth', 'Can of coconut cream', 'Can of canned coconut milk',
        'Can of canned pineapple', 'Can of canned peaches', 'Can of fruit cocktail',
        'Can of applesauce', 'Can of olives', 'Can of green olives', 'Can of black olives',
        'Can of pickles', 'Can of capers', 'Can of sun-dried tomatoes',
        'Can of roasted red peppers', 'Can of artichoke hearts', 'Can of water chestnuts',
        'Can of bamboo shoots', 'Can of sauerkraut', 'Can of pickled beets',
        'Can of corn kernels', 'Can of green peas jar', 'Can of jackfruit canned',
        'Bottle of olive oil', 'Bottle of extra virgin olive oil',
        'Bottle of vegetable oil', 'Bottle of canola oil', 'Bottle of coconut oil',
        'Bottle of avocado oil', 'Bottle of sesame oil', 'Bottle of sunflower oil',
        'Bottle of soybean oil', 'Bottle of corn oil', 'Bottle of cooking spray',
        'Bottle of vinegar', 'Bottle of white vinegar', 'Bottle of apple cider vinegar',
        'Bottle of balsamic vinegar', 'Bottle of red wine vinegar',
        'Bottle of rice vinegar', 'Bottle of soy sauce', 'Bottle of tamari',
        'Bottle of teriyaki sauce', 'Bottle of fish sauce', 'Bottle of oyster sauce',
        'Bottle of hoisin sauce', 'Bottle of worcestershire sauce', 'Bottle of ketchup',
        'Bottle of mustard', 'Bottle of dijon mustard', 'Bottle of yellow mustard',
        'Bottle of honey mustard', 'Bottle of mayonnaise', 'Bottle of garlic mayonnaise',
        'Bottle of ranch dressing', 'Bottle of caesar dressing',
        'Bottle of italian dressing', 'Bottle of vinaigrette', 'Bottle of salad dressing',
        'Bottle of hot sauce', 'Bottle of sriracha', 'Bottle of tabasco',
        'Bottle of buffalo sauce', 'Bottle of barbecue sauce', 'Bottle of steak sauce',
        'Bottle of tartar sauce', 'Bottle of cocktail sauce', 'Bottle of salsa',
        'Bottle of salsa verde', 'Bottle of chimichurri', 'Bottle of guacamole',
        'Bottle of pesto', 'Bottle of tahini', 'Bottle of chili garlic sauce',
        'Bottle of sweet chili sauce', 'Bottle of gravy', 'Bottle of maple syrup topping',
        'Bottle of agave nectar', 'Bottle of molasses', 'Bottle of corn syrup',
        'Bottle of coconut aminos', 'Bottle of relish', 'Bottle of horseradish sauce',
        'Jar of salt', 'Jar of sea salt', 'Jar of kosher salt', 'Jar of pink salt',
        'Jar of black pepper', 'Jar of white pepper', 'Jar of cinnamon',
        'Jar of ground cinnamon', 'Jar of nutmeg', 'Jar of ground ginger', 'Jar of cloves',
        'Jar of allspice', 'Jar of cardamom', 'Jar of cumin', 'Jar of coriander',
        'Jar of paprika', 'Jar of smoked paprika', 'Jar of sweet paprika',
        'Jar of cayenne pepper', 'Jar of chili powder', 'Jar of red pepper flakes',
        'Jar of curry powder', 'Jar of garam masala', 'Jar of turmeric', 'Jar of saffron',
        'Jar of garlic powder', 'Jar of onion powder', 'Jar of dried oregano',
        'Jar of dried basil', 'Jar of dried thyme', 'Jar of dried rosemary',
        'Jar of dried parsley', 'Jar of bay leaves', 'Jar of italian seasoning',
        'Jar of taco seasoning', 'Jar of cajun seasoning', 'Jar of chicken seasoning',
        'Jar of meat seasoning', 'Jar of all-purpose seasoning', 'Jar of garlic salt',
        'Jar of seasoned salt', 'Jar of bouillon cubes', 'Jar of vegetable seasoning',
        'Jar of fennel seeds', 'Jar of sesame seeds', 'Jar of poppy seeds',
        'Jar of mustard seeds', 'Jar of chia seeds', 'Jar of flax seeds',
        'Jar of sunflower seeds', 'Jar of pumpkin seeds', 'Jar of star anise',
        'Jar of anise', 'Jar of vanilla beans', 'Jar of peppercorns', 'Jar of dried chili',
        'Jar of za\'atar', 'Jar of sumac', 'Jar of nutritional yeast', 'Pack of sugar',
        'Pack of brown sugar', 'Pack of powdered sugar', 'Pack of cane sugar',
        'Pack of coconut sugar', 'Pack of demerara sugar', 'Pack of stevia',
        'Pack of sweetener', 'Pack of baking soda', 'Pack of baking powder',
        'Pack of yeast', 'Pack of active dry yeast', 'Pack of fresh yeast',
        'Pack of vanilla extract', 'Pack of almond extract', 'Pack of cocoa powder',
        'Pack of chocolate chips', 'Pack of white chocolate chips',
        'Pack of baking chocolate', 'Pack of cornstarch', 'Pack of breadcrumbs',
        'Pack of panko', 'Pack of gelatin', 'Pack of agar agar', 'Pack of food coloring',
        'Pack of sprinkles', 'Pack of cake mix', 'Pack of brownie mix', 'Pack of frosting',
        'Pack of pie crust', 'Pack of condensed milk baking', 'Pack of shredded coconut',
        'Pack of marzipan', 'Pack of fondant', 'Pack of whipping cream powder',
        'Pack of powdered milk baking', 'Pack of raisins', 'Pack of dried cranberries',
        'Pack of candied fruit', 'Pack of chocolate sprinkles', 'Pack of golden syrup',
        'Pack of chips', 'Pack of potato chips', 'Pack of tortilla chips',
        'Pack of corn chips', 'Pack of pita chips', 'Pack of cheese puffs',
        'Pack of popcorn', 'Pack of microwave popcorn', 'Pack of pretzels',
        'Pack of rice cakes', 'Pack of nuts', 'Pack of almonds', 'Pack of peanuts',
        'Pack of roasted peanuts', 'Pack of cashews', 'Pack of brazil nuts',
        'Pack of walnuts', 'Pack of pecans', 'Pack of pistachios', 'Pack of macadamia nuts',
        'Pack of hazelnuts', 'Pack of pine nuts', 'Pack of mixed nuts', 'Pack of trail mix',
        'Pack of granola bars', 'Pack of protein bars', 'Pack of cereal bars',
        'Pack of fruit snacks', 'Pack of crackers snack', 'Pack of cheese crackers',
        'Pack of beef jerky', 'Pack of seaweed snack', 'Pack of dried fruit',
        'Pack of banana chips', 'Pack of vegetable chips', 'Pack of rice crackers',
        'Pack of chocolate', 'Pack of dark chocolate', 'Pack of milk chocolate',
        'Pack of white chocolate', 'Pack of chocolate bar', 'Pack of chocolate truffles',
        'Pack of candy', 'Pack of gummy bears', 'Pack of lollipops', 'Pack of hard candy',
        'Pack of caramel', 'Pack of toffee', 'Pack of gum', 'Pack of mints',
        'Pack of marshmallows', 'Pack of cookies sweet', 'Pack of wafer',
        'Pack of chocolate cookies', 'Pack of brigadeiro', 'Pack of condensed milk candy',
        'Pack of honey candy', 'Pack of jellybeans', 'Pack of licorice', 'Pack of fudge',
        'Pack of nougat', 'Pack of peanut brittle', 'Pack of coconut candy',
        'Pack of guava paste', 'Pack of quince paste', 'Pack of chocolate wafer',
        'Pack of frozen vegetables', 'Pack of frozen peas', 'Pack of frozen corn',
        'Pack of frozen broccoli', 'Pack of frozen spinach',
        'Pack of frozen mixed vegetables', 'Pack of frozen green beans',
        'Pack of frozen fruit', 'Pack of frozen berries', 'Pack of frozen strawberries',
        'Pack of frozen mango', 'Pack of frozen acai', 'Pack of frozen pizza',
        'Pack of french fries', 'Pack of tater tots', 'Pack of onion rings',
        'Pack of frozen chicken', 'Pack of frozen nuggets', 'Pack of fish sticks frozen',
        'Pack of frozen fish', 'Pack of frozen shrimp', 'Pack of frozen waffles',
        'Pack of frozen pancakes', 'Pack of frozen burritos', 'Pack of frozen lasagna',
        'Pack of frozen dinners', 'Pack of frozen dumplings', 'Pack of frozen pastry',
        'Pack of ice cream', 'Pack of chocolate ice cream', 'Pack of vanilla ice cream',
        'Pack of popsicles', 'Pack of ice cream sandwiches', 'Pack of frozen yogurt',
        'Pack of ice', 'Pack of ice cubes', 'Pack of frozen bread dough',
        'Pack of frozen pie', 'Pack of frozen meatballs', 'Pack of frozen spring rolls',
        'Bottle of water', 'Bottle of bottled water', 'Bottle of sparkling water',
        'Bottle of still water', 'Bottle of flavored water', 'Bottle of juice',
        'Bottle of orange juice', 'Bottle of apple juice', 'Bottle of grape juice',
        'Bottle of cranberry juice', 'Bottle of pineapple juice', 'Bottle of mango juice',
        'Bottle of passion fruit juice', 'Bottle of lemon juice',
        'Bottle of grapefruit juice', 'Bottle of tomato juice', 'Bottle of coconut water',
        'Bottle of lemonade', 'Bottle of iced tea', 'Bottle of powdered juice',
        'Bottle of juice box', 'Bottle of coffee', 'Bottle of ground coffee',
        'Bottle of coffee beans', 'Bottle of instant coffee', 'Bottle of coffee pods',
        'Bottle of cold brew', 'Bottle of decaf coffee', 'Bottle of tea',
        'Bottle of green tea', 'Bottle of black tea', 'Bottle of herbal tea',
        'Bottle of chamomile tea', 'Bottle of peppermint tea', 'Bottle of hibiscus tea',
        'Bottle of mate tea', 'Bottle of matcha', 'Bottle of soda', 'Bottle of cola',
        'Bottle of diet soda', 'Bottle of guarana soda', 'Bottle of lemon soda',
        'Bottle of ginger ale', 'Bottle of root beer', 'Bottle of tonic water',
        'Bottle of club soda', 'Bottle of energy drink', 'Bottle of sports drink',
        'Bottle of kombucha', 'Bottle of smoothie', 'Bottle of milkshake',
        'Bottle of hot chocolate', 'Bottle of chocolate milk', 'Bottle of protein shake',
        'Bottle of beer', 'Bottle of light beer', 'Bottle of craft beer', 'Bottle of wine',
        'Bottle of red wine', 'Bottle of white wine', 'Bottle of rose wine',
        'Bottle of sparkling wine', 'Bottle of champagne', 'Bottle of prosecco',
        'Bottle of whiskey', 'Bottle of vodka', 'Bottle of rum', 'Bottle of cachaca',
        'Bottle of gin', 'Bottle of tequila', 'Bottle of cognac', 'Bottle of liqueur',
        'Bottle of vermouth', 'Bottle of cider', 'Bottle of sangria', 'Bottle of sake',
        'Pack of dish soap', 'Pack of dishwasher detergent', 'Pack of dishwasher tablets',
        'Pack of rinse aid', 'Pack of laundry detergent', 'Pack of liquid detergent',
        'Pack of laundry pods', 'Pack of fabric softener', 'Pack of dryer sheets',
        'Pack of stain remover', 'Pack of bleach', 'Pack of oxygen bleach',
        'Pack of all-purpose cleaner', 'Pack of glass cleaner', 'Pack of bathroom cleaner',
        'Pack of toilet cleaner', 'Pack of floor cleaner', 'Pack of wood cleaner',
        'Pack of disinfectant', 'Pack of disinfectant wipes', 'Pack of multi-surface spray',
        'Pack of degreaser', 'Pack of furniture polish', 'Pack of descaler',
        'Pack of drain cleaner', 'Pack of air freshener', 'Pack of scented candles',
        'Pack of insect spray', 'Pack of ant killer', 'Pack of mothballs',
        'Pack of sponges', 'Pack of steel wool', 'Pack of scrub brush',
        'Pack of cleaning cloths', 'Pack of microfiber cloth', 'Pack of dust cloth',
        'Pack of broom', 'Pack of mop', 'Pack of dustpan', 'Pack of bucket',
        'Pack of rubber gloves', 'Pack of clothespins', 'Pack of laundry basket',
        'Pack of batteries', 'Pack of light bulbs', 'Pack of matches', 'Pack of lighter',
        'Pack of duct tape', 'Pack of super glue', 'Pack of trash bags',
        'Pack of garbage bags', 'Pack of paper towels', 'Pack of toilet paper',
        'Pack of facial tissues', 'Pack of napkins', 'Pack of paper plates',
        'Pack of paper cups', 'Pack of plastic cups', 'Pack of plastic cutlery',
        'Pack of plastic wrap', 'Pack of aluminum foil', 'Pack of parchment paper',
        'Pack of wax paper', 'Pack of sandwich bags', 'Pack of freezer bags',
        'Pack of storage bags', 'Pack of vacuum bags', 'Pack of food containers',
        'Pack of straws', 'Pack of toothpicks', 'Pack of coffee filters',
        'Pack of baking cups', 'Pack of skewers', 'Pack of ice cube trays',
        'Pack of kitchen twine', 'Pack of diapers', 'Pack of newborn diapers',
        'Pack of baby wipes', 'Pack of baby formula', 'Pack of baby food',
        'Pack of baby cereal', 'Pack of baby snacks', 'Pack of baby lotion',
        'Pack of baby shampoo', 'Pack of baby soap', 'Pack of diaper cream',
        'Pack of baby powder', 'Pack of baby oil', 'Pack of pacifiers',
        'Pack of baby bottles', 'Pack of bottle nipples', 'Pack of teething gel',
        'Pack of baby cotton', 'Pack of bibs', 'Pack of baby detergent', 'Bag of dog food',
        'Bag of wet dog food', 'Bag of dry dog food', 'Bag of dog treats',
        'Bag of puppy food', 'Bag of dog bones', 'Bag of cat food', 'Bag of wet cat food',
        'Bag of dry cat food', 'Bag of cat treats', 'Bag of cat litter',
        'Bag of pet shampoo', 'Bag of flea treatment', 'Bag of pet wipes',
        'Bag of bird seed', 'Bag of fish food', 'Bag of pee pads', 'Bag of poop bags',
        'Bag of pet toys', 'Bag of cat scratcher', 'Pack of nori', 'Pack of wakame',
        'Pack of pickled ginger', 'Pack of wasabi', 'Pack of miso paste',
        'Pack of rice paper', 'Pack of spring roll wrappers', 'Pack of wonton wrappers',
        'Pack of dumpling wrappers', 'Pack of kimchi', 'Pack of curry paste',
        'Pack of red curry paste', 'Pack of coconut milk thai', 'Pack of rice noodles thin',
        'Pack of taco shells', 'Pack of tortilla wraps', 'Pack of enchilada sauce',
        'Pack of refried beans mexican', 'Pack of nacho cheese', 'Pack of falafel mix',
        'Pack of tahini paste', 'Pack of harissa', 'Pack of couscous mix',
        'Pack of polenta ready', 'Pack of gnocchi ready', 'Pack of plantain chips',
        'Pack of coconut cream specialty', 'Pack of dulce de leche jar',
        'Pack of yerba mate', 'Pack of farofa', 'Pack of cassava starch',
        'Pack of palm oil', 'Pack of cornstarch pudding mix', 'Pack of panettone specialty',
        'Pack of chestnuts', 'Pack of olive tapenade', 'Pack of anchovy paste',
        'Pack of curry sauce jar', 'Pack of soy protein chunks', 'Pack of gochujang',
        'Pack of ponzu sauce', 'Pack of masala chai', 'Kilo of rambutan',
        'Kilo of blackcurrant', 'Kilo of green papaya', 'Kilo of baby corn',
        'Kilo of turnip greens', 'Kilo of arracacha', 'Kilo of frisee',
        'Kilo of green tomatoes', 'Pack of processed cheese', 'Pack of cheese spread',
        'Pack of focaccia', 'Pack of cornbread', 'Pack of pretzel bread',
        'Pack of milk cream', 'Kilo of beef shank', 'Kilo of pork sausage',
        'Kilo of dried beef', 'Kilo of vermicelli', 'Kilo of pearl couscous',
        'Can of canned lentils', 'Can of canned chickpeas', 'Can of tomato passata',
        'Can of garlic sauce', 'Can of mint sauce', 'Can of apple butter',
        'Can of herbs de provence', 'Can of onion flakes', 'Pack of cheese balls',
        'Pack of corn nuts', 'Pack of chocolate coins', 'Pack of almond drink',
        'Pack of barley water', 'Pack of ginger tea', 'Pack of fabric spray',
        'Pack of shoe polish', 'Pack of drain unclogger', 'Pack of beard oil',
        'Pack of cuticle oil', 'Pack of vitamin e', 'Pack of melatonin',
        'Pack of cat grass', 'Kilo of loquat', 'Kilo of sapodilla', 'Kilo of jabuticaba',
        'Kilo of pitanga', 'Kilo of seriguela', 'Kilo of genipap', 'Kilo of sugar apple',
        'Kilo of custard apple', 'Kilo of physalis', 'Kilo of kumquat',
        'Kilo of green coconut', 'Kilo of silver banana', 'Kilo of nanica banana',
        'Kilo of apple banana', 'Kilo of umbu', 'Kilo of buriti', 'Kilo of pequi',
        'Kilo of feijoa', 'Kilo of longan', 'Kilo of bitter melon', 'Kilo of purslane',
        'Kilo of escarole', 'Kilo of catalonia chicory', 'Kilo of amaranth leaves',
        'Kilo of jambu', 'Kilo of taro leaves', 'Kilo of purple yam', 'Kilo of white yam',
        'Kilo of purple sweet potato', 'Kilo of lotus root', 'Kilo of nettle',
        'Kilo of sword bean', 'Kilo of long beans', 'Kilo of chicken heart',
        'Kilo of chicken gizzard', 'Kilo of beef short ribs', 'Kilo of beef chuck',
        'Kilo of beef rump cap', 'Kilo of beef knuckle', 'Kilo of beef bottom round',
        'Kilo of beef top round', 'Kilo of pork feet', 'Kilo of pork ear',
        'Kilo of smoked ribs', 'Kilo of cod fritters', 'Kilo of fish cake',
        'Kilo of peeled shrimp', 'Kilo of dried shrimp', 'Kilo of whole fish',
        'Box of instant mashed potatoes', 'Box of ready rice',
        'Box of boxed mac and cheese', 'Box of instant soup', 'Box of ramen cup',
        'Box of canned ravioli', 'Box of stuffing mix', 'Box of gravy mix',
        'Box of bread mix', 'Box of cornbread mix', 'Box of tapioca pearls',
        'Box of pizza kit', 'Box of lasagna kit', 'Box of taco kit', 'Box of pancake syrup',
        'Box of ice cream topping', 'Box of cake sprinkles', 'Box of whipped topping',
        'Bottle of aioli', 'Bottle of blue cheese dressing', 'Bottle of thousand island',
        'Bottle of honey garlic sauce', 'Bottle of peanut sauce', 'Bottle of plum sauce',
        'Bottle of black bean sauce', 'Bottle of cranberry sauce', 'Bottle of cheese sauce',
        'Bottle of white sauce', 'Bottle of bechamel', 'Bottle of bolognese sauce',
        'Bottle of green pepper sauce', 'Bottle of wasabi mayo', 'Pack of sponge cloths',
        'Pack of scouring pads', 'Pack of toilet brush', 'Pack of squeegee',
        'Pack of feather duster', 'Pack of trash can', 'Pack of recycling bags',
        'Pack of extension cord', 'Pack of power strip', 'Pack of aa batteries',
        'Pack of aaa batteries', 'Pack of 9v battery', 'Pack of led bulb',
        'Pack of notebook', 'Pack of pens', 'Pack of pencils', 'Pack of sticky notes',
        'Pack of scissors', 'Pack of envelopes', 'Pack of printer paper',
        'Pack of glue stick', 'Pack of markers', 'Pack of stapler', 'Pack of paper clips',
        'Pack of birthday candles', 'Pack of party hats', 'Pack of balloons',
        'Pack of party plates', 'Pack of party cups', 'Pack of streamers',
        'Pack of gift wrap', 'Pack of gift bags', 'Pack of ribbon',
        'Pack of greeting cards', 'Pack of disposable tablecloth', 'Pack of chocolate eggs',
        'Pack of nougat candy', 'Pack of dried figs', 'Pack of christmas nuts',
        'Bag of apples', 'Bag of green apples', 'Bag of red apples', 'Bag of fuji apples',
        'Bag of gala apples', 'Bag of bananas', 'Bag of plantains', 'Bag of oranges',
        'Bag of blood orange', 'Bag of mandarins', 'Bag of tangerines',
        'Bag of clementines', 'Bag of lemons', 'Bag of limes', 'Bag of key lime',
        'Bag of grapefruit', 'Bag of grapes', 'Bag of green grapes', 'Bag of red grapes',
        'Bag of seedless grapes', 'Bag of strawberries', 'Bag of blueberries',
        'Bag of raspberries', 'Bag of blackberries', 'Bag of cranberries',
        'Bag of mixed berries', 'Bag of pineapple', 'Bag of mango', 'Bag of papaya',
        'Bag of avocado', 'Bag of pears', 'Bag of peaches', 'Bag of nectarines',
        'Bag of apricots', 'Bag of plums', 'Bag of prunes', 'Bag of cherries',
        'Bag of watermelon', 'Bag of cantaloupe', 'Bag of honeydew melon', 'Bag of kiwi',
        'Bag of golden kiwi', 'Bag of pomegranate', 'Bag of figs', 'Bag of coconut',
        'Bag of passion fruit', 'Bag of guava', 'Bag of lychee', 'Bag of persimmon',
        'Bag of dragon fruit', 'Bag of star fruit', 'Bag of rhubarb', 'Bag of currants',
        'Bag of gooseberries', 'Bag of dates', 'Bag of jackfruit', 'Bag of acerola',
        'Bag of soursop', 'Bag of cupuacu', 'Bag of acai', 'Bag of tamarind',
        'Bag of quince', 'Bag of mangosteen', 'Bag of cactus pear', 'Bag of cashew fruit',
        'Bag of elderberry', 'Bag of tomatoes', 'Bag of cherry tomatoes',
        'Bag of roma tomatoes', 'Bag of grape tomatoes', 'Bag of potatoes',
        'Bag of russet potatoes', 'Bag of red potatoes', 'Bag of yukon potatoes',
        'Bag of baby potatoes', 'Bag of sweet potatoes', 'Bag of yams', 'Bag of cassava',
        'Bag of yuca', 'Bag of taro', 'Bag of onions', 'Bag of red onions',
        'Bag of white onions', 'Bag of yellow onions', 'Bag of green onions',
        'Bag of pearl onions', 'Bag of shallots', 'Bag of garlic', 'Bag of ginger',
        'Bag of carrots', 'Bag of baby carrots', 'Bag of celery', 'Bag of broccoli',
        'Bag of broccolini', 'Bag of cauliflower', 'Bag of brussels sprouts',
        'Bag of spinach', 'Bag of baby spinach', 'Bag of lettuce', 'Bag of romaine lettuce',
        'Bag of iceberg lettuce', 'Bag of butter lettuce', 'Bag of arugula', 'Bag of kale',
        'Bag of baby kale', 'Bag of swiss chard', 'Bag of collard greens',
        'Bag of mustard greens', 'Bag of watercress', 'Bag of radicchio', 'Bag of endive',
        'Bag of mixed greens', 'Bag of microgreens', 'Bag of cabbage', 'Bag of red cabbage',
        'Bag of green cabbage', 'Bag of savoy cabbage', 'Bag of napa cabbage',
        'Bag of bok choy', 'Bag of cucumber', 'Bag of zucchini', 'Bag of yellow squash',
        'Bag of butternut squash', 'Bag of acorn squash', 'Bag of spaghetti squash',
        'Bag of pumpkin', 'Bag of squash blossoms', 'Bag of chayote', 'Bag of bell peppers',
        'Bag of red bell pepper', 'Bag of green bell pepper', 'Bag of yellow bell pepper',
        'Bag of jalapenos', 'Bag of serrano peppers', 'Bag of habanero peppers',
        'Bag of poblano peppers', 'Bag of chili peppers', 'Bag of mushrooms',
        'Bag of portobello mushrooms', 'Bag of shiitake mushrooms',
        'Bag of cremini mushrooms', 'Bag of oyster mushrooms', 'Bag of green beans',
        'Bag of snap peas', 'Bag of snow peas', 'Bag of sugar snap peas', 'Bag of peas',
        'Bag of fava beans', 'Bag of lima beans', 'Bag of edamame', 'Bag of corn',
        'Bag of corn on the cob', 'Bag of sweet corn', 'Bag of asparagus',
        'Bag of eggplant', 'Bag of okra', 'Bag of artichokes', 'Bag of hearts of palm',
        'Bag of beets', 'Bag of radishes', 'Bag of daikon', 'Bag of turnips',
        'Bag of parsnips', 'Bag of rutabaga', 'Bag of kohlrabi', 'Bag of leeks',
        'Bag of fennel', 'Bag of celeriac', 'Bag of horseradish root',
        'Bag of bean sprouts', 'Bag of alfalfa sprouts', 'Box of milk', 'Box of whole milk',
        'Box of skim milk', 'Box of 2% milk', 'Box of lactose-free milk',
        'Box of powdered milk', 'Box of almond milk', 'Box of soy milk', 'Box of oat milk',
        'Box of coconut milk', 'Box of rice milk', 'Box of cashew milk',
        'Box of buttermilk', 'Box of half and half', 'Box of heavy cream',
        'Box of whipping cream', 'Box of sour cream', 'Box of clotted cream', 'Box of eggs',
        'Box of egg whites', 'Box of free-range eggs', 'Box of quail eggs', 'Box of butter',
        'Box of unsalted butter', 'Box of salted butter', 'Box of margarine', 'Box of ghee',
        'Box of cheese', 'Box of cheddar cheese', 'Box of sharp cheddar',
        'Box of mozzarella', 'Box of fresh mozzarella', 'Box of parmesan',
        'Box of provolone', 'Box of swiss cheese', 'Box of gouda', 'Box of brie',
        'Box of camembert', 'Box of feta cheese', 'Box of goat cheese',
        'Box of blue cheese', 'Box of ricotta', 'Box of cream cheese',
        'Box of cottage cheese', 'Box of mascarpone', 'Box of string cheese',
        'Box of requeijao', 'Box of minas cheese', 'Box of curd cheese',
        'Box of grated cheese', 'Box of shredded cheese', 'Box of sliced cheese',
        'Box of yogurt', 'Box of greek yogurt', 'Box of plain yogurt',
        'Box of vanilla yogurt', 'Box of fruit yogurt', 'Box of yogurt drink',
        'Box of kefir', 'Box of condensed milk', 'Box of evaporated milk',
        'Box of whipped cream', 'Box of custard', 'Box of pudding', 'Box of flan',
        'Box of dulce de leche', 'Bag of bread', 'Bag of white bread',
        'Bag of whole wheat bread', 'Bag of multigrain bread', 'Bag of sourdough bread',
        'Bag of rye bread', 'Bag of brioche', 'Bag of ciabatta', 'Bag of baguette',
        'Bag of french bread', 'Bag of sliced bread', 'Bag of bagels',
        'Bag of english muffins', 'Bag of tortillas', 'Bag of corn tortillas',
        'Bag of flour tortillas', 'Bag of pita bread', 'Bag of naan', 'Bag of flatbread',
        'Bag of croissants', 'Bag of muffins', 'Bag of blueberry muffins',
        'Bag of banana bread', 'Bag of cheese bread', 'Bag of dinner rolls',
        'Bag of hamburger buns', 'Bag of hot dog buns', 'Bag of buns', 'Bag of rolls',
        'Bag of sweet bread', 'Bag of cake', 'Bag of birthday cake', 'Bag of pound cake',
        'Bag of cupcakes', 'Bag of cookies', 'Bag of brownies', 'Bag of donuts',
        'Bag of pastries', 'Bag of pie', 'Bag of apple pie', 'Bag of cheesecake',
        'Bag of crackers', 'Bag of breadsticks', 'Bag of toast', 'Bag of melba toast',
        'Bag of rusk', 'Bag of panettone', 'Bag of sponge cake', 'Bag of roll cake',
        'Bag of danish pastry', 'Bag of scones', 'Bag of biscuits', 'Bag of puff pastry',
        'Bag of pizza dough', 'Tray of chicken', 'Tray of chicken breast',
        'Tray of chicken thighs', 'Tray of chicken wings', 'Tray of chicken drumsticks',
        'Tray of whole chicken', 'Tray of ground chicken', 'Tray of rotisserie chicken',
        'Tray of chicken liver', 'Tray of chicken feet', 'Tray of ground beef',
        'Tray of beef', 'Tray of steak', 'Tray of ribeye steak', 'Tray of sirloin steak',
        'Tray of filet mignon', 'Tray of rump steak', 'Tray of flank steak',
        'Tray of brisket', 'Tray of beef roast', 'Tray of beef ribs', 'Tray of stew meat',
        'Tray of oxtail', 'Tray of beef tongue', 'Tray of beef liver',
        'Tray of ground turkey', 'Tray of turkey', 'Tray of turkey breast', 'Tray of duck',
        'Tray of quail', 'Tray of rabbit', 'Tray of lamb', 'Tray of lamb chops',
        'Tray of leg of lamb', 'Tray of goat meat', 'Tray of veal', 'Tray of pork',
        'Tray of pork chops', 'Tray of pork loin', 'Tray of pork ribs',
        'Tray of pork belly', 'Tray of ground pork', 'Tray of pork shoulder',
        'Tray of pork tenderloin', 'Tray of bacon', 'Tray of ham', 'Tray of smoked ham',
        'Tray of prosciutto', 'Tray of turkey breast deli', 'Tray of mortadella',
        'Tray of sausages', 'Tray of italian sausage', 'Tray of breakfast sausage',
        'Tray of chorizo', 'Tray of salami', 'Tray of pepperoni', 'Tray of hot dogs',
        'Tray of blood sausage', 'Tray of calabresa sausage', 'Tray of pancetta',
        'Tray of salmon', 'Tray of smoked salmon', 'Tray of salmon fillet', 'Tray of tuna',
        'Tray of tuna steak', 'Tray of shrimp', 'Tray of jumbo shrimp', 'Tray of crab',
        'Tray of crab meat', 'Tray of lobster', 'Tray of scallops', 'Tray of mussels',
        'Tray of clams', 'Tray of oysters', 'Tray of squid', 'Tray of octopus',
        'Tray of fish', 'Tray of cod', 'Tray of salted cod', 'Tray of tilapia',
        'Tray of halibut', 'Tray of trout', 'Tray of sea bass', 'Tray of snapper',
        'Tray of grouper', 'Tray of mackerel', 'Tray of sardines', 'Tray of anchovies',
        'Tray of herring', 'Tray of catfish', 'Tray of hake', 'Tray of fish fillet',
        'Tray of fish sticks', 'Tray of crab sticks', 'Tray of caviar', 'Tray of fish roe',
        'Box of rice', 'Box of white rice', 'Box of brown rice', 'Box of basmati rice',
        'Box of jasmine rice', 'Box of arborio rice', 'Box of wild rice',
        'Box of parboiled rice', 'Box of sushi rice', 'Box of quinoa', 'Box of couscous',
        'Box of moroccan couscous', 'Box of bulgur', 'Box of barley', 'Box of farro',
        'Box of millet', 'Box of oats', 'Box of rolled oats', 'Box of steel-cut oats',
        'Box of cornmeal', 'Box of polenta', 'Box of semolina', 'Box of tapioca',
        'Box of tapioca flour', 'Box of pasta', 'Box of spaghetti', 'Box of penne',
        'Box of fusilli', 'Box of macaroni', 'Box of rigatoni', 'Box of farfalle',
        'Box of lasagna noodles', 'Box of fettuccine', 'Box of linguine',
        'Box of angel hair pasta', 'Box of egg noodles', 'Box of rice noodles',
        'Box of ramen noodles', 'Box of instant noodles', 'Box of udon noodles',
        'Box of soba noodles', 'Box of orzo', 'Box of gnocchi', 'Box of ravioli',
        'Box of tortellini', 'Box of cannelloni', 'Box of flour',
        'Box of all-purpose flour'
    ];

    // Portuguese (pt-BR) equivalents, one per English item above, so the same
    // suggestions work when shopping in either language.
    var GROCERIES_PT = [
        // Fruit
        'Maçã', 'Maçã verde', 'Maçã vermelha', 'Maçã fuji', 'Maçã gala', 'Banana',
        'Banana-da-terra', 'Laranja', 'Laranja sanguínea', 'Mexerica', 'Tangerina',
        'Clementina', 'Limão', 'Limão-taiti', 'Limão-galego', 'Toranja', 'Uva', 'Uva verde',
        'Uva vermelha', 'Uva sem semente', 'Morango', 'Mirtilo', 'Framboesa', 'Amora',
        'Cranberry', 'Frutas vermelhas', 'Abacaxi', 'Manga', 'Mamão', 'Abacate', 'Pera',
        'Pêssego', 'Nectarina', 'Damasco', 'Ameixa', 'Ameixa seca', 'Cereja', 'Melancia',
        'Melão', 'Melão verde', 'Kiwi', 'Kiwi dourado', 'Romã', 'Figo', 'Coco', 'Maracujá',
        'Goiaba', 'Lichia', 'Caqui', 'Pitaya', 'Carambola', 'Ruibarbo', 'Groselha',
        'Groselha espinhosa', 'Tâmara', 'Jaca', 'Acerola', 'Graviola', 'Cupuaçu', 'Açaí',
        'Tamarindo', 'Marmelo', 'Mangostão', 'Figo-da-índia', 'Caju', 'Sabugueiro',
        // Vegetables
        'Tomate', 'Tomate cereja', 'Tomate italiano', 'Tomate grape', 'Batata',
        'Batata asterix', 'Batata rosada', 'Batata amarela', 'Batata bolinha',
        'Batata-doce', 'Inhame', 'Mandioca', 'Aipim', 'Taro', 'Cebola', 'Cebola roxa',
        'Cebola branca', 'Cebola amarela', 'Cebolinha', 'Cebola pérola', 'Chalota', 'Alho',
        'Gengibre', 'Cenoura', 'Cenoura baby', 'Aipo', 'Brócolis', 'Brócolis ninja',
        'Couve-flor', 'Couve-de-bruxelas', 'Espinafre', 'Espinafre baby', 'Alface',
        'Alface romana', 'Alface americana', 'Alface manteiga', 'Rúcula', 'Couve',
        'Couve baby', 'Acelga', 'Couve-manteiga', 'Folha de mostarda', 'Agrião',
        'Radicchio', 'Endívia', 'Mix de folhas', 'Microverdes', 'Repolho', 'Repolho roxo',
        'Repolho verde', 'Repolho crespo', 'Acelga chinesa', 'Bok choy', 'Pepino',
        'Abobrinha', 'Abóbora amarela', 'Abóbora butternut', 'Abóbora acorn',
        'Abóbora espaguete', 'Abóbora', 'Flor de abóbora', 'Chuchu', 'Pimentão',
        'Pimentão vermelho', 'Pimentão verde', 'Pimentão amarelo', 'Jalapeño',
        'Pimenta serrano', 'Pimenta habanero', 'Pimenta poblano', 'Pimenta', 'Cogumelo',
        'Cogumelo portobello', 'Cogumelo shiitake', 'Cogumelo paris', 'Cogumelo shimeji',
        'Vagem', 'Ervilha torta', 'Ervilha holandesa', 'Ervilha doce', 'Ervilha', 'Fava',
        'Feijão-fava', 'Edamame', 'Milho', 'Espiga de milho', 'Milho verde', 'Aspargo',
        'Berinjela', 'Quiabo', 'Alcachofra', 'Palmito', 'Beterraba', 'Rabanete',
        'Nabo daikon', 'Nabo', 'Pastinaca', 'Nabo-sueco', 'Couve-rábano', 'Alho-poró',
        'Erva-doce', 'Aipo-rábano', 'Raiz-forte', 'Broto de feijão', 'Broto de alfafa',
        // Fresh herbs
        'Coentro', 'Salsa', 'Manjericão', 'Hortelã', 'Alecrim', 'Tomilho', 'Sálvia',
        'Endro', 'Cebolinha francesa', 'Estragão', 'Orégano', 'Manjerona', 'Louro',
        'Capim-limão', 'Folha de curry', 'Cerefólio', 'Azedinha', 'Chicória',
        'Folha de manjericão', 'Gengibre fresco',
        // Dairy & eggs
        'Leite', 'Leite integral', 'Leite desnatado', 'Leite semidesnatado',
        'Leite sem lactose', 'Leite em pó', 'Leite de amêndoas', 'Leite de soja',
        'Leite de aveia', 'Leite de coco', 'Leite de arroz', 'Leite de castanha',
        'Leitelho', 'Creme de leite', 'Creme de leite fresco', 'Creme para chantilly',
        'Creme azedo', 'Nata', 'Ovos', 'Claras de ovo', 'Ovos caipiras', 'Ovos de codorna',
        'Manteiga', 'Manteiga sem sal', 'Manteiga com sal', 'Margarina', 'Manteiga ghee',
        'Queijo', 'Queijo cheddar', 'Cheddar forte', 'Mussarela', 'Mussarela de búfala',
        'Parmesão', 'Provolone', 'Queijo suíço', 'Queijo gouda', 'Queijo brie',
        'Queijo camembert', 'Queijo feta', 'Queijo de cabra', 'Queijo gorgonzola', 'Ricota',
        'Cream cheese', 'Queijo cottage', 'Mascarpone', 'Queijo palito', 'Requeijão',
        'Queijo minas', 'Queijo coalho', 'Queijo ralado', 'Queijo ralado grosso',
        'Queijo fatiado', 'Iogurte', 'Iogurte grego', 'Iogurte natural',
        'Iogurte de baunilha', 'Iogurte de frutas', 'Bebida láctea', 'Kefir',
        'Leite condensado', 'Leite evaporado', 'Chantilly', 'Creme', 'Pudim',
        'Pudim de leite', 'Doce de leite',
        // Bakery
        'Pão', 'Pão branco', 'Pão integral', 'Pão multigrãos', 'Pão de fermentação natural',
        'Pão de centeio', 'Pão brioche', 'Ciabatta', 'Baguete', 'Pão francês',
        'Pão de forma', 'Bagel', 'Muffin inglês', 'Tortilha', 'Tortilha de milho',
        'Tortilha de trigo', 'Pão pita', 'Pão naan', 'Pão sírio', 'Croissant', 'Muffin',
        'Muffin de mirtilo', 'Bolo de banana', 'Pão de queijo', 'Pãezinhos',
        'Pão de hambúrguer', 'Pão de hot dog', 'Bisnaguinha', 'Pão de leite', 'Pão doce',
        'Bolo', 'Bolo de aniversário', 'Bolo amanteigado', 'Cupcake', 'Biscoitos',
        'Brownie', 'Rosquinha', 'Folhados', 'Torta', 'Torta de maçã', 'Cheesecake',
        'Bolacha', 'Palito de pão', 'Torrada', 'Torrada tipo melba', 'Torrada dupla',
        'Panetone', 'Pão de ló', 'Rocambole', 'Folhado dinamarquês', 'Scone',
        'Biscoito amanteigado', 'Massa folhada', 'Massa de pizza',
        // Meat & poultry
        'Frango', 'Peito de frango', 'Sobrecoxa de frango', 'Asa de frango',
        'Coxa de frango', 'Frango inteiro', 'Frango moído', 'Frango assado',
        'Fígado de galinha', 'Pé de galinha', 'Carne moída', 'Carne bovina', 'Bife',
        'Bife ancho', 'Alcatra', 'Filé-mignon', 'Picanha', 'Fraldinha', 'Peito bovino',
        'Carne para assar', 'Costela bovina', 'Carne para ensopado', 'Rabada',
        'Língua bovina', 'Fígado bovino', 'Peru moído', 'Peru', 'Peito de peru', 'Pato',
        'Codorna', 'Coelho', 'Cordeiro', 'Costeleta de cordeiro', 'Pernil de cordeiro',
        'Carne de cabrito', 'Vitela', 'Carne suína', 'Bisteca suína', 'Lombo suíno',
        'Costela suína', 'Barriga de porco', 'Carne suína moída', 'Paleta suína',
        'Filé suíno', 'Bacon', 'Presunto', 'Presunto defumado', 'Presunto cru',
        'Peito de peru fatiado', 'Mortadela', 'Linguiça', 'Linguiça italiana', 'Salsicha',
        'Chouriço', 'Salame', 'Pepperoni', 'Salsicha para cachorro-quente',
        'Chouriço de sangue', 'Linguiça calabresa', 'Panceta',
        // Seafood
        'Salmão', 'Salmão defumado', 'Filé de salmão', 'Atum', 'Posta de atum', 'Camarão',
        'Camarão grande', 'Caranguejo', 'Carne de caranguejo', 'Lagosta', 'Vieiras',
        'Mexilhão', 'Vôngole', 'Ostras', 'Lula', 'Polvo', 'Peixe', 'Bacalhau',
        'Bacalhau salgado', 'Tilápia', 'Linguado', 'Truta', 'Robalo', 'Pargo', 'Garoupa',
        'Cavala', 'Sardinha', 'Anchova', 'Arenque', 'Bagre', 'Merluza', 'Filé de peixe',
        'Palito de peixe', 'Kani', 'Caviar', 'Ovas de peixe',
        // Deli & plant protein
        'Tofu', 'Tofu firme', 'Tofu macio', 'Tempeh', 'Seitan', 'Hambúrguer vegetal',
        'Linguiça vegetal', 'Carne vegetal moída', 'Proteína de soja', 'Frios fatiados',
        'Presunto fatiado', 'Rosbife', 'Pastrami', 'Patê de fígado', 'Nuggets de frango',
        'Almôndegas', 'Homus', 'Falafel', 'Grãos de edamame',
        // Grains, rice & pasta
        'Arroz', 'Arroz branco', 'Arroz integral', 'Arroz basmati', 'Arroz jasmine',
        'Arroz arbóreo', 'Arroz selvagem', 'Arroz parboilizado', 'Arroz para sushi',
        'Quinoa', 'Cuscuz', 'Cuscuz marroquino', 'Trigo bulgur', 'Cevada', 'Farro',
        'Painço', 'Aveia', 'Aveia em flocos', 'Aveia em grãos', 'Fubá', 'Polenta', 'Sêmola',
        'Tapioca', 'Goma de tapioca', 'Macarrão', 'Espaguete', 'Penne', 'Parafuso',
        'Macarrão cotovelo', 'Rigatoni', 'Gravatinha', 'Massa de lasanha', 'Fettuccine',
        'Linguine', 'Cabelo de anjo', 'Talharim', 'Macarrão de arroz', 'Lámen', 'Miojo',
        'Macarrão udon', 'Macarrão soba', 'Massa orzo', 'Nhoque', 'Ravióli', 'Tortelline',
        'Canelone', 'Farinha de trigo', 'Farinha comum', 'Farinha integral',
        'Farinha de pão', 'Farinha com fermento', 'Farinha de amêndoa',
        'Farinha de mandioca', 'Farinha de milho', 'Farinha de grão-de-bico',
        'Farinha de arroz', 'Gérmen de trigo', 'Farelo',
        // Breakfast & cereal
        'Cereal', 'Flocos de milho', 'Granola', 'Muesli', 'Mingau de aveia',
        'Aveia instantânea', 'Cereal de chocolate', 'Flocos de farelo', 'Arroz tufado',
        'Mistura para panqueca', 'Mistura para waffle', 'Batata rösti',
        'Barra de café da manhã', 'Torrada doce', 'Xarope de bordo', 'Mel', 'Geleia',
        'Geleia de morango', 'Geleia de uva', 'Marmelada', 'Pasta de amendoim',
        'Pasta de amêndoa', 'Nutella', 'Creme de avelã', 'Achocolatado', 'Creme para café',
        'Chocolate em pó', 'Biscoito matinal', 'Croutons', 'Polvilho',
        // Canned & jarred
        'Tomate em lata', 'Tomate em cubos', 'Tomate triturado', 'Molho de tomate',
        'Extrato de tomate', 'Purê de tomate', 'Molho para macarrão', 'Molho marinara',
        'Molho alfredo', 'Molho de pizza', 'Feijão em lata', 'Feijão preto',
        'Feijão vermelho', 'Feijão carioca', 'Feijão branco', 'Grão-de-bico',
        'Feijão refrito', 'Feijão cozido', 'Lentilha', 'Ervilha partida', 'Milho em lata',
        'Ervilha em lata', 'Cenoura em lata', 'Champignon em conserva', 'Atum em lata',
        'Sardinha em lata', 'Salmão em lata', 'Frango em lata', 'Sopa em lata',
        'Canja de galinha', 'Sopa de tomate', 'Caldo', 'Caldo de galinha', 'Caldo de carne',
        'Caldo de legumes', 'Caldo de osso', 'Creme de coco', 'Leite de coco em lata',
        'Abacaxi em calda', 'Pêssego em calda', 'Salada de frutas em calda', 'Purê de maçã',
        'Azeitona', 'Azeitona verde', 'Azeitona preta', 'Picles', 'Alcaparra',
        'Tomate seco', 'Pimentão assado', 'Coração de alcachofra', 'Castanha-d\'água',
        'Broto de bambu', 'Chucrute', 'Beterraba em conserva', 'Milho verde em conserva',
        'Ervilha em conserva', 'Jaca em conserva',
        // Oils, vinegars & condiments
        'Azeite', 'Azeite extravirgem', 'Óleo vegetal', 'Óleo de canola', 'Óleo de coco',
        'Óleo de abacate', 'Óleo de gergelim', 'Óleo de girassol', 'Óleo de soja',
        'Óleo de milho', 'Óleo em spray', 'Vinagre', 'Vinagre branco', 'Vinagre de maçã',
        'Vinagre balsâmico', 'Vinagre de vinho tinto', 'Vinagre de arroz', 'Molho shoyu',
        'Molho tamari', 'Molho teriyaki', 'Molho de peixe', 'Molho de ostra',
        'Molho hoisin', 'Molho inglês', 'Ketchup', 'Mostarda', 'Mostarda dijon',
        'Mostarda amarela', 'Mostarda com mel', 'Maionese', 'Maionese de alho',
        'Molho ranch', 'Molho caesar', 'Molho italiano', 'Vinagrete', 'Molho para salada',
        'Molho de pimenta', 'Sriracha', 'Tabasco', 'Molho buffalo', 'Molho barbecue',
        'Molho para carne', 'Molho tártaro', 'Molho coquetel', 'Molho salsa', 'Molho verde',
        'Chimichurri', 'Guacamole', 'Pesto', 'Tahine', 'Molho de alho e pimenta',
        'Molho agridoce', 'Molho gravy', 'Cobertura de bordo', 'Néctar de agave', 'Melado',
        'Xarope de milho', 'Molho de coco', 'Relish', 'Molho de raiz-forte',
        // Spices & seasonings
        'Sal', 'Sal marinho', 'Sal grosso', 'Sal rosa', 'Pimenta-do-reino',
        'Pimenta branca', 'Canela', 'Canela em pó', 'Noz-moscada', 'Gengibre em pó',
        'Cravo', 'Pimenta-da-jamaica', 'Cardamomo', 'Cominho', 'Coentro em pó', 'Páprica',
        'Páprica defumada', 'Páprica doce', 'Pimenta caiena', 'Pimenta em pó',
        'Pimenta calabresa', 'Curry em pó', 'Garam masala', 'Cúrcuma', 'Açafrão',
        'Alho em pó', 'Cebola em pó', 'Orégano seco', 'Manjericão seco', 'Tomilho seco',
        'Alecrim seco', 'Salsa desidratada', 'Folha de louro', 'Tempero italiano',
        'Tempero para taco', 'Tempero cajun', 'Tempero para frango', 'Tempero para carne',
        'Tempero completo', 'Sal de alho', 'Sal temperado', 'Caldo em cubo',
        'Tempero de legumes', 'Semente de erva-doce', 'Gergelim', 'Semente de papoula',
        'Semente de mostarda', 'Semente de chia', 'Semente de linhaça',
        'Semente de girassol', 'Semente de abóbora', 'Anis-estrelado', 'Erva-doce em grão',
        'Fava de baunilha', 'Pimenta em grão', 'Pimenta seca', 'Zaatar', 'Sumagre',
        'Levedura nutricional',
        // Baking
        'Açúcar', 'Açúcar mascavo', 'Açúcar de confeiteiro', 'Açúcar de cana',
        'Açúcar de coco', 'Açúcar demerara', 'Estévia', 'Adoçante', 'Bicarbonato de sódio',
        'Fermento em pó', 'Fermento', 'Fermento biológico seco', 'Fermento fresco',
        'Extrato de baunilha', 'Extrato de amêndoa', 'Cacau em pó', 'Gotas de chocolate',
        'Gotas de chocolate branco', 'Chocolate para cobertura', 'Amido de milho',
        'Farinha de rosca', 'Farinha panko', 'Gelatina', 'Ágar-ágar', 'Corante alimentar',
        'Granulado', 'Mistura para bolo', 'Mistura para brownie', 'Cobertura para bolo',
        'Massa de torta', 'Leite condensado para doce', 'Coco ralado', 'Marzipã',
        'Pasta americana', 'Chantilly em pó', 'Leite em pó para bolo', 'Uva-passa',
        'Cranberry seco', 'Fruta cristalizada', 'Chocolate granulado', 'Melado dourado',
        // Snacks
        'Salgadinho', 'Batata frita de pacote', 'Tortilha chips', 'Chips de milho',
        'Chips de pita', 'Salgadinho de queijo', 'Pipoca', 'Pipoca de micro-ondas',
        'Pretzel', 'Biscoito de arroz', 'Castanhas', 'Amêndoas', 'Amendoim',
        'Amendoim torrado', 'Castanha de caju', 'Castanha-do-pará', 'Nozes', 'Nozes-pecã',
        'Pistache', 'Macadâmia', 'Avelã', 'Pinoli', 'Mix de castanhas',
        'Mix de frutas secas', 'Barra de granola', 'Barra de proteína', 'Barra de cereal',
        'Bala de frutas', 'Bolacha salgada', 'Biscoito de queijo', 'Carne seca em tiras',
        'Alga marinha', 'Frutas secas', 'Chips de banana', 'Chips de vegetais',
        'Biscoito de arroz japonês',
        // Sweets & candy
        'Chocolate', 'Chocolate amargo', 'Chocolate ao leite', 'Chocolate branco',
        'Barra de chocolate', 'Trufas de chocolate', 'Bala', 'Bala de goma', 'Pirulito',
        'Bala dura', 'Caramelo', 'Puxa-puxa', 'Chiclete', 'Bala de menta', 'Marshmallow',
        'Biscoito doce', 'Wafer', 'Biscoito de chocolate', 'Brigadeiro', 'Bala de mel',
        'Jujuba', 'Alcaçuz', 'Fudge', 'Torrone', 'Pé de moleque', 'Cocada', 'Goiabada',
        'Marmelada em barra', 'Wafer de chocolate',
        // Frozen
        'Legumes congelados', 'Ervilha congelada', 'Milho congelado', 'Brócolis congelado',
        'Espinafre congelado', 'Seleta de legumes congelada', 'Vagem congelada',
        'Frutas congeladas', 'Frutas vermelhas congeladas', 'Morango congelado',
        'Manga congelada', 'Açaí congelado', 'Pizza congelada', 'Batata frita congelada',
        'Bolinha de batata', 'Anéis de cebola', 'Frango congelado', 'Nuggets congelados',
        'Palito de peixe congelado', 'Peixe congelado', 'Camarão congelado',
        'Waffle congelado', 'Panqueca congelada', 'Burrito congelado', 'Lasanha congelada',
        'Prato congelado', 'Guioza congelada', 'Folhado congelado', 'Sorvete',
        'Sorvete de chocolate', 'Sorvete de baunilha', 'Picolé', 'Sanduíche de sorvete',
        'Iogurte congelado', 'Gelo', 'Cubos de gelo', 'Massa de pão congelada',
        'Torta congelada', 'Almôndegas congeladas', 'Rolinho primavera congelado',
        // Beverages
        'Água', 'Água mineral', 'Água com gás', 'Água sem gás', 'Água saborizada', 'Suco',
        'Suco de laranja', 'Suco de maçã', 'Suco de uva', 'Suco de cranberry',
        'Suco de abacaxi', 'Suco de manga', 'Suco de maracujá', 'Suco de limão',
        'Suco de toranja', 'Suco de tomate', 'Água de coco', 'Limonada', 'Chá gelado',
        'Suco em pó', 'Suco de caixinha', 'Café', 'Café moído', 'Café em grãos',
        'Café solúvel', 'Cápsula de café', 'Café cold brew', 'Café descafeinado', 'Chá',
        'Chá verde', 'Chá preto', 'Chá de ervas', 'Chá de camomila', 'Chá de hortelã',
        'Chá de hibisco', 'Erva-mate', 'Matchá', 'Refrigerante', 'Refrigerante de cola',
        'Refrigerante diet', 'Guaraná', 'Refrigerante de limão', 'Ginger ale', 'Root beer',
        'Água tônica', 'Soda limonada', 'Energético', 'Isotônico', 'Kombucha', 'Smoothie',
        'Milk-shake', 'Chocolate quente', 'Leite achocolatado', 'Shake de proteína',
        // Alcohol
        'Cerveja', 'Cerveja leve', 'Cerveja artesanal', 'Vinho', 'Vinho tinto',
        'Vinho branco', 'Vinho rosé', 'Espumante', 'Champanhe', 'Prosecco', 'Uísque',
        'Vodca', 'Rum', 'Cachaça', 'Gim', 'Tequila', 'Conhaque', 'Licor', 'Vermute',
        'Sidra', 'Sangria', 'Saquê',
        // Household & cleaning
        'Detergente', 'Detergente para lava-louças', 'Tablete para lava-louças',
        'Secante para louça', 'Sabão em pó', 'Sabão líquido', 'Cápsula para roupa',
        'Amaciante', 'Lenço para secadora', 'Tira-manchas', 'Água sanitária',
        'Alvejante sem cloro', 'Limpador multiuso', 'Limpa-vidros', 'Limpador de banheiro',
        'Limpador de vaso sanitário', 'Limpador de piso', 'Limpa-móveis', 'Desinfetante',
        'Lenço desinfetante', 'Spray multissuperfície', 'Desengordurante', 'Lustra-móveis',
        'Removedor de calcário', 'Desentupidor químico', 'Aromatizador de ambiente',
        'Vela aromática', 'Inseticida', 'Mata-formigas', 'Naftalina', 'Esponja',
        'Palha de aço', 'Escova de limpeza', 'Pano de limpeza', 'Pano de microfibra',
        'Flanela', 'Vassoura', 'Rodo', 'Pá de lixo', 'Balde', 'Luva de borracha',
        'Prendedor de roupa', 'Cesto de roupa', 'Pilhas', 'Lâmpadas', 'Fósforo', 'Isqueiro',
        'Fita adesiva', 'Cola instantânea', 'Saco de lixo', 'Sacola de lixo',
        // Paper & kitchen supplies
        'Papel toalha', 'Papel higiênico', 'Lenço de papel', 'Guardanapo',
        'Prato descartável', 'Copo descartável', 'Copo plástico', 'Talher descartável',
        'Filme plástico', 'Papel alumínio', 'Papel manteiga', 'Papel encerado',
        'Saquinho para sanduíche', 'Saco para congelar', 'Saco ziplock', 'Saco a vácuo',
        'Pote plástico', 'Canudo', 'Palito de dente', 'Filtro de café', 'Forminha de papel',
        'Espeto', 'Forma de gelo', 'Barbante de cozinha',
        // Personal care
        'Xampu', 'Condicionador', 'Xampu a seco', 'Máscara capilar', 'Leave-in',
        'Óleo capilar', 'Laquê', 'Gel de cabelo', 'Mousse capilar', 'Sabonete líquido',
        'Sabonete em barra', 'Sabonete para as mãos', 'Álcool em gel',
        'Hidratante corporal', 'Hidratante facial', 'Creme para mãos', 'Creme para os pés',
        'Protetor solar', 'Pós-sol', 'Pasta de dente', 'Pasta de dente infantil',
        'Escova de dente', 'Refil de escova elétrica', 'Enxaguante bucal', 'Fio dental',
        'Desodorante', 'Antitranspirante', 'Desodorante roll-on', 'Aparelho de barbear',
        'Lâmina de barbear', 'Creme de barbear', 'Espuma de barbear', 'Pós-barba',
        'Algodão', 'Cotonete', 'Demaquilante', 'Sabonete facial', 'Esfoliante facial',
        'Hidratante', 'Sérum facial', 'Protetor labial', 'Cortador de unha', 'Lixa de unha',
        'Esmalte', 'Removedor de esmalte', 'Pinça', 'Pente', 'Escova de cabelo',
        'Elástico de cabelo', 'Grampo de cabelo', 'Perfume', 'Body splash', 'Talco',
        'Absorvente', 'Absorvente interno', 'Protetor diário', 'Coletor menstrual',
        'Lenço umedecido',
        // Health & pharmacy
        'Vitaminas', 'Polivitamínico', 'Vitamina C', 'Vitamina D', 'Vitamina B12',
        'Suplemento de ferro', 'Suplemento de cálcio', 'Magnésio', 'Zinco', 'Óleo de peixe',
        'Ômega 3', 'Probióticos', 'Colágeno', 'Whey protein', 'Creatina', 'Analgésico',
        'Ibuprofeno', 'Paracetamol', 'Aspirina', 'Dipirona', 'Antialérgico',
        'Remédio para gripe', 'Xarope para tosse', 'Pastilha para garganta', 'Spray nasal',
        'Soro fisiológico', 'Antiácido', 'Laxante', 'Antidiarreico', 'Remédio para enjoo',
        'Curativo', 'Atadura', 'Gaze', 'Esparadrapo', 'Antisséptico', 'Álcool',
        'Água oxigenada', 'Disco de algodão', 'Termômetro', 'Colírio',
        'Solução para lentes', 'Protetor solar em bastão', 'Repelente',
        // Baby
        'Fralda', 'Fralda de recém-nascido', 'Lenço umedecido para bebê',
        'Fórmula infantil', 'Papinha', 'Cereal infantil', 'Petisco infantil',
        'Loção infantil', 'Xampu infantil', 'Sabonete infantil', 'Pomada para assadura',
        'Talco para bebê', 'Óleo para bebê', 'Chupeta', 'Mamadeira', 'Bico de mamadeira',
        'Gel para gengiva', 'Algodão para bebê', 'Babador', 'Sabão para roupa de bebê',
        // Pet
        'Ração para cachorro', 'Ração úmida para cachorro', 'Ração seca para cachorro',
        'Petisco para cachorro', 'Ração para filhote', 'Osso para cachorro',
        'Ração para gato', 'Ração úmida para gato', 'Ração seca para gato',
        'Petisco para gato', 'Areia para gato', 'Xampu para pet', 'Antipulgas',
        'Lenço para pet', 'Ração para pássaro', 'Ração para peixe', 'Tapete higiênico',
        'Saco para fezes', 'Brinquedo para pet', 'Arranhador para gato',
        // International & specialty
        'Nori', 'Alga wakame', 'Gengibre em conserva', 'Wasabi', 'Pasta de missô',
        'Papel de arroz', 'Massa para rolinho primavera', 'Massa para wonton',
        'Massa para guioza', 'Kimchi', 'Pasta de curry', 'Pasta de curry vermelho',
        'Leite de coco tailandês', 'Bifum', 'Casquinha de taco', 'Wrap de tortilha',
        'Molho para enchilada', 'Feijão refrito mexicano', 'Queijo para nachos',
        'Mistura para falafel', 'Pasta de gergelim', 'Harissa', 'Cuscuz temperado',
        'Polenta pronta', 'Nhoque pronto', 'Chips de banana-da-terra',
        'Creme de coco premium', 'Doce de leite em pote', 'Erva-mate para chimarrão',
        'Farofa pronta', 'Polvilho azedo', 'Azeite de dendê', 'Maisena para mingau',
        'Panetone trufado', 'Castanha portuguesa', 'Patê de azeitona', 'Pasta de anchova',
        'Molho de curry', 'Proteína de soja em cubos', 'Gochujang', 'Molho ponzu',
        'Chá masala',
        // More fruit & veg
        'Rambutã', 'Cassis', 'Mamão verde', 'Milho baby', 'Folha de nabo', 'Batata-baroa',
        'Frisée', 'Tomate verde',
        // More dairy & bakery
        'Queijo processado', 'Queijo cremoso', 'Focaccia', 'Broa de milho', 'Pão pretzel',
        'Nata caseira',
        // More meat & grains
        'Músculo bovino', 'Linguiça de porco', 'Carne-seca', 'Aletria', 'Cuscuz israelense',
        // More pantry
        'Lentilha em lata', 'Grão-de-bico em lata', 'Passata de tomate', 'Molho de alho',
        'Molho de menta', 'Manteiga de maçã', 'Ervas de Provença', 'Cebola em flocos',
        // More snacks & drinks
        'Bolinha de queijo', 'Milho torrado', 'Moeda de chocolate', 'Bebida de amêndoa',
        'Água de cevada', 'Chá de gengibre',
        // More household & care
        'Spray para tecido', 'Graxa de sapato', 'Desentupidor', 'Óleo para barba',
        'Óleo para cutícula', 'Vitamina E', 'Melatonina', 'Grama para gato',
        // More fruit
        'Nêspera', 'Sapoti', 'Jabuticaba', 'Pitanga', 'Seriguela', 'Jenipapo',
        'Fruta-do-conde', 'Pinha', 'Physalis', 'Kumquat', 'Coco verde', 'Banana-prata',
        'Banana-nanica', 'Banana-maçã', 'Umbu', 'Buriti', 'Pequi', 'Feijoa', 'Longan',
        // More vegetables
        'Melão-de-são-caetano', 'Beldroega', 'Escarola', 'Almeirão', 'Caruru', 'Jambu',
        'Taioba', 'Cará-roxo', 'Cará', 'Batata-doce roxa', 'Raiz de lótus', 'Urtiga',
        'Feijão-de-porco', 'Feijão-de-metro',
        // More meat & seafood
        'Coração de frango', 'Moela', 'Costela ripa', 'Acém', 'Maminha', 'Patinho',
        'Coxão duro', 'Coxão mole', 'Pé de porco', 'Orelha de porco', 'Costela defumada',
        'Bolinho de bacalhau', 'Bolinho de peixe', 'Camarão limpo', 'Camarão seco',
        'Peixe inteiro',
        // More pantry & prepared
        'Purê de batata instantâneo', 'Arroz pronto', 'Macarrão com queijo em caixa',
        'Sopa instantânea', 'Miojo copo', 'Ravióli em lata', 'Mistura de recheio',
        'Mistura para molho', 'Mistura para pão', 'Mistura para broa', 'Sagu',
        'Kit para pizza', 'Kit para lasanha', 'Kit para taco', 'Calda para panqueca',
        'Cobertura para sorvete', 'Confeito', 'Cobertura chantilly',
        // More condiments & sauces
        'Aioli', 'Molho de gorgonzola', 'Molho mil ilhas', 'Molho de alho e mel',
        'Molho de amendoim', 'Molho de ameixa', 'Molho de feijão preto',
        'Molho de cranberry', 'Molho de queijo', 'Molho branco', 'Molho bechamel',
        'Molho à bolonhesa', 'Molho de pimenta verde', 'Maionese de wasabi',
        // Household & office
        'Pano multiuso', 'Esfregão', 'Escova sanitária', 'Rodo de vidro', 'Espanador',
        'Lixeira', 'Saco para reciclagem', 'Extensão elétrica', 'Filtro de linha',
        'Pilha AA', 'Pilha AAA', 'Bateria 9V', 'Lâmpada LED', 'Caderno', 'Canetas', 'Lápis',
        'Bloco adesivo', 'Tesoura', 'Envelopes', 'Papel para impressora', 'Cola bastão',
        'Marcadores', 'Grampeador', 'Clipes',
        // Party & seasonal
        'Vela de aniversário', 'Chapéu de festa', 'Balões', 'Prato de festa',
        'Copo de festa', 'Serpentina', 'Papel de presente', 'Sacola de presente',
        'Fita de presente', 'Cartão comemorativo', 'Toalha de mesa descartável',
        'Ovo de páscoa', 'Torrone de natal', 'Figo seco', 'Castanhas de natal',
        // Quantities, packs & sizes
        'Quilo de maçã', 'Quilo de maçã verde', 'Quilo de maçã vermelha',
        'Quilo de maçã fuji', 'Quilo de maçã gala', 'Quilo de banana',
        'Quilo de banana-da-terra', 'Quilo de laranja', 'Quilo de laranja sanguínea',
        'Quilo de mexerica', 'Quilo de tangerina', 'Quilo de clementina', 'Quilo de limão',
        'Quilo de limão-taiti', 'Quilo de limão-galego', 'Quilo de toranja', 'Quilo de uva',
        'Quilo de uva verde', 'Quilo de uva vermelha', 'Quilo de uva sem semente',
        'Quilo de morango', 'Quilo de mirtilo', 'Quilo de framboesa', 'Quilo de amora',
        'Quilo de cranberry', 'Quilo de frutas vermelhas', 'Quilo de abacaxi',
        'Quilo de manga', 'Quilo de mamão', 'Quilo de abacate', 'Quilo de pera',
        'Quilo de pêssego', 'Quilo de nectarina', 'Quilo de damasco', 'Quilo de ameixa',
        'Quilo de ameixa seca', 'Quilo de cereja', 'Quilo de melancia', 'Quilo de melão',
        'Quilo de melão verde', 'Quilo de kiwi', 'Quilo de kiwi dourado', 'Quilo de romã',
        'Quilo de figo', 'Quilo de coco', 'Quilo de maracujá', 'Quilo de goiaba',
        'Quilo de lichia', 'Quilo de caqui', 'Quilo de pitaya', 'Quilo de carambola',
        'Quilo de ruibarbo', 'Quilo de groselha', 'Quilo de groselha espinhosa',
        'Quilo de tâmara', 'Quilo de jaca', 'Quilo de acerola', 'Quilo de graviola',
        'Quilo de cupuaçu', 'Quilo de açaí', 'Quilo de tamarindo', 'Quilo de marmelo',
        'Quilo de mangostão', 'Quilo de figo-da-índia', 'Quilo de caju',
        'Quilo de sabugueiro', 'Quilo de tomate', 'Quilo de tomate cereja',
        'Quilo de tomate italiano', 'Quilo de tomate grape', 'Quilo de batata',
        'Quilo de batata asterix', 'Quilo de batata rosada', 'Quilo de batata amarela',
        'Quilo de batata bolinha', 'Quilo de batata-doce', 'Quilo de inhame',
        'Quilo de mandioca', 'Quilo de aipim', 'Quilo de taro', 'Quilo de cebola',
        'Quilo de cebola roxa', 'Quilo de cebola branca', 'Quilo de cebola amarela',
        'Quilo de cebolinha', 'Quilo de cebola pérola', 'Quilo de chalota', 'Quilo de alho',
        'Quilo de gengibre', 'Quilo de cenoura', 'Quilo de cenoura baby', 'Quilo de aipo',
        'Quilo de brócolis', 'Quilo de brócolis ninja', 'Quilo de couve-flor',
        'Quilo de couve-de-bruxelas', 'Quilo de espinafre', 'Quilo de espinafre baby',
        'Quilo de alface', 'Quilo de alface romana', 'Quilo de alface americana',
        'Quilo de alface manteiga', 'Quilo de rúcula', 'Quilo de couve',
        'Quilo de couve baby', 'Quilo de acelga', 'Quilo de couve-manteiga',
        'Quilo de folha de mostarda', 'Quilo de agrião', 'Quilo de radicchio',
        'Quilo de endívia', 'Quilo de mix de folhas', 'Quilo de microverdes',
        'Quilo de repolho', 'Quilo de repolho roxo', 'Quilo de repolho verde',
        'Quilo de repolho crespo', 'Quilo de acelga chinesa', 'Quilo de bok choy',
        'Quilo de pepino', 'Quilo de abobrinha', 'Quilo de abóbora amarela',
        'Quilo de abóbora butternut', 'Quilo de abóbora acorn',
        'Quilo de abóbora espaguete', 'Quilo de abóbora', 'Quilo de flor de abóbora',
        'Quilo de chuchu', 'Quilo de pimentão', 'Quilo de pimentão vermelho',
        'Quilo de pimentão verde', 'Quilo de pimentão amarelo', 'Quilo de jalapeño',
        'Quilo de pimenta serrano', 'Quilo de pimenta habanero', 'Quilo de pimenta poblano',
        'Quilo de pimenta', 'Quilo de cogumelo', 'Quilo de cogumelo portobello',
        'Quilo de cogumelo shiitake', 'Quilo de cogumelo paris',
        'Quilo de cogumelo shimeji', 'Quilo de vagem', 'Quilo de ervilha torta',
        'Quilo de ervilha holandesa', 'Quilo de ervilha doce', 'Quilo de ervilha',
        'Quilo de fava', 'Quilo de feijão-fava', 'Quilo de edamame', 'Quilo de milho',
        'Quilo de espiga de milho', 'Quilo de milho verde', 'Quilo de aspargo',
        'Quilo de berinjela', 'Quilo de quiabo', 'Quilo de alcachofra', 'Quilo de palmito',
        'Quilo de beterraba', 'Quilo de rabanete', 'Quilo de nabo daikon', 'Quilo de nabo',
        'Quilo de pastinaca', 'Quilo de nabo-sueco', 'Quilo de couve-rábano',
        'Quilo de alho-poró', 'Quilo de erva-doce', 'Quilo de aipo-rábano',
        'Quilo de raiz-forte', 'Quilo de broto de feijão', 'Quilo de broto de alfafa',
        'Maço de coentro', 'Maço de salsa', 'Maço de manjericão', 'Maço de hortelã',
        'Maço de alecrim', 'Maço de tomilho', 'Maço de sálvia', 'Maço de endro',
        'Maço de cebolinha francesa', 'Maço de estragão', 'Maço de orégano',
        'Maço de manjerona', 'Maço de louro', 'Maço de capim-limão',
        'Maço de folha de curry', 'Maço de cerefólio', 'Maço de azedinha',
        'Maço de chicória', 'Maço de folha de manjericão', 'Maço de gengibre fresco',
        'Pacote de leite', 'Pacote de leite integral', 'Pacote de leite desnatado',
        'Pacote de leite semidesnatado', 'Pacote de leite sem lactose',
        'Pacote de leite em pó', 'Pacote de leite de amêndoas', 'Pacote de leite de soja',
        'Pacote de leite de aveia', 'Pacote de leite de coco', 'Pacote de leite de arroz',
        'Pacote de leite de castanha', 'Pacote de leitelho', 'Pacote de creme de leite',
        'Pacote de creme de leite fresco', 'Pacote de creme para chantilly',
        'Pacote de creme azedo', 'Pacote de nata', 'Pacote de ovos',
        'Pacote de claras de ovo', 'Pacote de ovos caipiras', 'Pacote de ovos de codorna',
        'Pacote de manteiga', 'Pacote de manteiga sem sal', 'Pacote de manteiga com sal',
        'Pacote de margarina', 'Pacote de manteiga ghee', 'Pacote de queijo',
        'Pacote de queijo cheddar', 'Pacote de cheddar forte', 'Pacote de mussarela',
        'Pacote de mussarela de búfala', 'Pacote de parmesão', 'Pacote de provolone',
        'Pacote de queijo suíço', 'Pacote de queijo gouda', 'Pacote de queijo brie',
        'Pacote de queijo camembert', 'Pacote de queijo feta', 'Pacote de queijo de cabra',
        'Pacote de queijo gorgonzola', 'Pacote de ricota', 'Pacote de cream cheese',
        'Pacote de queijo cottage', 'Pacote de mascarpone', 'Pacote de queijo palito',
        'Pacote de requeijão', 'Pacote de queijo minas', 'Pacote de queijo coalho',
        'Pacote de queijo ralado', 'Pacote de queijo ralado grosso',
        'Pacote de queijo fatiado', 'Pacote de iogurte', 'Pacote de iogurte grego',
        'Pacote de iogurte natural', 'Pacote de iogurte de baunilha',
        'Pacote de iogurte de frutas', 'Pacote de bebida láctea', 'Pacote de kefir',
        'Pacote de leite condensado', 'Pacote de leite evaporado', 'Pacote de chantilly',
        'Pacote de creme', 'Pacote de pudim', 'Pacote de pudim de leite',
        'Pacote de doce de leite', 'Pacote de pão', 'Pacote de pão branco',
        'Pacote de pão integral', 'Pacote de pão multigrãos',
        'Pacote de pão de fermentação natural', 'Pacote de pão de centeio',
        'Pacote de pão brioche', 'Pacote de ciabatta', 'Pacote de baguete',
        'Pacote de pão francês', 'Pacote de pão de forma', 'Pacote de bagel',
        'Pacote de muffin inglês', 'Pacote de tortilha', 'Pacote de tortilha de milho',
        'Pacote de tortilha de trigo', 'Pacote de pão pita', 'Pacote de pão naan',
        'Pacote de pão sírio', 'Pacote de croissant', 'Pacote de muffin',
        'Pacote de muffin de mirtilo', 'Pacote de bolo de banana',
        'Pacote de pão de queijo', 'Pacote de pãezinhos', 'Pacote de pão de hambúrguer',
        'Pacote de pão de hot dog', 'Pacote de bisnaguinha', 'Pacote de pão de leite',
        'Pacote de pão doce', 'Pacote de bolo', 'Pacote de bolo de aniversário',
        'Pacote de bolo amanteigado', 'Pacote de cupcake', 'Pacote de biscoitos',
        'Pacote de brownie', 'Pacote de rosquinha', 'Pacote de folhados', 'Pacote de torta',
        'Pacote de torta de maçã', 'Pacote de cheesecake', 'Pacote de bolacha',
        'Pacote de palito de pão', 'Pacote de torrada', 'Pacote de torrada tipo melba',
        'Pacote de torrada dupla', 'Pacote de panetone', 'Pacote de pão de ló',
        'Pacote de rocambole', 'Pacote de folhado dinamarquês', 'Pacote de scone',
        'Pacote de biscoito amanteigado', 'Pacote de massa folhada',
        'Pacote de massa de pizza', 'Quilo de frango', 'Quilo de peito de frango',
        'Quilo de sobrecoxa de frango', 'Quilo de asa de frango', 'Quilo de coxa de frango',
        'Quilo de frango inteiro', 'Quilo de frango moído', 'Quilo de frango assado',
        'Quilo de fígado de galinha', 'Quilo de pé de galinha', 'Quilo de carne moída',
        'Quilo de carne bovina', 'Quilo de bife', 'Quilo de bife ancho', 'Quilo de alcatra',
        'Quilo de filé-mignon', 'Quilo de picanha', 'Quilo de fraldinha',
        'Quilo de peito bovino', 'Quilo de carne para assar', 'Quilo de costela bovina',
        'Quilo de carne para ensopado', 'Quilo de rabada', 'Quilo de língua bovina',
        'Quilo de fígado bovino', 'Quilo de peru moído', 'Quilo de peru',
        'Quilo de peito de peru', 'Quilo de pato', 'Quilo de codorna', 'Quilo de coelho',
        'Quilo de cordeiro', 'Quilo de costeleta de cordeiro',
        'Quilo de pernil de cordeiro', 'Quilo de carne de cabrito', 'Quilo de vitela',
        'Quilo de carne suína', 'Quilo de bisteca suína', 'Quilo de lombo suíno',
        'Quilo de costela suína', 'Quilo de barriga de porco', 'Quilo de carne suína moída',
        'Quilo de paleta suína', 'Quilo de filé suíno', 'Quilo de bacon',
        'Quilo de presunto', 'Quilo de presunto defumado', 'Quilo de presunto cru',
        'Quilo de peito de peru fatiado', 'Quilo de mortadela', 'Quilo de linguiça',
        'Quilo de linguiça italiana', 'Quilo de salsicha', 'Quilo de chouriço',
        'Quilo de salame', 'Quilo de pepperoni', 'Quilo de salsicha para cachorro-quente',
        'Quilo de chouriço de sangue', 'Quilo de linguiça calabresa', 'Quilo de panceta',
        'Quilo de salmão', 'Quilo de salmão defumado', 'Quilo de filé de salmão',
        'Quilo de atum', 'Quilo de posta de atum', 'Quilo de camarão',
        'Quilo de camarão grande', 'Quilo de caranguejo', 'Quilo de carne de caranguejo',
        'Quilo de lagosta', 'Quilo de vieiras', 'Quilo de mexilhão', 'Quilo de vôngole',
        'Quilo de ostras', 'Quilo de lula', 'Quilo de polvo', 'Quilo de peixe',
        'Quilo de bacalhau', 'Quilo de bacalhau salgado', 'Quilo de tilápia',
        'Quilo de linguado', 'Quilo de truta', 'Quilo de robalo', 'Quilo de pargo',
        'Quilo de garoupa', 'Quilo de cavala', 'Quilo de sardinha', 'Quilo de anchova',
        'Quilo de arenque', 'Quilo de bagre', 'Quilo de merluza', 'Quilo de filé de peixe',
        'Quilo de palito de peixe', 'Quilo de kani', 'Quilo de caviar',
        'Quilo de ovas de peixe', 'Pacote de tofu', 'Pacote de tofu firme',
        'Pacote de tofu macio', 'Pacote de tempeh', 'Pacote de seitan',
        'Pacote de hambúrguer vegetal', 'Pacote de linguiça vegetal',
        'Pacote de carne vegetal moída', 'Pacote de proteína de soja',
        'Pacote de frios fatiados', 'Pacote de peito de peru fatiado',
        'Pacote de presunto fatiado', 'Pacote de rosbife', 'Pacote de pastrami',
        'Pacote de patê de fígado', 'Pacote de nuggets de frango', 'Pacote de almôndegas',
        'Pacote de homus', 'Pacote de falafel', 'Pacote de grãos de edamame',
        'Pacote de arroz', 'Pacote de arroz branco', 'Pacote de arroz integral',
        'Pacote de arroz basmati', 'Pacote de arroz jasmine', 'Pacote de arroz arbóreo',
        'Pacote de arroz selvagem', 'Pacote de arroz parboilizado',
        'Pacote de arroz para sushi', 'Pacote de quinoa', 'Pacote de cuscuz',
        'Pacote de cuscuz marroquino', 'Pacote de trigo bulgur', 'Pacote de cevada',
        'Pacote de farro', 'Pacote de painço', 'Pacote de aveia',
        'Pacote de aveia em flocos', 'Pacote de aveia em grãos', 'Pacote de fubá',
        'Pacote de polenta', 'Pacote de sêmola', 'Pacote de tapioca',
        'Pacote de goma de tapioca', 'Pacote de macarrão', 'Pacote de espaguete',
        'Pacote de penne', 'Pacote de parafuso', 'Pacote de macarrão cotovelo',
        'Pacote de rigatoni', 'Pacote de gravatinha', 'Pacote de massa de lasanha',
        'Pacote de fettuccine', 'Pacote de linguine', 'Pacote de cabelo de anjo',
        'Pacote de talharim', 'Pacote de macarrão de arroz', 'Pacote de lámen',
        'Pacote de miojo', 'Pacote de macarrão udon', 'Pacote de macarrão soba',
        'Pacote de massa orzo', 'Pacote de nhoque', 'Pacote de ravióli',
        'Pacote de tortelline', 'Pacote de canelone', 'Pacote de farinha de trigo',
        'Pacote de farinha comum', 'Pacote de farinha integral', 'Pacote de farinha de pão',
        'Pacote de farinha com fermento', 'Pacote de farinha de amêndoa',
        'Pacote de farinha de mandioca', 'Pacote de farinha de milho',
        'Pacote de farinha de grão-de-bico', 'Pacote de farinha de arroz',
        'Pacote de gérmen de trigo', 'Pacote de farelo', 'Caixa de cereal',
        'Caixa de flocos de milho', 'Caixa de granola', 'Caixa de muesli',
        'Caixa de mingau de aveia', 'Caixa de aveia instantânea',
        'Caixa de cereal de chocolate', 'Caixa de flocos de farelo',
        'Caixa de arroz tufado', 'Caixa de mistura para panqueca',
        'Caixa de mistura para waffle', 'Caixa de batata rösti',
        'Caixa de barra de café da manhã', 'Caixa de torrada doce',
        'Caixa de xarope de bordo', 'Caixa de mel', 'Caixa de geleia',
        'Caixa de geleia de morango', 'Caixa de geleia de uva', 'Caixa de marmelada',
        'Caixa de pasta de amendoim', 'Caixa de pasta de amêndoa', 'Caixa de nutella',
        'Caixa de creme de avelã', 'Caixa de achocolatado', 'Caixa de creme para café',
        'Caixa de chocolate em pó', 'Caixa de biscoito matinal', 'Caixa de croutons',
        'Caixa de polvilho', 'Lata de tomate em lata', 'Lata de tomate em cubos',
        'Lata de tomate triturado', 'Lata de molho de tomate', 'Lata de extrato de tomate',
        'Lata de purê de tomate', 'Lata de molho para macarrão', 'Lata de molho marinara',
        'Lata de molho alfredo', 'Lata de molho de pizza', 'Lata de feijão em lata',
        'Lata de feijão preto', 'Lata de feijão vermelho', 'Lata de feijão carioca',
        'Lata de feijão branco', 'Lata de grão-de-bico', 'Lata de feijão refrito',
        'Lata de feijão cozido', 'Lata de lentilha', 'Lata de ervilha partida',
        'Lata de milho em lata', 'Lata de ervilha em lata', 'Lata de cenoura em lata',
        'Lata de champignon em conserva', 'Lata de atum em lata',
        'Lata de sardinha em lata', 'Lata de salmão em lata', 'Lata de frango em lata',
        'Lata de sopa em lata', 'Lata de canja de galinha', 'Lata de sopa de tomate',
        'Lata de caldo', 'Lata de caldo de galinha', 'Lata de caldo de carne',
        'Lata de caldo de legumes', 'Lata de caldo de osso', 'Lata de creme de coco',
        'Lata de leite de coco em lata', 'Lata de abacaxi em calda',
        'Lata de pêssego em calda', 'Lata de salada de frutas em calda',
        'Lata de purê de maçã', 'Lata de azeitona', 'Lata de azeitona verde',
        'Lata de azeitona preta', 'Lata de picles', 'Lata de alcaparra',
        'Lata de tomate seco', 'Lata de pimentão assado', 'Lata de coração de alcachofra',
        'Lata de castanha-d\'água', 'Lata de broto de bambu', 'Lata de chucrute',
        'Lata de beterraba em conserva', 'Lata de milho verde em conserva',
        'Lata de ervilha em conserva', 'Lata de jaca em conserva', 'Garrafa de azeite',
        'Garrafa de azeite extravirgem', 'Garrafa de óleo vegetal',
        'Garrafa de óleo de canola', 'Garrafa de óleo de coco',
        'Garrafa de óleo de abacate', 'Garrafa de óleo de gergelim',
        'Garrafa de óleo de girassol', 'Garrafa de óleo de soja',
        'Garrafa de óleo de milho', 'Garrafa de óleo em spray', 'Garrafa de vinagre',
        'Garrafa de vinagre branco', 'Garrafa de vinagre de maçã',
        'Garrafa de vinagre balsâmico', 'Garrafa de vinagre de vinho tinto',
        'Garrafa de vinagre de arroz', 'Garrafa de molho shoyu', 'Garrafa de molho tamari',
        'Garrafa de molho teriyaki', 'Garrafa de molho de peixe',
        'Garrafa de molho de ostra', 'Garrafa de molho hoisin', 'Garrafa de molho inglês',
        'Garrafa de ketchup', 'Garrafa de mostarda', 'Garrafa de mostarda dijon',
        'Garrafa de mostarda amarela', 'Garrafa de mostarda com mel', 'Garrafa de maionese',
        'Garrafa de maionese de alho', 'Garrafa de molho ranch', 'Garrafa de molho caesar',
        'Garrafa de molho italiano', 'Garrafa de vinagrete', 'Garrafa de molho para salada',
        'Garrafa de molho de pimenta', 'Garrafa de sriracha', 'Garrafa de tabasco',
        'Garrafa de molho buffalo', 'Garrafa de molho barbecue',
        'Garrafa de molho para carne', 'Garrafa de molho tártaro',
        'Garrafa de molho coquetel', 'Garrafa de molho salsa', 'Garrafa de molho verde',
        'Garrafa de chimichurri', 'Garrafa de guacamole', 'Garrafa de pesto',
        'Garrafa de tahine', 'Garrafa de molho de alho e pimenta',
        'Garrafa de molho agridoce', 'Garrafa de molho gravy',
        'Garrafa de cobertura de bordo', 'Garrafa de néctar de agave', 'Garrafa de melado',
        'Garrafa de xarope de milho', 'Garrafa de molho de coco', 'Garrafa de relish',
        'Garrafa de molho de raiz-forte', 'Pote de sal', 'Pote de sal marinho',
        'Pote de sal grosso', 'Pote de sal rosa', 'Pote de pimenta-do-reino',
        'Pote de pimenta branca', 'Pote de canela', 'Pote de canela em pó',
        'Pote de noz-moscada', 'Pote de gengibre em pó', 'Pote de cravo',
        'Pote de pimenta-da-jamaica', 'Pote de cardamomo', 'Pote de cominho',
        'Pote de coentro em pó', 'Pote de páprica', 'Pote de páprica defumada',
        'Pote de páprica doce', 'Pote de pimenta caiena', 'Pote de pimenta em pó',
        'Pote de pimenta calabresa', 'Pote de curry em pó', 'Pote de garam masala',
        'Pote de cúrcuma', 'Pote de açafrão', 'Pote de alho em pó', 'Pote de cebola em pó',
        'Pote de orégano seco', 'Pote de manjericão seco', 'Pote de tomilho seco',
        'Pote de alecrim seco', 'Pote de salsa desidratada', 'Pote de folha de louro',
        'Pote de tempero italiano', 'Pote de tempero para taco', 'Pote de tempero cajun',
        'Pote de tempero para frango', 'Pote de tempero para carne',
        'Pote de tempero completo', 'Pote de sal de alho', 'Pote de sal temperado',
        'Pote de caldo em cubo', 'Pote de tempero de legumes',
        'Pote de semente de erva-doce', 'Pote de gergelim', 'Pote de semente de papoula',
        'Pote de semente de mostarda', 'Pote de semente de chia',
        'Pote de semente de linhaça', 'Pote de semente de girassol',
        'Pote de semente de abóbora', 'Pote de anis-estrelado', 'Pote de erva-doce em grão',
        'Pote de fava de baunilha', 'Pote de pimenta em grão', 'Pote de pimenta seca',
        'Pote de zaatar', 'Pote de sumagre', 'Pote de levedura nutricional',
        'Pacote de açúcar', 'Pacote de açúcar mascavo', 'Pacote de açúcar de confeiteiro',
        'Pacote de açúcar de cana', 'Pacote de açúcar de coco', 'Pacote de açúcar demerara',
        'Pacote de estévia', 'Pacote de adoçante', 'Pacote de bicarbonato de sódio',
        'Pacote de fermento em pó', 'Pacote de fermento',
        'Pacote de fermento biológico seco', 'Pacote de fermento fresco',
        'Pacote de extrato de baunilha', 'Pacote de extrato de amêndoa',
        'Pacote de cacau em pó', 'Pacote de gotas de chocolate',
        'Pacote de gotas de chocolate branco', 'Pacote de chocolate para cobertura',
        'Pacote de amido de milho', 'Pacote de farinha de rosca', 'Pacote de farinha panko',
        'Pacote de gelatina', 'Pacote de ágar-ágar', 'Pacote de corante alimentar',
        'Pacote de granulado', 'Pacote de mistura para bolo',
        'Pacote de mistura para brownie', 'Pacote de cobertura para bolo',
        'Pacote de massa de torta', 'Pacote de leite condensado para doce',
        'Pacote de coco ralado', 'Pacote de marzipã', 'Pacote de pasta americana',
        'Pacote de chantilly em pó', 'Pacote de leite em pó para bolo',
        'Pacote de uva-passa', 'Pacote de cranberry seco', 'Pacote de fruta cristalizada',
        'Pacote de chocolate granulado', 'Pacote de melado dourado', 'Pacote de salgadinho',
        'Pacote de batata frita de pacote', 'Pacote de tortilha chips',
        'Pacote de chips de milho', 'Pacote de chips de pita',
        'Pacote de salgadinho de queijo', 'Pacote de pipoca',
        'Pacote de pipoca de micro-ondas', 'Pacote de pretzel',
        'Pacote de biscoito de arroz', 'Pacote de castanhas', 'Pacote de amêndoas',
        'Pacote de amendoim', 'Pacote de amendoim torrado', 'Pacote de castanha de caju',
        'Pacote de castanha-do-pará', 'Pacote de nozes', 'Pacote de nozes-pecã',
        'Pacote de pistache', 'Pacote de macadâmia', 'Pacote de avelã', 'Pacote de pinoli',
        'Pacote de mix de castanhas', 'Pacote de mix de frutas secas',
        'Pacote de barra de granola', 'Pacote de barra de proteína',
        'Pacote de barra de cereal', 'Pacote de bala de frutas',
        'Pacote de bolacha salgada', 'Pacote de biscoito de queijo',
        'Pacote de carne seca em tiras', 'Pacote de alga marinha', 'Pacote de frutas secas',
        'Pacote de chips de banana', 'Pacote de chips de vegetais',
        'Pacote de biscoito de arroz japonês', 'Pacote de chocolate',
        'Pacote de chocolate amargo', 'Pacote de chocolate ao leite',
        'Pacote de chocolate branco', 'Pacote de barra de chocolate',
        'Pacote de trufas de chocolate', 'Pacote de bala', 'Pacote de bala de goma',
        'Pacote de pirulito', 'Pacote de bala dura', 'Pacote de caramelo',
        'Pacote de puxa-puxa', 'Pacote de chiclete', 'Pacote de bala de menta',
        'Pacote de marshmallow', 'Pacote de biscoito doce', 'Pacote de wafer',
        'Pacote de biscoito de chocolate', 'Pacote de brigadeiro', 'Pacote de bala de mel',
        'Pacote de jujuba', 'Pacote de alcaçuz', 'Pacote de fudge', 'Pacote de torrone',
        'Pacote de pé de moleque', 'Pacote de cocada', 'Pacote de goiabada',
        'Pacote de marmelada em barra', 'Pacote de wafer de chocolate',
        'Pacote de legumes congelados', 'Pacote de ervilha congelada',
        'Pacote de milho congelado', 'Pacote de brócolis congelado',
        'Pacote de espinafre congelado', 'Pacote de seleta de legumes congelada',
        'Pacote de vagem congelada', 'Pacote de frutas congeladas',
        'Pacote de frutas vermelhas congeladas', 'Pacote de morango congelado',
        'Pacote de manga congelada', 'Pacote de açaí congelado',
        'Pacote de pizza congelada', 'Pacote de batata frita congelada',
        'Pacote de bolinha de batata', 'Pacote de anéis de cebola',
        'Pacote de frango congelado', 'Pacote de nuggets congelados',
        'Pacote de palito de peixe congelado', 'Pacote de peixe congelado',
        'Pacote de camarão congelado', 'Pacote de waffle congelado',
        'Pacote de panqueca congelada', 'Pacote de burrito congelado',
        'Pacote de lasanha congelada', 'Pacote de prato congelado',
        'Pacote de guioza congelada', 'Pacote de folhado congelado', 'Pacote de sorvete',
        'Pacote de sorvete de chocolate', 'Pacote de sorvete de baunilha',
        'Pacote de picolé', 'Pacote de sanduíche de sorvete', 'Pacote de iogurte congelado',
        'Pacote de gelo', 'Pacote de cubos de gelo', 'Pacote de massa de pão congelada',
        'Pacote de torta congelada', 'Pacote de almôndegas congeladas',
        'Pacote de rolinho primavera congelado', 'Garrafa de água',
        'Garrafa de água mineral', 'Garrafa de água com gás', 'Garrafa de água sem gás',
        'Garrafa de água saborizada', 'Garrafa de suco', 'Garrafa de suco de laranja',
        'Garrafa de suco de maçã', 'Garrafa de suco de uva', 'Garrafa de suco de cranberry',
        'Garrafa de suco de abacaxi', 'Garrafa de suco de manga',
        'Garrafa de suco de maracujá', 'Garrafa de suco de limão',
        'Garrafa de suco de toranja', 'Garrafa de suco de tomate',
        'Garrafa de água de coco', 'Garrafa de limonada', 'Garrafa de chá gelado',
        'Garrafa de suco em pó', 'Garrafa de suco de caixinha', 'Garrafa de café',
        'Garrafa de café moído', 'Garrafa de café em grãos', 'Garrafa de café solúvel',
        'Garrafa de cápsula de café', 'Garrafa de café cold brew',
        'Garrafa de café descafeinado', 'Garrafa de chá', 'Garrafa de chá verde',
        'Garrafa de chá preto', 'Garrafa de chá de ervas', 'Garrafa de chá de camomila',
        'Garrafa de chá de hortelã', 'Garrafa de chá de hibisco', 'Garrafa de erva-mate',
        'Garrafa de matchá', 'Garrafa de refrigerante', 'Garrafa de refrigerante de cola',
        'Garrafa de refrigerante diet', 'Garrafa de guaraná',
        'Garrafa de refrigerante de limão', 'Garrafa de ginger ale', 'Garrafa de root beer',
        'Garrafa de água tônica', 'Garrafa de soda limonada', 'Garrafa de energético',
        'Garrafa de isotônico', 'Garrafa de kombucha', 'Garrafa de smoothie',
        'Garrafa de milk-shake', 'Garrafa de chocolate quente',
        'Garrafa de leite achocolatado', 'Garrafa de shake de proteína',
        'Garrafa de cerveja', 'Garrafa de cerveja leve', 'Garrafa de cerveja artesanal',
        'Garrafa de vinho', 'Garrafa de vinho tinto', 'Garrafa de vinho branco',
        'Garrafa de vinho rosé', 'Garrafa de espumante', 'Garrafa de champanhe',
        'Garrafa de prosecco', 'Garrafa de uísque', 'Garrafa de vodca', 'Garrafa de rum',
        'Garrafa de cachaça', 'Garrafa de gim', 'Garrafa de tequila', 'Garrafa de conhaque',
        'Garrafa de licor', 'Garrafa de vermute', 'Garrafa de sidra', 'Garrafa de sangria',
        'Garrafa de saquê', 'Pacote de detergente', 'Pacote de detergente para lava-louças',
        'Pacote de tablete para lava-louças', 'Pacote de secante para louça',
        'Pacote de sabão em pó', 'Pacote de sabão líquido', 'Pacote de cápsula para roupa',
        'Pacote de amaciante', 'Pacote de lenço para secadora', 'Pacote de tira-manchas',
        'Pacote de água sanitária', 'Pacote de alvejante sem cloro',
        'Pacote de limpador multiuso', 'Pacote de limpa-vidros',
        'Pacote de limpador de banheiro', 'Pacote de limpador de vaso sanitário',
        'Pacote de limpador de piso', 'Pacote de limpa-móveis', 'Pacote de desinfetante',
        'Pacote de lenço desinfetante', 'Pacote de spray multissuperfície',
        'Pacote de desengordurante', 'Pacote de lustra-móveis',
        'Pacote de removedor de calcário', 'Pacote de desentupidor químico',
        'Pacote de aromatizador de ambiente', 'Pacote de vela aromática',
        'Pacote de inseticida', 'Pacote de mata-formigas', 'Pacote de naftalina',
        'Pacote de esponja', 'Pacote de palha de aço', 'Pacote de escova de limpeza',
        'Pacote de pano de limpeza', 'Pacote de pano de microfibra', 'Pacote de flanela',
        'Pacote de vassoura', 'Pacote de rodo', 'Pacote de pá de lixo', 'Pacote de balde',
        'Pacote de luva de borracha', 'Pacote de prendedor de roupa',
        'Pacote de cesto de roupa', 'Pacote de pilhas', 'Pacote de lâmpadas',
        'Pacote de fósforo', 'Pacote de isqueiro', 'Pacote de fita adesiva',
        'Pacote de cola instantânea', 'Pacote de saco de lixo', 'Pacote de sacola de lixo',
        'Pacote de papel toalha', 'Pacote de papel higiênico', 'Pacote de lenço de papel',
        'Pacote de guardanapo', 'Pacote de prato descartável', 'Pacote de copo descartável',
        'Pacote de copo plástico', 'Pacote de talher descartável',
        'Pacote de filme plástico', 'Pacote de papel alumínio', 'Pacote de papel manteiga',
        'Pacote de papel encerado', 'Pacote de saquinho para sanduíche',
        'Pacote de saco para congelar', 'Pacote de saco ziplock', 'Pacote de saco a vácuo',
        'Pacote de pote plástico', 'Pacote de canudo', 'Pacote de palito de dente',
        'Pacote de filtro de café', 'Pacote de forminha de papel', 'Pacote de espeto',
        'Pacote de forma de gelo', 'Pacote de barbante de cozinha', 'Pacote de fralda',
        'Pacote de fralda de recém-nascido', 'Pacote de lenço umedecido para bebê',
        'Pacote de fórmula infantil', 'Pacote de papinha', 'Pacote de cereal infantil',
        'Pacote de petisco infantil', 'Pacote de loção infantil',
        'Pacote de xampu infantil', 'Pacote de sabonete infantil',
        'Pacote de pomada para assadura', 'Pacote de talco para bebê',
        'Pacote de óleo para bebê', 'Pacote de chupeta', 'Pacote de mamadeira',
        'Pacote de bico de mamadeira', 'Pacote de gel para gengiva',
        'Pacote de algodão para bebê', 'Pacote de babador',
        'Pacote de sabão para roupa de bebê', 'Saco de ração para cachorro',
        'Saco de ração úmida para cachorro', 'Saco de ração seca para cachorro',
        'Saco de petisco para cachorro', 'Saco de ração para filhote',
        'Saco de osso para cachorro', 'Saco de ração para gato',
        'Saco de ração úmida para gato', 'Saco de ração seca para gato',
        'Saco de petisco para gato', 'Saco de areia para gato', 'Saco de xampu para pet',
        'Saco de antipulgas', 'Saco de lenço para pet', 'Saco de ração para pássaro',
        'Saco de ração para peixe', 'Saco de tapete higiênico', 'Saco de saco para fezes',
        'Saco de brinquedo para pet', 'Saco de arranhador para gato', 'Pacote de nori',
        'Pacote de alga wakame', 'Pacote de gengibre em conserva', 'Pacote de wasabi',
        'Pacote de pasta de missô', 'Pacote de papel de arroz',
        'Pacote de massa para rolinho primavera', 'Pacote de massa para wonton',
        'Pacote de massa para guioza', 'Pacote de kimchi', 'Pacote de pasta de curry',
        'Pacote de pasta de curry vermelho', 'Pacote de leite de coco tailandês',
        'Pacote de bifum', 'Pacote de casquinha de taco', 'Pacote de wrap de tortilha',
        'Pacote de molho para enchilada', 'Pacote de feijão refrito mexicano',
        'Pacote de queijo para nachos', 'Pacote de mistura para falafel',
        'Pacote de pasta de gergelim', 'Pacote de harissa', 'Pacote de cuscuz temperado',
        'Pacote de polenta pronta', 'Pacote de nhoque pronto',
        'Pacote de chips de banana-da-terra', 'Pacote de creme de coco premium',
        'Pacote de doce de leite em pote', 'Pacote de erva-mate para chimarrão',
        'Pacote de farofa pronta', 'Pacote de polvilho azedo', 'Pacote de azeite de dendê',
        'Pacote de maisena para mingau', 'Pacote de panetone trufado',
        'Pacote de castanha portuguesa', 'Pacote de patê de azeitona',
        'Pacote de pasta de anchova', 'Pacote de molho de curry',
        'Pacote de proteína de soja em cubos', 'Pacote de gochujang',
        'Pacote de molho ponzu', 'Pacote de chá masala', 'Quilo de rambutã',
        'Quilo de cassis', 'Quilo de mamão verde', 'Quilo de milho baby',
        'Quilo de folha de nabo', 'Quilo de batata-baroa', 'Quilo de frisée',
        'Quilo de tomate verde', 'Pacote de queijo processado', 'Pacote de queijo cremoso',
        'Pacote de focaccia', 'Pacote de broa de milho', 'Pacote de pão pretzel',
        'Pacote de nata caseira', 'Quilo de músculo bovino', 'Quilo de linguiça de porco',
        'Quilo de carne-seca', 'Quilo de aletria', 'Quilo de cuscuz israelense',
        'Lata de lentilha em lata', 'Lata de grão-de-bico em lata',
        'Lata de passata de tomate', 'Lata de molho de alho', 'Lata de molho de menta',
        'Lata de manteiga de maçã', 'Lata de ervas de provença', 'Lata de cebola em flocos',
        'Pacote de bolinha de queijo', 'Pacote de milho torrado',
        'Pacote de moeda de chocolate', 'Pacote de bebida de amêndoa',
        'Pacote de água de cevada', 'Pacote de chá de gengibre',
        'Pacote de spray para tecido', 'Pacote de graxa de sapato',
        'Pacote de desentupidor', 'Pacote de óleo para barba',
        'Pacote de óleo para cutícula', 'Pacote de vitamina e', 'Pacote de melatonina',
        'Pacote de grama para gato', 'Quilo de nêspera', 'Quilo de sapoti',
        'Quilo de jabuticaba', 'Quilo de pitanga', 'Quilo de seriguela',
        'Quilo de jenipapo', 'Quilo de fruta-do-conde', 'Quilo de pinha',
        'Quilo de physalis', 'Quilo de kumquat', 'Quilo de coco verde',
        'Quilo de banana-prata', 'Quilo de banana-nanica', 'Quilo de banana-maçã',
        'Quilo de umbu', 'Quilo de buriti', 'Quilo de pequi', 'Quilo de feijoa',
        'Quilo de longan', 'Quilo de melão-de-são-caetano', 'Quilo de beldroega',
        'Quilo de escarola', 'Quilo de almeirão', 'Quilo de caruru', 'Quilo de jambu',
        'Quilo de taioba', 'Quilo de cará-roxo', 'Quilo de cará',
        'Quilo de batata-doce roxa', 'Quilo de raiz de lótus', 'Quilo de urtiga',
        'Quilo de feijão-de-porco', 'Quilo de feijão-de-metro',
        'Quilo de coração de frango', 'Quilo de moela', 'Quilo de costela ripa',
        'Quilo de acém', 'Quilo de maminha', 'Quilo de patinho', 'Quilo de coxão duro',
        'Quilo de coxão mole', 'Quilo de pé de porco', 'Quilo de orelha de porco',
        'Quilo de costela defumada', 'Quilo de bolinho de bacalhau',
        'Quilo de bolinho de peixe', 'Quilo de camarão limpo', 'Quilo de camarão seco',
        'Quilo de peixe inteiro', 'Caixa de purê de batata instantâneo',
        'Caixa de arroz pronto', 'Caixa de macarrão com queijo em caixa',
        'Caixa de sopa instantânea', 'Caixa de miojo copo', 'Caixa de ravióli em lata',
        'Caixa de mistura de recheio', 'Caixa de mistura para molho',
        'Caixa de mistura para pão', 'Caixa de mistura para broa', 'Caixa de sagu',
        'Caixa de kit para pizza', 'Caixa de kit para lasanha', 'Caixa de kit para taco',
        'Caixa de calda para panqueca', 'Caixa de cobertura para sorvete',
        'Caixa de confeito', 'Caixa de cobertura chantilly', 'Garrafa de aioli',
        'Garrafa de molho de gorgonzola', 'Garrafa de molho mil ilhas',
        'Garrafa de molho de alho e mel', 'Garrafa de molho de amendoim',
        'Garrafa de molho de ameixa', 'Garrafa de molho de feijão preto',
        'Garrafa de molho de cranberry', 'Garrafa de molho de queijo',
        'Garrafa de molho branco', 'Garrafa de molho bechamel',
        'Garrafa de molho à bolonhesa', 'Garrafa de molho de pimenta verde',
        'Garrafa de maionese de wasabi', 'Pacote de pano multiuso', 'Pacote de esfregão',
        'Pacote de escova sanitária', 'Pacote de rodo de vidro', 'Pacote de espanador',
        'Pacote de lixeira', 'Pacote de saco para reciclagem',
        'Pacote de extensão elétrica', 'Pacote de filtro de linha', 'Pacote de pilha aa',
        'Pacote de pilha aaa', 'Pacote de bateria 9v', 'Pacote de lâmpada led',
        'Pacote de caderno', 'Pacote de canetas', 'Pacote de lápis',
        'Pacote de bloco adesivo', 'Pacote de tesoura', 'Pacote de envelopes',
        'Pacote de papel para impressora', 'Pacote de cola bastão', 'Pacote de marcadores',
        'Pacote de grampeador', 'Pacote de clipes', 'Pacote de vela de aniversário',
        'Pacote de chapéu de festa', 'Pacote de balões', 'Pacote de prato de festa',
        'Pacote de copo de festa', 'Pacote de serpentina', 'Pacote de papel de presente',
        'Pacote de sacola de presente', 'Pacote de fita de presente',
        'Pacote de cartão comemorativo', 'Pacote de toalha de mesa descartável',
        'Pacote de ovo de páscoa', 'Pacote de torrone de natal', 'Pacote de figo seco',
        'Pacote de castanhas de natal', 'Saco de maçã', 'Saco de maçã verde',
        'Saco de maçã vermelha', 'Saco de maçã fuji', 'Saco de maçã gala', 'Saco de banana',
        'Saco de banana-da-terra', 'Saco de laranja', 'Saco de laranja sanguínea',
        'Saco de mexerica', 'Saco de tangerina', 'Saco de clementina', 'Saco de limão',
        'Saco de limão-taiti', 'Saco de limão-galego', 'Saco de toranja', 'Saco de uva',
        'Saco de uva verde', 'Saco de uva vermelha', 'Saco de uva sem semente',
        'Saco de morango', 'Saco de mirtilo', 'Saco de framboesa', 'Saco de amora',
        'Saco de cranberry', 'Saco de frutas vermelhas', 'Saco de abacaxi', 'Saco de manga',
        'Saco de mamão', 'Saco de abacate', 'Saco de pera', 'Saco de pêssego',
        'Saco de nectarina', 'Saco de damasco', 'Saco de ameixa', 'Saco de ameixa seca',
        'Saco de cereja', 'Saco de melancia', 'Saco de melão', 'Saco de melão verde',
        'Saco de kiwi', 'Saco de kiwi dourado', 'Saco de romã', 'Saco de figo',
        'Saco de coco', 'Saco de maracujá', 'Saco de goiaba', 'Saco de lichia',
        'Saco de caqui', 'Saco de pitaya', 'Saco de carambola', 'Saco de ruibarbo',
        'Saco de groselha', 'Saco de groselha espinhosa', 'Saco de tâmara', 'Saco de jaca',
        'Saco de acerola', 'Saco de graviola', 'Saco de cupuaçu', 'Saco de açaí',
        'Saco de tamarindo', 'Saco de marmelo', 'Saco de mangostão',
        'Saco de figo-da-índia', 'Saco de caju', 'Saco de sabugueiro', 'Saco de tomate',
        'Saco de tomate cereja', 'Saco de tomate italiano', 'Saco de tomate grape',
        'Saco de batata', 'Saco de batata asterix', 'Saco de batata rosada',
        'Saco de batata amarela', 'Saco de batata bolinha', 'Saco de batata-doce',
        'Saco de inhame', 'Saco de mandioca', 'Saco de aipim', 'Saco de taro',
        'Saco de cebola', 'Saco de cebola roxa', 'Saco de cebola branca',
        'Saco de cebola amarela', 'Saco de cebolinha', 'Saco de cebola pérola',
        'Saco de chalota', 'Saco de alho', 'Saco de gengibre', 'Saco de cenoura',
        'Saco de cenoura baby', 'Saco de aipo', 'Saco de brócolis',
        'Saco de brócolis ninja', 'Saco de couve-flor', 'Saco de couve-de-bruxelas',
        'Saco de espinafre', 'Saco de espinafre baby', 'Saco de alface',
        'Saco de alface romana', 'Saco de alface americana', 'Saco de alface manteiga',
        'Saco de rúcula', 'Saco de couve', 'Saco de couve baby', 'Saco de acelga',
        'Saco de couve-manteiga', 'Saco de folha de mostarda', 'Saco de agrião',
        'Saco de radicchio', 'Saco de endívia', 'Saco de mix de folhas',
        'Saco de microverdes', 'Saco de repolho', 'Saco de repolho roxo',
        'Saco de repolho verde', 'Saco de repolho crespo', 'Saco de acelga chinesa',
        'Saco de bok choy', 'Saco de pepino', 'Saco de abobrinha',
        'Saco de abóbora amarela', 'Saco de abóbora butternut', 'Saco de abóbora acorn',
        'Saco de abóbora espaguete', 'Saco de abóbora', 'Saco de flor de abóbora',
        'Saco de chuchu', 'Saco de pimentão', 'Saco de pimentão vermelho',
        'Saco de pimentão verde', 'Saco de pimentão amarelo', 'Saco de jalapeño',
        'Saco de pimenta serrano', 'Saco de pimenta habanero', 'Saco de pimenta poblano',
        'Saco de pimenta', 'Saco de cogumelo', 'Saco de cogumelo portobello',
        'Saco de cogumelo shiitake', 'Saco de cogumelo paris', 'Saco de cogumelo shimeji',
        'Saco de vagem', 'Saco de ervilha torta', 'Saco de ervilha holandesa',
        'Saco de ervilha doce', 'Saco de ervilha', 'Saco de fava', 'Saco de feijão-fava',
        'Saco de edamame', 'Saco de milho', 'Saco de espiga de milho',
        'Saco de milho verde', 'Saco de aspargo', 'Saco de berinjela', 'Saco de quiabo',
        'Saco de alcachofra', 'Saco de palmito', 'Saco de beterraba', 'Saco de rabanete',
        'Saco de nabo daikon', 'Saco de nabo', 'Saco de pastinaca', 'Saco de nabo-sueco',
        'Saco de couve-rábano', 'Saco de alho-poró', 'Saco de erva-doce',
        'Saco de aipo-rábano', 'Saco de raiz-forte', 'Saco de broto de feijão',
        'Saco de broto de alfafa', 'Caixa de leite', 'Caixa de leite integral',
        'Caixa de leite desnatado', 'Caixa de leite semidesnatado',
        'Caixa de leite sem lactose', 'Caixa de leite em pó', 'Caixa de leite de amêndoas',
        'Caixa de leite de soja', 'Caixa de leite de aveia', 'Caixa de leite de coco',
        'Caixa de leite de arroz', 'Caixa de leite de castanha', 'Caixa de leitelho',
        'Caixa de creme de leite', 'Caixa de creme de leite fresco',
        'Caixa de creme para chantilly', 'Caixa de creme azedo', 'Caixa de nata',
        'Caixa de ovos', 'Caixa de claras de ovo', 'Caixa de ovos caipiras',
        'Caixa de ovos de codorna', 'Caixa de manteiga', 'Caixa de manteiga sem sal',
        'Caixa de manteiga com sal', 'Caixa de margarina', 'Caixa de manteiga ghee',
        'Caixa de queijo', 'Caixa de queijo cheddar', 'Caixa de cheddar forte',
        'Caixa de mussarela', 'Caixa de mussarela de búfala', 'Caixa de parmesão',
        'Caixa de provolone', 'Caixa de queijo suíço', 'Caixa de queijo gouda',
        'Caixa de queijo brie', 'Caixa de queijo camembert', 'Caixa de queijo feta',
        'Caixa de queijo de cabra', 'Caixa de queijo gorgonzola', 'Caixa de ricota',
        'Caixa de cream cheese', 'Caixa de queijo cottage', 'Caixa de mascarpone',
        'Caixa de queijo palito', 'Caixa de requeijão', 'Caixa de queijo minas',
        'Caixa de queijo coalho', 'Caixa de queijo ralado', 'Caixa de queijo ralado grosso',
        'Caixa de queijo fatiado', 'Caixa de iogurte', 'Caixa de iogurte grego',
        'Caixa de iogurte natural', 'Caixa de iogurte de baunilha',
        'Caixa de iogurte de frutas', 'Caixa de bebida láctea', 'Caixa de kefir',
        'Caixa de leite condensado', 'Caixa de leite evaporado', 'Caixa de chantilly',
        'Caixa de creme', 'Caixa de pudim', 'Caixa de pudim de leite',
        'Caixa de doce de leite', 'Saco de pão', 'Saco de pão branco',
        'Saco de pão integral', 'Saco de pão multigrãos',
        'Saco de pão de fermentação natural', 'Saco de pão de centeio',
        'Saco de pão brioche', 'Saco de ciabatta', 'Saco de baguete', 'Saco de pão francês',
        'Saco de pão de forma', 'Saco de bagel', 'Saco de muffin inglês',
        'Saco de tortilha', 'Saco de tortilha de milho', 'Saco de tortilha de trigo',
        'Saco de pão pita', 'Saco de pão naan', 'Saco de pão sírio', 'Saco de croissant',
        'Saco de muffin', 'Saco de muffin de mirtilo', 'Saco de bolo de banana',
        'Saco de pão de queijo', 'Saco de pãezinhos', 'Saco de pão de hambúrguer',
        'Saco de pão de hot dog', 'Saco de bisnaguinha', 'Saco de pão de leite',
        'Saco de pão doce', 'Saco de bolo', 'Saco de bolo de aniversário',
        'Saco de bolo amanteigado', 'Saco de cupcake', 'Saco de biscoitos',
        'Saco de brownie', 'Saco de rosquinha', 'Saco de folhados', 'Saco de torta',
        'Saco de torta de maçã', 'Saco de cheesecake', 'Saco de bolacha',
        'Saco de palito de pão', 'Saco de torrada', 'Saco de torrada tipo melba',
        'Saco de torrada dupla', 'Saco de panetone', 'Saco de pão de ló',
        'Saco de rocambole', 'Saco de folhado dinamarquês', 'Saco de scone',
        'Saco de biscoito amanteigado', 'Saco de massa folhada', 'Saco de massa de pizza',
        'Bandeja de frango', 'Bandeja de peito de frango', 'Bandeja de sobrecoxa de frango',
        'Bandeja de asa de frango', 'Bandeja de coxa de frango',
        'Bandeja de frango inteiro', 'Bandeja de frango moído', 'Bandeja de frango assado',
        'Bandeja de fígado de galinha', 'Bandeja de pé de galinha',
        'Bandeja de carne moída', 'Bandeja de carne bovina', 'Bandeja de bife',
        'Bandeja de bife ancho', 'Bandeja de alcatra', 'Bandeja de filé-mignon',
        'Bandeja de picanha', 'Bandeja de fraldinha', 'Bandeja de peito bovino',
        'Bandeja de carne para assar', 'Bandeja de costela bovina',
        'Bandeja de carne para ensopado', 'Bandeja de rabada', 'Bandeja de língua bovina',
        'Bandeja de fígado bovino', 'Bandeja de peru moído', 'Bandeja de peru',
        'Bandeja de peito de peru', 'Bandeja de pato', 'Bandeja de codorna',
        'Bandeja de coelho', 'Bandeja de cordeiro', 'Bandeja de costeleta de cordeiro',
        'Bandeja de pernil de cordeiro', 'Bandeja de carne de cabrito', 'Bandeja de vitela',
        'Bandeja de carne suína', 'Bandeja de bisteca suína', 'Bandeja de lombo suíno',
        'Bandeja de costela suína', 'Bandeja de barriga de porco',
        'Bandeja de carne suína moída', 'Bandeja de paleta suína', 'Bandeja de filé suíno',
        'Bandeja de bacon', 'Bandeja de presunto', 'Bandeja de presunto defumado',
        'Bandeja de presunto cru', 'Bandeja de peito de peru fatiado',
        'Bandeja de mortadela', 'Bandeja de linguiça', 'Bandeja de linguiça italiana',
        'Bandeja de salsicha', 'Bandeja de chouriço', 'Bandeja de salame',
        'Bandeja de pepperoni', 'Bandeja de salsicha para cachorro-quente',
        'Bandeja de chouriço de sangue', 'Bandeja de linguiça calabresa',
        'Bandeja de panceta', 'Bandeja de salmão', 'Bandeja de salmão defumado',
        'Bandeja de filé de salmão', 'Bandeja de atum', 'Bandeja de posta de atum',
        'Bandeja de camarão', 'Bandeja de camarão grande', 'Bandeja de caranguejo',
        'Bandeja de carne de caranguejo', 'Bandeja de lagosta', 'Bandeja de vieiras',
        'Bandeja de mexilhão', 'Bandeja de vôngole', 'Bandeja de ostras', 'Bandeja de lula',
        'Bandeja de polvo', 'Bandeja de peixe', 'Bandeja de bacalhau',
        'Bandeja de bacalhau salgado', 'Bandeja de tilápia', 'Bandeja de linguado',
        'Bandeja de truta', 'Bandeja de robalo', 'Bandeja de pargo', 'Bandeja de garoupa',
        'Bandeja de cavala', 'Bandeja de sardinha', 'Bandeja de anchova',
        'Bandeja de arenque', 'Bandeja de bagre', 'Bandeja de merluza',
        'Bandeja de filé de peixe', 'Bandeja de palito de peixe', 'Bandeja de kani',
        'Bandeja de caviar', 'Bandeja de ovas de peixe', 'Caixa de arroz',
        'Caixa de arroz branco', 'Caixa de arroz integral', 'Caixa de arroz basmati',
        'Caixa de arroz jasmine', 'Caixa de arroz arbóreo', 'Caixa de arroz selvagem',
        'Caixa de arroz parboilizado', 'Caixa de arroz para sushi', 'Caixa de quinoa',
        'Caixa de cuscuz', 'Caixa de cuscuz marroquino', 'Caixa de trigo bulgur',
        'Caixa de cevada', 'Caixa de farro', 'Caixa de painço', 'Caixa de aveia',
        'Caixa de aveia em flocos', 'Caixa de aveia em grãos', 'Caixa de fubá',
        'Caixa de polenta', 'Caixa de sêmola', 'Caixa de tapioca',
        'Caixa de goma de tapioca', 'Caixa de macarrão', 'Caixa de espaguete',
        'Caixa de penne', 'Caixa de parafuso', 'Caixa de macarrão cotovelo',
        'Caixa de rigatoni', 'Caixa de gravatinha', 'Caixa de massa de lasanha',
        'Caixa de fettuccine', 'Caixa de linguine', 'Caixa de cabelo de anjo',
        'Caixa de talharim', 'Caixa de macarrão de arroz', 'Caixa de lámen',
        'Caixa de miojo', 'Caixa de macarrão udon', 'Caixa de macarrão soba',
        'Caixa de massa orzo', 'Caixa de nhoque', 'Caixa de ravióli', 'Caixa de tortelline',
        'Caixa de canelone', 'Caixa de farinha de trigo', 'Caixa de farinha comum'
    ];

    var HISTORY_KEY = 'itemHistory-v1';

    function loadHistory() {
        try {
            var raw = JSON.parse(storageGet(HISTORY_KEY, '{}'));
            return (raw && typeof raw === 'object') ? raw : {};
        } catch (error) {
            return {};
        }
    }

    /** Record an item name so it floats to the top of future suggestions. */
    function rememberItem(name) {
        name = (name || '').trim();
        if (!name) return;
        var history = loadHistory();
        var key = name.toLowerCase();
        var entry = history[key] || { name: name, count: 0 };
        entry.name = name;
        entry.count += 1;
        entry.at = Date.now();
        history[key] = entry;
        storageSet(HISTORY_KEY, JSON.stringify(history));
    }

    // History (most-used first) followed by the built-in groceries in both
    // English and Portuguese, de-duped.
    function suggestionPool() {
        var pool = [];
        var seen = {};
        function add(name) {
            var key = (name || '').trim().toLowerCase();
            if (!key || seen[key]) return;
            seen[key] = true;
            pool.push(name.trim());
        }
        var history = loadHistory();
        Object.keys(history)
            .map(function (key) { return history[key]; })
            .sort(function (a, b) { return (b.count - a.count) || ((b.at || 0) - (a.at || 0)); })
            .forEach(function (entry) { add(entry.name); });
        GROCERIES.forEach(add);
        GROCERIES_PT.forEach(add);
        return pool;
    }

    // Fold to lowercase and strip accents, so typing "agua" matches "Água"
    // and "acai" matches "Açaí". Works in both languages.
    function foldText(text) {
        return (text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    }

    function computeSuggestions(query) {
        query = foldText((query || '').trim());
        if (!query) return [];

        var pool = suggestionPool();
        var starts = [];
        var contains = [];
        for (var i = 0; i < pool.length; i++) {
            var lower = foldText(pool[i]);
            if (lower === query) continue;
            var at = lower.indexOf(query);
            if (at === 0) starts.push(pool[i]);
            else if (at !== -1) contains.push(pool[i]);
            if (starts.length >= 8) break;
        }
        return starts.concat(contains).slice(0, 8);
    }

    var suggestItems = [];
    var suggestActiveIndex = -1;

    function renderSuggestions() {
        suggestItems = computeSuggestions(ui.newName.value);
        suggestActiveIndex = -1;

        if (!suggestItems.length || document.activeElement !== ui.newName) {
            hideSuggestions();
            return;
        }

        ui.suggestions.textContent = '';
        suggestItems.forEach(function (name, index) {
            var option = el('li', {
                class: 'suggestion', role: 'option', id: 'suggestion-' + index
            }, name);
            // mousedown (not click) so it runs before the input's blur hides us.
            option.addEventListener('mousedown', function (event) {
                event.preventDefault();
                chooseSuggestion(index);
            });
            ui.suggestions.appendChild(option);
        });

        ui.suggestions.hidden = false;
        ui.newName.setAttribute('aria-expanded', 'true');
        positionSuggestions();
    }

    /** Fit the list to the room the keyboard leaves, and drop it below the input
     *  when that side has more space than above it. */
    function positionSuggestions() {
        if (ui.suggestions.hidden) return;

        var vv = window.visualViewport;
        var top = (vv && vv.scale <= 1.05) ? vv.offsetTop : 0;
        var rect = ui.newName.getBoundingClientRect();
        var above = rect.top - top - 12;
        var below = visibleBottom() - rect.bottom - 12;
        // The composer sits at the end of the page, so above is normally the
        // roomier side; only flip when below wins by a clear margin.
        var flip = below > above + 40;

        ui.suggestions.classList.toggle('below', flip);
        ui.suggestions.style.maxHeight =
            Math.max(96, Math.min(260, flip ? below : above)) + 'px';
    }

    function hideSuggestions() {
        if (ui.suggestions.hidden && !suggestItems.length) return;
        ui.suggestions.hidden = true;
        ui.suggestions.textContent = '';
        suggestItems = [];
        suggestActiveIndex = -1;
        ui.newName.setAttribute('aria-expanded', 'false');
        ui.newName.removeAttribute('aria-activedescendant');
    }

    function moveSuggestion(delta) {
        if (!suggestItems.length) return;
        suggestActiveIndex = (suggestActiveIndex + delta + suggestItems.length) % suggestItems.length;
        Array.prototype.forEach.call(ui.suggestions.children, function (option, index) {
            option.classList.toggle('active', index === suggestActiveIndex);
        });
        var active = ui.suggestions.children[suggestActiveIndex];
        if (active) {
            active.scrollIntoView({ block: 'nearest' });
            ui.newName.setAttribute('aria-activedescendant', active.id);
        }
    }

    function chooseSuggestion(index) {
        var name = suggestItems[index];
        if (!name) return;
        ui.newName.value = name;
        hideSuggestions();
        syncComposerFields();
        saveDraft();
        ui.newName.focus();
    }

    function setupSuggestions() {
        ui.newName.addEventListener('focus', renderSuggestions);
        window.addEventListener('resize', positionSuggestions);
        ui.newName.addEventListener('blur', function () {
            setTimeout(hideSuggestions, 120);
        });
        ui.newName.addEventListener('keydown', function (event) {
            if (ui.suggestions.hidden) return;
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                moveSuggestion(1);
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                moveSuggestion(-1);
            } else if (event.key === 'Enter' && suggestActiveIndex >= 0) {
                // Enter accepts the highlighted suggestion instead of submitting.
                event.preventDefault();
                chooseSuggestion(suggestActiveIndex);
            } else if (event.key === 'Escape') {
                hideSuggestions();
            }
        });
    }

    // ===================================================================== //
    // Sync
    // ===================================================================== //

    var syncFailures = 0;
    // Set when a server change lands while the outbox still has local edits, so
    // the drain can pull that change in once our own edits are through.
    var missedSync = false;

    function syncLoop() {
        var since = state.version;

        fetch('/api/version?since=' + since + '&wait=25', { credentials: 'same-origin' })
            .then(function (response) {
                if (response.status === 401) {
                    window.location.href = '/login';
                    throw new Error('Signed out');
                }
                return response.json();
            })
            .then(function (payload) {
                syncFailures = 0;
                // Hold off pulling the server's view while we still have local
                // edits queued - note it and let the drain refresh once we are
                // through, so our own changes are not clobbered mid-flight.
                if (payload.version !== state.version) {
                    if (outbox.length) missedSync = true;
                    else return refreshState();
                }
            })
            .catch(function () {
                syncFailures += 1;
            })
            .finally(function () {
                // Back off when the server is unreachable instead of hammering it.
                var delay = syncFailures ? Math.min(30000, 1000 * Math.pow(2, syncFailures)) : 250;
                setTimeout(syncLoop, delay);
            });
    }

    function setupConnectivity() {
        function update() {
            ui.offlineBanner.hidden = navigator.onLine;
            setBusy(0);
        }

        window.addEventListener('online', function () {
            update();
            // Push out whatever queued up while offline; the drain resyncs after.
            if (outbox.length) flushOutbox();
            else refreshState().catch(function () { /* still flaky */ });
        });
        window.addEventListener('offline', update);
        update();

        document.addEventListener('visibilitychange', function () {
            if (document.hidden) return;
            if (outbox.length) flushOutbox();
            else refreshState().catch(function () { /* offline */ });
        });
    }

    // ===================================================================== //
    // Account & user management
    // ===================================================================== //

    function iconSvg(id) {
        var holder = document.createElement('span');
        holder.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#' + id + '"></use></svg>';
        return holder.firstChild;
    }

    function field(labelText, input) {
        return el('label', { class: 'field block' }, [
            el('span', { class: 'field-label', text: labelText }),
            input
        ]);
    }

    function showError(node, message) {
        node.textContent = message || 'Something went wrong';
        node.hidden = false;
    }

    function clearError(node) {
        node.hidden = true;
        node.textContent = '';
    }

    /** Keep the header account menu in step with the current user. */
    function reflectUser() {
        var user = state.user || {};
        ui.accountHeadingName.textContent = user.username || '';
        ui.accountHeadingRole.hidden = !user.isAdmin;
        ui.manageUsersItem.hidden = !user.isAdmin;
    }

    // ----- Modal ---------------------------------------------------------- //

    var lastFocusBeforeModal = null;

    function openModal(title, buildBody, options) {
        options = options || {};
        // flowHead: let the header scroll away with the content instead of
        // staying pinned, freeing vertical space on tall/scrolling screens.
        ui.modalCard.classList.toggle('modal-flow', !!options.flowHead);

        ui.modalTitle.textContent = title;
        ui.modalBody.textContent = '';
        buildBody(ui.modalBody);

        lastFocusBeforeModal = document.activeElement;
        ui.modalOverlay.hidden = false;

        var focusable = ui.modalBody.querySelector('input, button, [tabindex]');
        if (focusable) focusable.focus();
    }

    function closeModal() {
        if (ui.modalOverlay.hidden) return;
        ui.modalOverlay.hidden = true;
        ui.modalBody.textContent = '';
        if (lastFocusBeforeModal && lastFocusBeforeModal.focus) lastFocusBeforeModal.focus();
    }

    function setupModal() {
        ui.modalClose.addEventListener('click', closeModal);
        ui.modalOverlay.addEventListener('click', function (event) {
            if (event.target === ui.modalOverlay) closeModal();
        });
    }

    // ----- Confirmation dialog -------------------------------------------- //
    // In-app replacement for window.confirm(). Returns a Promise<boolean> and
    // uses its own overlay so it can stack on top of an open modal.

    var confirmResolver = null;
    var confirmLastFocus = null;

    function confirmDialog(options) {
        options = options || {};
        return new Promise(function (resolve) {
            // If a confirm is somehow already open, dismiss it as cancelled.
            if (confirmResolver) {
                var previous = confirmResolver;
                confirmResolver = null;
                previous(false);
            }

            ui.confirmTitle.textContent = options.title || 'Are you sure?';
            ui.confirmMessage.textContent = options.message || '';
            ui.confirmOk.textContent = options.confirmText || 'Confirm';
            ui.confirmCancel.textContent = options.cancelText || 'Cancel';
            ui.confirmOk.classList.toggle('danger', !!options.danger);
            ui.confirmOk.classList.toggle('primary', !options.danger);

            confirmLastFocus = document.activeElement;
            ui.confirmOverlay.hidden = false;
            confirmResolver = resolve;
            ui.confirmOk.focus();
        });
    }

    function closeConfirm(result) {
        if (ui.confirmOverlay.hidden) return;
        ui.confirmOverlay.hidden = true;
        var resolve = confirmResolver;
        confirmResolver = null;
        if (confirmLastFocus && confirmLastFocus.focus) confirmLastFocus.focus();
        if (resolve) resolve(!!result);
    }

    function setupConfirm() {
        ui.confirmOk.addEventListener('click', function () { closeConfirm(true); });
        ui.confirmCancel.addEventListener('click', function () { closeConfirm(false); });
        ui.confirmOverlay.addEventListener('click', function (event) {
            if (event.target === ui.confirmOverlay) closeConfirm(false);
        });
    }

    // ----- Account settings (any user) ------------------------------------ //

    function openAccountSettings() {
        openModal('Account settings', function (body) {
            // Only admins may rename accounts (their own included); everyone can
            // change their own password.
            if (state.user && state.user.isAdmin) {
                body.appendChild(buildProfileSection());
            }
            body.appendChild(buildPasswordSection());
        });
    }

    function buildProfileSection() {
        var input = el('input', {
            type: 'text', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off'
        });
        input.value = (state.user && state.user.username) || '';

        var error = el('p', { class: 'form-error', hidden: true, role: 'alert' });
        var button = el('button', { class: 'button primary', type: 'submit', text: 'Save username' });

        var form = el('form', { class: 'settings-form' }, [
            field('Username', input), error, button
        ]);

        form.addEventListener('submit', function (event) {
            event.preventDefault();
            clearError(error);

            var name = input.value.trim();
            if (!name) { showError(error, 'Username cannot be empty'); return; }
            if (name === (state.user && state.user.username)) { closeModal(); return; }

            button.disabled = true;
            api('POST', '/api/account/username', { username: name })
                .then(function (payload) {
                    state.user = payload.user;
                    reflectUser();
                    closeModal();
                    toast('Username updated', 'success');
                })
                .catch(function (err) { showError(error, err.message); })
                .finally(function () { button.disabled = false; });
        });

        return el('section', { class: 'settings-section' }, [
            el('h3', null, [iconSvg('i-user'), 'Profile']),
            el('p', { class: 'settings-hint', text: 'The name you sign in with.' }),
            form
        ]);
    }

    function buildPasswordSection() {
        var current = el('input', { type: 'password', autocomplete: 'current-password' });
        var next = el('input', { type: 'password', autocomplete: 'new-password' });
        var confirm = el('input', { type: 'password', autocomplete: 'new-password' });
        var error = el('p', { class: 'form-error', hidden: true, role: 'alert' });
        var button = el('button', { class: 'button primary', type: 'submit', text: 'Change password' });

        var form = el('form', { class: 'settings-form' }, [
            field('Current password', current),
            field('New password', next),
            field('Confirm new password', confirm),
            error, button
        ]);

        form.addEventListener('submit', function (event) {
            event.preventDefault();
            clearError(error);

            if (next.value.length < 4) { showError(error, 'Password must be at least 4 characters'); return; }
            if (next.value !== confirm.value) { showError(error, 'The new passwords do not match'); return; }

            button.disabled = true;
            api('POST', '/api/account/password', { currentPassword: current.value, newPassword: next.value })
                .then(function () {
                    closeModal();
                    toast('Password changed', 'success');
                })
                .catch(function (err) { showError(error, err.message); })
                .finally(function () { button.disabled = false; });
        });

        return el('section', { class: 'settings-section' }, [
            el('h3', null, [iconSvg('i-key'), 'Password']),
            form
        ]);
    }

    // ----- User management (admins) --------------------------------------- //

    function openUserManagement() {
        openModal('Manage users', function (body) {
            body.appendChild(el('p', { class: 'settings-hint', text: 'Loading...' }));
            loadUsers(body);
        }, { flowHead: true });
    }

    function loadUsers(body) {
        api('GET', '/api/users')
            .then(function (payload) { renderUsers(body, payload.users); })
            .catch(function (err) {
                body.textContent = '';
                body.appendChild(el('p', { class: 'form-error', text: err.message }));
            });
    }

    function renderUsers(body, users) {
        body.textContent = '';

        var addName = el('input', { type: 'text', autocapitalize: 'none', autocorrect: 'off' });
        var addPass = el('input', { type: 'password', autocomplete: 'new-password' });
        var addAdmin = el('input', { type: 'checkbox' });
        var addCanShare = el('input', { type: 'checkbox' });
        var addError = el('p', { class: 'form-error', hidden: true, role: 'alert' });

        var toggleButton = el('button', { class: 'button add-user-toggle', type: 'button' },
            [iconSvg('i-plus'), 'Add user']);

        // Admins can always share, so the "allow sharing" option only makes sense
        // while the account is a regular user.
        var addShareLabel = el('label', { class: 'toggle-row' }, [addCanShare, 'Allow sharing lists']);
        addAdmin.addEventListener('change', function () {
            addShareLabel.hidden = addAdmin.checked;
        });

        var addForm = el('form', { class: 'settings-form', hidden: true }, [
            field('Username', addName),
            field('Password', addPass),
            el('label', { class: 'toggle-row' }, [addAdmin, 'Administrator']),
            addShareLabel,
            addError,
            el('div', { class: 'user-edit-buttons' }, [
                el('button', { class: 'button primary', type: 'submit', text: 'Create user' }),
                el('button', {
                    class: 'button', type: 'button', text: 'Cancel',
                    onclick: function () { addForm.hidden = true; toggleButton.hidden = false; }
                })
            ])
        ]);

        toggleButton.addEventListener('click', function () {
            toggleButton.hidden = true;
            addForm.hidden = false;
            addName.focus();
        });

        addForm.addEventListener('submit', function (event) {
            event.preventDefault();
            clearError(addError);

            var name = addName.value.trim();
            if (!name) { showError(addError, 'Username cannot be empty'); return; }
            if (addPass.value.length < 4) { showError(addError, 'Password must be at least 4 characters'); return; }

            api('POST', '/api/users', {
                username: name, password: addPass.value,
                isAdmin: addAdmin.checked, canShare: addCanShare.checked
            })
                .then(function () { toast('User created', 'success'); loadUsers(body); })
                .catch(function (err) { showError(addError, err.message); });
        });

        body.appendChild(el('div', { class: 'add-user-block' }, [toggleButton, addForm]));

        var listElement = el('ul', { class: 'users-list' });
        users.forEach(function (user) { listElement.appendChild(buildUserRow(body, user)); });
        body.appendChild(listElement);
    }

    function buildUserRow(body, user) {
        var isSelf = !!(state.user && user.id === state.user.id);

        var tags = [];
        if (user.isAdmin) tags.push(el('span', { class: 'user-badge admin' }, [iconSvg('i-shield'), 'Admin']));
        if (!user.isAdmin && user.canShare) tags.push(el('span', { class: 'user-badge you' }, [iconSvg('i-share'), 'Sharing']));
        if (isSelf) tags.push(el('span', { class: 'user-badge you', text: 'You' }));

        var main = el('div', { class: 'user-main' }, [el('span', { class: 'user-name', text: user.username })]);
        if (tags.length) main.appendChild(el('div', { class: 'user-tags' }, tags));

        var editButton = el('button', {
            class: 'icon-button', type: 'button', title: 'Edit user', 'aria-label': 'Edit user'
        }, [iconSvg('i-edit')]);

        var deleteButton = el('button', {
            class: 'icon-button', type: 'button',
            title: isSelf ? 'You cannot delete your own account' : 'Delete user', 'aria-label': 'Delete user'
        }, [iconSvg('i-trash')]);
        if (isSelf) deleteButton.disabled = true;

        var row = el('li', { class: 'user-row' }, [
            main, el('div', { class: 'user-actions' }, [editButton, deleteButton])
        ]);

        var editor = null;
        function collapse() {
            row.classList.remove('editing');
            if (editor) { editor.remove(); editor = null; }
        }

        editButton.addEventListener('click', function () {
            if (editor) { collapse(); return; }
            row.classList.add('editing');
            editor = buildUserEditor(body, user, isSelf, collapse);
            row.appendChild(editor);
            var first = editor.querySelector('input');
            if (first) first.focus();
        });

        deleteButton.addEventListener('click', function () {
            if (isSelf) return;
            confirmDialog({
                title: 'Delete user',
                message: 'Delete user "' + user.username + '" and all of their lists? This cannot be undone.',
                confirmText: 'Delete',
                danger: true
            }).then(function (ok) {
                if (!ok) return;
                api('DELETE', '/api/users/' + user.id)
                    .then(function () { toast('User deleted', 'success'); loadUsers(body); })
                    .catch(function (err) { toast(err.message, 'error'); });
            });
        });

        return row;
    }

    function formatWhen(iso) {
        try { return new Date(iso).toLocaleString(); } catch (error) { return iso; }
    }

    function buildUserEditor(body, user, isSelf, done) {
        var nameInput = el('input', { type: 'text', autocapitalize: 'none', autocorrect: 'off' });
        nameInput.value = user.username;

        var adminInput = el('input', { type: 'checkbox' });
        adminInput.checked = !!user.isAdmin;
        if (isSelf) adminInput.disabled = true;
        var adminLabel = el('label', { class: 'toggle-row' + (isSelf ? ' disabled' : '') },
            [adminInput, 'Administrator']);

        // Admins can always share, so this toggle only shows for regular users.
        var shareInput = el('input', { type: 'checkbox' });
        shareInput.checked = !!user.canShare;
        var shareLabel = el('label', { class: 'toggle-row' }, [shareInput, 'Allow sharing lists']);
        function syncShareVisibility() { shareLabel.hidden = adminInput.checked; }
        adminInput.addEventListener('change', syncShareVisibility);
        syncShareVisibility();

        var passInput = el('input', { type: 'password', autocomplete: 'new-password' });
        var error = el('p', { class: 'form-error', hidden: true, role: 'alert' });
        var saveButton = el('button', { class: 'button primary', type: 'submit', text: 'Save' });

        var form = el('form', { class: 'user-edit' }, [
            field('Username', nameInput),
            adminLabel,
            shareLabel,
            field('Reset password (optional)', passInput),
            error,
            el('div', { class: 'user-edit-buttons' }, [
                saveButton,
                el('button', { class: 'button', type: 'button', text: 'Cancel', onclick: done })
            ])
        ]);

        form.addEventListener('submit', function (event) {
            event.preventDefault();
            clearError(error);

            var name = nameInput.value.trim();
            if (!name) { showError(error, 'Username cannot be empty'); return; }

            var payload = {};
            if (name !== user.username) payload.username = name;
            if (!isSelf && adminInput.checked !== !!user.isAdmin) payload.isAdmin = adminInput.checked;
            if (!adminInput.checked && shareInput.checked !== !!user.canShare) payload.canShare = shareInput.checked;
            if (passInput.value) {
                if (passInput.value.length < 4) { showError(error, 'Password must be at least 4 characters'); return; }
                payload.password = passInput.value;
            }

            if (!Object.keys(payload).length) { done(); return; }

            saveButton.disabled = true;
            api('PATCH', '/api/users/' + user.id, payload)
                .then(function () { toast('User updated', 'success'); loadUsers(body); })
                .catch(function (err) { showError(error, err.message); saveButton.disabled = false; });
        });

        // ---- Extra tools: history, their lists, sharing, force sign-out ---- //
        var panel = el('div');
        var openPanelName = null;

        function togglePanel(name, builder) {
            if (openPanelName === name) { panel.textContent = ''; openPanelName = null; return; }
            openPanelName = name;
            panel.textContent = '';
            var wrap = el('div', { class: 'user-panel' });
            panel.appendChild(wrap);
            builder(wrap);
        }

        var actionButtons = [
            el('button', { class: 'button', type: 'button', onclick: function () {
                togglePanel('logins', function (wrap) { buildLoginHistoryPanel(wrap, user); });
            } }, [iconSvg('i-clock'), 'Login history']),
            el('button', { class: 'button', type: 'button', onclick: function () {
                togglePanel('lists', function (wrap) { buildUserListsPanel(wrap, user); });
            } }, [iconSvg('i-list'), 'View lists']),
            el('button', { class: 'button', type: 'button', onclick: function () {
                togglePanel('share', function (wrap) { buildShareMyListsPanel(wrap, user); });
            } }, [iconSvg('i-share'), 'Share my lists'])
        ];

        if (!isSelf) {
            actionButtons.push(el('button', { class: 'button', type: 'button', onclick: function () {
                confirmDialog({
                    title: 'Force sign-out',
                    message: 'Sign ' + user.username + ' out of all their devices?',
                    confirmText: 'Sign out',
                    danger: true
                }).then(function (ok) {
                    if (!ok) return;
                    api('POST', '/api/users/' + user.id + '/logout')
                        .then(function () { toast(user.username + ' was signed out', 'success'); })
                        .catch(function (err) { toast(err.message, 'error'); });
                });
            } }, [iconSvg('i-logout'), 'Force sign-out']));
        }

        return el('div', { class: 'user-edit' }, [
            form,
            el('div', { class: 'user-actions-row' }, actionButtons),
            panel
        ]);
    }

    function buildLoginHistoryPanel(wrap, user) {
        wrap.appendChild(el('h4', null, 'Recent logins'));
        var list = el('ul', { class: 'login-list' });
        wrap.appendChild(list);

        api('GET', '/api/users/' + user.id + '/logins')
            .then(function (payload) {
                if (!payload.events.length) {
                    list.appendChild(el('li', { class: 'empty-hint', text: 'No logins recorded yet.' }));
                    return;
                }
                payload.events.forEach(function (event) {
                    list.appendChild(el('li', { class: 'login-row' }, [
                        el('span', { class: 'login-when', text: formatWhen(event.at) }),
                        el('span', { class: 'login-meta',
                            text: (event.ip || 'unknown IP') + ' · ' + (event.userAgent || 'unknown device') })
                    ]));
                });
            })
            .catch(function (err) { list.appendChild(el('li', { class: 'form-error', text: err.message })); });
    }

    function buildUserListsPanel(wrap, user) {
        wrap.appendChild(el('h4', null, user.username + '’s lists'));
        var container = el('div');
        wrap.appendChild(container);

        api('GET', '/api/users/' + user.id + '/lists')
            .then(function (payload) {
                if (!payload.lists.length) {
                    container.appendChild(el('p', { class: 'empty-hint', text: 'No lists yet.' }));
                    return;
                }
                payload.lists.forEach(function (list) {
                    var items = el('ul', { class: 'readonly-items' });
                    if (!list.items.length) {
                        items.appendChild(el('li', { class: 'empty-hint', text: 'Empty' }));
                    }
                    list.items.forEach(function (item) {
                        items.appendChild(el('li', { class: 'readonly-item' + (item.checked ? ' done' : '') }, [
                            el('span', { class: 'ri-qty', text: quantityText(item.quantity) + '×' }),
                            el('span', { class: 'ri-name', text: item.name })
                        ]));
                    });
                    container.appendChild(el('div', { class: 'readonly-list' }, [
                        el('h4', null, [
                            el('span', { text: list.name + (list.shared ? ' (shared by ' + list.owner + ')' : '') }),
                            el('span', { class: 'list-total', text: money(list.total) })
                        ]),
                        items
                    ]));
                });
            })
            .catch(function (err) { container.appendChild(el('p', { class: 'form-error', text: err.message })); });
    }

    function buildShareMyListsPanel(wrap, user) {
        wrap.appendChild(el('h4', null, 'Share your lists with ' + user.username));

        var mine = state.lists.filter(function (list) {
            return list.ownerId === state.user.id;
        });
        if (!mine.length) {
            wrap.appendChild(el('p', { class: 'empty-hint', text: 'You do not own any lists to share.' }));
            return;
        }

        var container = el('div');
        wrap.appendChild(container);

        // Find out which of my lists this user can already see.
        api('GET', '/api/users/' + user.id + '/lists')
            .then(function (payload) {
                var theirIds = {};
                payload.lists.forEach(function (list) { theirIds[list.id] = true; });

                mine.forEach(function (list) {
                    var toggle = el('input', { type: 'checkbox' });
                    toggle.checked = !!theirIds[list.id];

                    toggle.addEventListener('change', function () {
                        toggle.disabled = true;
                        var wantShared = toggle.checked;
                        var request = wantShared
                            ? api('POST', '/api/lists/' + list.id + '/shares', { userId: user.id })
                            : api('DELETE', '/api/lists/' + list.id + '/shares/' + user.id);
                        request
                            .then(function () {
                                toast(wantShared ? 'Shared "' + list.name + '"' : 'Unshared "' + list.name + '"', 'success');
                            })
                            .catch(function (err) { toggle.checked = !wantShared; toast(err.message, 'error'); })
                            .finally(function () { toggle.disabled = false; });
                    });

                    container.appendChild(el('label', { class: 'share-mine-row' },
                        [el('span', { class: 'share-name', text: list.name }), toggle]));
                });
            })
            .catch(function (err) { container.appendChild(el('p', { class: 'form-error', text: err.message })); });
    }

    function setupAccountMenu() {
        function close() {
            ui.accountMenu.hidden = true;
            ui.accountButton.setAttribute('aria-expanded', 'false');
        }

        ui.accountButton.addEventListener('click', function (event) {
            event.stopPropagation();
            var open = ui.accountMenu.hidden;
            ui.accountMenu.hidden = !open;
            ui.accountButton.setAttribute('aria-expanded', open ? 'true' : 'false');
        });

        document.addEventListener('click', function (event) {
            if (!ui.accountMenu.hidden && !ui.accountMenu.contains(event.target)
                && event.target !== ui.accountButton) {
                close();
            }
        });

        document.addEventListener('keydown', function (event) {
            if (event.key !== 'Escape') return;
            if (!ui.confirmOverlay.hidden) { closeConfirm(false); return; }
            if (!ui.modalOverlay.hidden) { closeModal(); return; }
            close();
        });

        ui.accountMenu.addEventListener('click', function (event) {
            var button = event.target.closest('[data-account-action]');
            if (!button) return;
            close();

            if (button.dataset.accountAction === 'account') openAccountSettings();
            else if (button.dataset.accountAction === 'users') openUserManagement();
        });
    }

    // ===================================================================== //
    // Sharing
    // ===================================================================== //

    function openShareDialog() {
        var list = activeList();
        if (!list) return;

        openModal('Share “' + list.name + '”', function (body) {
            body.appendChild(el('p', { class: 'settings-hint', text: 'Loading…' }));
            Promise.all([
                api('GET', '/api/lists/' + list.id + '/shares'),
                api('GET', '/api/share-targets')
            ]).then(function (results) {
                renderShareDialog(body, list, results[0], results[1]);
            }).catch(function (err) {
                body.textContent = '';
                body.appendChild(el('p', { class: 'form-error', text: err.message }));
            });
        });
    }

    function renderShareDialog(body, list, shares, targets) {
        body.textContent = '';

        var collaborators = shares.collaborators || [];
        var canManage = !!shares.canManage;
        var owner = collaborators.filter(function (c) { return c.owner; })[0];
        var sharedIds = {};
        collaborators.forEach(function (c) { if (!c.owner) sharedIds[c.id] = true; });

        var section = el('section', { class: 'settings-section' }, [
            el('h3', null, [iconSvg('i-users'), 'People with access'])
        ]);

        if (owner) {
            section.appendChild(el('div', { class: 'share-row' }, [
                el('span', { class: 'share-name', text: owner.username }),
                el('span', { class: 'share-role', text: 'Owner' })
            ]));
        }

        (targets.users || []).forEach(function (person) {
            if (owner && person.id === owner.id) return;

            var toggle = el('input', { type: 'checkbox' });
            toggle.checked = !!sharedIds[person.id];
            if (!canManage) toggle.disabled = true;

            toggle.addEventListener('change', function () {
                toggle.disabled = true;
                var wantShared = toggle.checked;
                var request = wantShared
                    ? api('POST', '/api/lists/' + list.id + '/shares', { userId: person.id })
                    : api('DELETE', '/api/lists/' + list.id + '/shares/' + person.id);

                request
                    .then(function () {
                        toast(wantShared ? 'Shared with ' + person.username
                            : 'Removed ' + person.username, 'success');
                    })
                    .catch(function (err) {
                        toggle.checked = !wantShared;
                        toast(err.message, 'error');
                    })
                    .finally(function () { toggle.disabled = !canManage; });
            });

            section.appendChild(el('label', { class: 'share-row' + (canManage ? '' : ' disabled') },
                [el('span', { class: 'share-name', text: person.username }), toggle]));
        });

        body.appendChild(section);

        if (!canManage) {
            body.appendChild(el('p', { class: 'settings-hint',
                text: 'Only the owner or an admin can change who this list is shared with.' }));
        } else if (!(targets.users || []).length) {
            body.appendChild(el('p', { class: 'empty-hint', text: 'There are no other users to share with yet.' }));
        }
    }

    // ===================================================================== //
    // Wiring
    // ===================================================================== //

    function setupMenu() {
        function close() {
            ui.menu.hidden = true;
            ui.menuButton.setAttribute('aria-expanded', 'false');
        }

        ui.menuButton.addEventListener('click', function (event) {
            event.stopPropagation();
            var open = ui.menu.hidden;
            if (open) {
                var list = activeList();
                // Share is for anyone allowed to share; Leave only appears on a
                // list that reached you through a share.
                ui.menuShare.hidden = !canShare();
                ui.menuLeave.hidden = !(list && list.shared);
            }
            ui.menu.hidden = !open;
            ui.menuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
        });

        document.addEventListener('click', function (event) {
            if (!ui.menu.hidden && !ui.menu.contains(event.target)) close();
        });

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') close();
        });

        ui.menu.addEventListener('click', function (event) {
            var button = event.target.closest('[data-action]');
            if (!button) return;

            var action = button.dataset.action;
            if (action !== 'toggle-sink') close();

            if (action === 'rename') {
                ui.listName.focus();
                ui.listName.select();
            } else if (action === 'uncheck-all') {
                setAllChecked(false);
            } else if (action === 'clear-checked') {
                clearChecked();
            } else if (action === 'copy') {
                copyList();
            } else if (action === 'export') {
                exportCsv();
            } else if (action === 'duplicate') {
                duplicateList();
            } else if (action === 'share') {
                openShareDialog();
            } else if (action === 'leave') {
                leaveList();
            } else if (action === 'toggle-sink') {
                toggleSinkChecked();
            } else if (action === 'delete') {
                deleteList();
            }
        });
    }

    function setupSearch() {
        function apply() {
            filterText = ui.searchInput.value.trim();
            var list = activeList();
            if (list) renderItems(list);
        }

        ui.searchToggle.addEventListener('click', function () {
            ui.searchRow.hidden = !ui.searchRow.hidden;
            if (ui.searchRow.hidden) {
                ui.searchInput.value = '';
                apply();
            } else {
                ui.searchInput.focus();
            }
        });

        ui.searchInput.addEventListener('input', apply);
        ui.searchInput.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                ui.searchInput.value = '';
                apply();
                ui.searchInput.blur();
            }
        });

        // Collapse the search row once it loses focus while empty (nothing is
        // being filtered). The timeout lets the clear button's click run first
        // — it re-focuses the input, so we won't hide it out from under them.
        ui.searchInput.addEventListener('blur', function () {
            setTimeout(function () {
                if (document.activeElement === ui.searchInput) return;
                if (ui.searchInput.value.trim() === '') {
                    ui.searchRow.hidden = true;
                }
            }, 120);
        });

        ui.searchClear.addEventListener('click', function () {
            ui.searchInput.value = '';
            apply();
            ui.searchInput.focus();
        });
    }

    function setupHotkeys() {
        document.addEventListener('keydown', function (event) {
            if (!ui.modalOverlay.hidden) return;
            var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

            if (event.key === '/' && !typing) {
                event.preventDefault();
                ui.searchRow.hidden = false;
                ui.searchInput.focus();
            } else if (event.key.toLowerCase() === 'n' && !typing && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                ui.newName.focus();
            }
        });
    }

    // The composer now lives at the end of the list, so a small floating button
    // appears whenever it is scrolled out of view and jumps you straight to it.
    function composerOnScreen() {
        if (ui.composer.hidden) return true;
        var rect = ui.composer.getBoundingClientRect();
        var viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        // Count it as "on screen" once most of it has come into view.
        return rect.top < viewportHeight - 40 && rect.bottom > 0;
    }

    function updateFab() {
        var show = !ui.composer.hidden && !composerOnScreen();
        ui.scrollFab.classList.toggle('show', show);
    }

    function setupFab() {
        ui.scrollFab.addEventListener('click', function () {
            ui.composer.scrollIntoView({ behavior: 'smooth', block: 'center' });
            ui.newName.focus({ preventScroll: true });
        });

        window.addEventListener('scroll', updateFab, { passive: true });
        window.addEventListener('resize', updateFab);

        if ('IntersectionObserver' in window) {
            // Fires when the composer's visibility changes for reasons other than
            // scrolling (rows added/removed, list switched).
            new IntersectionObserver(updateFab, { rootMargin: '0px 0px -40px 0px' })
                .observe(ui.composer);
        }
    }

    function setupServiceWorker() {
        if (!('serviceWorker' in navigator) || location.protocol === 'http:' && location.hostname !== 'localhost') {
            // Service workers need a secure context; plain http on a LAN IP is not one.
            return;
        }
        navigator.serviceWorker.register('/sw.js').catch(function () { /* not fatal */ });
    }

    function init() {
        var stored = Number(storageGet('activeList', ''));
        if (stored && state.lists.some(function (list) { return list.id === stored; })) {
            activeListId = stored;
        } else if (state.lists.length) {
            activeListId = state.lists[0].id;
        }

        ui.priceLabel.textContent = 'Price (' + currencySymbol() + ')';

        // Re-hydrate any edits that could not reach the server before, so a
        // reload while offline does not lose them.
        loadOutbox();
        applyOutboxToState();

        render();
        loadDraft();
        syncComposerFields();
        updateMenuLabels();

        ui.composer.addEventListener('submit', addItem);

        // Tapping Add would otherwise blur the name field, which closes the
        // keyboard and - now that the keyboard resizes the page - reflows the
        // whole document, only for the focus() after the add to reopen it. The
        // click still fires; all this drops is the focus change.
        var addButton = ui.composer.querySelector('.add');
        if (addButton) {
            addButton.addEventListener('mousedown', function (event) {
                event.preventDefault();
            });
        }

        [ui.newName, ui.newQuantity, ui.newPrice].forEach(function (input) {
            input.addEventListener('input', saveDraft);
        });
        ui.newName.addEventListener('input', syncComposerFields);
        ui.newName.addEventListener('input', renderSuggestions);
        [ui.newQuantity, ui.newPrice].forEach(function (input) {
            input.addEventListener('blur', syncComposerFields);
        });

        ui.boughtToggle.addEventListener('click', toggleBought);

        ui.listName.addEventListener('change', function () {
            renameList(ui.listName.value.trim());
        });
        ui.listName.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') ui.listName.blur();
        });

        ui.emptyNewList.addEventListener('click', createList);
        ui.themeToggle.addEventListener('click', toggleTheme);

        setupMenu();
        setupSearch();
        setupSuggestions();
        setupSwipe();
        setupTapToggle();
        setupToastSwipe();
        setupHotkeys();
        setupFab();
        setupModal();
        setupConfirm();
        setupAccountMenu();
        setupConnectivity();
        setupServiceWorker();
        setBusy(0);
        flushOutbox();
        syncLoop();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
