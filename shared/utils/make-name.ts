// NHTSA lists makes in capitals ("MERCEDES-BENZ"). The page shows them the way
// people write them ("Mercedes-Benz"), so a make reads as a name, not a shouted
// label. Data and search keep the original spelling; this is display only.

// Words that stay in capitals: acronyms and brands written that way.
const KEEP_UPPER = new Set(["AC", "AM", "BMW", "BYD", "MINI", "RUF", "SCG", "SSC"]);
// Words with their own capitalization.
const SPECIAL: Record<string, string> = { MCLAREN: "McLaren" };

const word = (w: string) =>
    KEEP_UPPER.has(w) ? w : (SPECIAL[w] ?? w.charAt(0) + w.slice(1).toLowerCase());

// "MERCEDES-BENZ" -> "Mercedes-Benz", "SCUDERIA CAMERON GLICKENHAUS (SCG)" ->
// "Scuderia Cameron Glickenhaus (SCG)", "BMW" -> "BMW".
export function displayMake(make: string) {
    return make.replace(/[A-Z0-9]+/gi, (w) => word(w.toUpperCase()));
}
