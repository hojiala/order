const DEFAULT_COLLECTION = "orders";
const DEFAULT_POCKETBASE_URL = "https://pb.yuangi168.com";
const DEFAULT_FIREBASE_DATABASE_URL = "https://breakfast-ai-system-default-rtdb.asia-southeast1.firebasedatabase.app";
const DEFAULT_POCKETBASE_ORDER_ENDPOINT = "https://yuangi-secure-order.inovaxt.workers.dev/api/orders";
const DEFAULT_TELEGRAM_NOTIFY_ENDPOINT = "https://yuangi-secure-order.inovaxt.workers.dev/api/notify/fallback";
const DEFAULT_TIMEOUT_MS = 6000;
const RESET_TIMEOUT_MS = 10000;
const PUBLIC_ENDPOINT_COOLDOWN_MS = 60 * 1000;
const PUBLIC_CACHE_DB_NAME = "pb_public_snapshots_v5";
const PUBLIC_CACHE_STORE = "snapshots";
const PUBLIC_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
let backfillPausedUntil = 0;
let publicSettingsPausedUntil = 0;
let publicMenuPausedUntil = 0;
let publicCacheDbPromise = null;

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

function hasCjkText(value) {
    return /[\u3400-\u9fff\uf900-\ufaff]/.test(text(value));
}

function suspiciousTextScore(value) {
    var raw = text(value);
    if (!raw) return 0;
    var matches = raw.match(/[ÃÂÅÆÇÐÑÕÖØåæçéèêëíìîïóòôõöúùûü¤¦¬œŸ\u0080-\u009f]/g);
    return matches ? matches.length : 0;
}

