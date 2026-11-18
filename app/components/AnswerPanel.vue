<script setup lang="ts">
// The "G" of RAG on the page (docs/specs/generate.md, step 5): an optional
// AI-written answer about the search results, only when asked for (decision 2).
// The panel holds a one-line summary; the reasons are shown inside the picked
// result cards (the page does that from the `answered` event), so the answer is
// visibly tied to the results it came from.
// The page keys this component by search, so every search starts it fresh.
const props = defineProps<{ query: string; results: SearchResult[] }>();
const emit = defineEmits<{ answered: [answer: Answer] }>();

// Decision 4: a refusal is fixed page text, never model text.
const REFUSAL_TEXT = "None of these match your search. The catalog only has cars.";

// What each 429 reason says (S14). Search keeps working in every case.
const LIMIT_TEXT: Record<AnswerLimitReason, string> = {
    "try-again-in-a-minute": "Too many answers in the last minute. Try again in a minute.",
    "paused-for-today": "Answers are paused for today: the AI's daily limit is used up. Search still works.",
    "out-of-quota": "Answers are unavailable: the AI account is out of credit. Search still works.",
};
// Retrying can't help once the day's limit is used up or the account is out of credit.
const NO_RETRY: AnswerLimitReason[] = ["paused-for-today", "out-of-quota"];
const FAILED_TEXT = "Couldn't write a reliable answer this time. The results below aren't affected.";
// A 4xx other than 429: the request itself was refused, usually because the
// catalog changed since this search. Retrying the same request can't work.
const STALE_TEXT = "These results are out of date. Search again to refresh them.";

type State
    = | { kind: "idle" }
        | { kind: "loading" }
        | { kind: "answer"; response: AnswerResponse }
        | { kind: "problem"; text: string; retry: boolean };

const state = ref<State>({ kind: "idle" });
const outcome = ref<HTMLElement | null>(null);

// S14: repeat clicks within 500 ms are ignored, counted from the last click or
// the last reply, so a quick "Try again" right after an error isn't swallowed
// because of the first click.
const DEBOUNCE_MS = 500;
let quietUntil = 0;

// The picks, in the AI's order, with each car's rank in the results for the link text.
const picks = computed(() => {
    if (state.value.kind !== "answer") return [];
    return state.value.response.answer.picks.flatMap((pick) => {
        const rank = props.results.findIndex((car) => car._id === pick.carId);
        const car = props.results[rank];
        return car ? [{ carId: pick.carId, model: car.model, rank: rank + 1 }] : [];
    });
});

// "A", "A and B", "A, B, and C": the separator before each pick.
function separator(i: number, count: number) {
    if (i === 0) return "";
    if (i < count - 1) return ", ";
    return count > 2 ? ", and " : " and ";
}

async function explain() {
    if (state.value.kind === "loading" || Date.now() < quietUntil) return;
    quietUntil = Date.now() + DEBOUNCE_MS;

    state.value = { kind: "loading" };
    try {
        const response = await $fetch("/api/answer", {
            method: "POST",
            body: { query: props.query, resultIds: props.results.map((car) => car._id) },
        });
        state.value = { kind: "answer", response };
        // The server only returns picks from these results, but if none matched,
        // an empty "these fit" would be worse than saying it failed.
        if (!response.answer.noneFit && !picks.value.length) {
            state.value = { kind: "problem", text: FAILED_TEXT, retry: true };
        } else {
            emit("answered", response.answer);
        }
    } catch (err) {
        state.value = problemFor(err);
    }
    quietUntil = Date.now() + DEBOUNCE_MS;

    // The button that had focus is gone or changed: move focus to what happened,
    // so keyboard and screen-reader users land on the answer, not the page top.
    await nextTick();
    outcome.value?.focus();
}

function problemFor(err: unknown): State {
    const e = err as { statusCode?: number; data?: { data?: { reason?: unknown } } } | null;
    const reason = e?.data?.data?.reason;
    if (typeof reason === "string" && reason in LIMIT_TEXT) {
        const limit = reason as AnswerLimitReason;
        return { kind: "problem", text: LIMIT_TEXT[limit], retry: !NO_RETRY.includes(limit) };
    }
    const status = e?.statusCode ?? 0;
    if (status >= 400 && status < 500 && status !== 429) return { kind: "problem", text: STALE_TEXT, retry: false };
    return { kind: "problem", text: FAILED_TEXT, retry: true };
}
</script>

