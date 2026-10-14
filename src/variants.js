// Input variants: different ways of presenting the same position to the
// decision model. Each takes an engine state and returns a request with one
// Choice question named QUESTION whose criteria are keyed by direction.
//
// Except for `sentences`, no variant lets code judge anything: every move the
// snake can be steered in is offered, fatal ones included, under a neutral
// label, and the model is given the rules and the raw position.

import { steerable } from './snake.js';
import { describeMoves, buildRequest, boardRows, QUESTION } from './describe.js';

const RULES =
  'You are steering a snake on a grid. Choose its next move. The snake dies if ' +
  'its head leaves the grid or enters a cell occupied by its own body. When the ' +
  'head reaches the food the snake grows by one. Keep the snake alive as long ' +
  'as possible while collecting food; survival matters more than food.';

const AXES = 'x counts columns from the left and y counts rows from the top, both starting at 0.';
const LEGEND = 'H head, o body, t tail, * food, . empty';

const MOVE_LABEL = {
  up: 'The head moves up one row (y - 1).',
  down: 'The head moves down one row (y + 1).',
  left: 'The head moves left one column (x - 1).',
  right: 'The head moves right one column (x + 1).',
};

function rawRequest(state, fields, instructions) {
  const criteria = Object.fromEntries(steerable(state).map((d) => [d, MOVE_LABEL[d]]));
  return {
    state: fields,
    questions: { [QUESTION]: { type: 'choice', instructions, criteria } },
  };
}

const xy = (c) => [c.x, c.y];

const boardFields = (state) => ({
  board_rows_top_to_bottom: boardRows(state),
  legend: LEGEND,
  heading: state.dir,
});

const coordFields = (state) => ({
  width: state.width,
  height: state.height,
  heading: state.dir,
  head: xy(state.snake[0]),
  body_from_neck_to_tail: state.snake.slice(1).map(xy),
  food: xy(state.food),
});

export const VARIANTS = {
  // What the app sends today: code simulates each move, drops the fatal ones
  // and writes the outcome of the rest as sentences. The reference point.
  sentences: (state) => buildRequest(state, describeMoves(state)),

  // A drawing of the board and nothing else.
  board: (state) => rawRequest(state, boardFields(state), RULES),

  // Coordinates only, with the body listed in order.
  coords: (state) => rawRequest(state, coordFields(state), `${RULES} ${AXES}`),

  // Both the drawing and the coordinates.
  'board-coords': (state) =>
    rawRequest(state, { ...boardFields(state), ...coordFields(state) }, `${RULES} ${AXES}`),
};