function repairSuspiciousText(value) {
    if (typeof value !== "string") return value;
    var raw = value;
    var trimmed = raw.trim();
    if (!trimmed) return raw;
    if (!suspiciousTextScore(raw) && !/[\u0080-\u00ff]/.test(raw)) return raw;
    var candidate = raw;
    for (var i = 0; i < 2; i++) {
        try {
            var repaired = decodeURIComponent(escape(candidate));
            if (!repaired || repaired === candidate) break;
            candidate = repaired;
        } catch (e) {
            break;
        }
    }
    if (candidate === raw) return raw;
    var rawScore = suspiciousTextScore(raw);
    var candidateScore = suspiciousTextScore(candidate);
    if (hasCjkText(candidate) && !hasCjkText(raw)) return candidate;
    if (candidateScore < rawScore) return candidate;
    return raw;
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

function configuredDefaultBaseUrl() {
    if (typeof window !== "undefined" && window.POCKETBASE_DEFAULT_URL) return cleanBaseUrl(window.POCKETBASE_DEFAULT_URL);
    return cleanBaseUrl(DEFAULT_POCKETBASE_URL);
}

function configuredDefaultOrderEndpoint() {
    if (typeof window !== "undefined") {
        var direct = window.POCKETBASE_ORDER_ENDPOINT || window.SECURE_ORDER_ENDPOINT || window.POCKETBASE_DEFAULT_ORDER_ENDPOINT;
        if (direct) return cleanBaseUrl(direct);
    }
    return cleanBaseUrl(DEFAULT_POCKETBASE_ORDER_ENDPOINT);
}

function configuredDefaultFirebaseDatabaseUrl() {
    if (typeof window !== "undefined") {
        var direct = window.FIREBASE_DATABASE_URL || window.FIREBASE_DB_URL || window.FIREBASE_RTDB_URL;
        if (direct) return cleanBaseUrl(direct);
    }
    return cleanBaseUrl(DEFAULT_FIREBASE_DATABASE_URL);
}

function configuredDefaultTelegramNotifyEndpoint() {
    if (typeof window !== "undefined") {
        var direct = window.TELEGRAM_FALLBACK_NOTIFY_ENDPOINT || window.FIREBASE_FALLBACK_NOTIFY_ENDPOINT;
        if (direct) return cleanBaseUrl(direct);
    }
    return cleanBaseUrl(DEFAULT_TELEGRAM_NOTIFY_ENDPOINT);
}

function loadTurnstileScript() {
    if (typeof window === "undefined" || typeof document === "undefined") return Promise.resolve(false);
    if (window.turnstile && typeof window.turnstile.render === "function") return Promise.resolve(true);
    if (window.__pbTurnstileScriptPromise) return window.__pbTurnstileScriptPromise;
    window.__pbTurnstileScriptPromise = new Promise(function(resolve, reject) {
        var script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        script.onload = function() { resolve(true); };
        script.onerror = function() { reject(new Error("Turnstile script load failed")); };
        document.head.appendChild(script);
    });
    return window.__pbTurnstileScriptPromise;
}

function turnstileContainer() {
    var id = "pb-turnstile-container";
    var el = document.getElementById(id);
    var shell = document.getElementById("pb-turnstile-shell");
    if (el && shell) {
        shell.style.display = "flex";
        return el;
    }
    shell = document.createElement("div");
    shell.id = "pb-turnstile-shell";
    shell.style.position = "fixed";
    shell.style.inset = "0";
    shell.style.zIndex = "2147483647";
    shell.style.display = "flex";
    shell.style.alignItems = "center";
    shell.style.justifyContent = "center";
    shell.style.background = "transparent";
    shell.style.padding = "16px";
    shell.style.pointerEvents = "none";
    var panel = document.createElement("div");
    panel.id = "pb-turnstile-panel";
    panel.style.background = "#fff";
    panel.style.borderRadius = "8px";
    panel.style.boxShadow = "0 18px 60px rgba(0,0,0,.28)";
    panel.style.padding = "16px";
    panel.style.maxWidth = "360px";
    panel.style.width = "100%";
    panel.style.opacity = "0";
    panel.style.transform = "translateY(8px)";
    panel.style.pointerEvents = "none";
    panel.style.transition = "opacity .12s ease, transform .12s ease";
    var label = document.createElement("div");
    label.textContent = "Cloudflare verification";
    label.style.font = "700 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    label.style.color = "#0f172a";
    label.style.marginBottom = "12px";
    el = document.createElement("div");
    el.id = id;
    el.style.position = "fixed";
    el.style.position = "relative";
    panel.appendChild(label);
    panel.appendChild(el);
    shell.appendChild(panel);
    document.body.appendChild(shell);
    return el;
}

function showTurnstileContainer() {
    try {
        var shell = document.getElementById("pb-turnstile-shell");
        var panel = document.getElementById("pb-turnstile-panel");
        if (shell) {
            shell.style.display = "flex";
            shell.style.background = "rgba(15,23,42,.35)";
            shell.style.pointerEvents = "auto";
        }
        if (panel) {
            panel.style.opacity = "1";
            panel.style.transform = "translateY(0)";
            panel.style.pointerEvents = "auto";
        }
    } catch(e) {}
}

function hideTurnstileContainer() {
    try {
        var shell = document.getElementById("pb-turnstile-shell");
        var panel = document.getElementById("pb-turnstile-panel");
        if (shell) {
            shell.style.background = "transparent";
            shell.style.pointerEvents = "none";
        }
        if (panel) {
            panel.style.opacity = "0";
            panel.style.transform = "translateY(8px)";
            panel.style.pointerEvents = "none";
        }
    } catch(e) {}
}

function removeTurnstileContainer() {
    try {
        var shell = document.getElementById("pb-turnstile-shell");
        if (shell && shell.parentNode) shell.parentNode.removeChild(shell);
    } catch(e) {}
}

function requestTurnstileToken(siteKey, timeoutMs) {
    if (!siteKey) return Promise.resolve("");
    if (typeof window === "undefined" || typeof document === "undefined") return Promise.resolve("");
    return loadTurnstileScript().then(function() {
        return new Promise(function(resolve, reject) {
            var done = false;
            var timer = setTimeout(function() {
                if (done) return;
                done = true;
                reject(new Error("Turnstile token timeout"));
            }, Math.max(30000, Number(timeoutMs || 90000) || 90000));
            var finish = function(err, token) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (!err) hideTurnstileContainer();
                if (err) reject(err);
                else resolve(token || "");
            };
            try {
                var turnstile = window.turnstile;
                if (window.__pbTurnstileWidgetId !== undefined && window.__pbTurnstileWidgetId !== null && typeof turnstile.remove === "function") {
                    try { turnstile.remove(window.__pbTurnstileWidgetId); } catch(removeErr) {}
                }
                window.__pbTurnstileWidgetId = null;
                removeTurnstileContainer();
                var widgetId = turnstile.render(turnstileContainer(), {
                    sitekey: siteKey,
                    execution: "execute",
                    appearance: "interaction-only",
                    size: "normal",
                    theme: "light",
                    callback: function(token) { finish(null, token); },
                    "before-interactive-callback": function() {
                        showTurnstileContainer();
                    },
                    "after-interactive-callback": function() {
                        hideTurnstileContainer();
                    },
                    "error-callback": function(code) {
                        console.warn("Turnstile challenge failed:", code || "");
                        finish(new Error("Turnstile challenge failed" + (code ? ": " + code : "")));
                    },
                    "expired-callback": function() {
                        console.warn("Turnstile token expired");
                        finish(new Error("Turnstile token expired"));
                    },
                    "timeout-callback": function() {
                        console.warn("Turnstile challenge timed out");
                    },
                    "unsupported-callback": function() {
                        console.warn("Turnstile browser unsupported");
                        finish(new Error("Turnstile browser unsupported"));
                    }
                });
                window.__pbTurnstileWidgetId = widgetId;
                turnstile.execute(widgetId);
            } catch(e) {
                finish(e);
            }
        });
    });
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
        configuredDefaultBaseUrl() ||
        ""
    );
    var orderEndpoint = cleanBaseUrl(
        optionValue(options, ["pocketBaseOrderEndpoint", "pocketbaseOrderEndpoint", "pocketBaseSecureOrderEndpoint", "secureOrderEndpoint", "orderWriteEndpoint"]) ||
        nested.orderEndpoint ||
        nested.secureOrderEndpoint ||
        (typeof window !== "undefined" && (window.POCKETBASE_ORDER_ENDPOINT || window.SECURE_ORDER_ENDPOINT)) ||
        storageValue(["pocketbase_order_endpoint", "POCKETBASE_ORDER_ENDPOINT"]) ||
        configuredDefaultOrderEndpoint() ||
        ""
    );
    var manageEndpoint = cleanBaseUrl(
        optionValue(options, ["pocketBaseManageEndpoint", "pocketbaseManageEndpoint", "pocketBaseSecureManageEndpoint", "secureManageEndpoint", "manageWriteEndpoint"]) ||
        nested.manageEndpoint ||
        nested.secureManageEndpoint ||
        (typeof window !== "undefined" && (window.POCKETBASE_MANAGE_ENDPOINT || window.SECURE_MANAGE_ENDPOINT)) ||
        storageValue(["pocketbase_manage_endpoint", "POCKETBASE_MANAGE_ENDPOINT"]) ||
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
    var turnstileSiteKey = text(
        optionValue(options, ["turnstileSiteKey", "cloudflareTurnstileSiteKey", "pocketBaseTurnstileSiteKey"]) ||
        nested.turnstileSiteKey ||
        (typeof window !== "undefined" && (window.TURNSTILE_SITE_KEY || "")) ||
        storageValue(["turnstile_site_key", "TURNSTILE_SITE_KEY"])
    );
    return { baseUrl: baseUrl, orderEndpoint: orderEndpoint, manageEndpoint: manageEndpoint, collection: collection, token: token, turnstileSiteKey: turnstileSiteKey };
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

function orderRecordIdentity(record) {
    record = record || {};
    return text(record.order_id || record.orderId || record.id);
}

function orderRecordQuality(record) {
    record = record || {};
    var customer = jsonObject(record.customer);
    var items = jsonArray(record.items);
    var score = 0;
    if (numericOrUndefined(customer.timestamp)) score += 1000;
    if (items.length) score += items.length * 20;
    if (numericOrUndefined(record.total)) score += 10;
    if (numericOrUndefined(record.order_no || record.orderNo)) score += 8;
    if (text(record.status)) score += 4;
    if (text(customer.name || customer.tableLabel)) score += 3;
    if (text(customer.phone)) score += 3;
    if (text(record.pickup_time || record.pickupTime)) score += 2;
    var created = Date.parse(text(record.created));
    if (Number.isFinite(created)) score += 1;
    return score;
}

function mergeOrderRecord(primary, secondary) {
    primary = primary || {};
    secondary = secondary || {};
    var merged = Object.assign({}, secondary, primary);
    var pc = jsonObject(primary.customer);
    var sc = jsonObject(secondary.customer);
    var customer = Object.assign({}, sc, pc);
    if (!numericOrUndefined(customer.timestamp) && numericOrUndefined(sc.timestamp)) customer.timestamp = sc.timestamp;
    if (!text(customer.name) && text(sc.name)) customer.name = sc.name;
    if (!text(customer.phone) && text(sc.phone)) customer.phone = sc.phone;
    merged.customer = customer;
    if ((!Array.isArray(jsonArray(merged.items)) || !jsonArray(merged.items).length) && jsonArray(secondary.items).length) {
        merged.items = jsonArray(secondary.items);
    }
    return merged;
}

function dedupeOrderRecords(records) {
    var out = [];
    var byKey = {};
    (Array.isArray(records) ? records : []).forEach(function(record) {
        var key = orderRecordIdentity(record);
        if (!key) {
            out.push(record);
            return;
        }
        if (byKey[key] === undefined) {
            byKey[key] = out.length;
            out.push(record);
            return;
        }
        var idx = byKey[key];
        var existing = out[idx];
        var incoming = record;
        var existingQuality = orderRecordQuality(existing);
        var incomingQuality = orderRecordQuality(incoming);
        var primary = incomingQuality > existingQuality ? incoming : existing;
        var secondary = primary === incoming ? existing : incoming;
        out[idx] = mergeOrderRecord(primary, secondary);
    });
    return out;
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
        return fetchRecords("", "").then(function(rows) {
            return dedupeOrderRecords(sortOrderRecords(filterRecordsByDateKeys(rows, options.dateKeys)));
        });
    }

    return fetchRecords(filter, "").catch(fallbackAfterBadQuery).then(function(rows) {
        rows = dedupeOrderRecords(sortOrderRecords(filterRecordsByDateKeys(rows, options.dateKeys)));
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

function stripPocketBaseSystemFields(record) {
    var source = record && typeof record === "object" ? record : {};
    var out = {};
    Object.keys(source).forEach(function(key) {
        if (key === "collectionId" || key === "collectionName" || key === "expand" || key === "created" || key === "updated") return;
        out[key] = decodeJsonLike(source[key]);
    });
    return out;
}

function decodeJsonLike(value) {
    function bytesToString(bytes) {
        if (!Array.isArray(bytes) || !bytes.length) return "";
        for (var i = 0; i < bytes.length; i++) {
            var n = Number(bytes[i]);
            if (!Number.isFinite(n) || n < 0 || n > 255) return "";
        }
        var out = "";
        for (var j = 0; j < bytes.length; j++) out += String.fromCharCode(Number(bytes[j]) || 0);
        try {
            return decodeURIComponent(escape(out));
        } catch (e) {
            return out;
        }
    }
    var current = value;
    if (Array.isArray(current)) {
        var decodedBytes = bytesToString(current);
        var trimmedBytes = text(decodedBytes).trim();
        if (trimmedBytes && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(trimmedBytes)) current = decodedBytes;
    }
    for (var i = 0; i < 3; i++) {
        if (typeof current !== "string") break;
        var raw = current.trim();
        if (!raw) return "";
        var first = raw.charAt(0);
        var last = raw.charAt(raw.length - 1);
        if (!((first === "{" && last === "}") || (first === "[" && last === "]") || (first === '"' && last === '"'))) break;
        try {
            current = JSON.parse(raw);
        } catch(e) {
            break;
        }
    }
    if (Array.isArray(current)) return current.map(decodeJsonLike);
    if (current && typeof current === "object") {
        var out = {};
        Object.keys(current).forEach(function(key) {
            out[key] = decodeJsonLike(current[key]);
        });
        return out;
    }
    return typeof current === "string" ? repairSuspiciousText(current) : current;
}

function unwrapValueWrapper(value) {
    var current = decodeJsonLike(value);
    if (Array.isArray(current)) return current.map(unwrapValueWrapper);
    if (current && typeof current === "object") {
        var keys = Object.keys(current);
        if (keys.length === 1 && (keys[0] === "v" || keys[0] === "val")) {
            return unwrapValueWrapper(current[keys[0]]);
        }
        var out = {};
        keys.forEach(function(key) {
            out[key] = unwrapValueWrapper(current[key]);
        });
        return out;
    }
    return current;
}

function normalizeSettingsObject(value) {
    var decoded = unwrapValueWrapper(value);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return {};
    var out = Object.assign({}, decoded);
    function listLike(input) {
        var normalized = decodeJsonLike(input);
        if (Array.isArray(normalized)) return normalized;
        if (normalized && typeof normalized === "object") return Object.values(normalized);
        if (normalized === undefined || normalized === null || normalized === "") return [];
        if (typeof normalized === "string") {
            var raw = normalized.trim();
            if (!raw) return [];
            if (raw.indexOf("、") !== -1) return raw.split("、");
            if (raw.indexOf(",") !== -1) return raw.split(",");
        }
        return [normalized];
    }
    function stringList(input) {
        var list = listLike(input);
        var seen = {};
        return list.map(function(entry) {
            return text(decodeJsonLike(entry)).trim();
        }).filter(function(entry) {
            if (!entry || seen[entry]) return false;
            seen[entry] = true;
            return true;
        });
    }
    function weekDayList(input) {
        var list = listLike(input);
        var seen = {};
        return list.map(function(entry) {
            return parseInt(decodeJsonLike(entry), 10);
        }).filter(function(entry) {
            if (!Number.isFinite(entry) || entry < 0 || entry > 6 || seen[entry]) return false;
            seen[entry] = true;
            return true;
        });
    }
    function subcategoryMap(raw, categories) {
        var normalized = decodeJsonLike(raw);
        var source = normalized && typeof normalized === "object" && !Array.isArray(normalized) ? normalized : {};
        var cats = Array.isArray(categories) ? categories : [];
        var result = {};
        cats.forEach(function(cat) {
            result[cat] = stringList(source[cat]);
        });
        return result;
    }
    function normalizedPinString(input) {
        var raw = text(decodeJsonLike(input)).trim();
        return /^\d{4}$/.test(raw) ? raw : "";
    }
    function normalizedUrlString(input) {
        var raw = text(decodeJsonLike(input)).trim();
        if (!raw) return "";
        return /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, "") : "";
    }
    var categories = stringList(out.categories);
    if (categories.length || out.categories !== undefined) out.categories = categories;
    if (out.posOnlyCategories !== undefined) out.posOnlyCategories = stringList(out.posOnlyCategories);
    if (out.holidays !== undefined) out.holidays = stringList(out.holidays);
    if (out.weeklyDaysOff !== undefined) out.weeklyDaysOff = weekDayList(out.weeklyDaysOff);
    if (out.categorySubcategories !== undefined) out.categorySubcategories = subcategoryMap(out.categorySubcategories, categories);
    if (out.telegramFallbackNotifyEndpoint !== undefined) out.telegramFallbackNotifyEndpoint = normalizedUrlString(out.telegramFallbackNotifyEndpoint);
    if (out.telegramNotifyEndpoint !== undefined) out.telegramNotifyEndpoint = normalizedUrlString(out.telegramNotifyEndpoint);
    if (
        Object.prototype.hasOwnProperty.call(out, "dineinPin") ||
        Object.prototype.hasOwnProperty.call(out, "qrPin")
    ) {
        var finalPin = normalizedPinString(out.dineinPin) || normalizedPinString(out.qrPin) || "";
        out.dineinPin = finalPin;
        out.qrPin = finalPin;
    }
    return out;
}

export function normalizePublicSettings(value) {
    return normalizeSettingsObject(value);
}

function collectionOption(options, keys, fallback) {
    options = options || {};
    var settings = options.settings || {};
    var nested = settings.pocketBase || settings.pocketbase || {};
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (options[key]) return text(options[key]);
        if (settings[key]) return text(settings[key]);
        if (nested[key]) return text(nested[key]);
    }
    return fallback;
}

function listPocketBaseCollection(options, collectionName, queryOptions) {
    options = options || {};
    queryOptions = queryOptions || {};
    var config = resolvePocketBaseConfig(options);
    if (!config.baseUrl) return Promise.resolve({ ok: false, skipped: true, reason: "missing_pocketbase_url", records: [] });
    var headers = {};
    if (config.token) headers.Authorization = "Bearer " + config.token;
    var perPage = Math.max(1, Math.min(500, Math.floor(Number(queryOptions.perPage || 500) || 500)));
    var maxPages = Math.max(1, Math.floor(Number(queryOptions.maxPages || 6) || 6));
    var timeoutMs = Number(queryOptions.timeoutMs || options.timeoutMs || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    var baseUrl = config.baseUrl + "/api/collections/" + encodeURIComponent(collectionName) + "/records";
    var records = [];
    function fetchPage(page) {
        var url = baseUrl + "?page=" + page + "&perPage=" + perPage;
        if (queryOptions.sort) url += "&sort=" + encodeURIComponent(queryOptions.sort);
        if (queryOptions.filter) url += "&filter=" + encodeURIComponent(queryOptions.filter);
        return requestJson(url, { method: "GET", headers: headers }, timeoutMs).then(function(data) {
            var items = Array.isArray(data && data.items) ? data.items : [];
            records = records.concat(items);
            var totalPages = Number(data && data.totalPages) || page;
            if (page < totalPages && page < maxPages) return fetchPage(page + 1);
            return records;
        });
    }
    return fetchPage(1).then(function(rows) {
        return { ok: true, backend: "pocketbase", records: rows };
    }).catch(function(e) {
        return { ok: false, backend: "pocketbase", error: e, message: e && e.message ? e.message : String(e), records: [] };
    });
}

function looksLikeSettingsPayload(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return [
        "isOpen", "dineinIsOpen", "openTime", "closeTime", "dailyHours",
        "pickupDays", "pickupInterval", "holidays", "weeklyDaysOff",
        "categories", "categorySubcategories", "posOnlyCategories", "stations"
    ].some(function(key) {
        return Object.prototype.hasOwnProperty.call(value, key);
    });
}

function settingsFromRecords(records) {
    records = Array.isArray(records) ? records : [];
    var keyed = {};
    var sawKeyed = false;
    var firstObject = null;
    records.forEach(function(record) {
        var row = stripPocketBaseSystemFields(record);
        var hasStoredValue = row.value !== undefined || row.data !== undefined || row.json !== undefined || row.settings !== undefined;
        var key = text(row.key || row.setting_key || row.settingKey || (hasStoredValue ? row.name : ""));
        var payload = row.settings || row.data || row.value || row.json || {};
        var normalizedPayload = normalizeSettingsObject(payload);
        if (looksLikeSettingsPayload(normalizedPayload)) {
            firstObject = Object.assign(firstObject || {}, normalizedPayload);
            return;
        }
        if (key) {
            sawKeyed = true;
            var value = row.value;
            if (value === undefined) value = row.data;
            if (value === undefined) value = row.json;
            if (value === undefined) value = row.settings;
            var decoded = unwrapValueWrapper(value);
            if ((key === "settings" || key === "config") && decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
                Object.assign(keyed, normalizeSettingsObject(decoded));
            } else {
                keyed[key] = decoded;
            }
            return;
        }
        payload = normalizedPayload;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};
        if (!firstObject) {
            firstObject = Object.assign({}, payload);
            Object.keys(row || {}).forEach(function(field) {
                if (["settings", "data", "value", "json"].indexOf(field) !== -1) return;
                var value = row[field];
                if (value === undefined || value === null || value === "") return;
                firstObject[field] = decodeJsonLike(value);
            });
        }
    });
    if (sawKeyed) return normalizeSettingsObject(Object.assign({}, firstObject || {}, keyed));
    return normalizeSettingsObject(firstObject || {});
}

function finiteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function createdNumber(value) {
    var n = finiteNumber(value);
    if (n !== null) return n;
    if (typeof value === "string" && value.trim()) {
        var t = Date.parse(value);
        return Number.isFinite(t) ? t : 0;
    }
    return 0;
}

function sortMenuItems(items) {
    return (Array.isArray(items) ? items : []).map(function(item, index) {
        return { item: item || {}, index: index };
    }).sort(function(a, b) {
        var sa = finiteNumber(a.item.sortOrder);
        var sb = finiteNumber(b.item.sortOrder);
        if (sa !== null && sb !== null && sa !== sb) return sa - sb;
        if (sa !== null && sb === null) return -1;
        if (sa === null && sb !== null) return 1;
        var ca = createdNumber(a.item.createdAt || a.item.created_at);
        var cb = createdNumber(b.item.createdAt || b.item.created_at);
        if (ca !== cb) return ca - cb;
        return a.index - b.index;
    }).map(function(row) {
        return row.item;
    });
}

function dedupeMenuItems(items) {
    var out = [];
    var byKey = {};
    function idOf(item) {
        return text(item && (item.id || item.item_id || item.itemId || item.menu_id || item.menuId || item.firebase_id || item.firebaseId));
    }
    function idScore(id) {
        id = text(id);
        if (id.charAt(0) === "-") return 4;
        if (/^(menu|item)_/i.test(id)) return 3;
        if (id.length > 15) return 2;
        return id ? 1 : 0;
    }
    function keyOf(item) {
        var name = text(item && (item.name || item.printName || item.shortName)).trim().toLowerCase();
        var category = text(item && item.category).trim().toLowerCase();
        var price = text(item && item.price).trim();
        if (name) return "shape:" + [name, category, price].join("|");
        var id = idOf(item);
        return id ? "id:" + id : "";
    }
    function quality(item) {
        var score = idScore(idOf(item));
        if (text(item && item.subCategory).trim()) score += 3;
        if (text(item && item.img).trim()) score += 3;
        if (Array.isArray(item && item.optionGroups) && item.optionGroups.length) score += 2;
        if (Array.isArray(item && item.options) && item.options.length) score += 1;
        if (finiteNumber(item && item.sortOrder) !== null) score += 1;
        if (createdNumber(item && (item.createdAt || item.created_at))) score += 1;
        return score;
    }
    function freshness(item) {
        return createdNumber(item && (item.updatedAt || item.updated_at || item.createdAt || item.created_at));
    }
    function mergeItem(existing, incoming) {
        existing = existing || {};
        incoming = incoming || {};
        var incomingQuality = quality(incoming);
        var existingQuality = quality(existing);
        var primary = incomingQuality > existingQuality ? incoming : existing;
        if (incomingQuality === existingQuality && freshness(incoming) > freshness(existing)) primary = incoming;
        var secondary = primary === incoming ? existing : incoming;
        var merged = Object.assign({}, secondary, primary);
        ["subCategory", "img", "desc", "shortName", "printName", "category", "price", "station", "availableAfter"].forEach(function(field) {
            if ((merged[field] === undefined || merged[field] === null || merged[field] === "") && secondary[field] !== undefined) merged[field] = secondary[field];
        });
        ["options", "optionGroups", "posExtras", "printStations"].forEach(function(field) {
            if ((!Array.isArray(merged[field]) || !merged[field].length) && Array.isArray(secondary[field]) && secondary[field].length) merged[field] = secondary[field];
        });
        var primarySort = finiteNumber(primary && primary.sortOrder);
        var secondarySort = finiteNumber(secondary && secondary.sortOrder);
        if (primarySort === null && secondarySort !== null) merged.sortOrder = secondarySort;
        else if (primarySort !== null && secondarySort === null) merged.sortOrder = primarySort;
        else if (primarySort !== null && secondarySort !== null && primarySort !== secondarySort) merged.sortOrder = freshness(primary) >= freshness(secondary) ? primarySort : secondarySort;
        var primaryId = idOf(primary);
        var secondaryId = idOf(secondary);
        merged.id = idScore(primaryId) >= idScore(secondaryId) ? primaryId : secondaryId;
        return merged;
    }
    (Array.isArray(items) ? items : []).forEach(function(item) {
        item = item || {};
        var key = keyOf(item);
        if (!key) {
            out.push(item);
            return;
        }
        if (byKey[key] === undefined) {
            byKey[key] = out.length;
            out.push(item);
            return;
        }
        var idx = byKey[key];
        out[idx] = mergeItem(out[idx], item);
    });
    return out;
}

function menuItemFromRecord(record) {
    var row = stripPocketBaseSystemFields(record);
    var payload = row.item || row.data || row.value || row.json || {};
    payload = decodeJsonLike(payload);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};
    var item = Object.assign({}, payload);
    [
        "name", "shortName", "printName", "price", "category", "subCategory", "desc", "img",
        "imageUrl", "image", "photo", "options", "optionGroups", "posExtras", "station",
        "printStations", "availableAfter", "active", "sortOrder", "sort_order", "order", "sortIndex", "__sortIndex", "createdAt", "updatedAt",
        "firebase_id", "firebaseId", "item_id", "itemId", "menu_id", "menuId"
    ].forEach(function(field) {
        var value = row[field];
        if (value === undefined || value === null || value === "") return;
        item[field] = decodeJsonLike(value);
    });
    var rawSort = row.sortOrder;
    if (rawSort === undefined) rawSort = row.sort_order;
    if (rawSort === undefined) rawSort = row.order;
    if (rawSort === undefined) rawSort = row.sortIndex;
    if (rawSort === undefined) rawSort = row.__sortIndex;
    if (rawSort === undefined) rawSort = item.sortOrder;
    if (rawSort === undefined) rawSort = item.sort_order;
    if (rawSort === undefined) rawSort = item.order;
    if (rawSort === undefined) rawSort = item.sortIndex;
    if (rawSort === undefined) rawSort = item.__sortIndex;
    var rowSort = finiteNumber(rawSort);
    if (rowSort !== null) item.sortOrder = rowSort;
    var canonicalImage = text(
        item.img || item.imageUrl || item.image || item.photo || item.photoUrl || item.imgUrl || item.picture ||
        row.img || row.imageUrl || row.image || row.photo || row.photoUrl || row.imgUrl || row.picture
    ).trim();
    if (canonicalImage) {
        item.img = canonicalImage;
        item.imageUrl = canonicalImage;
    }
    if (!item.img && item.imageUrl) item.img = item.imageUrl;
    if (!item.img && item.image) item.img = item.image;
    if (!item.img && item.photo) item.img = item.photo;
    if (!item.imageUrl && item.img) item.imageUrl = item.img;
    item.id = text(payload.id || payload.item_id || payload.itemId || payload.menu_id || payload.menuId || payload.firebase_id || payload.firebaseId || row.firebase_id || row.firebaseId || row.item_id || row.itemId || row.menu_id || row.menuId || row.id || (record && record.id));
    return item;
}

