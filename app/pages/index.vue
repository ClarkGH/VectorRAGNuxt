<script setup lang="ts">
// The landing card's examples, one row per way search works: by name, with a
// year filter, or by meaning (the AI-written descriptions).
const searchWays = [
    { name: "By model", hint: "A name or a trim", searches: ["civic type r", "toyota corolla"] },
    { name: "With a year", hint: "Only models sold then", searches: ["2018 accord", "2016-2019 mazda3"] },
    { name: "By description", hint: "What you want, in your words", searches: ["small reliable sedan", "cheap sporty car"] },
];

const query = ref("");
const searched = ref("");
const years = ref<YearRange | null>(null);
const results = ref<SearchResult[] | null>(null);
const nothingClose = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);

// The AI answer's picks, carId -> reason, shown inside the matching result cards.
// `searchCount` keys the answer panel, so every search (even a repeat of the
// same words) starts it fresh, and the picks are cleared with it.
const picks = ref(new Map<string, string>());
const searchCount = ref(0);

const hasDescriptions = computed(() => results.value?.some((car) => car.description) ?? false);

// What's loaded, read from Mongo on the server render. If Mongo is down this is
// null and the page falls back to wording without numbers.
const { data: catalog } = await useFetch("/api/catalog");

async function search() {
    const q = query.value.trim();
    if (!q) return;
    loading.value = true;
    error.value = null;
    try {
        const res = await $fetch("/api/search", { method: "POST", body: { query: q } });
        results.value = res.results;
        years.value = res.years;
        nothingClose.value = res.nothingClose;
        searched.value = q;
        picks.value = new Map();
        searchCount.value++;
    } catch {
        results.value = null;
        error.value
            = "Check that Mongo is running and NUXT_OPENAI_KEY is set, then search again. The dev server terminal has the details.";
    } finally {
        loading.value = false;
    }
}

function tryExample(text: string) {
    query.value = text;
    search();
}

// The match is shown as a word, not a percentage: a mid score can't tell a
// right answer from a wrong one (docs/evaluation.md, "The match display").
// Steps fill the small meter beside it: 3 strong, 2 possible, 1 weak.
const MATCH_STEPS: Record<MatchStrength, number> = { strong: 3, possible: 2, weak: 1 };
</script>

