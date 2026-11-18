// S17: refuse every request not addressed to localhost (DNS rebinding).
// The check lives in server/utils/host.ts.
export default defineEventHandler((event) => {
    const host = getRequestHeader(event, "host");
    // Nitro's own requests (prerender for `pnpm generate`, server-side $fetch)
    // carry no Host header. A rebinding attack always does: browsers send Host
    // on every request and pages can't remove it (it's a forbidden header).
    if (host === undefined) return;
    if (!isLocalHost(host)) {
        throw createError({ statusCode: 403, statusMessage: "This app only answers on localhost" });
    }
});
