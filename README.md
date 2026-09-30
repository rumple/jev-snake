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

The live client in `src/jev.js` has not been run against the real API yet. Its
request shape is reconstructed from public demo repos; see the note at the top
of that file.

Snake asks for a decision on almost every tick, so a 12×12 game is roughly 900
model calls. Use the 8×8 board (`--size 8` in the benchmark) to keep live runs
inside the cap.

## Layout

```
src/snake.js      engine: seeded, pure functions over plain state
src/describe.js   move simulation, features, sentences, the request
src/players.js    random, heuristic and jev players behind one interface
src/mock.js       mock model: keyword scoring over the sentences, plus noise
src/jev.js        live TypeSafe client, mock/live selection, call cap
server.js         static hosting and the /api/decide proxy
public/           browser UI: board, probability heatmap, decision panel
tools/bench.js    headless benchmark
runs/             one jsonl of requests and answers per server run (gitignored)
```