function menuItemLooksRenderable(item) {
    item = item || {};
    var name = text(item.name || item.printName || item.shortName || item.label || item.title).trim();
    var category = text(item.category).trim();
    var subCategory = text(item.subCategory).trim();
    var desc = text(item.desc).trim();
    var img = text(item.img || item.imageUrl || item.image || item.photo).trim();
    var station = text(item.station).trim();
    var hasPrice = item.price !== undefined && item.price !== null && item.price !== "";
    var hasOptions = Array.isArray(item.options) && item.options.length > 0;
    var hasOptionGroups = Array.isArray(item.optionGroups) && item.optionGroups.length > 0;
    var hasPosExtras = Array.isArray(item.posExtras) && item.posExtras.length > 0;
    var hasPrintStations = Array.isArray(item.printStations) && item.printStations.length > 0;
    if (name || category || subCategory || desc || img || station || hasPrice || hasOptions || hasOptionGroups || hasPosExtras || hasPrintStations) return true;
    var id = text(item.id || item.item_id || item.itemId || item.menu_id || item.menuId || item.firebase_id || item.firebaseId).trim();
    if (/_(pos_extras|options|choices)_/i.test(id)) return false;
    return false;
}

function endpointCooldownResult(pausedUntil, payload) {
    var now = Date.now();
    if (!pausedUntil || now >= pausedUntil) return null;
    return Object.assign({
        ok: false,
        backend: "pocketbase",
        skipped: true,
        reason: "pocketbase_public_endpoint_cooldown",
        retryAfterMs: pausedUntil - now
    }, payload || {});
}

function envFlag(value, defaultValue) {
    if (value === true || value === false) return value;
    if (value === null || value === undefined || value === "") return !!defaultValue;
    var textValue = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on", "required", "require"].indexOf(textValue) !== -1) return true;
    if (["0", "false", "no", "off", "disabled", "disable"].indexOf(textValue) !== -1) return false;
    return !!defaultValue;
}

