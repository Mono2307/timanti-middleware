'use strict';

function roundToTwo(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

module.exports = { roundToTwo };
