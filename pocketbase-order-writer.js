const DEFAULT_COLLECTION = "orders";
const DEFAULT_TIMEOUT_MS = 2500;

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

function customerPayload(orderData) {
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
        customer: customerPayload(orderData),
        items: Array.isArray(orderData.items) ? orderData.items : []
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

function encodeFilterValue(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function requestJson(url, init, timeoutMs) {
    init = init || {};
    timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = controller ? setTimeout(function() { controller.abort(); }, timeoutMs) : null;
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
    }).finally(function() {
        if (timer) clearTimeout(timer);
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
        var url = existingId ? (baseRecordsUrl + "/" + encodeURIComponent(existingId)) : baseRecordsUrl;
        var method = existingId ? "PATCH" : "POST";
        return requestJson(url, {
            method: method,
            headers: headers,
            body: JSON.stringify(record)
        }, timeoutMs).then(function(data) {
            return { ok: true, action: existingId ? "updated" : "created", id: (data && data.id) || existingId || "", record: record };
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