function shouldRequestTurnstile(config, options) {
    options = options || {};
    if (!config || !config.turnstileSiteKey) return false;
    if (options.skipTurnstile === true || options.disableTurnstile === true) return false;
    if (options.requireTurnstile !== undefined) return envFlag(options.requireTurnstile, false);
    if (options.useTurnstile !== undefined) return envFlag(options.useTurnstile, false);
    if (typeof window !== "undefined") {
        if (window.PB_REQUIRE_TURNSTILE !== undefined) return envFlag(window.PB_REQUIRE_TURNSTILE, false);
        if (window.REQUIRE_TURNSTILE !== undefined) return envFlag(window.REQUIRE_TURNSTILE, false);
    }
    return false;
}

function cacheSupported() {
    return typeof indexedDB !== "undefined" && typeof Promise !== "undefined";
}

function openPublicCacheDb() {
    if (!cacheSupported()) return Promise.resolve(null);
    if (publicCacheDbPromise) return publicCacheDbPromise;
    publicCacheDbPromise = new Promise(function(resolve) {
        var req;
        try {
            req = indexedDB.open(PUBLIC_CACHE_DB_NAME, 1);
        } catch(e) {
            resolve(null);
            return;
        }
        req.onupgradeneeded = function() {
            try {
                var db = req.result;
                if (!db.objectStoreNames.contains(PUBLIC_CACHE_STORE)) db.createObjectStore(PUBLIC_CACHE_STORE, { keyPath: "key" });
            } catch(e) {}
        };
        req.onsuccess = function() { resolve(req.result || null); };
        req.onerror = function() { resolve(null); };
        req.onblocked = function() { resolve(null); };
    });
    return publicCacheDbPromise;
}

function publicCacheKey(kind, baseUrl) {
    return String(kind || "public") + "|" + cleanBaseUrl(baseUrl || configuredDefaultBaseUrl());
}

function readPublicCache(key, maxAgeMs) {
    return openPublicCacheDb().then(function(db) {
        if (!db) return null;
        return new Promise(function(resolve) {
            try {
                var tx = db.transaction(PUBLIC_CACHE_STORE, "readonly");
                var store = tx.objectStore(PUBLIC_CACHE_STORE);
                var req = store.get(key);
                req.onsuccess = function() {
                    var row = req.result;
                    if (!row || !row.payload) {
                        resolve(null);
                        return;
                    }
                    var age = Date.now() - (Number(row.savedAt) || 0);
                    if (maxAgeMs && age > maxAgeMs) {
                        resolve(null);
                        return;
                    }
                    resolve(plainJson(row.payload, row.payload));
                };
                req.onerror = function() { resolve(null); };
            } catch(e) {
                resolve(null);
            }
        });
    });
}

function writePublicCache(key, payload) {
    if (!payload || payload.ok !== true) return Promise.resolve(false);
    return openPublicCacheDb().then(function(db) {
        if (!db) return false;
        return new Promise(function(resolve) {
            try {
                var tx = db.transaction(PUBLIC_CACHE_STORE, "readwrite");
                var store = tx.objectStore(PUBLIC_CACHE_STORE);
                store.put({ key: key, savedAt: Date.now(), payload: plainJson(payload, payload) });
                tx.oncomplete = function() { resolve(true); };
                tx.onerror = function() { resolve(false); };
                tx.onabort = function() { resolve(false); };
            } catch(e) {
                resolve(false);
            }
        });
    });
}

function cachedPublicResult(kind, cacheKey, extra) {
    return readPublicCache(cacheKey, PUBLIC_CACHE_MAX_AGE_MS).then(function(cached) {
        if (!cached || cached.ok !== true) return null;
        if (kind === "settings") cached.settings = normalizeSettingsObject(cached.settings || {});
        if (kind === "menu" && Array.isArray(cached.items)) {
            cached.items = sortMenuItems(dedupeMenuItems(cached.items.map(decodeJsonLike)));
            if (!menuLooksUsable(cached.items)) return null;
        }
        return Object.assign({}, cached, {
            ok: true,
            backend: "pocketbase_cache",
            cached: true
        }, extra || {});
    });
}

function parsePublicSettingsResponse(data) {
    var settings = data && data.settings && typeof data.settings === "object" ? normalizeSettingsObject(data.settings) : {};
    return { ok: true, backend: "pocketbase", settings: settings, data: data };
}

function hasSettingsCategories(settings) {
    return !!(settings && categoryListLooksUsable(settings.categories));
}

function hasSettingsSubcategories(settings) {
    if (!settings || !settings.categorySubcategories || typeof settings.categorySubcategories !== "object") return false;
    return Object.keys(settings.categorySubcategories).some(function(category) {
        return Array.isArray(settings.categorySubcategories[category]) && settings.categorySubcategories[category].length;
    });
}

function settingsFromMenuItems(items, baseSettings) {
    var settings = normalizeSettingsObject(Object.assign({
        isOpen: true,
        dineinIsOpen: true,
        openTime: "00:00",
        closeTime: "23:59"
    }, baseSettings || {}));
    var categories = categoryListLooksUsable(settings.categories) ? settings.categories.slice() : [];
    var subMap = categories.length && settings.categorySubcategories && typeof settings.categorySubcategories === "object" ? Object.assign({}, settings.categorySubcategories) : {};
    (Array.isArray(items) ? items : []).forEach(function(item) {
        item = item || {};
        var category = text(item.category).trim();
        var subCategory = text(item.subCategory).trim();
        if (!category || item.active === false) return;
        if (categories.indexOf(category) === -1) categories.push(category);
        if (!Array.isArray(subMap[category])) subMap[category] = [];
        if (subCategory && subMap[category].indexOf(subCategory) === -1) subMap[category].push(subCategory);
    });
    settings.categories = categories;
    settings.categorySubcategories = subMap;
    return completeCategorySubcategoriesFromNames(normalizeSettingsObject(settings));
}

function completeCategorySubcategoriesFromNames(settings) {
    settings = settings || {};
    var categories = Array.isArray(settings.categories) ? settings.categories : [];
    var map = settings.categorySubcategories && typeof settings.categorySubcategories === "object" ? Object.assign({}, settings.categorySubcategories) : {};
    categories.forEach(function(category) {
        if (Array.isArray(map[category]) && map[category].length) return;
        if (text(category).indexOf("、") === -1) return;
        map[category] = text(category).split("、").map(function(part) {
            return text(part).trim();
        }).filter(Boolean);
    });
    settings.categorySubcategories = map;
    return settings;
}

function completeSettingsWithMenu(result, options) {
    result = result || { ok: true, backend: "pocketbase", settings: {} };
    result.settings = normalizeSettingsObject(result.settings || {});
    if (hasSettingsCategories(result.settings) && hasSettingsSubcategories(result.settings)) return Promise.resolve(result);
    // ponytail: settings route is flaky in production; derive public category shape from the known-good menu.
    return listMenuItemsFromPocketBase(Object.assign({}, options || {}, {
        settings: result.settings,
        activeOnly: false,
        forceFresh: true,
        disableCacheFallback: true,
        skipCacheWrite: true
    })).then(function(menuResult) {
        if (menuResult && Array.isArray(menuResult.items) && menuResult.items.length) {
            result.settings = settingsFromMenuItems(menuResult.items, result.settings);
            result.backend = result.backend ? result.backend + "+menu_derived" : "menu_derived_settings";
        }
        return result;
    }).catch(function() {
        return result;
    });
}

function settingsLooksUsable(settings) {
    settings = settings || {};
    if (categoryListLooksUsable(settings.categories)) return true;
    if (Array.isArray(settings.weeklyDaysOff) && settings.weeklyDaysOff.length) return true;
    if (settings.pickupDays || settings.pickupInterval) return true;
    return Object.keys(settings).some(function(key) {
        return ["isOpen", "dineinIsOpen", "openTime", "closeTime", "categorySubcategories"].indexOf(key) === -1;
    });
}

function categoryListLooksUsable(categories) {
    if (!Array.isArray(categories) || !categories.length) return false;
    return categories.some(function(category) {
        return /[^\d\s]/.test(text(category).trim());
    });
}

function suspiciousValueCount(value) {
    if (typeof value === "string") return suspiciousTextScore(value) > 0 ? 1 : 0;
    if (Array.isArray(value)) {
        return value.reduce(function(total, entry) {
            return total + suspiciousValueCount(entry);
        }, 0);
    }
    if (value && typeof value === "object") {
        return Object.keys(value).reduce(function(total, key) {
            return total + suspiciousValueCount(value[key]);
        }, 0);
    }
    return 0;
}

function countCategorySubcategories(map) {
    if (!map || typeof map !== "object") return 0;
    return Object.keys(map).reduce(function(total, key) {
        return total + (Array.isArray(map[key]) ? map[key].length : 0);
    }, 0);
}

function settingsRichnessScore(settings) {
    settings = settings || {};
    var score = 0;
    score += (categoryListLooksUsable(settings.categories) ? settings.categories.length : 0) * 10;
    score += (Array.isArray(settings.weeklyDaysOff) ? settings.weeklyDaysOff.length : 0) * 4;
    score += (Array.isArray(settings.holidays) ? settings.holidays.length : 0) * 2;
    score += countCategorySubcategories(settings.categorySubcategories) * 2;
    score += (Array.isArray(settings.stations) ? settings.stations.length : 0) * 3;
    if (text(settings.openTime).trim()) score += 3;
    if (text(settings.closeTime).trim()) score += 3;
    if (Number.isFinite(Number(settings.pickupDays))) score += 4;
    if (Number.isFinite(Number(settings.pickupInterval))) score += 4;
    if (text(settings.storeInfo).trim()) score += 8;
    if (text(settings.storePhone).trim()) score += 6;
    if (text(settings.storeAddress).trim()) score += 6;
    if (text(settings.storeInfoExtra).trim()) score += 3;
    score -= suspiciousValueCount(settings) * 20;
    return score;
}

function preferCachedSettingsResult(fresh, cached) {
    if (cached && cached.ok && settingsLooksUsable(cached.settings)) {
        if (!fresh || fresh.ok !== true || !settingsLooksUsable(fresh.settings)) return cached;
        var freshScore = settingsRichnessScore(fresh.settings);
        var cachedScore = settingsRichnessScore(cached.settings);
        if (cachedScore > freshScore + 12) return cached;
    }
    return fresh;
}

function menuLooksUsable(items) {
    if (!Array.isArray(items)) return false;
    var stats = menuRichnessStats(items);
    if (!stats.count || !stats.basicCount) return false;
    return stats.basicCount >= Math.min(3, stats.count);
}

function menuRichnessStats(items) {
    var stats = { count: 0, basicCount: 0, optionGroupCount: 0, optionCount: 0, sortOrderCount: 0, subCategoryCount: 0, suspiciousCount: 0 };
    (Array.isArray(items) ? items : []).forEach(function(item) {
        if (!item || typeof item !== "object") return;
        stats.count++;
        if (text(item.name || item.printName || item.shortName).trim() && text(item.category).trim()) stats.basicCount++;
        if (Array.isArray(item.optionGroups) && item.optionGroups.length) stats.optionGroupCount++;
        if (Array.isArray(item.options) && item.options.length) stats.optionCount++;
        if (finiteNumber(item.sortOrder) !== null) stats.sortOrderCount++;
        if (text(item.subCategory).trim()) stats.subCategoryCount++;
        if (
            suspiciousTextScore(item.name || item.printName || item.shortName) > 0 ||
            suspiciousTextScore(item.category) > 0 ||
            suspiciousTextScore(item.subCategory) > 0 ||
            suspiciousTextScore(item.station) > 0
        ) stats.suspiciousCount++;
    });
    return stats;
}

