const STAFF_UIDS = new Set([
    "LS1y2tRMGLfG5PmUpAotTEGybEy2",
    "XJSOFPnRX3N2oj4mWJF9kUo8Cg53"
]);

const MANAGE_UIDS = new Set([
    "XJSOFPnRX3N2oj4mWJF9kUo8Cg53"
]);

export function isBackofficeUser(user) {
    return !!(user && !user.isAnonymous && STAFF_UIDS.has(String(user.uid || "")));
}

export function isManageUser(user) {
    return !!(user && !user.isAnonymous && MANAGE_UIDS.has(String(user.uid || "")));
}
