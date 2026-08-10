const DEFAULT_ACTIVATION_ENDPOINT = "https://secure-order.yuangi168.com/api/auth/activate-virtual-staff";

export async function activateTrustedVirtualStaff(user, endpoint) {
    if (!user || user.isAnonymous || typeof user.getIdToken !== "function") {
        throw new Error("firebase_auth_required");
    }
    const idToken = await user.getIdToken();
    const response = await fetch(endpoint || DEFAULT_ACTIVATION_ENDPOINT, {
        method: "POST",
        headers: {
            "Authorization": "Bearer " + idToken,
            "Content-Type": "application/json"
        },
        body: "{}"
    });
    const payload = await response.json().catch(function() { return {}; });
    if (!response.ok || !payload.ok || payload.emailVerified !== true) {
        throw new Error(payload.message || "virtual_staff_activation_failed");
    }
    return payload;
}