<template>
    <div class="page">
        <header class="hero">
            <div class="wrap">
                <p class="wordmark">
                    Closest Car
                </p>
                <h1 id="title">
                    Find the closest car
                </h1>
                <p class="hero-sub">
                    Describe a car in your own words, and we'll match it to real models.
                </p>

                <form
                    class="search"
                    @submit.prevent="search"
                >
                    <label
                        for="q"
                        class="sr-only"
                    >Car description</label>
                    <UInput
                        id="q"
                        v-model="query"
                        class="flex-1"
                        size="xl"
                        placeholder="Try “2018 accord” or “small reliable sedan”"
                        :maxlength="500"
                        autofocus
                        :ui="{ base: 'search-input' }"
                    />
                    <UButton
                        type="submit"
                        size="xl"
                        :loading="loading"
                        class="brand-button search-button"
                    >
                        Search
                    </UButton>
                </form>
            </div>
        </header>

        <main class="wrap content">
            <!-- Before the first search: how search works, with examples to try. -->
            <section
                v-if="!results && !error"
                class="start"
                aria-labelledby="start-title"
            >
                <h2
                    id="start-title"
                    class="start-title"
                >
                    Try a search
                </h2>
                <p class="start-sub">
                    Name a car, add a year, or describe the car you want.
                </p>
                <dl class="ways">
                    <div
                        v-for="way in searchWays"
                        :key="way.name"
                        class="way"
                    >
                        <dt>
                            <span class="way-name">{{ way.name }}</span>
                            <span class="way-hint">{{ way.hint }}</span>
                        </dt>
                        <dd class="way-examples">
                            <button
                                v-for="text in way.searches"
                                :key="text"
                                type="button"
                                class="example"
                                :disabled="loading"
                                @click="tryExample(text)"
                            >
                                {{ text }}
                            </button>
                        </dd>
                    </div>
                </dl>
            </section>

            <div
                v-if="error"
                class="notice notice-error"
                role="alert"
            >
                <p class="notice-title">
                    Search failed
                </p>
                <p>{{ error }}</p>
            </div>

            <p
                v-else-if="results && !results.length"
                class="notice"
            >
                <template v-if="years">
                    No cars sold in {{ formatYears(years) }} came back for “{{ searched }}”.
                    <template v-if="catalog?.years">
                        The catalog covers model years {{ formatYears(catalog.years) }}.
                    </template>
                </template>
                <template v-else>
                    Nothing came back for “{{ searched }}”. The catalog is mostly passenger cars, with a few
                    SUVs and no pickups.
                </template>
            </p>

            <section
                v-else-if="results"
                aria-labelledby="results-title"
            >
                <h2 id="results-title">
                    Closest to “{{ searched }}”
                </h2>
                <p
                    v-if="nothingClose"
                    class="notice nothing-close"
                >
                    <span class="notice-title">Nothing close to that in the catalog.</span>
                    These are the nearest cars anyway. The catalog is mostly passenger cars, with a few SUVs
                    and no pickups.
                </p>
                <p class="scale-note">
                    <template v-if="years">
                        Showing models sold in {{ formatYears(years) }}.
                    </template>
                    A strong match is very likely right; a possible match may or may not fit.
                    <template v-if="hasDescriptions">
                        Descriptions are AI-written and can be wrong.
                    </template>
                </p>

                <!-- Not offered when nothing is close: the server's gate would refuse anyway. -->
                <AnswerPanel
                    v-if="!nothingClose"
                    :key="searchCount"
                    :query="searched"
                    :results="results"
                    @answered="(answer) => (picks = new Map(answer.picks.map((p) => [p.carId, p.reason])))"
                />

                <ol
                    :key="searchCount"
                    class="result-list"
                >
                    <li
                        v-for="(car, i) in results"
                        :id="`car-${car._id}`"
                        :key="car._id"
                        class="result"
                        :class="{ picked: picks.has(car._id) }"
                    >
                        <span
                            class="rank"
                            aria-hidden="true"
                        >{{ i + 1 }}</span>
                        <div class="result-body">
                            <div class="result-head">
                                <div>
                                    <p class="make">
                                        {{ displayMake(car.make) }}
                                    </p>
                                    <p class="model">
                                        {{ car.model }}
                                    </p>
                                    <p class="years">
                                        Model years <span class="nowrap">{{ formatYears(car.years) }}</span>
                                    </p>
                                </div>
                                <!-- The match in words; the steps repeat it visually, so they're hidden from screen readers. -->
                                <div
                                    class="score"
                                    :data-strength="matchStrength(car.score)"
                                >
                                    <p class="strength">
                                        {{ MATCH_LABEL[matchStrength(car.score)] }}
                                    </p>
                                    <div
                                        class="steps"
                                        aria-hidden="true"
                                    >
                                        <span
                                            v-for="n in 3"
                                            :key="n"
                                            class="step"
                                            :class="{ on: n <= MATCH_STEPS[matchStrength(car.score)] }"
                                        />
                                    </div>
                                </div>
                            </div>
                            <p
                                v-if="car.description"
                                class="description"
                            >
                                {{ car.description }}
                            </p>
                            <!-- The AI answer, marked on the car it's about. Plain text (P5). -->
                            <p
                                v-if="picks.has(car._id)"
                                class="pick-note"
                            >
                                <span class="pick-label">AI pick</span>
                                {{ picks.get(car._id) }}
                            </p>
                        </div>
                    </li>
                </ol>
            </section>
        </main>

        <footer class="wrap source">
            <template v-if="catalog?.years">
                {{ catalog.models }} passenger car models from the NHTSA vehicle database, model years
                {{ formatYears(catalog.years) }}.
            </template>
            <template v-else>
                Passenger cars from the NHTSA vehicle database.
            </template>
            A few SUVs and no pickups: NHTSA lists most of those separately.
        </footer>
    </div>
</template>

<style scoped>
.page {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}
.wrap {
  width: 100%;
  max-width: 48rem;
  margin: 0 auto;
  padding-inline: 1rem;
}

/* Navy band with the search, like a car-pricing site's landing page. The yellow
   stripe along its bottom is the brand; in dark mode it also separates the band
   from the page, which sit close in color. */
.hero {
  background: var(--navy);
  color: #ffffff;
  padding: 1.25rem 0 2.5rem;
  box-shadow: inset 0 -6px 0 var(--brand);
}
.wordmark {
  font-weight: 800;
  font-size: 1.125rem;
  letter-spacing: -0.01em;
}
h1 {
  margin-top: 2.25rem;
  font-size: 2.5rem;
  line-height: 1.1;
  font-weight: 800;
  letter-spacing: -0.02em;
}
.hero-sub {
  margin-top: 0.625rem;
  font-size: 1.125rem;
  color: var(--hero-muted);
}

/* The search sits on a white panel, so it reads as the one thing to do here. */
.search {
  margin-top: 1.75rem;
  display: flex;
  gap: 0.5rem;
  padding: 0.5rem;
  background: #ffffff;
  border-radius: 0.75rem;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
}
.search :deep(.search-input) {
  background: #ffffff;
  color: #1b2330;
  font-size: 1.0625rem;
  border-radius: 0.5rem;
  box-shadow: none;
}
.search :deep(.search-input::placeholder) {
  color: #6b7686;
}
.search :deep(.search-input:focus-visible) {
  box-shadow: inset 0 0 0 2px var(--blue);
}
/* Colors, hover and focus come from .brand-button (main.css). */
.search-button {
  padding-inline: 1.5rem;
  justify-content: center;
}

