<script setup lang="ts">
const examples = ["civic type r", "small honda", "cheap reliable car"];

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

// Mongo's score runs 0..1, but 0.5 already means "unrelated", so the page shows
// 0.5..1 as 0..100%. One helper feeds both the number and the bar, so they can't drift apart.
function matchPercent(score: number) {
    return Math.round(Math.min(Math.max((score - 0.5) / 0.5, 0), 1) * 100);
}
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
                        class="action-button search-button"
                    >
                        Search
                    </UButton>
                </form>

                <div
                    v-if="!results && !error"
                    class="examples"
                >
                    <span class="examples-label">Popular searches:</span>
                    <button
                        v-for="text in examples"
                        :key="text"
                        type="button"
                        class="example"
                        :disabled="loading"
                        @click="tryExample(text)"
                    >
                        {{ text }}
                    </button>
                </div>
            </div>
        </header>

        <main class="wrap content">
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
                    Nothing came back for “{{ searched }}”. The catalog has passenger cars only, so SUVs, vans
                    and pickups won't match.
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
                    These are the nearest cars anyway. The catalog has passenger cars only, so SUVs, vans and
                    pickups won't match.
                </p>
                <p class="scale-note">
                    <template v-if="years">
                        Showing models sold in {{ formatYears(years) }}.
                    </template>
                    Bars run from unrelated (50%) to identical (100%).
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
                                        {{ car.make }}
                                    </p>
                                    <p class="model">
                                        {{ car.model }}
                                    </p>
                                </div>
                                <p class="score">
                                    <span class="score-number">{{ matchPercent(car.score) }}%</span>
                                    <span class="score-label">match</span>
                                </p>
                            </div>
                            <p class="years">
                                Model years {{ formatYears(car.years) }}
                            </p>
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
                            <div
                                class="bar"
                                aria-hidden="true"
                            >
                                <div
                                    class="bar-fill"
                                    :style="{ width: `${matchPercent(car.score)}%` }"
                                />
                            </div>
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
            No SUVs, vans or pickups yet.
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

/* Navy band with the search, like a car-pricing site's landing page. */
.hero {
  background: var(--navy);
  color: #ffffff;
  padding: 1.25rem 0 2.5rem;
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
/* Colors, hover and focus come from .action-button (main.css). */
.search-button {
  padding-inline: 1.5rem;
  justify-content: center;
}

.examples {
  margin-top: 1rem;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.examples-label {
  color: var(--hero-muted);
  margin-right: 0.25rem;
}
.example {
  padding: 0.3rem 0.85rem;
  border: 1px solid rgb(255 255 255 / 0.35);
  border-radius: 999px;
  color: #ffffff;
  cursor: pointer;
}
.example:hover:not(:disabled) {
  background: rgb(255 255 255 / 0.12);
}
.example:focus-visible {
  outline: 2px solid #ffffff;
  outline-offset: 2px;
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
  text-align: right;
  line-height: 1.1;
}
.score-number {
  display: block;
  font-size: 1.5rem;
  font-weight: 800;
  color: var(--score);
  font-variant-numeric: tabular-nums;
}
.score-label {
  color: var(--muted);
  font-size: 0.8125rem;
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
/* AI-written, so it sits on the rank chips' tint, apart from the description. */
.pick-note {
  margin-top: 0.75rem;
  padding: 0.625rem 0.875rem;
  max-width: 60ch;
  border-radius: 0.5rem;
  background: var(--rank-bg);
  color: var(--ink);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.pick-label {
  display: block;
  color: var(--rank-ink);
  font-weight: 700;
  font-size: 0.875rem;
}
.bar {
  margin-top: 0.875rem;
  height: 0.375rem;
  border-radius: 999px;
  background: var(--track);
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--bar);
  transform-origin: left;
  animation: grow 500ms cubic-bezier(0.2, 0.7, 0.2, 1) both;
}
@keyframes grow {
  from {
    transform: scaleX(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .bar-fill {
    animation: none;
  }
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