function menuRichnessScore(items) {
    var stats = menuRichnessStats(items);
    return (
        stats.basicCount * 12 +
        stats.sortOrderCount * 10 +
        stats.subCategoryCount * 3 +
        stats.optionGroupCount * 2 +
        stats.optionCount -
        stats.suspiciousCount * 25
    );
}

function preferCachedMenuResult(fresh, cached) {
    if (cached && cached.ok && menuLooksUsable(cached.items)) {
        if (!fresh || fresh.ok !== true || !menuLooksUsable(fresh.items)) return cached;
        var freshStats = menuRichnessStats(fresh.items);
        var cachedStats = menuRichnessStats(cached.items);
        if (cachedStats.sortOrderCount > freshStats.sortOrderCount + 5) return cached;
        if (menuRichnessScore(cached.items) > menuRichnessScore(fresh.items) + 20) return cached;
    }
    return fresh;
}

function parsePublicMenuResponse(data, options) {
    var items = Array.isArray(data && data.items) ? data.items.map(decodeJsonLike) : [];
    items = items.filter(menuItemLooksRenderable);
    items = dedupeMenuItems(items);
    if (options && options.activeOnly) items = items.filter(function(item) { return item && item.active !== false; });
    return { ok: true, backend: "pocketbase", items: sortMenuItems(items), data: data };
}

function firebasePublicUrl(path) {
    var baseUrl = configuredDefaultFirebaseDatabaseUrl();
    if (!baseUrl) return "";
    return baseUrl + "/" + String(path || "").replace(/^\/+/, "") + ".json";
}

function requestFirebasePublicJson(path, timeoutMs) {
    var url = firebasePublicUrl(path);
    if (!url) return Promise.reject(new Error("missing_firebase_database_url"));
    return requestJson(url, { method: "GET" }, timeoutMs);
}

function parseFirebaseSettingsResponse(data) {
    var settings = normalizeSettingsObject(data && typeof data === "object" && !Array.isArray(data) ? data : {});
    return { ok: true, backend: "firebase", settings: settings, data: data };
}

function parseFirebaseMenuResponse(data, options) {
    var source = data && typeof data === "object" && !Array.isArray(data) ? data : {};
    var items = Object.keys(source).map(function(id) {
        var row = source[id];
        if (!row || typeof row !== "object" || Array.isArray(row)) return null;
        return decodeJsonLike(Object.assign({ id: id }, row));
    }).filter(Boolean).filter(menuItemLooksRenderable);
    items = dedupeMenuItems(items);
    if (options && options.activeOnly) items = items.filter(function(item) { return item && item.active !== false; });
    return { ok: true, backend: "firebase", items: sortMenuItems(items), data: data };
}

export function readSettingsFromPocketBase(options) {
    options = options || {};
    var config = resolvePocketBaseConfig(options);
    var timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    if (!config.baseUrl) return Promise.resolve({ ok: false, skipped: true, reason: "missing_pocketbase_url", settings: {} });
    var cacheKey = publicCacheKey("settings", config.baseUrl);
    if (options.cacheOnly === true) {
        return cachedPublicResult("settings", cacheKey, { cacheOnly: true }).then(function(cached) {
            return cached || { ok: false, backend: "pocketbase_cache", skipped: true, reason: "public_settings_cache_miss", settings: {} };
        });
    }
    if (options.forceFresh !== true) {
        return cachedPublicResult("settings", cacheKey).then(function(cached) {
            return readSettingsFromPocketBase(Object.assign({}, options, {
                forceFresh: true,
                disableCacheFallback: true,
                skipCacheWrite: true
            })).then(function(fresh) {
                var preferred = preferCachedSettingsResult(fresh, cached);
                if (preferred && preferred === fresh && fresh.ok && settingsLooksUsable(fresh.settings)) writePublicCache(cacheKey, fresh);
                return preferred || cached || fresh || { ok: false, backend: "pocketbase", settings: {} };
            }).catch(function(err) {
                if (cached) return cached;
                return {
                    ok: false,
                    backend: "pocketbase",
                    endpointError: err,
                    message: err && err.message ? err.message : String(err),
                    settings: {}
                };
            });
        });
    }
    var paused = options.ignoreCooldown === true ? null : endpointCooldownResult(publicSettingsPausedUntil, { settings: {} });
    if (paused) {
        return cachedPublicResult("settings", cacheKey, { cooldown: true, retryAfterMs: paused.retryAfterMs }).then(function(cached) {
            return cached || paused;
        });
    }
    function loadSettingsCollection(endpointErr) {
        var collection = collectionOption(options, ["pocketBaseSettingsCollection", "pocketbaseSettingsCollection", "settingsCollection"], "settings");
        return listPocketBaseCollection(options, collection, {
            perPage: 100,
            maxPages: 3,
            timeoutMs: timeoutMs
        }).then(function(result) {
            if (!result.ok) {
                result.endpointError = endpointErr;
                result.settings = {};
                return result;
            }
            var parsed = { ok: true, backend: "pocketbase", settings: normalizeSettingsObject(settingsFromRecords(result.records)), records: result.records };
            return completeSettingsWithMenu(parsed, options).then(function(done) {
                if (options.skipCacheWrite !== true) writePublicCache(cacheKey, done);
                return done;
            });
        });
    }
    function loadFirebaseSettings(endpointErr) {
        return requestFirebasePublicJson("settings", timeoutMs).then(function(data) {
            var parsed = parseFirebaseSettingsResponse(data);
            if (!settingsLooksUsable(parsed.settings)) throw new Error("Firebase settings incomplete");
            if (options.skipCacheWrite !== true) writePublicCache(cacheKey, parsed);
            return parsed;
        }).catch(function(firebaseErr) {
            var failed = {
                ok: false,
                backend: "firebase",
                endpointError: endpointErr,
                firebaseError: firebaseErr,
                message: firebaseErr && firebaseErr.message ? firebaseErr.message : String(firebaseErr),
                settings: {}
            };
            if (options.disableCacheFallback === true) return failed;
            return cachedPublicResult("settings", cacheKey, { endpointError: endpointErr, firebaseError: firebaseErr }).then(function(cached) {
                return cached || failed;
            });
        });
    }
    if (options.usePocketBasePublicEndpoint === false) return loadFirebaseSettings(null);
    var canUseDirectSettingsCollection = options.allowDirectCollectionFallback === true && !!config.token;
    if (canUseDirectSettingsCollection) {
        // ponytail: admin-capable pages should not accept public safe defaults over real settings.
        return loadSettingsCollection(null);
    }
    if (!config.token && options.preferPublicSettingsEndpoint !== true) {
        // ponytail: try the tiny self-contained settings route before deriving tabs from menu.
        return requestJson(config.baseUrl + "/api/order-public/settings-snapshot", { method: "GET" }, timeoutMs)
            .then(function(data) {
                var parsed = parsePublicSettingsResponse(data);
                return completeSettingsWithMenu(parsed, options).then(function(done) {
                    if (!settingsLooksUsable(done.settings)) throw new Error("PocketBase settings snapshot incomplete");
                    if (options.skipCacheWrite !== true) writePublicCache(cacheKey, done);
                    return done;
                });
            })
            .catch(function() {
                return completeSettingsWithMenu({ ok: true, backend: "menu_derived_settings_first", settings: {} }, options).then(function(derived) {
                    if (options.skipCacheWrite !== true && settingsLooksUsable(derived.settings)) writePublicCache(cacheKey, derived);
                    return derived;
                });
            });
    }
    var settingsEndpoints = options.tryAllPublicEndpoints === true ? [
        "/settings-canary-20260629",
        "/api/order-public/settings-menu-20260629",
        "/api/order-public/settings-inline",
        "/api/order-public/settings",
        "/api/order-public/settings-snapshot",
        "/api/order-public/settings-safe"
    ] : [
        "/settings-canary-20260629",
        "/api/order-public/settings-menu-20260629",
        "/api/order-public/settings-inline",
        "/api/order-public/settings-snapshot"
    ];
    function trySettingsEndpoint(index, lastErr) {
        if (index >= settingsEndpoints.length) return Promise.reject(lastErr || new Error("PocketBase settings endpoint failed"));
        return requestJson(config.baseUrl + settingsEndpoints[index], { method: "GET" }, timeoutMs)
            .catch(function(err) { return trySettingsEndpoint(index + 1, err); });
    }
    return trySettingsEndpoint(0)
        .then(function(data) {
            publicSettingsPausedUntil = 0;
            var parsed = parsePublicSettingsResponse(data);
            return completeSettingsWithMenu(parsed, options).then(function(done) {
                if (!settingsLooksUsable(done.settings)) throw new Error("PocketBase settings incomplete");
                if (options.skipCacheWrite !== true) writePublicCache(cacheKey, done);
                return done;
            });
        })
        .catch(function(endpointErr) {
            publicSettingsPausedUntil = Date.now() + PUBLIC_ENDPOINT_COOLDOWN_MS;
            if (canUseDirectSettingsCollection) return loadSettingsCollection(endpointErr);
            if (options.allowFirebasePublicFallback === true) return loadFirebaseSettings(endpointErr).then(function(firebaseResult) {
                if (firebaseResult && firebaseResult.ok) return firebaseResult;
            var failed = {
                ok: false,
                backend: "pocketbase",
                endpointError: endpointErr,
                message: endpointErr && endpointErr.message ? endpointErr.message : String(endpointErr),
                settings: {}
            };
            if (options.disableCacheFallback === true) return failed;
            return cachedPublicResult("settings", cacheKey, { endpointError: endpointErr }).then(function(cached) {
                return cached || failed;
            });
            });
            var failed = {
                ok: false,
                backend: "pocketbase_snapshot",
                endpointError: endpointErr,
                message: endpointErr && endpointErr.message ? endpointErr.message : String(endpointErr),
                settings: {}
            };
            return completeSettingsWithMenu({ ok: true, backend: "menu_derived_settings", endpointError: endpointErr, settings: {} }, options).then(function(derived) {
                if (settingsLooksUsable(derived.settings)) {
                    if (options.skipCacheWrite !== true) writePublicCache(cacheKey, derived);
                    return derived;
                }
                if (options.disableCacheFallback === true) return failed;
                return cachedPublicResult("settings", cacheKey, { endpointError: endpointErr }).then(function(cached) {
                    return cached || failed;
                });
            });
        });
}

