/**
 * The migration worker (docs/mods.md, "The migration worker"): "Fix for 1.20…"'s plans and runs, off Electron's main thread.
 * Started by main's MigrationThread (mods/migrationThread.ts), which forwards its host's calls.
 */
import { serveMigrations } from './mods/migrationThread.ts';

serveMigrations();
