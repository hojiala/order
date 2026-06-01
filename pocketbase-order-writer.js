const DEFAULT_COLLECTION = "orders";
const DEFAULT_TIMEOUT_MS = 2500;
const RESET_TIMEOUT_MS = 10000;
let backfillPausedUntil = 0;

function cleanBaseUrl(url) {
    var value = String(url || "").trim();
    if (!value) return "";
    return value.replace(/\/+$/, "");
}

function normalizeDateKey(orderData) {
    if (orderData && orderData.orderDateKey) return String(orderData.orderDateKey);
    if (orderData && orderData.pickupDate) return String(orderData.pickupDate);
    var d = new Date((orderData && orderData.timestamp) || Date.now());
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
}

function numericOrUndefined(value) {
    if (value === "" || value === null || value === undefined) return undefined;
    var n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}

function text(value) {
    return value === null || value === undefined ? "" : String(value);
}

function plainJson(value, fallback) {
    if (value === null || value === undefined) return fallback;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch(e) {
        return fallback;
    }
}

function jsonObject(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) return plainJson(value, {});
    if (typeof value === "string" && value.trim()) {
        try {
            var parsed = JSON.parse(value);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        } catch(e) {}
    }
    return {};
}

function jsonArray(value) {
    if (Array.isArray(value)) return plainJson(value, []);
    if (typeof value === "string" && value.trim()) {
        try {
            var parsed = JSON.parse(value);
            if (Array.isArray(parsed)) return parsed;
        } catch(e) {}
    }
    return [];
}

function timestampFromRecord(record, customer) {
    var ts = numericOrUndefined(customer && customer.timestamp);
    if (ts) return ts;
    var raw = text((record && (record.created || record.updated)) || "");
    var parsed = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : Date.now();
}

function padOrderNo(value) {
    return String(Math.max(0, Number(value) || 0)).padStart(3, "0");
}

function sourceLabelFor(orderData, sourcePage) {
    if (orderData && orderData.sourceLabel) return text(orderData.sourceLabel);
    var source = text(orderData && orderData.source);
    var labels = {
        online: "線上點餐",
        dinein: "桌邊點餐",
        qrcode: "桌邊掃碼",
        qr_takeout: "掃碼外帶",
        pos: "現場 POS"
    };
    return labels[source] || labels[sourcePage] || source || text(sourcePage);
}

function customerPayload(orderData, options) {
    options = options || {};
    var settings = options.settings || {};
    var state = settings.orderCounterState || {};
    var raw = orderData && orderData.customer;
    var payload;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        payload = Object.assign({}, raw);
    } else {
        payload = {
            name: text(raw || (orderData && orderData.tableLabel) || ""),
            phone: text(orderData && orderData.phone),
            deviceId: text(orderData && (orderData.deviceId || orderData.tableDevice)),
            tableLabel: text(orderData && orderData.tableLabel),
            tableType: text(orderData && orderData.tableType)
        };
    }
    payload.phone = payload.phone || text(orderData && orderData.phone);
    payload.deviceId = payload.deviceId || text(orderData && (orderData.deviceId || orderData.tableDevice));
    payload.tableLabel = payload.tableLabel || text(orderData && orderData.tableLabel);
    payload.tableType = payload.tableType || text(orderData && orderData.tableType);
    payload.orderNote = payload.orderNote || text(orderData && orderData.orderNote);
    payload.printTask = payload.printTask || text(orderData && orderData.print_task);
    payload.timestamp = payload.timestamp || numericOrUndefined(orderData && orderData.timestamp);
    payload.counterCycleKey = payload.counterCycleKey || text(orderData && orderData.counterCycleKey);
    payload.counterResetTime = payload.counterResetTime || text(
        (orderData && orderData.counterResetTime) ||
        options.counterResetTime ||
        options.resetTime ||
        settings.counterResetTime ||
        state.resetTime ||
        "00:00"
    );
    payload.counterMaxNo = numericOrUndefined(
        payload.counterMaxNo ||
        (orderData && orderData.counterMaxNo) ||
        options.counterMaxNo ||
        options.maxNo ||
        settings.counterMaxNo ||
        state.maxNo ||
        999
    ) || 999;
    payload.printSource = payload.printSource || text(orderData && (orderData.printSource || orderData["訂單來源"]));
    if (!payload.stationMap && orderData && Array.isArray(orderData.stationMap)) payload.stationMap = orderData.stationMap;
    if (!payload.stationSettings && orderData && Array.isArray(orderData.stationSettings)) payload.stationSettings = orderData.stationSettings;
    return payload;
}

