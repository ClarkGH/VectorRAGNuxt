// S17: requests must be addressed to localhost (DNS rebinding).
import { describe, expect, it } from "vitest";
import { isLocalHost } from "../../server/utils/host.ts";

describe("isLocalHost", () => {
    it.each(["localhost", "localhost:3000", "127.0.0.1:3000", "[::1]:3000", "[::1]", "LOCALHOST:3100", " localhost:3000 "])(
        "accepts %s",
        (header) => {
            expect(isLocalHost(header)).toBe(true);
        },
    );

    it.each([
        ["no header", undefined],
        ["empty", ""],
        ["a rebinding domain", "evil.example:3000"],
        ["a lookalike subdomain", "localhost.evil.example:3000"],
        ["a LAN address", "192.168.1.20:3000"],
        ["all interfaces", "0.0.0.0:3000"],
        ["junk after the port", "localhost:3000@evil.example"],
        ["a non-numeric port", "localhost:abc"],
        ["an unclosed IPv6 bracket", "[::1:3000"],
        ["another IPv6 address", "[::2]:3000"],
    ])("rejects %s", (_name, header) => {
        expect(isLocalHost(header)).toBe(false);
    });
});
