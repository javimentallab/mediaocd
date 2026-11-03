"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.letterboxdRating = void 0;
// Letterboxd takes ratings from 0.5 to 5, and MediaOCD stores them as 1 to 5 stars (half
// stars can come from an old Trakt import), so they go out as stored, with no scaling.
// No rating means an empty cell.
const letterboxdRating = rating => rating || '';
exports.letterboxdRating = letterboxdRating;