function compactRecord(record) {
    var out = {};
    Object.keys(record).forEach(function(key) {
        if (record[key] !== undefined && record[key] !== null) out[key] = record[key];
    });
    return out;
}

export function buildPocketBaseOrderRecord(orderId, orderData, options) {
    options = options || {};
    orderData = orderData || {};
    var dateKey = normalizeDateKey(orderData);
    return compactRecord({
        order_id: text(orderId || orderData.id),
        order_no: numericOrUndefined(orderData.orderNo || orderData.order_no),
        date_key: dateKey,
        source: text(orderData.source || options.sourcePage || ""),
        source_label: sourceLabelFor(orderData, options.sourcePage),
        status: text(orderData.status || "new"),
        payment_method: text(orderData.paymentMethod || orderData.payment_method || ""),
        payment_status: text(orderData.paymentStatus || orderData.payment_status || ""),
        pickup_mode: text(orderData.type || orderData.pickupMode || orderData.pickup_mode || ""),
        pickup_time: text(orderData.pickupTime || orderData.pickup_time || ""),
        total: numericOrUndefined(orderData.total),
        customer: plainJson(customerPayload(orderData, options), {}),
        items: plainJson(Array.isArray(orderData.items) ? orderData.items : [], [])
    });
}

function optionValue(options, keys) {
    options = options || {};
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (options[key]) return options[key];
        if (options.settings && options.settings[key]) return options.settings[key];
    }
    return "";
}

function storageValue(keys) {
    try {
        if (typeof localStorage === "undefined") return "";
        for (var i = 0; i < keys.length; i++) {
            var value = localStorage.getItem(keys[i]);
            if (value) return value;
        }
    } catch(e) {}
    return "";
}

export function resolvePocketBaseConfig(options) {
    options = options || {};
    var settings = options.settings || {};
    var nested = settings.pocketBase || settings.pocketbase || {};
    var baseUrl = cleanBaseUrl(
        optionValue(options, ["pocketBaseUrl", "pocketbaseUrl"]) ||
        nested.url ||
        (typeof window !== "undefined" && (window.POCKETBASE_URL || window.POCKETBASE_BASE_URL)) ||
        storageValue(["pocketbase_url", "POCKETBASE_URL"]) ||
        ""
    );
    var collection = text(
        optionValue(options, ["pocketBaseOrdersCollection", "pocketbaseOrdersCollection"]) ||
        nested.ordersCollection ||
        DEFAULT_COLLECTION
    ) || DEFAULT_COLLECTION;
    var token = text(
        options.pocketBaseToken ||
        options.pocketbaseToken ||
        (typeof window !== "undefined" && (window.POCKETBASE_TOKEN || "")) ||
        storageValue(["pocketbase_token"])
    );
    return { baseUrl: baseUrl, collection: collection, token: token };
}