<template>
    <section
        class="answer-panel"
        aria-labelledby="answer-title"
        :data-state="state.kind"
    >
        <div class="answer-row">
            <div class="answer-text">
                <h3 id="answer-title">
                    Which of these fit your search?
                </h3>

                <!-- Before and during: announced politely as it changes. -->
                <p
                    v-if="state.kind === 'idle' || state.kind === 'loading'"
                    class="answer-hint"
                    aria-live="polite"
                >
                    <template v-if="state.kind === 'idle'">
                        An AI reads the descriptions below and marks the cars that fit.
                    </template>
                    <template v-else>
                        Reading the descriptions…
                    </template>
                </p>

                <!-- After: focused when it appears. All text is plain interpolation (P5). -->
                <div
                    v-else
                    ref="outcome"
                    class="answer-outcome"
                    tabindex="-1"
                >
                    <p
                        v-if="state.kind === 'problem'"
                        class="answer-problem"
                    >
                        {{ state.text }}
                    </p>
                    <template v-else-if="state.kind === 'answer'">
                        <p
                            v-if="state.response.answer.noneFit"
                            class="answer-summary"
                        >
                            {{ REFUSAL_TEXT }}
                        </p>
                        <p
                            v-else
                            class="answer-summary"
                        >
                            {{ picks.length }} of {{ results.length }} fit:
                            <template
                                v-for="(pick, i) in picks"
                                :key="pick.carId"
                            >
                                {{ separator(i, picks.length) }}<a :href="`#car-${pick.carId}`">{{ pick.model }} (#{{ pick.rank }})</a>
                            </template>.
                        </p>
                        <p class="answer-label">
                            <template v-if="state.response.source === 'mock'">
                                Mock answer for development: the AI wasn't asked.
                            </template>
                            <template v-else-if="state.response.source === 'gate'">
                                Nothing scored close enough to ask the AI.
                            </template>
                            <template v-else-if="state.response.answer.noneFit">
                                The AI read the descriptions and found no fit. It can be wrong.
                            </template>
                            <template v-else>
                                AI-written from the descriptions below. It can be wrong.
                            </template>
                        </p>
                    </template>
                </div>
            </div>

            <!-- While loading: aria-disabled, never disabled, since a disabled
                 button drops keyboard focus to the page. That's also why the
                 spinner is an icon, not :loading, which disables the button.
                 explain() ignores clicks while loading. -->
            <UButton
                v-if="state.kind === 'idle' || state.kind === 'loading' || (state.kind === 'problem' && state.retry)"
                class="action-button explain-button"
                :leading-icon="state.kind === 'loading' ? 'i-lucide-loader-circle' : undefined"
                :ui="{ leadingIcon: 'motion-safe:animate-spin' }"
                :aria-disabled="state.kind === 'loading' ? 'true' : undefined"
                @click="explain"
            >
                {{ state.kind === "problem" ? "Try again" : "Explain these results" }}
            </UButton>
        </div>
    </section>
</template>

<style scoped>
.answer-panel {
  margin-top: 1rem;
  padding: 1rem 1.25rem;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  line-height: 1.5;
}
.answer-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem 1.5rem;
}
.answer-text {
  flex: 1 1 22rem;
  min-width: 0;
}
h3 {
  font-size: 1.0625rem;
  font-weight: 700;
}
.explain-button {
  padding-inline: 1rem;
}
.answer-hint,
.answer-label {
  margin-top: 0.25rem;
  color: var(--muted);
  font-size: 0.9375rem;
}
.answer-outcome {
  margin-top: 0.375rem;
  border-radius: 0.25rem;
}
/* Focused by script, so only show a ring when the keyboard is in use. */
.answer-outcome:focus {
  outline: none;
}
.answer-outcome:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 4px;
}
.answer-summary {
  font-weight: 600;
  max-width: 65ch;
}
.answer-summary a {
  color: var(--score);
  text-decoration: underline;
  text-underline-offset: 0.15em;
}
.answer-summary a:hover {
  text-decoration-thickness: 2px;
}
.answer-problem {
  padding-left: 0.75rem;
  border-left: 4px solid var(--danger);
  max-width: 65ch;
}
</style>