/* The landing card: one row per way to search, each with examples to try. */
.start {
  padding: 1.25rem 1.5rem 0.5rem;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 0.75rem;
}
.start-title {
  font-size: 1.25rem;
}
.start-sub {
  margin-top: 0.25rem;
  color: var(--muted);
  line-height: 1.5;
}
.ways {
  margin-top: 0.75rem;
}
.way {
  display: grid;
  grid-template-columns: 11rem 1fr;
  align-items: center;
  gap: 0.5rem 1rem;
  padding-block: 0.875rem;
}
/* The rows are three kinds of search: a rule between them, none after the last. */
.way + .way {
  border-top: 1px solid var(--line);
}
.way-name {
  display: block;
  font-weight: 700;
}
.way-hint {
  display: block;
  color: var(--muted);
  font-size: 0.875rem;
}
.way-examples {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.example {
  padding: 0.3rem 0.85rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--page);
  color: var(--score);
  font-weight: 600;
  cursor: pointer;
}
.example:hover:not(:disabled) {
  border-color: var(--blue);
}
.example:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}
@media (max-width: 34rem) {
  .way {
    grid-template-columns: 1fr;
  }
}

.content {
  padding-top: 2rem;
  padding-bottom: 1rem;
}
.notice {
  padding: 1rem 1.25rem;
  background: var(--card);
  border: 1px solid var(--line);
  border-left: 4px solid var(--blue);
  border-radius: 0.5rem;
  line-height: 1.5;
}
.notice-error {
  border-left-color: var(--danger);
}
.notice-title {
  font-weight: 700;
}
.nothing-close {
  margin-top: 0.75rem;
}

h2 {
  font-size: 1.5rem;
  font-weight: 800;
  line-height: 1.2;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}
.scale-note {
  margin-top: 0.375rem;
  color: var(--muted);
  font-size: 0.9375rem;
  line-height: 1.5;
}

.result-list {
  margin-top: 1.25rem;
  display: grid;
  gap: 0.75rem;
}
.result {
  display: grid;
  grid-template-columns: 2.25rem 1fr;
  gap: 1rem;
  padding: 1.25rem;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  /* The answer panel's links jump here; leave room above the card. */
  scroll-margin-top: 1rem;
}
/* A car the AI answer picked: the same blue as the match bars, on the edge. */
.result.picked {
  box-shadow: inset 4px 0 0 var(--bar);
}
.rank {
  display: grid;
  place-items: center;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 999px;
  background: var(--rank-bg);
  color: var(--rank-ink);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.result-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
}
.make {
  color: var(--muted);
  font-size: 0.875rem;
  font-weight: 600;
}
.model {
  font-size: 1.375rem;
  font-weight: 800;
  line-height: 1.2;
  letter-spacing: -0.01em;
}
.score {
  flex-shrink: 0;
  min-width: 6.5rem;
  text-align: right;
  line-height: 1.1;
  white-space: nowrap;
}
/* On phones the word wraps ("Possible" / "match") to leave room for the name. */
@media (max-width: 34rem) {
  .score {
    min-width: 0;
    width: 4.5rem;
    white-space: normal;
  }
}
/* A year range never splits across lines ("2016–" / "2026"). */
.nowrap {
  white-space: nowrap;
}
/* The word carries the meaning; color only reinforces it. */
.strength {
  font-weight: 700;
  font-size: 0.9375rem;
  line-height: 1.25;
}
.score[data-strength="strong"] .strength {
  color: var(--score);
}
.score[data-strength="weak"] .strength {
  color: var(--muted);
}
.steps {
  margin-top: 0.4rem;
  display: flex;
  justify-content: flex-end;
  gap: 0.2rem;
}
.step {
  width: 1rem;
  height: 0.375rem;
  border-radius: 999px;
  background: var(--track);
}
.step.on {
  background: var(--bar);
}
.years {
  margin-top: 0.25rem;
  color: var(--muted);
  font-size: 0.9375rem;
  font-variant-numeric: tabular-nums;
}
.description {
  margin-top: 0.625rem;
  line-height: 1.5;
  max-width: 60ch;
}
/* AI-written, so it sits on the brand's yellow tint, apart from the description. */
.pick-note {
  margin-top: 0.75rem;
  padding: 0.625rem 0.875rem;
  max-width: 60ch;
  border-radius: 0.5rem;
  background: var(--pick-bg);
  color: var(--ink);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.pick-label {
  display: block;
  color: var(--pick-label);
  font-weight: 700;
  font-size: 0.875rem;
}
.source {
  margin-top: auto;
  padding-top: 2rem;
  padding-bottom: 2rem;
  color: var(--muted);
  font-size: 0.875rem;
}

@media (max-width: 30rem) {
  h1 {
    font-size: 2rem;
    margin-top: 1.5rem;
  }
  .search {
    flex-direction: column;
  }
  .result {
    grid-template-columns: 1.75rem 1fr;
    gap: 0.75rem;
    padding: 1rem;
  }
  .rank {
    width: 1.75rem;
    height: 1.75rem;
    font-size: 0.875rem;
  }
}
</style>
