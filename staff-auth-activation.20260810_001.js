const TRUSTED_VIRTUAL_STAFF_EMAILS = ["staff@yuangi.com", "manage@yuanqi.com"];

export function isBackofficeUser(user) {
    if (!user || user.isAnonymous) return false;
    const email = String(user.email || "").trim().toLowerCase();
    return user.emailVerified === true || TRUSTED_VIRTUAL_STAFF_EMAILS.indexOf(email) >= 0;
}