export function pocketBaseRecordToOrder(record) {
    record = record || {};
    var customer = jsonObject(record.customer);
    var items = jsonArray(record.items);
    var dateKey = text(record.date_key || record.dateKey || customer.orderDateKey || customer.pickupDate);
    var orderId = text(record.order_id || record.orderId || record.id);
    var source = text(record.source || "web");
    var paymentMethod = text(record.payment_method || record.paymentMethod || "");
    var paymentStatus = text(record.payment_status || record.paymentStatus || "");
    var pickupMode = text(record.pickup_mode || record.pickupMode || "");
    var orderNo = numericOrUndefined(record.order_no || record.orderNo);
    var timestamp = timestampFromRecord(record, customer);
    var sourceRecordPath = text(customer.sourceRecordPath || customer.source_record_path);
    if (!sourceRecordPath && dateKey && orderId) sourceRecordPath = "orders/" + dateKey + "/" + orderId;
    var order = {
        id: orderId || text(record.id),
        source: source,
        sourceLabel: text(record.source_label || record.sourceLabel || sourceLabelFor({ source: source }, source)),
        sourceOrderId: orderId || text(record.id),
        status: text(record.status || "new"),
        orderNo: orderNo || null,
        serialNumber: orderNo ? padOrderNo(orderNo) : text(record.serialNumber || ""),
        timestamp: timestamp,
        createdAt: timestamp,
        updatedAt: text(record.updated || ""),
        pickupDate: dateKey,
        orderDateKey: dateKey,
        _sourceDateKey: dateKey,
        pickupTime: text(record.pickup_time || record.pickupTime || ""),
        pickupTimeLabel: text(record.pickup_time || record.pickupTime || ""),
        type: pickupMode,
        pickupMode: pickupMode,
        tableLabel: text(customer.tableLabel),
        tableType: text(customer.tableType),
        customer: customer.name || customer.tableLabel || "",
        phone: text(customer.phone),
        paymentMethod: paymentMethod,
        paymentStatus: paymentStatus,
        payment: { method: paymentMethod, status: paymentStatus },
        items: items,
        total: numericOrUndefined(record.total) || 0,
        totals: { finalTotal: numericOrUndefined(record.total) || 0 },
        orderNote: text(customer.orderNote),
        counterCycleKey: text(customer.counterCycleKey),
        print_task: text(customer.printTask || customer.print_task),
        sourceRecordPath: sourceRecordPath,
        _pocketBaseRecordId: text(record.id),
        _readBackend: "pocketbase"
    };
    if (customer.deviceId) order.deviceId = text(customer.deviceId);
    if (Array.isArray(customer.stationMap)) order.stationMap = customer.stationMap;
    if (Array.isArray(customer.stationSettings)) order.stationSettings = customer.stationSettings;
    return order;
}

function dateKeyFilter(dateKeys) {
    var keys = Array.isArray(dateKeys) ? dateKeys.map(text).filter(Boolean) : [];
    keys = keys.filter(function(v, i, arr) { return arr.indexOf(v) === i; });
    if (!keys.length) return "";
    return "(" + keys.map(function(key) { return "date_key = '" + encodeFilterValue(key) + "'"; }).join(" || ") + ")";
}

function recordDateKey(record) {
    if (!record) return "";
    var customer = jsonObject(record.customer);
    return text(record.date_key || record.dateKey || customer.orderDateKey || customer.pickupDate);
}

function filterRecordsByDateKeys(records, dateKeys) {
    var keys = Array.isArray(dateKeys) ? dateKeys.map(text).filter(Boolean) : [];
    keys = keys.filter(function(v, i, arr) { return arr.indexOf(v) === i; });
    if (!keys.length) return records;
    return records.filter(function(record) {
        return keys.indexOf(recordDateKey(record)) >= 0;
    });
}

function sortOrderRecords(records) {
    return records.slice().sort(function(a, b) {
        var da = recordDateKey(a);
        var db = recordDateKey(b);
        if (da !== db) return db.localeCompare(da);
        var na = numericOrUndefined(a && (a.order_no || a.orderNo)) || 0;
        var nb = numericOrUndefined(b && (b.order_no || b.orderNo)) || 0;
        if (na !== nb) return nb - na;
        var ca = Date.parse(text(a && a.created));
        var cb = Date.parse(text(b && b.created));
        ca = Number.isFinite(ca) ? ca : 0;
        cb = Number.isFinite(cb) ? cb : 0;
        return cb - ca;
    });
}

