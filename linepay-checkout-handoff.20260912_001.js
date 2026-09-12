const STORAGE_KEY = "linepay_checkout_handoff_v1";
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

function getStorage(storage) {
    if (storage) return storage;
    if (typeof window !== "undefined") return window.localStorage;
    throw new Error("linepay_checkout_storage_unavailable");
}

function read(storage) {
    var raw = getStorage(storage).getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
        var value = JSON.parse(raw);
        return value && typeof value === "object" ? value : null;
    } catch (e) {
        return null;
    }
}

export function saveLinePayCheckoutHandoff(payload, storage) {
    payload = payload || {};
    var orderId = String(payload.orderId || "").trim();
    var returnPage = String(payload.returnPage || "").trim();
    if (!orderId || (returnPage !== "index" && returnPage !== "pos")) {
        throw new Error("invalid_linepay_checkout_handoff");
    }
    var value = {
        orderId: orderId,
        returnPage: returnPage,
        createdAt: Date.now(),
        outcome: "pending",
        cart: Array.isArray(payload.cart) ? payload.cart : [],
        form: payload.form && typeof payload.form === "object" ? payload.form : {}
    };
    getStorage(storage).setItem(STORAGE_KEY, JSON.stringify(value));
    return value;
}

export function markLinePayCheckoutOutcome(orderId, outcome, storage) {
    var value = read(storage);
    var normalized = String(outcome || "").toLowerCase();
    if (!value || value.orderId !== String(orderId || "") || !["cancelled", "failed"].includes(normalized)) return false;
    value.outcome = normalized;
    getStorage(storage).setItem(STORAGE_KEY, JSON.stringify(value));
    return true;
}

export function clearLinePayCheckoutHandoff(orderId, storage) {
    var value = read(storage);
    if (!value || (orderId && value.orderId !== String(orderId))) return false;
    getStorage(storage).removeItem(STORAGE_KEY);
    return true;
}

export function consumeRestorableLinePayCheckout(returnPage, storage, now) {
    var targetStorage = getStorage(storage);
    var value = read(targetStorage);
    if (!value) return null;
    var currentTime = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    if (!Number.isFinite(Number(value.createdAt)) || currentTime - Number(value.createdAt) > MAX_AGE_MS) {
        targetStorage.removeItem(STORAGE_KEY);
        return null;
    }
    if (value.returnPage !== String(returnPage || "")) return null;
    if (value.outcome !== "cancelled" && value.outcome !== "failed") return null;
    targetStorage.removeItem(STORAGE_KEY);
    return value;
}
