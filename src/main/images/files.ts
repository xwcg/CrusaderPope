/**
 * Graphics file kinds. The files themselves come from the layering of the game, its engine folders (`game/dlc/<dlc>`,
 * jomini, clausewitz) and the loaded mods — `GameFiles.list('gfx', { engine: true })` / `get(rel, { engine: true })`
 * (src/main/mods/gamefiles.ts). Paths are game paths like the game uses them (`gfx/interface/icons/traits/brave.dds`).
 */

export const IMAGE_EXT = /\.(dds|png|tga)$/i;
/** 3D model files: `.asset` declarations (pdxmesh / entity) and binary `.mesh` geometry */
export const MODEL_EXT = /\.(asset|mesh)$/i;