export function listOrdersFromPocketBase(options) {
    options = options || {};
    var config = resolvePocketBaseConfig(options);
    if (!config.baseUrl) {
        return Promise.resolve({ ok: false, skipped: true, reason: "missing_pocketbase_url", orders: [] });
    }
    if (typeof window !== "undefined" && window.location && window.location.protocol === "https:" &&
        /^http:\/\//i.test(config.baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(config.baseUrl)) {
        return Promise.resolve({ ok: false, skipped: true, reason: "mixed_content_http_pocketbase_url", orders: [] });
    }
    var headers = {};
    if (config.token) headers.Authorization = "Bearer " + config.token;
    var perPage = Math.max(1, Math.min(500, Math.floor(Number(options.perPage || 300) || 300)));
    var timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    var filter = dateKeyFilter(options.dateKeys);
    var baseUrl = config.baseUrl + "/api/collections/" + encodeURIComponent(config.collection) + "/records";
    var sort = text(options.sort || "-date_key,-order_no,-created");
    var maxPages = Math.max(1, Math.floor(Number(options.maxPages || 8) || 8));

    function fetchRecords(queryFilter, querySort) {
        var records = [];
        function fetchPage(page) {
            var url = baseUrl + "?page=" + page + "&perPage=" + perPage;
            if (querySort) url += "&sort=" + encodeURIComponent(querySort);
            if (queryFilter) url += "&filter=" + encodeURIComponent(queryFilter);
            return requestJson(url, { method: "GET", headers: headers }, timeoutMs).then(function(data) {
                var items = Array.isArray(data && data.items) ? data.items : [];
                records = records.concat(items);
                var totalPages = Number(data && data.totalPages) || page;
                if (page < totalPages && page < maxPages) return fetchPage(page + 1);
                return records;
            });
        }
        return fetchPage(1);
    }

    function fallbackAfterBadQuery(err) {
        if (!err || Number(err.status) !== 400) throw err;
        return fetchRecords("", sort).catch(function(sortErr) {
            if (!sortErr || Number(sortErr.status) !== 400) throw sortErr;
            return fetchRecords("", "");
        }).then(function(rows) {
            return sortOrderRecords(filterRecordsByDateKeys(rows, options.dateKeys));
        });
    }

    return fetchRecords(filter, sort).catch(fallbackAfterBadQuery).then(function(rows) {
        rows = sortOrderRecords(filterRecordsByDateKeys(rows, options.dateKeys));
        return {
            ok: true,
            backend: "pocketbase",
            records: rows,
            orders: rows.map(pocketBaseRecordToOrder)
        };
    }).catch(function(e) {
        return { ok: false, backend: "pocketbase", error: e, message: e && e.message ? e.message : String(e), orders: [] };
    });
}

function backfillThrottleKey(order) {
    var id = text(order && (order.id || order.sourceOrderId || order.orderId));
    if (id) return id;
    return [
        text(order && (order.source || "")),
        text(order && (order.orderDateKey || order.pickupDate || "")),
        text(order && (order.orderNo || order.serialNumber || "")),
        text(order && (order.phone || ""))
    ].join("|");
}

function wasRecentlyBackfilled(key, ttlMs) {
    try {
        if (typeof localStorage === "undefined" || !key) return false;
        var raw = Number(localStorage.getItem("pb_backfill_ok_" + key) || 0);
        return raw && Date.now() - raw < ttlMs;
    } catch(e) {
        return false;
    }
}

function markBackfilled(key) {
    try {
        if (typeof localStorage !== "undefined" && key) localStorage.setItem("pb_backfill_ok_" + key, String(Date.now()));
    } catch(e) {}
}

export function backfillOrdersToPocketBase(orders, options) {
    options = options || {};
    var now = Date.now();
    if (now < backfillPausedUntil) {
        return Promise.resolve({ ok: false, paused: true, attempted: 0, success: 0, failed: 0 });
    }
    var rows = Array.isArray(orders) ? orders : [];
    var limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit || 25) || 25)));
    var ttlMs = Math.max(10000, Number(options.throttleMs || 300000) || 300000);
    var seen = {};
    var candidates = rows.filter(function(order) {
        if (!order || typeof order !== "object") return false;
        if (order._readBackend === "pocketbase" || order._pocketBaseRecordId) return false;
        var key = backfillThrottleKey(order);
        if (!key || seen[key] || wasRecentlyBackfilled(key, ttlMs)) return false;
        seen[key] = true;
        return true;
    }).slice(0, limit);
    var success = 0;
    var failed = 0;

    return candidates.reduce(function(promise, order) {
        return promise.then(function() {
            var key = backfillThrottleKey(order);
            return writeOrderToPocketBase(text(order.id || order.sourceOrderId || order.orderId), order, Object.assign({}, options, {
                sourcePage: text(order.source || options.sourcePage || "firebase_fallback"),
                timeoutMs: Number(options.timeoutMs || 1200) || 1200
            })).then(function(result) {
                if (result && result.ok) {
                    success++;
                    markBackfilled(key);
                    return;
                }
                failed++;
                backfillPausedUntil = Date.now() + 10000;
            }).catch(function() {
                failed++;
                backfillPausedUntil = Date.now() + 10000;
            });
        });
    }, Promise.resolve()).then(function() {
        return { ok: failed === 0, attempted: candidates.length, success: success, failed: failed };
    });
}