export function listMenuItemsFromPocketBase(options) {
    options = options || {};
    var config = resolvePocketBaseConfig(options);
    var timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    if (!config.baseUrl) return Promise.resolve({ ok: false, skipped: true, reason: "missing_pocketbase_url", items: [] });
    var cacheKey = publicCacheKey("menu", config.baseUrl);
    if (options.cacheOnly === true) {
        return cachedPublicResult("menu", cacheKey, { cacheOnly: true }).then(function(cached) {
            if (cached && options.activeOnly) cached.items = (cached.items || []).filter(function(item) { return item && item.active !== false; });
            return cached || { ok: false, backend: "pocketbase_cache", skipped: true, reason: "public_menu_cache_miss", items: [] };
        });
    }
    if (options.forceFresh !== true) {
        return cachedPublicResult("menu", cacheKey).then(function(cached) {
            if (cached && options.activeOnly) cached = Object.assign({}, cached, {
                items: (cached.items || []).filter(function(item) { return item && item.active !== false; })
            });
            return listMenuItemsFromPocketBase(Object.assign({}, options, {
                forceFresh: true,
                disableCacheFallback: true,
                skipCacheWrite: true
            })).then(function(fresh) {
                var preferred = preferCachedMenuResult(fresh, cached);
                if (preferred && preferred === fresh && fresh.ok && menuLooksUsable(fresh.items)) {
                    writePublicCache(cacheKey, Object.assign({}, fresh, { items: fresh.items || [] }));
                }
                return preferred || cached || fresh || { ok: false, backend: "pocketbase", items: [] };
            }).catch(function(err) {
                if (cached) return cached;
                return {
                    ok: false,
                    backend: "pocketbase",
                    endpointError: err,
                    message: err && err.message ? err.message : String(err),
                    items: []
                };
            });
        });
    }
    var paused = options.ignoreCooldown === true ? null : endpointCooldownResult(publicMenuPausedUntil, { items: [] });
    if (paused) {
        return cachedPublicResult("menu", cacheKey, { cooldown: true, retryAfterMs: paused.retryAfterMs }).then(function(cached) {
            if (cached && options.activeOnly) cached.items = (cached.items || []).filter(function(item) { return item && item.active !== false; });
            return cached || paused;
        });
    }
    function loadMenuCollection(endpointErr) {
        var collection = collectionOption(options, ["pocketBaseMenuCollection", "pocketbaseMenuCollection", "menuCollection", "pocketBaseMenuItemsCollection"], "menu_items");
        return listPocketBaseCollection(options, collection, {
            perPage: 500,
            maxPages: 10,
            timeoutMs: timeoutMs
        }).then(function(result) {
            if (!result.ok) {
                result.endpointError = endpointErr;
                result.items = [];
                return result;
            }
            var items = dedupeMenuItems(result.records.map(menuItemFromRecord).filter(menuItemLooksRenderable));
            if (options.activeOnly) items = items.filter(function(item) { return item && item.active !== false; });
            var parsed = { ok: true, backend: "pocketbase", items: sortMenuItems(items), records: result.records };
            if (options.skipCacheWrite !== true) writePublicCache(cacheKey, Object.assign({}, parsed, { items: parsed.items || [] }));
            return parsed;
        });
    }
    function loadFirebaseMenu(endpointErr) {
        return requestFirebasePublicJson("menu", timeoutMs).then(function(data) {
            var parsed = parseFirebaseMenuResponse(data, options);
            if (!menuLooksUsable(parsed.items)) throw new Error("Firebase menu incomplete");
            if (options.skipCacheWrite !== true) writePublicCache(cacheKey, Object.assign({}, parsed, { items: parsed.items || [] }));
            return parsed;
        }).catch(function(firebaseErr) {
            var failed = {
                ok: false,
                backend: "firebase",
                endpointError: endpointErr,
                firebaseError: firebaseErr,
                message: firebaseErr && firebaseErr.message ? firebaseErr.message : String(firebaseErr),
                items: []
            };
            if (options.disableCacheFallback === true) return failed;
            return cachedPublicResult("menu", cacheKey, { endpointError: endpointErr, firebaseError: firebaseErr }).then(function(cached) {
                if (cached && options.activeOnly) cached.items = (cached.items || []).filter(function(item) { return item && item.active !== false; });
                return cached || failed;
            });
        });
    }
    if (options.usePocketBasePublicEndpoint === false) return loadFirebaseMenu(null);
    var canUseDirectMenuCollection = options.allowDirectCollectionFallback === true && !!config.token;
    if (canUseDirectMenuCollection && options.forceFresh === true && options.disableCacheFallback === true) {
        return loadMenuCollection(null);
    }
    var menuEndpoints = options.tryAllPublicEndpoints === true ? [
        "/api/order-public/menu-snapshot",
        "/api/order-public/menu-safe",
        "/api/order-public/menu-inline",
        "/api/order-public/menu"
    ] : ["/api/order-public/menu-snapshot"];
    function tryMenuEndpoint(index, lastErr) {
        if (index >= menuEndpoints.length) return Promise.reject(lastErr || new Error("PocketBase menu endpoint failed"));
        return requestJson(config.baseUrl + menuEndpoints[index], { method: "GET" }, timeoutMs)
            .catch(function(err) { return tryMenuEndpoint(index + 1, err); });
    }
    return tryMenuEndpoint(0)
        .then(function(data) {
            publicMenuPausedUntil = 0;
            var parsed = parsePublicMenuResponse(data, options);
            if (!menuLooksUsable(parsed.items)) throw new Error("PocketBase menu incomplete");
            if (options.skipCacheWrite !== true) writePublicCache(cacheKey, Object.assign({}, parsed, { items: parsed.items || [] }));
            return parsed;
        })
        .catch(function(endpointErr) {
            publicMenuPausedUntil = Date.now() + PUBLIC_ENDPOINT_COOLDOWN_MS;
            if (canUseDirectMenuCollection) return loadMenuCollection(endpointErr);
            if (options.allowFirebasePublicFallback === true) return loadFirebaseMenu(endpointErr).then(function(firebaseResult) {
                if (firebaseResult && firebaseResult.ok) return firebaseResult;
            var failed = {
                ok: false,
                backend: "pocketbase",
                endpointError: endpointErr,
                message: endpointErr && endpointErr.message ? endpointErr.message : String(endpointErr),
                items: []
            };
            if (options.disableCacheFallback === true) return failed;
            return cachedPublicResult("menu", cacheKey, { endpointError: endpointErr }).then(function(cached) {
                if (cached && options.activeOnly) cached.items = (cached.items || []).filter(function(item) { return item && item.active !== false; });
                return cached || failed;
            });
            });
            var failed = {
                ok: false,
                backend: "pocketbase_snapshot",
                endpointError: endpointErr,
                message: endpointErr && endpointErr.message ? endpointErr.message : String(endpointErr),
                items: []
            };
            if (options.disableCacheFallback === true) return failed;
            return cachedPublicResult("menu", cacheKey, { endpointError: endpointErr }).then(function(cached) {
                if (cached && options.activeOnly) cached.items = (cached.items || []).filter(function(item) { return item && item.active !== false; });
                return cached || failed;
            });
        });
}

export function rememberPublicMenuItems(options, items) {
    options = options || {};
    var config = resolvePocketBaseConfig(options);
    var cacheKey = publicCacheKey("menu", config.baseUrl || configuredDefaultBaseUrl());
    var parsed = { ok: true, backend: "pocketbase_cache", items: sortMenuItems(dedupeMenuItems(Array.isArray(items) ? items.map(decodeJsonLike) : [])) };
    if (!menuLooksUsable(parsed.items)) return Promise.resolve(false);
    return writePublicCache(cacheKey, parsed);
}

export function rememberPublicSettings(options, settings) {
    options = options || {};
    var config = resolvePocketBaseConfig(options);
    var cacheKey = publicCacheKey("settings", config.baseUrl || configuredDefaultBaseUrl());
    var parsed = {
        ok: true,
        backend: "pocketbase_cache",
        settings: normalizeSettingsObject(Object.assign({}, decodeJsonLike(options.settings || {}), decodeJsonLike(settings || {})))
    };
    return writePublicCache(cacheKey, parsed);
}

function secureManageEndpoint(config, kind, options) {
    options = options || {};
    function defaultWorkerManageEndpoint() {
        var fallback = cleanBaseUrl(configuredDefaultOrderEndpoint() || "");
        if (/\/api\/orders$/i.test(fallback)) return fallback.replace(/\/api\/orders$/i, "/api/manage/" + kind);
        if (/\/api\/secure\/orders$/i.test(fallback)) return fallback.replace(/\/api\/secure\/orders$/i, "/api/secure/manage/" + kind);
        return "";
    }
    var explicit = cleanBaseUrl(
        optionValue(options, kind === "settings"
            ? ["pocketBaseSettingsWriteEndpoint", "settingsWriteEndpoint", "secureSettingsEndpoint"]
            : ["pocketBaseMenuWriteEndpoint", "menuWriteEndpoint", "secureMenuEndpoint"]) || ""
    );
    if (explicit) return explicit;
    var base = cleanBaseUrl(config.manageEndpoint || "");
    if (base) {
        if (/\/api\/manage\/(menu|settings)$/i.test(base)) return base.replace(/\/(menu|settings)$/i, "/" + kind);
        return base.replace(/\/+$/, "") + "/" + kind;
    }
    var orderEndpoint = cleanBaseUrl(config.orderEndpoint || "");
    if (orderEndpoint) {
        var directSecureBase = cleanBaseUrl(config.baseUrl || "") + "/api/secure/orders";
        if (!config.token && cleanBaseUrl(config.baseUrl || "") && orderEndpoint.toLowerCase() === directSecureBase.toLowerCase()) {
            var proxy = defaultWorkerManageEndpoint();
            if (proxy) return proxy;
        }
        if (/\/api\/secure\/orders$/i.test(orderEndpoint)) return orderEndpoint.replace(/\/api\/secure\/orders$/i, "/api/secure/manage/" + kind);
        if (/\/api\/orders$/i.test(orderEndpoint)) return orderEndpoint.replace(/\/api\/orders$/i, "/api/manage/" + kind);
        return orderEndpoint.replace(/\/+$/, "") + "/manage/" + kind;
    }
    return "";
}

function recordFieldName(record, fields) {
    record = record || {};
    for (var i = 0; i < fields.length; i++) {
        if (Object.prototype.hasOwnProperty.call(record, fields[i])) return fields[i];
    }
    return "";
}

function collectionStoredValue(value) {
    var decoded = decodeJsonLike(value);
    if (Array.isArray(decoded) || (decoded && typeof decoded === "object")) {
        return JSON.stringify(plainJson(decoded, decoded));
    }
    return decoded;
}

function menuIdentityKey(item) {
    var name = text(item && (item.name || item.printName || item.shortName)).trim().toLowerCase();
    var category = text(item && item.category).trim().toLowerCase();
    var price = text(item && item.price).trim();
    if (!name) return "";
    return [name, category, price].join("|");
}

