// S1 and S2 from docs/specs/ingest-search.md.
import { describe, expect, it } from "vitest";
import {
    isJsonContentType,
    parseYearFilter,
    parseSearchBody,
    SEARCH_DEFAULT_LIMIT,
    SEARCH_MAX_LIMIT,
    SEARCH_MAX_QUERY_LENGTH,
    SearchInputError,
} from "../../server/utils/search.ts";

describe("isJsonContentType (S1)", () => {
    it.each(["application/json", "application/json; charset=utf-8", "Application/JSON"])("accepts %s", (header) => {
        expect(isJsonContentType(header)).toBe(true);
    });

    // The content types a cross-site HTML form or no-cors fetch can send without a preflight.
    it.each([
        "application/x-www-form-urlencoded",
        "text/plain",
        "multipart/form-data; boundary=x",
        "application/jsonx",
        "",
        undefined,
    ])("rejects %s", (header) => {
        expect(isJsonContentType(header)).toBe(false);
    });
});

describe("parseSearchBody (S2)", () => {
    it("trims the query and applies the default limit", () => {
        expect(parseSearchBody({ query: "  civic  " })).toEqual({ query: "civic", limit: SEARCH_DEFAULT_LIMIT });
    });

    it("accepts limits at the bounds", () => {
        expect(parseSearchBody({ query: "x", limit: 1 }).limit).toBe(1);
        expect(parseSearchBody({ query: "x", limit: SEARCH_MAX_LIMIT }).limit).toBe(SEARCH_MAX_LIMIT);
    });

    it.each([
        ["a Mongo operator", { query: { $gt: "" } }],
        ["a number", { query: 42 }],
        ["a missing query", {}],
        ["an empty query", { query: "   " }],
        ["an over-long query", { query: "a".repeat(SEARCH_MAX_QUERY_LENGTH + 1) }],
        ["limit 0", { query: "x", limit: 0 }],
        ["limit over max", { query: "x", limit: SEARCH_MAX_LIMIT + 1 }],
        ["a fractional limit", { query: "x", limit: 2.5 }],
        ["a string limit", { query: "x", limit: "5" }],
        ["an array body", [{ query: "x" }]],
        ["a string body", "query=civic"],
        ["a null body", null],
    ])("rejects %s", (_name, body) => {
        expect(() => parseSearchBody(body)).toThrow(SearchInputError);
    });
});

describe("parseYearFilter", () => {
    it.each([
        ["2018 accord", "accord", [2016, 2020]],
        ["accord 2018", "accord", [2016, 2020]],
        ["accord in 2018", "accord", [2016, 2020]],
        ["2016-2019 accord", "accord", [2016, 2019]],
        ["2016–2019 accord", "accord", [2016, 2019]],
        ["accord from 2016 to 2019", "accord", [2016, 2019]],
        ["between 2016 and 2019 civic", "civic", [2016, 2019]],
        ["2019-2016 civic", "civic", [2016, 2019]],
        // Documents the known limit: unrecognized connectors ("or") stay in the text.
        ["civic 2019 or 2021", "civic or", [2019, 2021]],
        ["2018", "2018", [2016, 2020]],
    ])("%s -> text %j, years %j", (query, text, years) => {
        expect(parseYearFilter(query)).toEqual({ text, years });
    });

    it.each([
        "honda accord",
        // Kit cars in the data are named after old years: searched by meaning, not filtered.
        "1955 Custom Belair",
        "1932 Ford Highboy replica",
        // Numbers that aren't four-digit years.
        "bmw 330i",
        "20185 civic",
    ])("leaves %s unfiltered", (query) => {
        expect(parseYearFilter(query)).toEqual({ text: query, years: null });
    });
});