function encodeFilterValue(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function requestJson(url, init, timeoutMs) {
    init = init || {};
    timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var didTimeout = false;
    var timer = controller ? setTimeout(function() {
        didTimeout = true;
        controller.abort();
    }, timeoutMs) : null;
    if (controller) init.signal = controller.signal;
    return fetch(url, init).then(function(res) {
        return res.text().then(function(bodyText) {
            var body = null;
            if (bodyText) {
                try { body = JSON.parse(bodyText); } catch(e) { body = bodyText; }
            }
            if (!res.ok) {
                var msg = body && body.message ? body.message : bodyText || ("HTTP " + res.status);
                var err = new Error(msg);
                err.status = res.status;
                err.body = body;
                throw err;
            }
            return body;
        });
    }).catch(function(err) {
        if (didTimeout) {
            throw new Error("PocketBase request timeout after " + timeoutMs + "ms");
        }
        throw err;
    }).finally(function() {
        if (timer) clearTimeout(timer);
    });
}

export function allocateOrderNoFromPocketBase(options) {
    options = options || {};
    var config = resolvePocketBaseConfig(options);
    if (!config.baseUrl) {
        return Promise.resolve({ ok: false, skipped: true, reason: "missing_pocketbase_url" });
    }
    if (typeof window !== "undefined" && window.location && window.location.protocol === "https:" &&
        /^http:\/\//i.test(config.baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(config.baseUrl)) {
        return Promise.resolve({ ok: false, skipped: true, reason: "mixed_content_http_pocketbase_url" });
    }
    var headers = { "Content-Type": "application/json" };
    if (config.token) headers.Authorization = "Bearer " + config.token;
    var settings = options.settings || {};
    var state = settings.orderCounterState || {};
    var resetValue = options.resetTime || settings.counterResetTime || state.resetTime;
    var maxValue = options.maxNo || settings.counterMaxNo || state.maxNo;
    var payload = {
        source: text(options.sourcePage || options.source || "")
    };
    if (text(resetValue)) payload.resetTime = text(resetValue);
    if (text(maxValue)) payload.maxNo = numericOrUndefined(maxValue) || 999;
    return requestJson(config.baseUrl + "/api/order-counter/next", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload)
    }, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS).then(function(data) {
        var orderNo = numericOrUndefined(data && (data.orderNo || data.order_no || data.value));
        if (!orderNo) return { ok: false, reason: "invalid_counter_response", response: data };
        return {
            ok: true,
            orderNo: orderNo,
            serialNumber: text((data && data.serialNumber) || String(orderNo).padStart(3, "0")),
            dateKey: text(data && (data.dateKey || data.date_key)),
            cycleKey: text(data && (data.cycleKey || data.cycle_key)),
            resetTime: text(data && (data.resetTime || data.reset_time)),
            maxNo: numericOrUndefined(data && (data.maxNo || data.max_no))
        };
    }).catch(function(e) {
        return { ok: false, error: e, message: e && e.message ? e.message : String(e) };
    });
}