function patchCollectionRecord(config, collection, recordId, payload, options) {
    if (!config || !config.baseUrl || !config.token || !recordId) {
        return Promise.resolve({ ok: false, skipped: true, reason: "missing_collection_patch_target" });
    }
    return requestJson(
        config.baseUrl + "/api/collections/" + encodeURIComponent(collection) + "/records/" + encodeURIComponent(recordId),
        {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + config.token
            },
            body: JSON.stringify(payload || {})
        },
        Number(options && (options.secureTimeoutMs || options.timeoutMs || DEFAULT_TIMEOUT_MS)) || DEFAULT_TIMEOUT_MS
    ).then(function(data) {
        return { ok: true, backend: "pocketbase_collection", id: recordId, data: data };
    }).catch(function(error) {
        return { ok: false, backend: "pocketbase_collection", id: recordId, error: error, message: error && error.message ? error.message : String(error) };
    });
}

function createCollectionRecord(config, collection, payload, options) {
    if (!config || !config.baseUrl || !config.token) {
        return Promise.resolve({ ok: false, skipped: true, reason: "missing_collection_create_target" });
    }
    return requestJson(
        config.baseUrl + "/api/collections/" + encodeURIComponent(collection) + "/records",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + config.token
            },
            body: JSON.stringify(payload || {})
        },
        Number(options && (options.secureTimeoutMs || options.timeoutMs || DEFAULT_TIMEOUT_MS)) || DEFAULT_TIMEOUT_MS
    ).then(function(data) {
        return { ok: true, backend: "pocketbase_collection", data: data, id: text(data && data.id) };
    }).catch(function(error) {
        return { ok: false, backend: "pocketbase_collection", error: error, message: error && error.message ? error.message : String(error) };
    });
}

