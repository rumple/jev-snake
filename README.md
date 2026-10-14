# Jev plays Snake

Snake where a decision model picks each move. Code owns the game; the model
supplies the judgment:

1. The engine lists the moves that don't kill the snake outright.
2. Each move is simulated and written up as a sentence ("Eats the food. Keeps
   the whole board reachable. Can still reach its own tail.").
3. The sentences go to the model as one Choice question; it returns a
   probability per move.
4. The most probable move is played.

## Run

```
npm run dev:mock     # http://localhost:5173, no key needed
npm test
npm run bench        # random vs heuristic vs jev over the same seeds
```

Requires Node 22+. There are no dependencies.

## Going live

```
cp .env.example .env   # set TYPESAFE_API_KEY
npm run dev
```

With a key set, the server and the benchmark use the live model; `JEV_MODE=mock`
forces the mock. The key stays on the server. `MAX_CALLS` (default 1500) caps
model calls per server process and per live benchmark run.

The request shape in `src/jev.js` was reconstructed from public demo repos
rather than TypeSafe's docs. It works against the live API for Choice
questions; nothing else has been tried.

Snake asks for a decision on almost every tick, so a 12×12 game is roughly 900
model calls. Use the 8×8 board (`--size 8` in the benchmark) to keep live runs
inside the cap.

## Eval

A fixed set of positions for comparing what we send the model. Each position is
one independent call, so every input variant is judged on identical positions.

```
npm run eval -- --mock                      # free dry run; raw variants score at chance
npm run eval -- --variants board,coords     # live
npm run eval -- --variants board --tag trap --limit 10
npm run eval:build                          # rebuild the position set from runs/
```

`evals/positions.jsonl` holds 150 positions recovered from logged games by
replaying them, weighted toward the harder kinds (walls, body, traps).
`src/variants.js` defines the inputs under test. Apart from `sentences` (what
the app sends today, kept as the reference), a variant gives the model the
rules and the raw position and offers every steerable move, fatal ones
included. Add a function there to try a new input.

Columns, each scored only on positions where the question arises:

- `survive`: did not pick a move that hits a wall or the body.
- `avoid trap`: did not pick a move that survives this turn but leaves no way out.
- `toward food`: picked the move with the shortest open path to the food.
- `= heuristic`: picked the same move as the hand-written bot.
- `p(fatal)`: probability the model put on fatal moves, where any were offered.

The answer key in `evals/grade.js` is never shown to the model. Per-call
records and a summary are written to `evals/results/<timestamp>/`.

## Layout

```
src/snake.js      engine: seeded, pure functions over plain state
src/describe.js   move simulation, features, sentences, the request
src/players.js    random, heuristic and jev players behind one interface
src/variants.js   input variants compared by the eval
src/mock.js       mock model: keyword scoring over the sentences, plus noise
src/jev.js        live TypeSafe client, mock/live selection, call cap
server.js         static hosting and the /api/decide proxy
public/           browser UI: board, probability heatmap, decision panel
tools/bench.js    headless benchmark
evals/            position set, answer key, builder and runner
runs/             one jsonl of requests and answers per server run (gitignored)
```
