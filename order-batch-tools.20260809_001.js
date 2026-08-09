(function(root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.OrderBatchTools = api;
})(typeof window !== 'undefined' ? window : globalThis, function() {
    'use strict';

    function text(value) {
        return String(value === undefined || value === null ? '' : value).trim();
    }

    function qty(value) {
        var n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : 1;
    }

    function orderNoOf(order) {
        var raw = order && (order.orderNo !== undefined ? order.orderNo : order.serialNumber);
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 0 ? Math.floor(raw) : null;
        var match = text(raw).match(/(\d+)\s*$/);
        if (!match) return null;
        var n = Number(match[1]);
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    function uniquePrintableOrders(orders) {
        var seen = {};
        return (Array.isArray(orders) ? orders : []).filter(function(order) {
            if (!order || !text(order.id) || text(order.status).toLowerCase() === 'archived') return false;
            var no = orderNoOf(order);
            if (no === null) return false;
            var dateKey = text(order.orderDateKey || order.pickupDate || order._sourceDateKey);
            var key = text(order.id) + '|' + dateKey + '|' + no;
            if (seen[key]) return false;
            seen[key] = true;
            return true;
        }).slice().sort(function(a, b) {
            var noDiff = orderNoOf(a) - orderNoOf(b);
            if (noDiff) return noDiff;
            return Number(a.timestamp || a.createdAt || 0) - Number(b.timestamp || b.createdAt || 0);
        });
    }

    function selectRange(orders, start, end) {
        var a = Number(start);
        var b = Number(end);
        if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return [];
        a = Math.floor(a);
        b = Math.floor(b);
        if (a > b) { var swap = a; a = b; b = swap; }
        return uniquePrintableOrders(orders).filter(function(order) {
            var no = orderNoOf(order);
            return no >= a && no <= b;
        });
    }

    function itemName(item) {
        return text(item && (item.name || item['品項'] || item.itemName || item.printName || item.shortName));
    }

    function itemQty(item) {
        return qty(item && (item.qty !== undefined ? item.qty : (item['數量'] !== undefined ? item['數量'] : item.quantity)));
    }

    function normalizedKey(value) {
        return text(value).toLowerCase().replace(/\s+/g, '');
    }

    function menuIndexes(menuItems) {
        var byId = {};
        var byName = {};
        (Array.isArray(menuItems) ? menuItems : []).forEach(function(item) {
            if (!item) return;
            [item.id, item.itemId, item.item_id, item.firebaseId, item.firebase_id].forEach(function(id) {
                id = text(id);
                if (id) byId[id] = item;
            });
            [item.name, item.printName, item.shortName].forEach(function(name) {
                var key = normalizedKey(name);
                if (key) byName[key] = item;
            });
        });
        return { byId: byId, byName: byName };
    }

    function findMenuItem(item, indexes) {
        var ids = [item && item.id, item && item.itemId, item && item.item_id, item && item.menuId, item && item.menu_id];
        for (var i = 0; i < ids.length; i++) {
            var id = text(ids[i]);
            if (id && indexes.byId[id]) return indexes.byId[id];
        }
        return indexes.byName[normalizedKey(itemName(item))] || null;
    }

    function pushCount(map, name, amount, unit) {
        name = text(name);
        unit = text(unit);
        amount = Number(amount);
        if (!name || !Number.isFinite(amount) || amount <= 0) return;
        var key = normalizedKey(name) + '|' + unit;
        if (!map[key]) map[key] = { name: name, qty: 0, unit: unit };
        map[key].qty += amount;
    }

    function rowsOf(map) {
        return Object.keys(map).map(function(key) {
            var row = map[key];
            var rounded = Math.round(row.qty * 100) / 100;
            return { name: row.name, qty: rounded, unit: row.unit };
        }).sort(function(a, b) { return a.name.localeCompare(b.name, 'zh-Hant'); });
    }

    function summarize(orders, menuItems) {
        var selected = uniquePrintableOrders(orders);
        var indexes = menuIndexes(menuItems);
        var itemMap = {};
        var extraMap = {};
        var prepMap = {};
        var missing = {};

        selected.forEach(function(order) {
            (Array.isArray(order && order.items) ? order.items : []).forEach(function(item) {
                var name = itemName(item);
                var count = itemQty(item);
                if (!name) return;
                pushCount(itemMap, name, count, '份');

                [item && item.options, item && item.posExtras].forEach(function(list) {
                    (Array.isArray(list) ? list : []).forEach(function(extra) {
                        var extraName = text(extra && (extra.name || extra['名稱']));
                        if (extraName) pushCount(extraMap, extraName, count * qty(extra && extra.qty), '份');
                    });
                });

                var menuItem = findMenuItem(item, indexes);
                var recipe = Array.isArray(item && item.prepItems) && item.prepItems.length
                    ? item.prepItems
                    : (menuItem && Array.isArray(menuItem.prepItems) ? menuItem.prepItems : []);
                if (!recipe.length) {
                    missing[name] = true;
                    return;
                }
                recipe.forEach(function(part) {
                    pushCount(prepMap, part && part.name, count * qty(part && part.qty), part && part.unit);
                });
            });
        });

        return {
            ordersCount: selected.length,
            itemRows: rowsOf(itemMap),
            extraRows: rowsOf(extraMap),
            prepRows: rowsOf(prepMap),
            missingRecipes: Object.keys(missing).sort(function(a, b) { return a.localeCompare(b, 'zh-Hant'); })
        };
    }

    return {
        orderNoOf: orderNoOf,
        uniquePrintableOrders: uniquePrintableOrders,
        selectRange: selectRange,
        summarize: summarize
    };
});