function updateMenuSortViaCollection(items, options) {
    options = options || {};
    var config = resolvePocketBaseConfig(options);
    if (!config.baseUrl || !config.token) {
        return Promise.resolve({ ok: false, skipped: true, reason: "missing_menu_collection_token" });
    }
    var collection = collectionOption(options, ["pocketBaseMenuCollection", "pocketbaseMenuCollection", "menuCollection", "pocketBaseMenuItemsCollection"], "menu_items");
    return listPocketBaseCollection(options, collection, {
        perPage: 500,
        maxPages: 10,
        timeoutMs: Number(options.secureTimeoutMs || options.timeoutMs || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
    }).then(function(result) {
        if (!result || !result.ok) return Object.assign({ ok: false, reason: "menu_collection_lookup_failed" }, result || {});
        var records = Array.isArray(result.records) ? result.records : [];
        var touched = {};
        var tasks = [];
        var updated = 0;
        var missed = 0;
        (items || []).forEach(function(row) {
            var sortOrder = finiteNumber(row && row.sortOrder);
            if (sortOrder === null) return;
            var wantedId = text(row && row.id);
            var wantedKey = menuIdentityKey(row);
            var matches = records.filter(function(record) {
                if (!record || !record.id || touched[record.id]) return false;
                if (wantedId) {
                    var ids = [
                        text(record.id),
                        text(record.firebase_id),
                        text(record.firebaseId),
                        text(record.item_id),
                        text(record.itemId),
                        text(record.menu_id),
                        text(record.menuId)
                    ];
                    if (ids.indexOf(wantedId) !== -1) return true;
                }
                return wantedKey && menuIdentityKey(menuItemFromRecord(record)) === wantedKey;
            });
            if (!matches.length) {
                missed++;
                return;
            }
            matches.forEach(function(record) {
                touched[record.id] = true;
                var payload = {};
                ["sortOrder", "sort_order", "order", "sortIndex", "__sortIndex"].forEach(function(field) {
                    if (Object.prototype.hasOwnProperty.call(record, field)) payload[field] = sortOrder;
                });
                var nestedField = recordFieldName(record, ["item", "data", "json", "value"]);
                if (nestedField) {
                    var nested = decodeJsonLike(record[nestedField]);
                    if (!nested || typeof nested !== "object" || Array.isArray(nested)) nested = {};
                    payload[nestedField] = collectionStoredValue(Object.assign({}, nested, { sortOrder: sortOrder }));
                }
                if (Object.prototype.hasOwnProperty.call(record, "updatedAt")) payload.updatedAt = Date.now();
                if (!Object.keys(payload).length) payload = { sortOrder: sortOrder };
                tasks.push(function() {
                    return patchCollectionRecord(config, collection, record.id, payload, options).then(function(step) {
                        if (step && step.ok) updated++;
                        return step;
                    });
                });
            });
        });
        return tasks.reduce(function(promise, task) {
            return promise.then(function(list) {
                return Promise.resolve(task()).then(function(step) {
                    list.push(step);
                    return list;
                });
            });
        }, Promise.resolve([])).then(function(steps) {
            return {
                ok: updated > 0 && missed === 0 && !steps.some(function(step) { return !step || step.ok !== true; }),
                backend: "pocketbase_collection",
                action: "sorted",
                updated: updated,
                missed: missed,
                steps: steps
            };
        });
    });
}

function writeSettingsViaCollection(settingsPatch, options) {
    options = options || {};
    var config = resolvePocketBaseConfig(options);
    if (!config.baseUrl || !config.token) {
        return Promise.resolve({ ok: false, skipped: true, reason: "missing_settings_collection_token" });
    }
    var collection = collectionOption(options, ["pocketBaseSettingsCollection", "pocketbaseSettingsCollection", "settingsCollection"], "settings");
    return listPocketBaseCollection(options, collection, {
        perPage: 100,
        maxPages: 3,
        timeoutMs: Number(options.secureTimeoutMs || options.timeoutMs || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
    }).then(function(result) {
        if (!result || !result.ok) return Object.assign({ ok: false, reason: "settings_collection_lookup_failed" }, result || {});
        var records = Array.isArray(result.records) ? result.records : [];
        var sample = records[0] || null;
        var sampleKeyField = recordFieldName(sample, ["key", "name", "setting_key", "settingKey"]);
        var sampleValueField = recordFieldName(sample, ["value", "data", "json", "settings"]);
        var useKeyedRecords = !!(sampleKeyField && sampleValueField && sampleValueField !== "settings");
        if (useKeyedRecords) {
            var keyedTasks = [];
            Object.keys(settingsPatch || {}).forEach(function(key) {
                var record = records.find(function(row) {
                    return text(row && (row.key || row.name || row.setting_key || row.settingKey)) === key;
                }) || null;
                var keyField = recordFieldName(record || sample, ["key", "name", "setting_key", "settingKey"]) || sampleKeyField;
                var valueField = recordFieldName(record || sample, ["value", "data", "json", "settings"]) || sampleValueField;
                if (!keyField || !valueField) return;
                var payload = {};
                [keyField].concat(["key", "name", "setting_key", "settingKey"]).forEach(function(field) {
                    if ((record && Object.prototype.hasOwnProperty.call(record, field)) || (sample && Object.prototype.hasOwnProperty.call(sample, field))) {
                        payload[field] = key;
                    }
                });
                payload[keyField] = key;
                payload[valueField] = collectionStoredValue(settingsPatch[key]);
                keyedTasks.push(function() {
                    if (record && record.id) return patchCollectionRecord(config, collection, record.id, payload, options);
                    return createCollectionRecord(config, collection, payload, options);
                });
            });
            return keyedTasks.reduce(function(promise, task) {
                return promise.then(function(list) {
                    return Promise.resolve(task()).then(function(step) {
                        list.push(step);
                        return list;
                    });
                });
            }, Promise.resolve([])).then(function(steps) {
                return {
                    ok: steps.length > 0 && steps.every(function(step) { return step && step.ok === true; }),
                    backend: "pocketbase_collection",
                    action: "settings_updated",
                    steps: steps
                };
            });
        }
        var record = sample;
        if (!record || !record.id) {
            return { ok: false, backend: "pocketbase_collection", reason: "settings_collection_empty" };
        }
        var objectField = recordFieldName(record, ["settings", "data", "json", "value"]);
        var payload = {};
        if (objectField) {
            var existing = decodeJsonLike(record[objectField]);
            if (!existing || typeof existing !== "object" || Array.isArray(existing)) existing = {};
            payload[objectField] = collectionStoredValue(Object.assign({}, existing, plainJson(settingsPatch || {}, {})));
        }
        Object.keys(settingsPatch || {}).forEach(function(key) {
            if (Object.prototype.hasOwnProperty.call(record, key)) payload[key] = collectionStoredValue(settingsPatch[key]);
        });
        if (!Object.keys(payload).length) return { ok: false, backend: "pocketbase_collection", reason: "settings_collection_no_writable_fields" };
        return patchCollectionRecord(config, collection, record.id, payload, options).then(function(step) {
            return Object.assign({ action: "settings_updated" }, step || {});
        });
    });
}

function writeManageRequest(kind, payload, options) {
    options = options || {};
    var config = resolvePocketBaseConfig(options);
    var endpoint = secureManageEndpoint(config, kind, options);
    if (!endpoint) return Promise.resolve({ ok: false, skipped: true, reason: "missing_manage_endpoint" });
    return requestJson(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {})
    }, Number(options.secureTimeoutMs || options.timeoutMs || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
}

export function writeMenuItemToPocketBase(itemId, itemData, options) {
    options = options || {};
    var payload = {
        action: options.action || "upsert",
        itemId: text(itemId || (itemData && itemData.id)),
        item: plainJson(itemData || {}, {})
    };
    return writeManageRequest("menu", payload, options).then(function(result) {
        if (result && result.ok && result.item) rememberPublicMenuItems(options, [result.item].concat(options.currentMenuItems || []));
        return Object.assign({ ok: true, backend: "pocketbase" }, result || {});
    });
}

export function deleteMenuItemFromPocketBase(itemId, options) {
    options = options || {};
    return writeManageRequest("menu", { action: "delete", itemId: text(itemId) }, options)
        .then(function(result) { return Object.assign({ ok: true, backend: "pocketbase" }, result || {}); });
}

export function updateMenuSortInPocketBase(items, options) {
    options = options || {};
    function rememberSortedItems() {
        var nextItems = null;
        if (Array.isArray(options.currentMenuItems) && options.currentMenuItems.length) {
            var orderById = {};
            var orderByKey = {};
            (items || []).forEach(function(row) {
                var id = text(row && row.id);
                var sortOrder = finiteNumber(row && row.sortOrder);
                if (sortOrder === null) return;
                if (id) orderById[id] = sortOrder;
                var key = menuIdentityKey(row);
                if (key) orderByKey[key] = sortOrder;
            });
            nextItems = options.currentMenuItems.map(function(item) {
                var id = text(item && item.id);
                var key = menuIdentityKey(item);
                var nextSort = orderById[id];
                if (nextSort === undefined && key) nextSort = orderByKey[key];
                if (nextSort === undefined) return item;
                return Object.assign({}, item, { sortOrder: nextSort });
            });
        }
        if (Array.isArray(nextItems) && nextItems.length) rememberPublicMenuItems(options, nextItems);
    }
    return writeManageRequest("menu", { action: "sort", items: plainJson(items || [], []) }, options)
        .then(function(result) {
            if (result && result.ok) {
                if (Array.isArray(result.items) && result.items.length) rememberPublicMenuItems(options, result.items);
                else rememberSortedItems();
                return Object.assign({ ok: true, backend: "pocketbase" }, result || {});
            }
            return result || { ok: false, backend: "pocketbase", reason: "menu_sort_write_failed" };
        }).then(function(result) {
            if (result && result.ok) return result;
            return updateMenuSortViaCollection(items, options);
        }).then(function(result) {
            if (result && result.ok) {
                rememberSortedItems();
                return result;
            }
            return result;
        }).catch(function(error) {
            return updateMenuSortViaCollection(items, options).then(function(result) {
                if (result && result.ok) {
                    rememberSortedItems();
                    return result;
                }
                return { ok: false, backend: "pocketbase", error: error, fallback: result, message: error && error.message ? error.message : String(error) };
            });
        });
}

export function writeSettingsToPocketBase(settingsPatch, options) {
    options = options || {};
    var patch = plainJson(settingsPatch || {}, {});
    return writeManageRequest("settings", { settings: patch }, options).then(function(result) {
        if (result && result.ok) {
            rememberPublicSettings(options, Object.assign({}, (options.settings || {}), patch));
            return Object.assign({ ok: true, backend: "pocketbase" }, result || {});
        }
        return writeSettingsViaCollection(patch, options);
    }).catch(function(error) {
        return writeSettingsViaCollection(patch, options).then(function(result) {
            if (result && result.ok) {
                rememberPublicSettings(options, Object.assign({}, (options.settings || {}), patch));
                return result;
            }
            return { ok: false, backend: "pocketbase", error: error, fallback: result, message: error && error.message ? error.message : String(error) };
        });
    }).then(function(result) {
        if (result && result.ok) rememberPublicSettings(options, Object.assign({}, (options.settings || {}), patch));
        return result;
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
    var skipped = 0;
    var config = resolvePocketBaseConfig(options);
    var headers = {};
    if (config.token) headers.Authorization = "Bearer " + config.token;

    return candidates.reduce(function(promise, order) {
        return promise.then(function() {
            var key = backfillThrottleKey(order);
            var orderId = text(order.id || order.sourceOrderId || order.orderId);
            var lookupTimeoutMs = Number(options.lookupTimeoutMs || options.timeoutMs || 3500) || 3500;
            return findExistingRecordIdChecked(config, orderId, headers, lookupTimeoutMs).then(function(existing) {
                if (existing && existing.ok && existing.id) {
                    success++;
                    markBackfilled(key);
                    return { ok: true, action: "exists", id: existing.id };
                }
                if (!existing || existing.ok !== true) {
                    skipped++;
                    backfillPausedUntil = Date.now() + 10000;
                    return { ok: false, skipped: true, reason: "pocketbase_backfill_lookup_failed", lookup: existing };
                }
                return writeOrderToPocketBase(orderId, order, Object.assign({}, options, {
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
        });
    }, Promise.resolve()).then(function() {
        return { ok: failed === 0, attempted: candidates.length, success: success, failed: failed, skipped: skipped };
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

function findExistingRecordIdChecked(config, orderId, headers, timeoutMs) {
    if (!config || !config.baseUrl || !orderId) return Promise.resolve({ ok: true, id: "" });
    var filter = 'order_id="' + encodeFilterValue(orderId) + '"';
    var url = config.baseUrl + "/api/collections/" + encodeURIComponent(config.collection) + "/records?perPage=1&filter=" + encodeURIComponent(filter);
    var lookupTimeout = Math.max(2000, Math.min(Number(timeoutMs || 3500) || 3500, 6000));
    return requestJson(url, { method: "GET", headers: headers || {} }, lookupTimeout)
        .then(function(data) {
            var id = data && data.items && data.items[0] && data.items[0].id ? text(data.items[0].id) : "";
            return { ok: true, id: id };
        })
        .catch(function(error) {
            return { ok: false, id: "", error: error, message: error && error.message ? error.message : String(error) };
        });
}

function writeOrderToSecureEndpoint(config, orderId, orderData, options, record, timeoutMs) {
    var tokenPromise = shouldRequestTurnstile(config, options)
        ? requestTurnstileToken(config.turnstileSiteKey, options.turnstileTimeoutMs || 90000)
        : Promise.resolve("");
    return tokenPromise.then(function(turnstileToken) {
        var payload = {
            orderId: text(orderId || (orderData && orderData.id)),
            sourcePage: text(options.sourcePage || (orderData && orderData.source) || ""),
            resetTime: text(options.resetTime || options.counterResetTime || ""),
            maxNo: numericOrUndefined(options.maxNo || options.counterMaxNo),
            orderData: plainJson(orderData || {}, {}),
            record: plainJson(record || {}, {}),
            turnstileToken: turnstileToken,
            clientTs: Date.now()
        };
        return requestJson(config.orderEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        }, Number(options.secureTimeoutMs || timeoutMs || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS).then(function(data) {
            var savedRecord = data && data.record && typeof data.record === "object" ? data.record : record;
            return {
                ok: true,
                action: text(data && data.action) || "created",
                id: text((data && data.id) || (savedRecord && savedRecord.id) || ""),
                record: savedRecord,
                data: data,
                secureEndpoint: true
            };
        });
    });
}

function deriveTelegramNotifyEndpoint(settings, options) {
    settings = settings || {};
    options = options || {};
    var explicit = cleanBaseUrl(
        optionValue(options, ["telegramFallbackNotifyEndpoint", "telegramNotifyEndpoint", "firebaseFallbackNotifyEndpoint"]) ||
        settings.telegramFallbackNotifyEndpoint ||
        settings.telegramNotifyEndpoint ||
        settings.firebaseFallbackNotifyEndpoint ||
        ""
    );
    if (explicit) return explicit;
    var resolvedConfig = resolvePocketBaseConfig(Object.assign({}, options, { settings: settings }));
    var orderEndpoint = cleanBaseUrl(
        resolvedConfig.orderEndpoint ||
        settings.pocketBaseOrderEndpoint ||
        settings.pocketbaseOrderEndpoint ||
        settings.pocketBaseSecureOrderEndpoint ||
        settings.secureOrderEndpoint ||
        ""
    );
    if (!orderEndpoint) return configuredDefaultTelegramNotifyEndpoint();
    if (/\/api\/(?:secure\/)?orders$/i.test(orderEndpoint)) {
        return orderEndpoint.replace(/\/api\/(?:secure\/)?orders$/i, "/api/notify/fallback");
    }
    if (orderEndpoint) return orderEndpoint.replace(/\/+$/, "") + "/notify/fallback";
    return configuredDefaultTelegramNotifyEndpoint();
}

function fallbackNotifyDateKey() {
    var d = new Date();
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
}

function summarizeFallbackReason(reason) {
    var textValue = text(
        (reason && (reason.message || reason.reason)) ||
        (reason && reason.error && (reason.error.message || reason.error.reason)) ||
        ""
    );
    if (/timeout|failed|unavailable|fetch|network|PocketBase/i.test(textValue)) return "Pi PocketBase 無法連線";
    return textValue || "Pi PocketBase 無法連線";
}

function notifyFirebaseFallbackOnce(orderId, orderData, options, reason, firebaseResult) {
    options = options || {};
    var settings = options.settings || {};
    var endpoint = deriveTelegramNotifyEndpoint(settings, options);
    if (!endpoint || typeof fetch !== "function") {
        console.warn("Firebase fallback Telegram notify skipped: missing notify endpoint");
        return Promise.resolve({ ok: false, skipped: true, reason: "missing_notify_endpoint" });
    }
    var dateKey = fallbackNotifyDateKey();
    var origin = (typeof window !== "undefined" && window.location && window.location.origin) ? window.location.origin : "unknown-origin";
    var eventKey = origin + ":firebase_fallback:" + dateKey;
    var storageKey = "telegram_fallback_notified:" + eventKey;
    var localDedupeMs = Math.max(60000, Number(settings.telegramFallbackNotifyTtlMs || settings.telegramFallbackNotifyLocalTtlMs || 21600000) || 21600000);
    try {
        var lastNotifiedAt = typeof localStorage !== "undefined" ? Number(localStorage.getItem(storageKey) || 0) : 0;
        if (lastNotifiedAt && Date.now() - lastNotifiedAt < localDedupeMs) {
            return Promise.resolve({ ok: true, skipped: true, reason: "local_already_notified" });
        }
    } catch(e) {}
    var storeName = text(settings.storeName || settings.storeTitle || settings.storeInfo || "元氣早午餐善化中山店");
    var body = {
        type: "firebase_fallback",
        eventKey: eventKey,
        orderId: text(orderId || (orderData && orderData.id)),
        sourcePage: text(options.sourcePage || (orderData && orderData.source) || ""),
        storeName: storeName,
        reason: summarizeFallbackReason(reason),
        messageTemplate: text(settings.telegramFallbackMessageTemplate || ""),
        clientTs: Date.now(),
        firebase: plainJson(firebaseResult || {}, {})
    };
    return requestJson(endpoint, {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    }, Number(options.notifyTimeoutMs || 3500) || 3500).then(function(result) {
        try {
            if (typeof localStorage !== "undefined") localStorage.setItem(storageKey, String(Date.now()));
        } catch(e) {}
        if (result && result.skipped) {
            console.info("Firebase fallback Telegram notify skipped:", result.message || result.reason || result.eventKey || "");
        } else {
            console.info("Firebase fallback Telegram notify sent:", result && result.eventKey ? result.eventKey : endpoint);
        }
        return result || { ok: true };
    }).catch(function(err) {
        console.warn("Firebase fallback Telegram notify failed:", err && err.message ? err.message : err);
        return { ok: false, error: err, message: err && err.message ? err.message : String(err) };
    });
}

export function writeOrderToPocketBase(orderId, orderData, options) {
    options = options || {};
    var config = resolvePocketBaseConfig(options);
    if (!config.baseUrl && !config.orderEndpoint) {
        return Promise.resolve({ ok: false, skipped: true, reason: "missing_pocketbase_url" });
    }
    if (typeof window !== "undefined" && window.location && window.location.protocol === "https:" &&
        /^http:\/\//i.test(config.baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(config.baseUrl)) {
        return Promise.resolve({ ok: false, skipped: true, reason: "mixed_content_http_pocketbase_url" });
    }
    var timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    var record = buildPocketBaseOrderRecord(orderId, orderData, options);
    if (config.orderEndpoint) {
        return writeOrderToSecureEndpoint(config, orderId, orderData, options, record, timeoutMs);
    }
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
        try {
            var detail = reason && (reason.message || reason.reason || (reason.error && reason.error.message) || "");
            var body = reason && (reason.body || (reason.error && reason.error.body));
            if (detail || body) console.warn("PocketBase primary write failed; using Firebase fallback:", detail || "", body || "");
        } catch(e) {}
        if (!writeToFirebase) {
            return Promise.resolve({ ok: false, backend: "none", fallback: false, pocketBase: reason });
        }
        return Promise.resolve()
            .then(function() { return writeToFirebase(reason); })
            .then(function(firebaseResult) {
                return notifyFirebaseFallbackOnce(orderId, orderData, options, reason, firebaseResult).then(function(notifyResult) {
                    return { ok: true, backend: "firebase", fallback: true, pocketBase: reason, firebase: firebaseResult, telegramNotify: notifyResult };
                });
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