export function resetOrderNoInPocketBase(options) {
    options = options || {};
    var config = resolvePocketBaseConfig(options);
    if (!config.baseUrl) {
        return Promise.resolve({ ok: false, skipped: true, reason: "missing_pocketbase_url" });
    }
    if (typeof window !== "undefined" && window.location && window.location.protocol === "https:" &&
        /^http:\/\//i.test(config.baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(config.baseUrl)) {
        return Promise.resolve({ ok: false, skipped: true, reason: "mixed_content_http_pocketbase_url" });
    }
    var headers = { "Content-Type": "application/json" };
    if (config.token) headers.Authorization = "Bearer " + config.token;
    var settings = options.settings || {};
    var state = settings.orderCounterState || {};
    var payload = {
        source: text(options.sourcePage || options.source || ""),
        resetTime: text(options.resetTime || settings.counterResetTime || state.resetTime || "00:00"),
        maxNo: numericOrUndefined(options.maxNo || settings.counterMaxNo || state.maxNo || 999) || 999
    };
    return requestJson(config.baseUrl + "/api/order-counter/reset", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload)
    }, Number(options.timeoutMs || RESET_TIMEOUT_MS) || RESET_TIMEOUT_MS).then(function(data) {
        return Object.assign({ ok: true }, data || {});
    }).catch(function(e) {
        return { ok: false, error: e, message: e && e.message ? e.message : String(e) };
    });
}

function findExistingRecordId(config, orderId, headers, timeoutMs) {
    if (!orderId) return Promise.resolve("");
    var filter = 'order_id="' + encodeFilterValue(orderId) + '"';
    var url = config.baseUrl + "/api/collections/" + encodeURIComponent(config.collection) + "/records?perPage=1&filter=" + encodeURIComponent(filter);
    return requestJson(url, { method: "GET", headers: headers }, Math.min(timeoutMs || DEFAULT_TIMEOUT_MS, 1200))
        .then(function(data) {
            return data && data.items && data.items[0] && data.items[0].id ? data.items[0].id : "";
        })
        .catch(function() { return ""; });
}

export function writeOrderToPocketBase(orderId, orderData, options) {
    options = options || {};
    var config = resolvePocketBaseConfig(options);
    if (!config.baseUrl) {
        return Promise.resolve({ ok: false, skipped: true, reason: "missing_pocketbase_url" });
    }
    if (typeof window !== "undefined" && window.location && window.location.protocol === "https:" &&
        /^http:\/\//i.test(config.baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(config.baseUrl)) {
        return Promise.resolve({ ok: false, skipped: true, reason: "mixed_content_http_pocketbase_url" });
    }
    var timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    var record = buildPocketBaseOrderRecord(orderId, orderData, options);
    var headers = { "Content-Type": "application/json" };
    if (config.token) headers.Authorization = "Bearer " + config.token;
    var baseRecordsUrl = config.baseUrl + "/api/collections/" + encodeURIComponent(config.collection) + "/records";

    return findExistingRecordId(config, record.order_id, headers, timeoutMs).then(function(existingId) {
        if (existingId && !config.token && options.allowPocketBaseUpdate !== true) {
            return { ok: true, action: "exists", id: existingId, record: record, skippedUpdate: true };
        }
        var url = existingId ? (baseRecordsUrl + "/" + encodeURIComponent(existingId)) : baseRecordsUrl;
        var method = existingId ? "PATCH" : "POST";
        return requestJson(url, {
            method: method,
            headers: headers,
            body: JSON.stringify(record)
        }, timeoutMs).then(function(data) {
            var mergedRecord = data && typeof data === "object" ? Object.assign({}, record, data) : record;
            return { ok: true, action: existingId ? "updated" : "created", id: (data && data.id) || existingId || "", record: mergedRecord, data: data };
        });
    });
}

export function writeOrderWithFirebaseFallback(orderId, orderData, options) {
    options = options || {};
    var writeToFirebase = typeof options.writeToFirebase === "function" ? options.writeToFirebase : null;
    var fallback = function(reason) {
        if (!writeToFirebase) {
            return Promise.resolve({ ok: false, backend: "none", fallback: false, pocketBase: reason });
        }
        return Promise.resolve()
            .then(function() { return writeToFirebase(reason); })
            .then(function(firebaseResult) {
                return { ok: true, backend: "firebase", fallback: true, pocketBase: reason, firebase: firebaseResult };
            });
    };
    return writeOrderToPocketBase(orderId, orderData, options)
        .then(function(pbResult) {
            if (pbResult && pbResult.ok) {
                return { ok: true, backend: "pocketbase", fallback: false, pocketBase: pbResult };
            }
            return fallback(pbResult || { ok: false, reason: "pocketbase_not_available" });
        })
        .catch(function(err) {
            return fallback({ ok: false, error: err, message: err && err.message ? err.message : String(err) });
        });
}
