// "2016–2026", or "2018" for a single year. Takes a sorted list of years or a
// [from, to] range. The page uses an en dash; the describe prompt passes "-".
export function formatYears(years: readonly number[], dash = "–") {
    const first = years[0];
    const last = years[years.length - 1];
    return first === last ? `${first}` : `${first}${dash}${last}`;
}
