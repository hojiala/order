export * from "./pocketbase-order-writer.20260809_005.js?v=20260902_print_handoff_1";

function asText(value) {
    return value === null || value === undefined ? "" : String(value);
}

export function filterCartToAvailableMenu(cart, menuItems) {
    var byId = Object.create(null);
    var byName = Object.create(null);
    (Array.isArray(menuItems) ? menuItems : []).forEach(function(item) {
        if (!item || item.active === false) return;
        var id = asText(item.id).trim();
        var name = asText(item.name).trim();
        if (id) byId[id] = name;
        if (name) byName[name] = true;
    });
    return (Array.isArray(cart) ? cart : []).filter(function(item) {
        var id = asText(item && item.id).trim();
        var name = asText(item && item.name).trim();
        if (id && Object.prototype.hasOwnProperty.call(byId, id)) return !name || byId[id] === name;
        return !!(name && byName[name]);
    });
}
