/**
 * @fracture/shared — public API.
 *
 * Contains everything both the authoritative server and the browser client
 * must agree on: gameplay constants, wire types, protocol validation, the
 * deterministic simulation and the arena definition.
 */
export * from './config.js';
export * from './math.js';
export * from './types.js';
export * from './arena.js';
export * from './protocol.js';
export * from './rules/platforms.js';
export * from './rules/targeting.js';
export * from './sim/movement.js';
export * from './sim/player.js';
export * from './sim/bot.js';
export * from './sim/match.js';
