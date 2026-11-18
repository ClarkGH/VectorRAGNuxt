// S17 (docs/specs/ingest-search.md): only answer requests addressed to this
// machine. DNS rebinding lets a website point its own domain at 127.0.0.1;
// the browser then treats our API as same-origin, so S1's JSON-only rule no
// longer keeps it out. The Host header still carries the attacker's domain.
// No h3/Nuxt imports, so it's unit-testable.

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

// "localhost", "127.0.0.1:3000", "[::1]:3000" -> true; anything else, or no header -> false.
export function isLocalHost(header: string | undefined) {
    if (!header) return false;
    const host = header.trim().toLowerCase();
    // IPv6 hosts are bracketed ("[::1]:3000"), so the port follows "]", not the first ":".
    const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
    if (!LOCAL_HOSTNAMES.has(name)) return false;
    const port = host.slice(name.length);
    return port === "" || /^:\d{1,5}$/.test(port);
}
